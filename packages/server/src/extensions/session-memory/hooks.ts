// The session-memory-summary extension's server hooks — the reference
// implementation of the extension hook registry. Every handler delegates to
// the existing lib functions; this file is the relocation of the call sites
// that used to live inline in routes/messages.ts and routes/sessions.ts, not
// a rewrite of the systems themselves.

import { and, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { estimateTokens } from "@yumina/engine";
import { isRecapShare, recapBudgetTokens, resolveMemoryEvery, SESSION_MEMORY_EXTENSION_KEY, type RecapShare } from "@yumina/shared";
import { db } from "../../db/index.js";
import { playSessions, messages } from "../../db/schema.js";
import {
  getMemorySystemSettings,
  type SessionMemorySystemRow,
} from "../../lib/memory-systems-core.js";
import {
  discardQueuedSessionMemoryUpdates,
  formatSessionMemoryForPrompt,
  hasIneligibleSessionMemorySource,
  regenerateSessionMemoryForSession,
  scheduleSessionMemoryIncrementalUpdate,
  scheduleSessionMemoryRepair,
} from "../../lib/session-memory.js";
import { hasUncertainMemoryCoverage } from "../../lib/session-memory-core.js";
import { dropMemoryVersions, dropMemoryVersionsFrom } from "../../lib/session-memory-versions.js";
import {
  DEFAULT_STORY_SUMMARY_MODEL,
  discardQueuedStoryCompactions,
  formatStorySummaryForPrompt,
  recompactStorySummaryAfterRevert,
  scheduleStoryCompaction,
} from "../../lib/session-compaction.js";
import { isExtensionInstalled } from "../../lib/extensions.js";
import { env } from "../../lib/env.js";
import {
  clearSummaryceptionData,
  loadRecapPromptBlock,
  markRecapChangedMessage,
  resetSummaryceptionSessionFields,
  scheduleSummaryceptionCompaction,
  trimRecapAfterRewind,
} from "../../lib/summaryception.js";
import {
  registerExtensionHooks,
  type ExtensionInvalidation,
  type InvalidateContext,
  type TurnRecapInputs,
} from "../../lib/extension-hooks.js";

/** Room left for the next turn before a default summary folds. Two turns of a
 *  typical long roleplay (a turn adds ~840 tokens at the median, ~1,080 at
 *  the 75th percentile, prod 2026-10): a fold started now has finished well
 *  before the next send (median 36 s against a median 140 s between turns). */
const FOLD_AHEAD_TOKENS = 2_000;

type RecapRunArgs = Parameters<typeof scheduleSummaryceptionCompaction>[0];
/**
 * Recap runs a prompt asked for, held until its reply is saved. They used to
 * start while the prompt was built, before the model answered, so a send that
 * failed still ran the recap: 27 and 14 calls on one player's own relay for
 * two sends that got no reply (2026-11-08). A send that never completes
 * leaves its entry for the next one; a stale entry is dropped.
 */
const pendingRecapRuns = new Map<string, { args: RecapRunArgs; at: number }>();
const PENDING_RECAP_TTL_MS = 30 * 60_000;

function holdRecapRun(args: RecapRunArgs, replace: boolean): void {
  if (!replace && pendingRecapRuns.has(args.sessionId)) return;
  pendingRecapRuns.set(args.sessionId, { args, at: Date.now() });
}

function takeRecapRun(sessionId: string): RecapRunArgs | null {
  const now = Date.now();
  for (const [id, entry] of pendingRecapRuns) if (now - entry.at > PENDING_RECAP_TTL_MS) pendingRecapRuns.delete(id);
  const entry = pendingRecapRuns.get(sessionId);
  pendingRecapRuns.delete(sessionId);
  return entry?.args ?? null;
}

/** The recap share a turn runs with once the recap is active for it: the
 *  player's choice, else standard (shared/src/recap.ts resolveRecapShare). */
function turnRecapShare(recap: TurnRecapInputs | undefined): RecapShare {
  return isRecapShare(recap?.chosenShare) ? recap.chosenShare : "standard";
}

/** Largest the recap may grow this turn; null when story memory is unknown. */
function turnRecapBudget(recap: TurnRecapInputs | undefined): number | null {
  if (!recap?.storyMemory) return null;
  return recapBudgetTokens(recap.storyMemory, turnRecapShare(recap)) || null;
}

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
        void regenerateSessionMemoryForSession({ sessionId: args.sessionId, userId: args.userId, automatic: true }).catch((err) =>
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
 * fact. Stale memory is excluded from prompts until a full rebuild succeeds. Under the lag-one
 * invariant memory never covers the newest visible reply anyway, so
 * swiping/regenerating/editing that reply needs no memory invalidation —
 * edits to OLDER turns hide derived memory and queue a full rebuild.
 */
function invalidateForChangedMessage(ctx: InvalidateContext): ExtensionInvalidation {
  const flags = ctx.messageFlags ?? {};
  const invalidateStory = flags.compacted === true;
  const invalidateSummaryception = flags.summaryceptionCompacted === true;
  return {
    sessionFields: {
      ...(invalidateStory ? STORY_SUMMARY_RESET_FIELDS : {}),
    },
    runAfter: async () => {
      // Saved memory versions that cover the changed turn describe text that
      // is gone; a rebuild continues from the newest one before it.
      await dropMemoryVersionsFrom(ctx.sessionId, flags.createdAt);
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
            rawCoverage.coversUntilMessageId === null
              ? isNull(playSessions.summaryCoversUntilMessageId)
              : eq(playSessions.summaryCoversUntilMessageId, rawCoverage.coversUntilMessageId),
            rawCoverage.sourceHash === null
              ? isNull(playSessions.summarySourceHash)
              : eq(playSessions.summarySourceHash, rawCoverage.sourceHash),
          ))
          .returning()
        : [];
      if (invalidateStory || rawCoverageReset.length > 0) {
        await db.update(messages).set({ compacted: false }).where(eq(messages.sessionId, ctx.sessionId));
      }
      // The recap keeps every chapter but the one covering this message,
      // which is revised on the recap's next run (one call).
      if (invalidateSummaryception) {
        if (flags.id) {
          await markRecapChangedMessage(ctx.sessionId, {
            id: flags.id,
            createdAt: flags.createdAt,
            deleted: ctx.reason === "message-deleted",
          });
        } else {
          await db.update(playSessions).set(resetSummaryceptionSessionFields()).where(eq(playSessions.id, ctx.sessionId));
          await clearSummaryceptionData(ctx.sessionId);
        }
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
            .set({ sessionMemoryStaleAt: staleSince(flags.createdAt) })
            .where(and(
              eq(playSessions.id, ctx.sessionId),
              isNotNull(playSessions.sessionMemory),
              eq(playSessions.sessionMemoryProcessedMessageId, flags.id),
            ));
          await scheduleSessionMemoryRepair(ctx.sessionId);
        }
        return;
      }
      // Read before the abort below clears an in-flight job's hash.
      const memoryMayCoverChange = await sessionMemoryMayCoverChange(ctx);
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
      // prompt omits derived facts until a full rebuild / manual save / clear
      // replaces the text. Queue the rebuild below. Guarded on a
      // memory existing: one built entirely after this change isn't stale.
      // (Real case: a player edited an early "we're at the beach" message and
      // two regenerations kept returning to the beach — the stale memory kept
      // re-asserting the old location every turn, 2026-08-29 report.)
      // A change after the memory's committed pointer is not in the memory.
      if (memoryMayCoverChange) {
        await db
          .update(playSessions)
          .set({ sessionMemoryStaleAt: staleSince(flags.createdAt) })
          .where(and(eq(playSessions.id, ctx.sessionId), isNotNull(playSessions.sessionMemory)));
      }
      await db.update(playSessions)
        .set({ summaryceptionStatus: "idle", summaryceptionSourceHash: null })
        .where(and(eq(playSessions.id, ctx.sessionId), eq(playSessions.summaryceptionStatus, "updating")));
      await scheduleSessionMemoryRepair(ctx.sessionId);
    },
  };
}

