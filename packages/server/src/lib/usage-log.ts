import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { usageLogs } from "../db/schema.js";
import { captureServerError } from "./posthog.js";
import { touchLastActive } from "./last-active.js";

/** The turns the daily and weekly quests count (lib/quests.ts questProgress). */
const QUEST_TURN_ENDPOINTS = new Set(["send", "regenerate", "continue"]);
import type { LedgerDatabase } from "./transaction-hash.js";

type UsageLogInsert = typeof usageLogs.$inferInsert;

/**
 * Billing policy registry — EVERY endpoint that reaches recordUsageLog must
 * be declared here with an explicit decision on who pays for the tokens.
 *
 * This is the tripwire against "the compaction ran free for months" (found
 * 2026-08-12: story-compaction/session-memory/summaryception burned ~594M
 * platform-key prompt tokens in 11 days with zero mushie deductions, because
 * billing was simply never wired). recordUsageLog is the single funnel every
 * LLM spend passes through, so an endpoint missing from this registry means
 * someone added a new LLM call path without deciding how it's paid for —
 * that now alarms loudly (console + PostHog) instead of silently running
 * free. lib/billing-coverage.test.ts statically enforces the same contract.
 *
 * Policies:
 *  - "billed":          official-key calls deduct mushies via deductCredits
 *                       (BYOK exempt; documented exemptions like empty replies
 *                       are part of the endpoint's billed policy).
 *  - "free-by-design":  deliberately unbilled platform cost. Requires an
 *                       owner-approved reason in the comment.
 *  - "byok-only":       the call can only ever run on the user's own key, so
 *                       there is nothing to bill.
 */
export const USAGE_ENDPOINT_BILLING_POLICY: Record<string, "billed" | "free-by-design" | "byok-only"> = {
  send: "billed",
  // Music generation (Lyria through OpenRouter): one charge per piece,
  // taken from the provider-reported cost in routes/music.ts.
  music: "billed",
  // Scene video (routes/realtime-video.ts): Comfy GPU seconds per clip, the director's
  // calls and fal stream seconds, each charged at provider cost × FILM_MARKUP.
  "film-clip": "billed",
  "film-director": "billed",
  "film-stream": "billed",
  regenerate: "billed",
  continue: "billed",
  // Empty replies are never charged (2026-05-31 empty-reply policy) — logged
  // under distinct endpoints purely for failure-rate monitoring.
  send_empty: "free-by-design",
  regenerate_empty: "free-by-design",
  continue_empty: "free-by-design",
  // Kimi repetition-loop replies are discarded before persistence and never
  // charged. Keep distinct endpoints so quality regressions remain measurable.
  send_repetitive: "free-by-design",
  regenerate_repetitive: "free-by-design",
  continue_repetitive: "free-by-design",
  // Historical resolver attempts remain platform-funded after its removal.
  // No gameplay route emits this endpoint anymore.
  "turn-state-resolver": "free-by-design",
  // Official corrections are charged atomically with the saved turn. Failed,
  // stale, cancelled, BYOK, free-model and unlimited-plan calls are exempt.
  "state-update-guard": "billed",
  // State Update Guard on by platform default (player never installed it):
  // the one correction runs on the default guard model with the platform key
  // and is never charged. Owner-approved 2026-09-26; kill switch
  // STATE_UPDATE_GUARD_DEFAULT=off.
  "state-update-guard-default": "free-by-design",
  "studio-agent": "billed",
  "studio-playtest": "billed",
  "source-digest": "billed",
  "side-completion": "billed",
  // Same existing side-call billing; distinguish silent output so it does not
  // become a successful play interaction in analytics.
  "side-completion_empty": "billed",
  "pvz-dave": "billed",
  // Failed, cancelled and silent Dave generations are not heard by the player.
  "pvz-dave-unheard": "free-by-design",
  "story-compaction": "billed",
  "session-memory": "billed",
  summaryception: "billed",
  // Run scopes (副本): the sealed-run memory summary and a worker station's
  // briefing. Both go through generateStorySummaryText, i.e. story
  // compaction's metering: official-key calls with usable text are charged
  // via billBackgroundUsage at the model's normal price, BYOK and unlimited
  // plans are not, empty output is logged but not charged.
  "run-summary": "billed",
  "module-worker": "billed",
  // Runs exclusively on the caller's own API key (see memory-extractor.ts).
  "memory-extract": "byok-only",
  // Continuity judge: one decision-model call per reply, platform key, output
  // tokens free, ~1e-4 USD per turn. Not charged to the player — it is part
  // of the card working as authored. Owner-approved 2026-09-21.
  continuity: "free-by-design",
  // Missed-update repair (continuity/missed-updates.ts): the platform model writes
  // only the state the story model forgot, when the decision model flags it.
  // Platform key, not charged — owner-approved 2026-10-05 ("Jev must also write
  // what the model left out").
  "missed-update-repair": "free-by-design",
  // Choice-only card direction, owner-approved 2026-10-04; capped at 20 calls
  // per minute/account and 32k chars. Actual BYOK use is logged as tier byok.
  "side-decision": "free-by-design",
  // Per-turn pictures' tagging calls (platform key). The player pays a flat
  // price per delivered picture (per-turn-image/billing.ts), which covers
  // these tokens; logged so the spend stays visible per user.
  "turn-image-tagging": "free-by-design",
  // Community-content translation: the result is cached and served to every
  // viewer, so charging the one user who happened to trigger it would bill
  // them for shared infrastructure. Platform cost, owner-reviewed 2026-08-12.
  translation: "free-by-design",
  // Preserve the existing generation policy: prompt rewriting runs before
  // generation billing and adds no user charge, including refused/failed
  // rewrites. Owner-authorized usage visibility fix, 2026-09-08.
  "generation-enhance": "free-by-design",
  // Voice readout (TTS). Priced per UTF-8 byte of input text; cost is computed
  // locally (byteLength × per-byte price) and deducted via providerCostUsd —
  // cache hits (same text+voice replayed) never reach recordUsageLog at all.
  tts: "billed",
  // Hold-to-talk transcription: free to every player by owner decision
  // (2026-09-28), always on the platform key; ~$0.002 per minute of speech,
  // bounded by the per-user clip rate limit in routes/voice-input.ts.
  "voice-input": "free-by-design",
  // Owner-authorized private Hat candidate test, 2026-10-06: exact creator/world
  // gate, two durable starts per rolling24h, server300s deadline. No public grant.
  "voice-pilot": "free-by-design",
  "voice-pilot-transcription": "free-by-design",
  // Zero-token durable start/cleanup reservation; never presented as measured AI.
  "voice-pilot-reservation": "free-by-design",
  // Jev emotion cues for voice readout: platform-funded, never charged. The
  // readout itself bills the player on the text alone (see routes/tts.ts).
  "tts-emotion": "free-by-design",
  // Jev casting (who says each line, which voice a new speaker gets):
  // platform-funded, like the emotion cues it runs alongside.
  "tts-cast": "free-by-design",
};

