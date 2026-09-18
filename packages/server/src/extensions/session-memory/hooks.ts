// The session-memory-summary extension's server hooks — the reference
// implementation of the extension hook registry. Every handler delegates to
// the existing lib functions; this file is the relocation of the call sites
// that used to live inline in routes/messages.ts and routes/sessions.ts, not
// a rewrite of the systems themselves.

import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { db } from "../../db/index.js";
import { playSessions, messages } from "../../db/schema.js";
import {
  getMemorySystemSettings,
  type SessionMemorySystemRow,
} from "../../lib/memory-systems-core.js";
import {
  discardQueuedSessionMemoryUpdates,
  formatSessionMemoryForPrompt,
  regenerateSessionMemoryForSession,
  scheduleSessionMemoryIncrementalUpdate,
} from "../../lib/session-memory.js";
import {
  discardQueuedStoryCompactions,
  formatStorySummaryForPrompt,
  recompactStorySummaryAfterRevert,
  scheduleStoryCompaction,
} from "../../lib/session-compaction.js";
import { isExtensionInstalled } from "../../lib/extensions.js";
import {
  clearSummaryceptionData,
  getSummaryceptionPromptBlock,
  resetSummaryceptionSessionFields,
  scheduleSummaryceptionCompaction,
} from "../../lib/summaryception.js";
import {
  registerExtensionHooks,
  type ExtensionInvalidation,
  type InvalidateContext,
} from "../../lib/extension-hooks.js";

const STORY_SUMMARY_RESET_FIELDS = {
  summary: null,
  summaryUpdatedAt: null,
  summaryStatus: "idle" as const,
  summaryError: null,
  summarySourceHash: null,
  summaryCoversUntilMessageId: null,
  summaryTokenCount: null,
  summaryClaimedAt: null,
};

/** Keep the stored summary text but invalidate any in-flight compaction:
 *  persistStorySummaryResult requires status "updating" + a matching hash. */
const STORY_JOB_ABORT_FIELDS = {
  summaryStatus: "idle" as const,
  summaryError: null,
  summarySourceHash: null,
  summaryClaimedAt: null,
};

const SESSION_MEMORY_RESET_FIELDS = {
  sessionMemory: null,
  sessionMemoryUpdatedAt: null,
  sessionMemoryStatus: "idle" as const,
  sessionMemoryClaimedAt: null,
  sessionMemoryRetryCount: 0,
  sessionMemoryError: null,
  sessionMemorySourceHash: null,
  sessionMemoryProcessedMessageId: null,
  sessionMemoryStaleAt: null,
};

/**
 * After a revert/fork rewrites the message list, eagerly rebuild the dropped
 * memory tiers from the SURVIVING transcript right away — instead of leaving
 * them empty until later turns lazily (and incompletely — incremental updates
 * only ever fold one prior exchange at a time) rebuild them. The session-memory
 * rebuild honors the lag-one invariant: it stops before the surviving
 * transcript's last exchange, so the newest visible reply stays out of memory.
 *
 * - Session memory: regenerated whenever it was dropped (enabled tier).
 * - Story summary: re-derived ONLY when `regenerateStorySummary` is set (REVERT
 *   path, when the summary was DROPPED because it covered a deleted message).
 *   The revert already dropped the summary and un-compacted every surviving
 *   message, so this runs a THRESHOLD-mode recompaction over the full surviving
 *   transcript: it regenerates the summary only if the surviving conversation
 *   is STILL over the trigger, and otherwise no-ops (the chat now fits raw, so
 *   no summary). Not done on fork (the branch's copied prefix is unchanged),
 *   and not done when the revert KEPT the summary (nothing to re-derive).
 *
 * Fires only for enabled tiers of an installed extension; the per-session job
 * chains coalesce rapid reverts.
 */