/**
 * The stale stamp records WHERE the memory went stale: the earliest changed
 * turn's time, so an automatic repair can revise the memory from that turn
 * instead of re-reading the whole chat (session-memory.ts turnBeforeChange).
 * A stamp later than the turn the memory covers through records when an
 * older edit happened instead, which locates nothing: it stays as it is, so
 * a later, nearer change never hides the earlier one it cannot see. An
 * unknown time stamps the start of the chat.
 */
function staleSince(changedAt: Date | string | null | undefined) {
  // Stored timestamps are naive UTC; pass the instant as UTC wall time.
  const at = (changedAt ? new Date(changedAt) : new Date(0)).toISOString().replace("T", " ").replace("Z", "");
  return sql<Date>`CASE
    WHEN ${playSessions.sessionMemoryStaleAt} IS NULL THEN ${at}::timestamp
    WHEN ${playSessions.sessionMemoryStaleAt} > coalesce((SELECT m.created_at FROM messages m WHERE m.id = ${playSessions.sessionMemoryProcessedMessageId}), '-infinity'::timestamp)
      THEN ${playSessions.sessionMemoryStaleAt}
    ELSE LEAST(${playSessions.sessionMemoryStaleAt}, ${at}::timestamp) END`;
}

async function getChangedMessageStoryCoverage(ctx: InvalidateContext): Promise<{
  coversUntilMessageId: string | null;
  sourceHash: string | null;
} | null> {
  const flags = ctx.messageFlags;
  if (!flags?.id || !flags.createdAt) return null;
  const [coverage] = await db
    .select({
      coversUntilMessageId: playSessions.summaryCoversUntilMessageId,
      sourceHash: playSessions.summarySourceHash,
      summary: playSessions.summary,
      coversUntilCreatedAt: messages.createdAt,
    })
    .from(playSessions)
    .leftJoin(messages, eq(messages.id, playSessions.summaryCoversUntilMessageId))
    .where(eq(playSessions.id, ctx.sessionId))
    .limit(1);
  if (!coverage) return null;
  // Older saved summaries have no coverage pointer. An edit cannot certify
  // them; keeping one would feed the edited-away fact into the memory rebuild.
  if (!coverage.coversUntilMessageId) return coverage.summary?.trim()
    ? { coversUntilMessageId: null, sourceHash: coverage.sourceHash } : null;
  const isCovered = coverage.coversUntilMessageId === flags.id
    || !!coverage.coversUntilCreatedAt
      && new Date(flags.createdAt).getTime() <= coverage.coversUntilCreatedAt.getTime();
  return isCovered
    ? { coversUntilMessageId: coverage.coversUntilMessageId, sourceHash: coverage.sourceHash }
    : null;
}

