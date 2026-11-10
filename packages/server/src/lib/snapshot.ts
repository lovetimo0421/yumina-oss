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
 *     rewind point is dropped), except a sparse checkpoint every
 *     SNAPSHOT_CHECKPOINT_EVERY assistant turns. Revert/branch to a turn between
 *     checkpoints replays the few recorded changes forward (rewindState).
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

/** Beyond the retention window, every Nth assistant turn of a session (counted
 *  from its opening, turn 0) keeps its snapshot as a rewind checkpoint. */
export const SNAPSHOT_CHECKPOINT_EVERY = 10;

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

/** One message on the way to a rewind target, oldest first. `stateChanges` is
 *  the ledger of the message's ACTIVE swipe (see activeStateChanges). */
export interface RewindTurn {
  role: string;
  stateSnapshot?: Record<string, unknown> | null;
  stateChanges?: unknown;
}

/** The change ledger a message's stored state reflects: its active swipe's,
 *  falling back to the row's own (which swipe switching keeps in sync). */
export function activeStateChanges(message: {
  stateChanges?: unknown;
  swipes?: ReadonlyArray<{ stateChanges?: unknown }> | null;
  activeSwipeIndex?: number | null;
}): unknown {
  return message.swipes?.[message.activeSwipeIndex ?? 0]?.stateChanges ?? message.stateChanges;
}

/** Game state at the end of `turns` (a session's messages up to and including
 *  the rewind target): the newest stored snapshot, rolled forward through the
 *  `newValue`s recorded by the assistant turns after it. Only variables move —
 *  ruleState and metadata stay the snapshot's; turnCount advances one per
 *  replayed reply. Writes the ledger never recorded (card UI patches) are not
 *  recovered, which is why replay stays within one checkpoint gap. Returns null
 *  when no snapshot survives at or before the target. */
export function rewindState(turns: ReadonlyArray<RewindTurn>): Record<string, unknown> | null {
  let base = turns.length - 1;
  while (base >= 0 && !turns[base]!.stateSnapshot) base--;
  if (base < 0) return null;
  const state = structuredClone(turns[base]!.stateSnapshot!);
  const variables = (state.variables && typeof state.variables === "object"
    ? state.variables : {}) as Record<string, unknown>;
  state.variables = variables;
  for (const turn of turns.slice(base + 1)) {
    if (turn.role !== "assistant") continue;
    if (typeof state.turnCount === "number") state.turnCount += 1;
    if (!Array.isArray(turn.stateChanges)) continue;
    // In order: a variable may have changed several times in one turn.
    for (const change of turn.stateChanges as Array<{ variableId?: unknown; newValue?: unknown } | null>) {
      if (change && typeof change.variableId === "string" && change.newValue !== undefined) {
        variables[change.variableId] = structuredClone(change.newValue);
      }
    }
  }
  return state;
}

/** Drop stored state beyond the most recent SNAPSHOT_RETENTION snapshots in a
 *  single session: null the message-level state_snapshot AND strip the
 *  per-swipe stateSnapshot (the swipe's text content is kept). Every
 *  SNAPSHOT_CHECKPOINT_EVERY-th assistant turn is a checkpoint instead: it keeps
 *  its message-level snapshot (the active swipe's state) and loses only the
 *  per-swipe copies. Revert/branch past the window rewinds from the nearest
 *  checkpoint (rewindState); with none left it keeps the live session state and
 *  says so. Swipe-restore skips the state write when the snapshot is gone. None
 *  of them zeroes variables.
 *
 *  Checkpoints are stable: a row's turn number counts the assistant turns
 *  before it, so appending never moves it and a tail revert never moves an
 *  earlier one. Only a single-message delete shifts later turn numbers; a row
 *  already kept as a checkpoint (snapshot kept, swipes stripped) is never nulled
 *  afterwards, so spacing may then drift (under 10, or up to ~20).
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
  await pruneSessionSnapshotsNow(sessionId, keep);
}

/** The prune itself, without the every-5th-turn gate (tests call it directly).
 *  One pass over the session's rows ranks snapshots by recency and numbers the
 *  assistant turns without reading any JSONB. Only rows whose swipes still carry
 *  state are rewritten, so a row is written once, when it leaves the window. An
 *  older checkpoint is recognised by the pruned replies after it and is not
 *  read again; an off-grid row reads its swipes so a checkpoint shifted by a
 *  deleted message (snapshot kept, swipes already stripped) stays kept. */
export async function pruneSessionSnapshotsNow(
  sessionId: string,
  keep = SNAPSHOT_RETENTION,
  every = SNAPSHOT_CHECKPOINT_EVERY,
): Promise<void> {
  await db.execute(sql`
    WITH ranked AS (
      SELECT id,
        state_snapshot IS NOT NULL AS has_snapshot,
        role = 'assistant'
          AND (COUNT(*) FILTER (WHERE role = 'assistant') OVER forward - 1) % ${every} = 0 AS checkpoint,
        COUNT(*) FILTER (WHERE state_snapshot IS NOT NULL) OVER backward AS recency,
        COUNT(*) FILTER (WHERE role = 'assistant' AND state_snapshot IS NULL) OVER backward AS newer_pruned
      FROM messages
      WHERE session_id = ${sessionId}
      WINDOW forward AS (ORDER BY created_at, id), backward AS (ORDER BY created_at DESC, id DESC)
    )
    UPDATE messages m
    SET state_snapshot = CASE WHEN r.checkpoint THEN m.state_snapshot ELSE NULL END,
        swipes = CASE
          WHEN jsonb_typeof(m.swipes) = 'array' THEN (
            SELECT COALESCE(jsonb_agg(elem - 'stateSnapshot' - 'generationState' ORDER BY ord), '[]'::jsonb)
            FROM jsonb_array_elements(m.swipes) WITH ORDINALITY AS arr(elem, ord)
          )
          ELSE m.swipes
        END
    FROM ranked r
    WHERE m.id = r.id AND r.has_snapshot AND r.recency > ${keep} AND CASE
      WHEN r.checkpoint AND r.newer_pruned > 0 THEN false
      WHEN r.checkpoint THEN COALESCE(jsonb_path_exists(m.swipes,
        '$[*] ? (exists(@.stateSnapshot) || exists(@.generationState))'), false)
      ELSE NOT COALESCE(jsonb_typeof(m.swipes) = 'array' AND m.swipes <> '[]'::jsonb
        AND NOT jsonb_path_exists(m.swipes, '$[*] ? (exists(@.stateSnapshot) || exists(@.generationState))'), false)
    END
  `);
}