export function regenerateDroppedMemoryTiers(args: {
  sessionId: string;
  userId: string;
  session: SessionMemorySystemRow;
  keptSessionMemory: boolean;
  regenerateStorySummary: boolean;
}): void {
  const settings = getMemorySystemSettings(args.session);
  const wantSessionMemory = settings.sessionMemoryIncluded && !args.keptSessionMemory;
  const wantStorySummary = settings.localdevSummaryIncluded && args.regenerateStorySummary;
  if (!wantSessionMemory && !wantStorySummary) return;

  void isExtensionInstalled(args.userId, SESSION_MEMORY_EXTENSION_KEY)
    .then((installed) => {
      if (!installed) return;
      if (wantSessionMemory) {
        void regenerateSessionMemoryForSession({ sessionId: args.sessionId, userId: args.userId }).catch((err) =>
          console.warn("[SessionMemory] revert/fork regen failed:", err instanceof Error ? err.message : err),
        );
      }
      if (wantStorySummary) {
        void recompactStorySummaryAfterRevert({ sessionId: args.sessionId, userId: args.userId }).catch((err) =>
          console.warn("[StoryCompaction] post-revert recompaction failed:", err instanceof Error ? err.message : err),
        );
      }
    })
    .catch((err) =>
      console.warn("[Memory] revert/fork regen entitlement check failed:", err instanceof Error ? err.message : err),
    );
}

/**
 * Invalidation after a message's content changed (edit, delete, swipe switch)
 * — scoped to the systems whose stored output actually covers that message. A
 * non-compacted message needs no invalidation at all: raw history feeds the
 * next compaction's source hash naturally. Previously these sites wiped ALL
 * THREE memory systems and un-compacted the whole session on every swipe/edit,
 * forcing a full re-summarization of the entire backlog. Structured session
 * memory is deliberately never wiped here — incremental updates only ever fold
 * one prior exchange, so a blanket wipe permanently lost every accumulated
 * fact; the memory panel offers a manual regenerate. Under the lag-one
 * invariant memory never covers the newest visible reply anyway, so
 * swiping/regenerating/editing that reply needs no memory invalidation —
 * only edits to OLDER turns can leave memory stale (accepted tradeoff).
 */