/** Session memory holds only turns up to its committed processed pointer. A
 *  change strictly after it (typically the player's own last message, or a
 *  reply the batched updater hasn't folded yet) is read fresh when the updater
 *  gets there, so stamping it stale only forced a full-history rebuild — one
 *  call per ~60k characters, 180+ on long sessions. A message edit preceded
 *  346 rebuilds (3,384 calls) in 3 days (2026-10-16..18). Any doubt
 *  (no/deleted pointer, unknown recency, repair or legacy coverage) answers
 *  true. createdAt arrives at millisecond precision, which only errs toward
 *  "covered". */
async function sessionMemoryMayCoverChange(ctx: InvalidateContext): Promise<boolean> {
  const flags = ctx.messageFlags;
  if (!flags?.id || !flags.createdAt) return true;
  const [row] = await db
    .select({
      pointer: playSessions.sessionMemoryProcessedMessageId,
      sessionMemoryStatus: playSessions.sessionMemoryStatus,
      sessionMemorySourceHash: playSessions.sessionMemorySourceHash,
    })
    .from(playSessions)
    .where(eq(playSessions.id, ctx.sessionId))
    .limit(1);
  if (!row?.pointer || hasUncertainMemoryCoverage(row)) return true;
  const [pointerIsOlder] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.sessionId, ctx.sessionId),
      eq(messages.id, row.pointer),
      or(
        lt(messages.createdAt, flags.createdAt),
        and(eq(messages.createdAt, flags.createdAt), lt(messages.id, flags.id)),
      ),
    ))
    .limit(1);
  return !pointerIsOlder;
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

  // The recap: chapters that cover no deleted message are kept; only those
  // that did are dropped (trimRecapAfterRewind). Without the deleted-tail
  // flags it cannot tell, and clears like before.
  const trimLayered = canDecide && removed.some((m) => m.summaryceptionCompacted === true);
  const keepLayered = canDecide;

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
      // Kept or trimmed, an in-flight recap run read the deleted messages.
      ...(keepLayered ? { summaryceptionStatus: "idle" as const, summaryceptionSourceHash: null } : resetSummaryceptionSessionFields()),
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
      } else if (trimLayered) {
        await trimRecapAfterRewind(ctx.sessionId);
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
          // The rolling story summary is no longer read by any turn (the
          // layered recap replaced it), so a rewind never pays to rebuild it.
          regenerateStorySummary: false,
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
        runAfter: async () => {
          await clearSummaryceptionData(ctx.sessionId);
          await dropMemoryVersions(ctx.sessionId);
        },
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
          await dropMemoryVersions(ctx.sessionId);
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
        runAfter: async () => {
          await clearSummaryceptionData(ctx.sessionId);
          await dropMemoryVersions(ctx.sessionId);
        },
      };
  }
}

