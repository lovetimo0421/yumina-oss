import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { usageLogs } from "../db/schema.js";
import { captureServerError } from "./posthog.js";
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
  // Official correction charges commit atomically with the saved turn.
  "state-update-guard": "billed",
  "studio-agent": "billed",
  "studio-playtest": "billed",
  "side-completion": "billed",
  "pvz-dave": "billed",
  // Failed, cancelled and silent Dave generations are not heard by the player.
  "pvz-dave-unheard": "free-by-design",
  "story-compaction": "billed",
  "session-memory": "billed",
  summaryception: "billed",
  // Runs exclusively on the caller's own API key (see memory-extractor.ts).
  "memory-extract": "byok-only",
  // Community-content translation: the result is cached and served to every
  // viewer, so charging the one user who happened to trigger it would bill
  // them for shared infrastructure. Platform cost, owner-reviewed 2026-08-12.
  translation: "free-by-design",
  // Image/video prompt preparation has no separate token charge: generation.ts
  // runs it before the existing fixed-price job debit, and failed/blocked
  // preparation is never charged. Register that existing product policy so
  // these internal calls stay observable without inventing a second charge.
  "generation-enhance": "free-by-design",
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
}