function invalidateForChangedMessage(ctx: InvalidateContext): ExtensionInvalidation {
  const flags = ctx.messageFlags ?? {};
  const invalidateStory = flags.compacted === true;
  const invalidateSummaryception = flags.summaryceptionCompacted === true;
  return {
    sessionFields: {
      ...(invalidateStory ? STORY_SUMMARY_RESET_FIELDS : {}),
      ...(invalidateSummaryception ? resetSummaryceptionSessionFields() : {}),
    },
    runAfter: async () => {
      // Manual regeneration can intentionally summarize a short transcript
      // without compacting its raw rows. In that case `compacted` is false,
      // so use the persisted coverage boundary to invalidate edits inside the
      // regenerated summary as well.
      const rawCoverage = !invalidateStory
        ? await getChangedMessageStoryCoverage(ctx)
        : null;
      const rawCoverageReset = rawCoverage
        ? await db
          .update(playSessions)
          .set(STORY_SUMMARY_RESET_FIELDS)
          .where(and(
            eq(playSessions.id, ctx.sessionId),
            eq(playSessions.summaryCoversUntilMessageId, rawCoverage.coversUntilMessageId),
            rawCoverage.sourceHash === null
              ? isNull(playSessions.summarySourceHash)
              : eq(playSessions.summarySourceHash, rawCoverage.sourceHash),
          ))
          .returning()
        : [];
      if (invalidateStory || rawCoverageReset.length > 0) {
        await db.update(messages).set({ compacted: false }).where(eq(messages.sessionId, ctx.sessionId));
      }
      if (invalidateSummaryception) {
        await clearSummaryceptionData(ctx.sessionId);
      }
      // The content changed while a background job may be mid-flight over the
      // OLD content (jobs snapshot their input when they start). Abort any
      // in-flight story/memory job so its guarded persist drops — the next
      // turn re-runs over current content. No-ops (0 rows) when nothing is in
      // flight.
      //
      // Scoped to messages a job could actually cover: a compaction window
      // always excludes the recent raw tail, and session memory's lag-one
      // invariant never covers the newest reply — so a change to the
      // session's NEWEST message (the regenerate/swipe target, by far the
      // most common change) cannot invalidate either job's input. Aborting
      // there anyway wasted a mid-flight multi-call compaction run on every
      // swipe (mykayumina churn, 2026-08). Unknown recency (missing
      // id/createdAt) stays conservative and aborts.
      if (await changedMessageIsNewest(ctx)) {
        // One exception to "the newest reply is never covered": a revert that
        // KEPT the accumulated memory can leave its processed pointer ON the
        // surviving tip (see invalidateForRevert). Swiping/editing that tip
        // then changes a reply the memory still describes, so stamp the
        // stale-confession — a no-op (0 rows) in the steady lag-one state.
        if (flags.id) {
          await db
            .update(playSessions)
            .set({ sessionMemoryStaleAt: new Date() })
            .where(and(
              eq(playSessions.id, ctx.sessionId),
              isNotNull(playSessions.sessionMemory),
              eq(playSessions.sessionMemoryProcessedMessageId, flags.id),
            ));
        }
        return;
      }
      await db
        .update(playSessions)
        .set({ summaryStatus: "idle", summarySourceHash: null, summaryClaimedAt: null })
        .where(and(eq(playSessions.id, ctx.sessionId), eq(playSessions.summaryStatus, "updating")));
      await db
        .update(playSessions)
        .set({ sessionMemoryStatus: "idle", sessionMemorySourceHash: null, sessionMemoryClaimedAt: null })
        .where(and(eq(playSessions.id, ctx.sessionId), eq(playSessions.sessionMemoryStatus, "updating")));
      // The changed message is OLDER than the newest reply, so session memory
      // may still describe its pre-edit content — and memory is deliberately
      // never wiped here (see the header comment). Stamp it stale so the
      // prompt block carries an explicit obsolete-content warning until a
      // full rebuild / manual save / clear replaces the text. Guarded on a
      // memory existing: one built entirely after this change isn't stale.
      // (Real case: a player edited an early "we're at the beach" message and
      // two regenerations kept returning to the beach — the stale memory kept
      // re-asserting the old location every turn, 2026-08-29 report.)
      await db
        .update(playSessions)
        .set({ sessionMemoryStaleAt: new Date() })
        .where(and(eq(playSessions.id, ctx.sessionId), isNotNull(playSessions.sessionMemory)));
    },
  };
}

async function getChangedMessageStoryCoverage(ctx: InvalidateContext): Promise<{
  coversUntilMessageId: string;
  sourceHash: string | null;
} | null> {
  const flags = ctx.messageFlags;
  if (!flags?.id || !flags.createdAt) return null;
  const [coverage] = await db
    .select({
      coversUntilMessageId: playSessions.summaryCoversUntilMessageId,
      sourceHash: playSessions.summarySourceHash,
      coversUntilCreatedAt: messages.createdAt,
    })
    .from(playSessions)
    .leftJoin(messages, eq(messages.id, playSessions.summaryCoversUntilMessageId))
    .where(eq(playSessions.id, ctx.sessionId))
    .limit(1);
  if (!coverage?.coversUntilMessageId) return null;
  const isCovered = coverage.coversUntilMessageId === flags.id
    || !!coverage.coversUntilCreatedAt
      && new Date(flags.createdAt).getTime() <= coverage.coversUntilCreatedAt.getTime();
  return isCovered
    ? { coversUntilMessageId: coverage.coversUntilMessageId, sourceHash: coverage.sourceHash }
    : null;
}

/** True when the changed message is the session's newest (nothing created
 *  after it). False on missing identity — callers treat that as "could be
 *  covered" and keep the conservative abort. */
async function changedMessageIsNewest(ctx: InvalidateContext): Promise<boolean> {
  const flags = ctx.messageFlags;
  if (!flags?.id || !flags.createdAt) return false;
  const [newer] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.sessionId, ctx.sessionId), gt(messages.createdAt, flags.createdAt)))
    .limit(1);
  return !newer;
}