export function registerSessionMemoryExtension(): void {
  registerExtensionHooks(SESSION_MEMORY_EXTENSION_KEY, {
    // The recap is on for everyone who never installed this extension
    // (owner 2026-10-30), unless they chose "off" in AI settings. A size
    // chosen there ("chosen") outranks an old uninstall; unchosen, the
    // uninstall still opts out. Such a run is the recap alone — the facts
    // list stays the player's own choice.
    activeByDefault: ({ recap }) => {
      if (isRecapShare(recap?.chosenShare)) return recap.chosenShare === "off" ? false : "chosen";
      return true;
    },
    // One recap: the layered one. The rolling story summary scored 8% against
    // the layered recap's 51% on the same questions (2026-10-30), so a session
    // that had either switched on now gets the layered recap, and an old
    // rolling summary is carried over as its first chapter (seedLegacyRecap).
    // "off" in the player's AI settings switches it off everywhere.
    resolveCapabilities: ({ session, defaultActivated, recap }) => {
      const recapOff = turnRecapShare(recap) === "off";
      if (defaultActivated) return recapOff ? [] : ["summaryception"];
      const settings = getMemorySystemSettings(session as SessionMemorySystemRow);
      const caps: string[] = [];
      if (settings.sessionMemoryIncluded) caps.push("session-memory");
      if (!recapOff && (settings.localdevSummaryIncluded || settings.summaryceptionIncluded)) caps.push("summaryception");
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
          : await (async () => {
            const recap = await loadRecapPromptBlock(ctx.sessionId, ctx.session);
            // An edited chapter is revised after this reply, not at the next fold.
            if (recap.needsRevision) {
              holdRecapRun({
                sessionId: ctx.sessionId,
                userId: ctx.ownerUserId,
                fallbackModel: DEFAULT_STORY_SUMMARY_MODEL,
                finalPromptRawTokenLimit: Number.MAX_SAFE_INTEGER,
              }, false);
            }
            return recap.content;
          })(),
      },
      {
        // Durable per-session facts — deliberately NOT freshStart-suppressed,
        // matching the original inline behavior exactly. The player's pinned
        // notes are no longer part of this block: they are a core block of
        // their own (lib/turn-memory.ts), sent with or without this extension.
        id: "session-memory",
        priority: 30,
        content: await (async () => {
          if (!ctx.capabilities.has("session-memory")) return null;
          return formatSessionMemoryForPrompt(ctx.session.sessionMemory, {
            staleSinceEdit: ctx.session.sessionMemoryStaleAt != null
              || await hasIneligibleSessionMemorySource(ctx.sessionId, ctx.session),
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
      // consecutive-failure budget. It starts once this turn's reply is saved
      // (onTurnComplete), never for a send that fails.
      if (ctx.capabilities.has("summaryception")) {
        holdRecapRun({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          fallbackModel: ctx.model,
          contextTokenLimit: ctx.maxContext,
          finalPromptRawTokenLimit: ctx.finalPromptRawTokenLimit,
          foldAll: true,
          recapBudgetTokens: turnRecapBudget(ctx.recap),
          storyMemoryTokens: ctx.recap?.storyMemory ?? null,
        }, true);
      }
      if (ctx.capabilities.has("story-summary")) {
        scheduleStoryCompaction({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          fallbackModel: ctx.model,
          contextTokenLimit: ctx.maxContext,
          finalPromptRawTokenLimit: ctx.finalPromptRawTokenLimit,
          authorRequired: ctx.defaultActivated === true,
          // Every automatic first summary recaps only what a prompt could
          // carry — installed or default-on alike. A cleared summary on a
          // 400-message branch otherwise re-summarised all of it in the
          // background (23 calls, a free player's whole balance, 2026-10-30);
          // a full rebuild stays one deliberate press away (force).
          recapWithinTokens: ctx.maxContext,
        });
      }
    },

    onTurnComplete: (ctx) => {
      // The recap folds ahead, like the default summary below: once the next
      // turn would overflow story memory, it folds the older half now, so
      // the shorter history and the new chapters reach the next prompt
      // together and the prompt cache breaks once per fold, not every turn.
      // A run this turn's prompt asked for (overflow, an edited chapter)
      // starts now that the reply is saved. A fold-ahead covers it: it folds
      // further back and revises edited chapters first.
      const held = takeRecapRun(ctx.sessionId);
      if (ctx.capabilities.has("summaryception")) {
        const raw = ctx.rawHistory;
        if (raw && raw.tokens + estimateTokens(ctx.assistantMessage, ctx.fallbackModel) + FOLD_AHEAD_TOKENS > raw.budget) {
          scheduleSummaryceptionCompaction({
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            fallbackModel: ctx.fallbackModel,
            contextTokenLimit: ctx.contextTokenLimit,
            finalPromptRawTokenLimit: Math.max(1, Math.floor(raw.budget / 2)),
            foldAll: true,
            recapBudgetTokens: turnRecapBudget(ctx.recap),
            storyMemoryTokens: ctx.recap?.storyMemory ?? null,
          });
        } else if (held) {
          scheduleSummaryceptionCompaction(held);
        }
      }
      if (ctx.capabilities.has("session-memory")) {
        scheduleSessionMemoryIncrementalUpdate({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          userMessage: ctx.userMessage,
          assistantMessage: ctx.assistantMessage,
          state: ctx.state,
          fallbackModel: ctx.fallbackModel,
          assistantMessageId: ctx.assistantMessageId,
          memoryEvery: resolveMemoryEvery(ctx.recap?.memoryEvery),
        });
      }
      // A summary nobody installed folds against the story memory, not the
      // threshold pass's own schedule: once the next turn would overflow, it
      // folds the older half now, so the shorter history and the new summary
      // reach the next prompt together and the cache breaks once. Folding
      // only at the overflow trimmed one turn and changed the summary the
      // next, breaking it twice. The summary covering the cut lets the step
      // be half the budget, not the third a bare trim keeps.
      const overflowOnly = ctx.defaultActivated === true && env.STORY_SUMMARY_DEFAULT_ON;
      if (ctx.capabilities.has("story-summary") && overflowOnly) {
        const raw = ctx.rawHistory;
        if (raw && raw.tokens + estimateTokens(ctx.assistantMessage, ctx.fallbackModel) + FOLD_AHEAD_TOKENS > raw.budget) {
          scheduleStoryCompaction({
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            fallbackModel: ctx.fallbackModel,
            contextTokenLimit: ctx.contextTokenLimit,
            finalPromptRawTokenLimit: Math.max(1, Math.floor(raw.budget / 2)),
            foldAtTokens: raw.budget - FOLD_AHEAD_TOKENS,
            recapWithinTokens: ctx.contextTokenLimit,
            authorRequired: true,
          });
        }
      } else if (ctx.capabilities.has("story-summary")) {
        scheduleStoryCompaction({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          fallbackModel: ctx.fallbackModel,
          contextTokenLimit: ctx.contextTokenLimit,
          authorRequired: ctx.defaultActivated === true,
          recapWithinTokens: ctx.contextTokenLimit,
        });
      }
    },

    invalidate,
  });
}
