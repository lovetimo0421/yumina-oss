import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import type { FailureCode } from "./turn-failure-codes.js";

export {
  FAILURE_CODE,
  classifyGenerationFailure,
  type FailureCode,
  type ClassifiedFailure,
} from "./turn-failure-codes.js";

/**
 * Why this exists (2026-07-30 investigation):
 *
 * When a generation failed, NOTHING was written to the database. The user row
 * was already persisted (its insert runs before the stream opens), the
 * assistant row was skipped, and `messages.status` / `messages.error_message`
 * — both in the schema since day one — were never written by any code path.
 * Across ~200k messages / 7 days, prod had 100% `status='complete'` and 100%
 * `error_message IS NULL`.
 *
 * Two consequences, both bad:
 *   - The player saw silence. Not "generation failed, tap retry" — nothing.
 *     The observed reaction was to mash send (one user submitted the same
 *     message 15 times in 57s) or restart the story (7 sessions across 5
 *     worlds in 2 hours, zero replies received).
 *   - We were blind. Failure rate could only be reconstructed by hunting for
 *     "orphaned" user messages (a user row whose next in-session row is not an
 *     assistant row), which is not a query anyone runs on a dashboard.
 *
 * The fix marks the USER message rather than inserting a synthetic assistant
 * row. That choice is deliberate: a fake assistant row would be picked up by
 * the history builders (`buildRawHistoryWhere` in routes/messages.ts) and fed
 * back to the model as a real assistant turn, corrupting the conversation. The
 * user message is already legitimately part of history and stays there on retry.
 */

/**
 * Mark the user message whose generation failed, so the client can render a
 * retry affordance and so failure rate becomes a plain SQL question.
 *
 * Never throws. This runs while a stream is already unwinding — often after
 * the client is gone, sometimes during a deploy drain. A failed bookkeeping
 * write must not become a second failure stacked on the one being recorded.
 */
export async function markTurnFailed(
  userMessageId: string | null | undefined,
  errorMessage: string,
  code: FailureCode | null = null,
): Promise<void> {
  if (!userMessageId) return;
  try {
    await db
      .update(messages)
      .set({
        status: "failed",
        // Prefix the code so a dashboard can group failures without re-parsing
        // prose that upstream providers change without notice.
        errorMessage: code ? `[${code}] ${errorMessage}` : errorMessage,
      })
      .where(eq(messages.id, userMessageId));
  } catch (err) {
    console.error(
      "[TurnFailure] Could not mark turn failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Clear a previous failure once a turn finally succeeds.
 *
 * Needed because the same user row is reused across retries — the mix-mode
 * retry path in routes/messages.ts deliberately reuses a dangling user row
 * instead of inserting a duplicate. Without this, a message that failed once
 * and then succeeded would keep its retry button forever.
 */
export async function clearTurnFailure(
  userMessageId: string | null | undefined,
): Promise<void> {
  if (!userMessageId) return;
  try {
    await db
      .update(messages)
      .set({ status: "complete", errorMessage: null })
      .where(eq(messages.id, userMessageId));
  } catch (err) {
    console.error(
      "[TurnFailure] Could not clear turn failure:",
      err instanceof Error ? err.message : err,
    );
  }
}