/**
 * Rewind (revert) deletes the tail. One rule for all three memory tiers: keep
 * the stored output when it covers no deleted message, drop it only when it
 * does. A revert deletes a SUFFIX of the timeline, so a tier whose coverage
 * pointer / compaction flags all sit in the surviving prefix describes only
 * surviving turns. Mirrors branchSession's keep-when-valid rules so revert
 * and branch agree.
 *
 * History of this function, because both halves were real incidents:
 * - It first wiped ALL THREE tiers on every revert.
 * - Then the story summary alone kept the wipe ("a revert always makes the
 *   summary outdated; re-summarize iff still over the trigger"). On a long
 *   session that meant un-compacting 1,800 messages and re-summarizing the
 *   whole transcript after every rewind: ~150 LLM calls in 15 minutes, the
 *   daily compaction budget gone, and a blank "failed" summary for the rest of
 *   the day — while the player's hand-pasted summary got wiped by the next
 *   rewind too (hhltwz report, 2026-09-04). Now the summary follows the same
 *   keep-when-valid rule as the other tiers.
 * - Session memory used to be wiped whenever an update was mid-flight. But the
 *   in-flight job already moved the pointer to the turn it is folding, so a
 *   surviving pointer still proves the stored (older) memory holds no
 *   deleted-turn facts; only a deleted or null pointer forces the wipe.
 *
 * Needs ctx.session (tier pointers/status) + ctx.removedMessages (the deleted
 * tail's flags); when either is absent it degrades to a full wipe (the old
 * behavior), so non-revert callers are unaffected.
 */
function invalidateForRevert(ctx: InvalidateContext): ExtensionInvalidation {
  const s = ctx.session ?? {};
  // Without the session row AND the deleted-tail flags we can't prove any tier's
  // coverage survives ⇒ fall back to the old full wipe. (The revert route always
  // supplies both; this only guards stray callers.)
  const canDecide = ctx.session != null && ctx.removedMessages != null;
  const removed = ctx.removedMessages ?? [];
  const removedIds = new Set(removed.map((m) => m.id));

  // Story summary: kept only when we can PROVE it covers no deleted message —
  // a summary is stored, no removed message was compacted into it, and its
  // covers-until pointer exists and survives. A stored summary with no pointer
  // (legacy rows) can't be verified ⇒ dropped, the old behavior; no stored
  // summary ⇒ the reset is a harmless no-op that also un-flags any stray
  // compacted survivors. On every keep the job bookkeeping (status / source
  // hash / claim) is reset regardless of what the row read as: the route
  // reads the row BEFORE deleting the tail, so a compaction can claim it in
  // that window, and its persist guard checks exactly those fields. The
  // stored TEXT stays — it only describes surviving messages.
  const coversUntil = s.summaryCoversUntilMessageId as string | null | undefined;
  const keepStorySummary =
    canDecide &&
    s.summary != null &&
    coversUntil != null &&
    !removedIds.has(coversUntil) &&
    !removed.some((m) => m.compacted === true);

  // Layered Summary (summaryception): keep-when-valid on its own flag.
  const keepLayered =
    canDecide &&
    s.summaryceptionStatus !== "updating" &&
    !removed.some((m) => m.summaryceptionCompacted === true);

  // Session memory: rolling latest-state — valid iff the turn it last
  // processed still survives. Wiping it on almost every rewind destroyed the
  // whole accumulated memory (in steady state the pointer sits exactly lag-one
  // behind the tip, so any rewind either deleted it or made it the new tip)
  // and the eager rebuild only sees a bounded recent window — the "rollback
  // loses session memory" report (格鲁曼钢铁厂, 2026-09-01).
  //
  // The pointer MAY equal the surviving tip (rewind of exactly one exchange).
  // That temporarily bends the lag-one invariant — regenerating that tip
  // right after the revert can read its own facts back — accepted as far
  // cheaper than the wipe; a swipe/edit of a covered tip stamps the
  // stale-confession (see invalidateForChangedMessage), and the next
  // completed turn restores the steady lag-one state. Mid-flight updates are
  // fine too: the job set the pointer to the turn it is folding when it
  // started, so a surviving pointer proves the stored memory is valid, and if
  // that job completes its result describes a surviving turn as well. Only a
  // null pointer can't be verified ⇒ wipe, then eagerly rebuild from the
  // surviving transcript minus its last exchange.
  const procId = s.sessionMemoryProcessedMessageId as string | null | undefined;
  const keepSessionMemory =
    canDecide &&
    s.sessionMemory != null &&
    procId != null &&
    !removedIds.has(procId);

  return {
    sessionFields: {
      ...(keepStorySummary ? STORY_JOB_ABORT_FIELDS : STORY_SUMMARY_RESET_FIELDS),
      ...(keepLayered ? {} : resetSummaryceptionSessionFields()),
      ...(keepSessionMemory ? {} : SESSION_MEMORY_RESET_FIELDS),
    },
    runAfter: async () => {
      if (!keepStorySummary) {
        // Un-compact EVERY surviving message so the threshold test +
        // re-derivation see ALL of the surviving context (not just the part
        // after the old summary), and the messages re-enter raw history
        // meanwhile. Skipped when the summary is kept: its compacted messages
        // stay compacted and stay covered.
        await db.update(messages).set({ compacted: false }).where(eq(messages.sessionId, ctx.sessionId));
      }
      if (!keepLayered) {
        // Deletes snippets AND unmarks summaryceptionCompacted on every message.
        await clearSummaryceptionData(ctx.sessionId);
      }
      // Re-derive only the tiers that were dropped, from the surviving
      // transcript now. The story summary's re-derivation is a threshold-mode
      // recompaction — re-summarize iff the surviving context is still over
      // the user's trigger limit, otherwise stay empty.
      if (ctx.userId && ctx.session) {
        regenerateDroppedMemoryTiers({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          session: ctx.session as SessionMemorySystemRow,
          keptSessionMemory: keepSessionMemory,
          regenerateStorySummary: !keepStorySummary,
        });
      }
    },
  };
}