/**
 * Persist a usage-log row durably: await + one retry, alert on double failure.
 *
 * Usage rows are billing-reconciliation and abuse-investigation ground truth.
 * They were previously inserted fire-and-forget across ~14 sites, so a brief
 * DB hiccup silently dropped them. Callers run at generation completion (the
 * user already has their reply), so the ~10ms await costs nothing perceptible.
 *
 * The id is pinned before the first attempt so the retry is idempotent via
 * onConflictDoNothing — if the first insert landed but its ack was lost, the
 * retry no-ops instead of duplicating the row.
 */
/**
 * A generation can outlive its session: the user deletes the chat while the
 * stream is still running, and the completion-time insert then references a
 * playSessions row that no longer exists (the FK's onDelete: "set null" only
 * rewrites rows that existed at delete time). The tokens were still consumed,
 * so keep the log and drop the dangling reference instead of losing the row.
 */
function isSessionFkViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = err; e && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("usage_logs_session_id_play_sessions_id_fk")) return true;
  }
  return false;
}

export async function recordUsageLog(row: UsageLogInsert, options?: {database?: LedgerDatabase; strict?: boolean}): Promise<void> {
  const database = options?.database ?? db;
  const values = { ...row, id: row.id ?? randomUUID() };
  // Any AI request is activity for the admin Users lookup (throttled, never awaited).
  touchLastActive(values.userId);
  if (!(values.endpoint in USAGE_ENDPOINT_BILLING_POLICY)) {
    // New LLM spend path without a billing decision — alarm, don't block.
    // The log row still lands so the spend stays visible for reconciliation.
    console.error(
      `[UsageLog] UNREGISTERED endpoint "${values.endpoint}" — no billing policy declared. ` +
        "Add it to USAGE_ENDPOINT_BILLING_POLICY (usage-log.ts) and wire billing or document why it is free.",
    );
    captureServerError("usage-endpoint-unregistered", new Error(`unregistered endpoint: ${values.endpoint}`), {
      userId: values.userId,
      model: values.model,
      endpoint: values.endpoint,
    });
  }
  try {
    await database.insert(usageLogs).values(values);
  } catch (firstErr) {
    try {
      const retryValues = isSessionFkViolation(firstErr)
        ? { ...values, sessionId: null }
        : values;
      await database.insert(usageLogs).values(retryValues).onConflictDoNothing();
    } catch (retryErr) {
      console.error(
        "[UsageLog] Insert failed after retry:",
        retryErr instanceof Error ? retryErr.message : retryErr,
      );
      captureServerError("usage-log-write-failed", retryErr, {
        userId: values.userId,
        model: values.model,
        endpoint: values.endpoint,
      });
      // Atomic billing callers roll back the debit if its usage record cannot
      // be stored. Legacy callers retain the non-throwing retry/alert contract.
      if (options?.strict) throw retryErr;
    }
  }
  // A finished turn can finish a quest; the collector looks a few seconds later.
  if (QUEST_TURN_ENDPOINTS.has(values.endpoint) && (values.completionTokens ?? 0) > 0) {
    // The collector imports the hosted edition, which mounts routes that use
    // this writer. Load it after module initialization to avoid a router cycle.
    // Capture the event time now so crossing a reward reset cannot move it.
    const at = new Date();
    void import("./quest-auto-collect.js")
      .then(({ scheduleQuestCollect }) => scheduleQuestCollect(values.userId, at))
      .catch((error) => captureServerError("quest-collect-schedule-failed", error, { userId: values.userId }));
  }
}
