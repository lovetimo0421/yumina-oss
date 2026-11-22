import { sql } from "drizzle-orm";
import {
  applyWorldChanges,
  diffWorld,
  isWorldChangeList,
  mergeWorldDefinition,
  migrateWorldDefinition,
  normalizeFolders,
  WORLD_ROW_COLLECTIONS,
  type WorldDefinition,
  type WorldEdit,
} from "@yumina/engine";
import { db } from "../db/index.js";

type Executor = Pick<typeof db, "execute">;
type Json = Record<string, unknown>;

/**
 * Note on a restore point what one write after it changed by itself: the
 * difference between the card that write started from and the card it
 * wrote, before any merge with other people's saves. Rolling back undoes
 * exactly these and nothing else. Run it in the write's own transaction —
 * a write saved without its record would be skipped by a rollback — so a
 * failure here fails the write instead of being swallowed.
 */
export async function recordSnapshotEdits(
  snapshotId: string | null | undefined,
  before: WorldDefinition | Json,
  after: WorldDefinition | Json,
  executor: Executor = db,
): Promise<void> {
  if (!snapshotId) return;
  const edits = diffWorld(
    migrateWorldDefinition(before as unknown as WorldDefinition),
    migrateWorldDefinition(after as unknown as WorldDefinition),
  );
  if (edits.length === 0) return;
  await executor.execute(sql`
    UPDATE world_snapshots SET edits = COALESCE(edits, '[]'::jsonb) || ${JSON.stringify(edits)}::jsonb
    WHERE id = ${snapshotId}`);
}

export interface SelectiveRevert {
  schema: Json;
  /** Places someone changed again after these steps; their version was kept. */
  kept: Array<{ collection: string; id: string }>;
}

/**
 * Undo the recorded steps from a restore point on, and only them. `before`
 * is the card at the restore point; `steps` are the change sets the steps
 * after it made, in order; `current` is the card now. Anything a step
 * touched that someone changed again later keeps the later change (and is
 * reported); everything else anyone did meanwhile is left alone.
 */
export function revertRecordedSteps(before: Json, steps: unknown[][], current: Json): SelectiveRevert | null {
  const edits: WorldEdit[] = [];
  for (const step of steps) {
    if (!isWorldChangeList(step)) return null;
    edits.push(...step);
  }
  const start = migrateWorldDefinition(before as unknown as WorldDefinition);
  const afterSteps = applyWorldChanges(start, edits);
  const now = migrateWorldDefinition(current as unknown as WorldDefinition);
  // Three-way, with the steps' result as the ancestor: what the steps changed
  // (ancestor vs `start`) goes back; what anyone changed since (ancestor vs
  // `now`) stays, and wins where both happened.
  const { merged, conflicts } = mergeWorldDefinition(afterSteps, now, start);
  const mergedJson = merged as unknown as Json;
  for (const key of WORLD_ROW_COLLECTIONS) {
    const rows = keepOrder(mergedJson[key], start[key as keyof WorldDefinition], afterSteps[key as keyof WorldDefinition], now[key as keyof WorldDefinition]);
    if (rows) mergedJson[key] = rows;
  }
  const world = normalizeFolders(merged).world;
  return {
    schema: world as unknown as Json,
    kept: conflicts.map((c) => ({ collection: c.collection, id: c.id })),
  };
}

const idsOf = (value: unknown): string[] | null => Array.isArray(value)
  && value.every((r) => r && typeof r === "object" && typeof (r as Json).id === "string")
  ? (value as Json[]).map((r) => r.id as string) : null;

/**
 * The order a rolled-back collection keeps. The card as it is now decides —
 * rows others added meanwhile stay where they put them — unless nobody
 * reordered since the steps, in which case the order from before the steps
 * comes back (undoing a reorder the steps made). Rows the rollback brings
 * back sit behind their old neighbour. Null leaves the merge's order.
 */
function keepOrder(merged: unknown, start: unknown, afterSteps: unknown, now: unknown): Json[] | null {
  const mergedIds = idsOf(merged);
  const startIds = idsOf(start) ?? [];
  const afterIds = idsOf(afterSteps) ?? [];
  const nowIds = idsOf(now) ?? [];
  if (!mergedIds) return null;
  const present = new Set(mergedIds);
  const inNow = new Set(nowIds);
  const shared = new Set(afterIds.filter((id) => inNow.has(id)));
  const sameOrder = (ids: string[]) => ids.filter((id) => shared.has(id));
  const nowShared = sameOrder(nowIds);
  const reorderedSince = sameOrder(afterIds).some((id, i) => id !== nowShared[i]);
  const order = (reorderedSince ? nowIds : startIds).filter((id) => present.has(id));
  const placed = new Set(order);
  for (const id of mergedIds) {
    if (placed.has(id)) continue;
    const source = inNow.has(id) ? nowIds : startIds;
    let at = 0;
    for (let i = source.indexOf(id) - 1; i >= 0; i--) {
      const j = order.indexOf(source[i]!);
      if (j >= 0) { at = j + 1; break; }
    }
    order.splice(at, 0, id);
    placed.add(id);
  }
  const byId = new Map((merged as Json[]).map((r) => [r.id as string, r]));
  return order.map((id) => byId.get(id)!);
}