function invalidate(ctx: InvalidateContext): ExtensionInvalidation {
  // Always stop queued background work first — every original site led with
  // the discards, before any row update.
  discardQueuedStoryCompactions(ctx.sessionId);
  discardQueuedSessionMemoryUpdates(ctx.sessionId);

  switch (ctx.reason) {
    case "message-edited":
    case "message-deleted":
    case "message-swiped":
      return invalidateForChangedMessage(ctx);
    case "character-creation":
      return {
        sessionFields: {
          ...STORY_SUMMARY_RESET_FIELDS,
          summaryBudgetWindowStartedAt: new Date(),
          summaryBudgetResumePending: false,
          ...resetSummaryceptionSessionFields(),
          ...SESSION_MEMORY_RESET_FIELDS,
        },
        runAfter: () => clearSummaryceptionData(ctx.sessionId),
      };
    case "session-revert":
      // Coverage-aware: keep each tier whose stored output covers no deleted
      // message (see invalidateForRevert). Restart below stays a full wipe.
      return invalidateForRevert(ctx);
    case "session-restart":
      return {
        sessionFields: {
          ...STORY_SUMMARY_RESET_FIELDS,
          summaryBudgetWindowStartedAt: new Date(),
          summaryBudgetResumePending: false,
          ...resetSummaryceptionSessionFields(),
          ...SESSION_MEMORY_RESET_FIELDS,
        },
        runAfter: async () => {
          await db.update(messages).set({ compacted: false }).where(eq(messages.sessionId, ctx.sessionId));
          // Snippets describing the deleted tail must not survive —
          // summaryception has no range-scoped invalidation, so clear it whole
          // (mirrors the unconditional story-summary clear above).
          await clearSummaryceptionData(ctx.sessionId);
        },
      };
    case "checkpoint-restore":
      // Checkpoints capture the story summary, so the ROUTE restores those
      // fields itself. Checkpoints don't capture summaryception snippets or
      // structured session memory, so the restored timeline must drop both
      // (compacted flags on messages are restored from the checkpoint data).
      return {
        sessionFields: {
          ...resetSummaryceptionSessionFields(),
          ...SESSION_MEMORY_RESET_FIELDS,
        },
        runAfter: () => clearSummaryceptionData(ctx.sessionId),
      };
  }
}

