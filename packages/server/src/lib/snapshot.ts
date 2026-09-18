/** Storage shaping for per-message game-state snapshots.
 *
 *  Every assistant turn persists a full GameState snapshot onto the message row
 *  (and onto each swipe) so revert / branch / swipe-restore can rewind to that
 *  exact point. Two of those snapshot fields were unboundedly expensive in prod:
 *
 *  1. `metadata.lastCharMessage` / `lastMessage` / `lastUserMessage` — full copies
 *     of message TEXT, duplicated into every snapshot (lastCharMessage alone was
 *     ~1.27 GB across the messages table). These are macro context that
 *     populateMacroContext rebuilds from history on every turn, so they never
 *     need to be persisted. `lastUserMessageAt` / `model` are tiny but likewise
 *     re-derived, so we drop them too for consistency.
 *
 *  2. Snapshots accumulate one-per-turn forever. We cap them: only the most
 *     recent SNAPSHOT_RETENTION messages per session keep their snapshot; older
 *     ones get their `state_snapshot` nulled (the message ROW stays — only the
 *     rewind point is dropped).
 *
 *  Everything else in `metadata` (personaName/personaImage/persona*, activeAudio,
 *  pendingContext, …) is real state the restore paths and the client depend on,
 *  so it MUST survive — only the keys below are stripped. Verified via a
 *  cross-package consumer trace (2026-06-04): the kept fields are read from the
 *  persisted snapshot by sandbox cards (useYumina().user), BGM resume, and the
 *  @ai.context queue; the stripped fields are always rebuilt before any read. */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/** Metadata keys re-derived every turn by populateMacroContext — safe to drop
 *  from anything we persist. Order doesn't matter. */
export const EPHEMERAL_METADATA_KEYS = [
  "lastMessage",
  "lastCharMessage",
  "lastUserMessage",
  "lastUserMessageAt",
  "model",
] as const;

/** Number of most-recent messages per session that keep their state snapshot. */
export const SNAPSHOT_RETENTION = 50;

/** Return a copy of a game-state snapshot with the ephemeral macro fields
 *  stripped from `metadata`. The input is left untouched (the live session.state
 *  written elsewhere keeps the full metadata). Returns the original reference
 *  when there's nothing to strip, so callers can use it unconditionally. */
export function thinSnapshotForStorage<T extends Record<string, unknown>>(snapshot: T): T {
  const meta = (snapshot as { metadata?: unknown }).metadata;
  if (!meta || typeof meta !== "object") return snapshot;

  let strippedMeta: Record<string, unknown> | null = null;
  for (const key of EPHEMERAL_METADATA_KEYS) {
    if (key in (meta as Record<string, unknown>)) {
      if (!strippedMeta) strippedMeta = { ...(meta as Record<string, unknown>) };
      delete strippedMeta[key];
    }
  }
  if (!strippedMeta) return snapshot;
  return { ...snapshot, metadata: strippedMeta };
}

/** Drop stored state beyond the most recent SNAPSHOT_RETENTION snapshots in a
 *  single session: null the message-level state_snapshot AND strip the
 *  per-swipe stateSnapshot (the swipe's text content is kept). Reverting or
 *  swiping to a message past the window is safe — revert falls back to the live
 *  session state and swipe-restore skips the state write when the snapshot is
 *  gone (neither zeroes variables).
 *
 *  Per-session scoped, so branches (separate sessions) each keep their own
 *  window. The window counts snapshot-bearing messages (only assistant turns
 *  carry one), so it retains the most recent ~50 rewind points. Idempotent and
 *  cheap; safe to fire-and-forget after an assistant turn is persisted. */
// The prune rewrites every over-window message's swipes JSONB (a detoast +
// re-toast of the largest rows in the database). Running it after EVERY turn
// was 1.5M statements and 331M block reads in six weeks for a window that
// moves by one row per turn — pruning every 5th turn per session keeps the
// retention promise (≤ keep+4 snapshots) at a fifth of the write amplification.
const PRUNE_EVERY_N_TURNS = 5;
const PRUNE_COUNTER_MAX = 20_000;
const pruneTurnCounter = new Map<string, number>();

export async function pruneSessionSnapshots(
  sessionId: string,
  keep = SNAPSHOT_RETENTION,
): Promise<void> {
  const seen = (pruneTurnCounter.get(sessionId) ?? 0) + 1;
  if (pruneTurnCounter.size >= PRUNE_COUNTER_MAX && !pruneTurnCounter.has(sessionId)) {
    pruneTurnCounter.clear();
  }
  pruneTurnCounter.set(sessionId, seen);
  if (seen % PRUNE_EVERY_N_TURNS !== 1) return;
  await db.execute(sql`
    UPDATE messages m
    SET state_snapshot = NULL,
        swipes = CASE
          WHEN jsonb_typeof(m.swipes) = 'array' THEN (
            SELECT COALESCE(jsonb_agg(elem - 'stateSnapshot' - 'generationState' ORDER BY ord), '[]'::jsonb)
            FROM jsonb_array_elements(m.swipes) WITH ORDINALITY AS arr(elem, ord)
          )
          ELSE m.swipes
        END
    WHERE m.id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY session_id ORDER BY created_at DESC, id DESC
        ) AS rn
        FROM messages
        WHERE session_id = ${sessionId} AND state_snapshot IS NOT NULL
      ) ranked
      WHERE ranked.rn > ${keep}
    )
  `);
}