export function registerSessionMemoryExtension(): void {
  registerExtensionHooks(SESSION_MEMORY_EXTENSION_KEY, {
    resolveCapabilities: ({ session }) => {
      const settings = getMemorySystemSettings(session as SessionMemorySystemRow);
      const caps: string[] = [];
      if (settings.sessionMemoryIncluded) caps.push("session-memory");
      if (settings.localdevSummaryIncluded) caps.push("story-summary");
      if (settings.summaryceptionIncluded) caps.push("summaryception");
      return caps;
    },

    contributePromptBlocks: async (ctx) => [
      // Canonical order (matches the pre-registry injection): story summary,
      // then summaryception, then session memory — all right before history.
      {
        id: "story-summary",
        priority: 10,
        content: ctx.freshStart || !ctx.capabilities.has("story-summary")
          ? null
          : formatStorySummaryForPrompt(ctx.session.summary),
      },
      {
        id: "summaryception",
        priority: 20,
        content: ctx.freshStart || !ctx.capabilities.has("summaryception")
          ? null
          : await getSummaryceptionPromptBlock(ctx.sessionId),
      },
      {
        // Durable per-session facts — deliberately NOT freshStart-suppressed,
        // matching the original inline behavior exactly. Player-pinned notes
        // ride along whenever present, even with the auto memory switched off:
        // they are the player's own standing instructions, not derived state.
        id: "session-memory",
        priority: 30,
        content: (() => {
          const autoMemoryOn = ctx.capabilities.has("session-memory");
          const pinned = typeof ctx.session.sessionMemoryPinned === "string" ? ctx.session.sessionMemoryPinned : null;
          if (!autoMemoryOn && !pinned) return null;
          return formatSessionMemoryForPrompt(autoMemoryOn ? ctx.session.sessionMemory : null, {
            staleSinceEdit: autoMemoryOn && ctx.session.sessionMemoryStaleAt != null,
            pinned,
          });
        })(),
      },
    ],

    filterHistory: (ctx) => {
      const conditions = [];
      if (ctx.capabilities.has("story-summary")) conditions.push(eq(messages.compacted, false));
      if (ctx.capabilities.has("summaryception")) conditions.push(eq(messages.summaryceptionCompacted, false));
      return conditions;
    },

    onPromptOverflow: async (ctx) => {
      // Deliberately fire-and-forget: the send path must NEVER wait on LLM
      // summarization. A permanently failing summary (e.g. the summary model
      // refusing the content) once re-ran a full-backlog compaction inside
      // every send, holding the response past Cloudflare's 100s origin limit
      // (the 2026-07-11 524 incident). This turn's prompt simply trims
      // (buildMessageHistory); the scheduled job repairs the summary for the
      // NEXT turn, reusing the background chain's dedupe and
      // consecutive-failure budget.
      if (ctx.capabilities.has("summaryception")) {
        scheduleSummaryceptionCompaction({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          fallbackModel: ctx.model,
          contextTokenLimit: ctx.maxContext,
          finalPromptRawTokenLimit: ctx.finalPromptRawTokenLimit,
        });
      }
      if (ctx.capabilities.has("story-summary")) {
        scheduleStoryCompaction({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          fallbackModel: ctx.model,
          contextTokenLimit: ctx.maxContext,
          finalPromptRawTokenLimit: ctx.finalPromptRawTokenLimit,
        });
      }
    },

    onTurnComplete: (ctx) => {
      if (ctx.capabilities.has("session-memory")) {
        scheduleSessionMemoryIncrementalUpdate({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          userMessage: ctx.userMessage,
          assistantMessage: ctx.assistantMessage,
          state: ctx.state,
          fallbackModel: ctx.fallbackModel,
          assistantMessageId: ctx.assistantMessageId,
        });
      }
      if (ctx.capabilities.has("story-summary")) {
        scheduleStoryCompaction({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          fallbackModel: ctx.fallbackModel,
          contextTokenLimit: ctx.contextTokenLimit,
        });
      }
    },

    invalidate,
  });
}
