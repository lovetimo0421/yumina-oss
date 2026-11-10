import { and, count, desc, eq, gte, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds, worldSnapshots } from "../db/schema.js";

/**
 * Guard rails for AIs that are not ours (lib/world-ops.ts via the card MCP):
 * a way back from what they change, and caps on what they can spend or
 * create on the creator's behalf.
 */

/** Studio keeps 50 snapshots per card (routes/agent.ts does the same). */
const SNAPSHOTS_KEPT = 50;
/** One snapshot per outside AI per card per this long: one "before" per task. */
const SNAPSHOT_WINDOW_MS = 15 * 60_000;

/**
 * Before an outside AI's write: the card as it was, in the editor's change
 * history (改动记录), labelled with who is about to change it — unless that AI
 * already left one for this card in the last few minutes, so a task of many
 * small writes is undone in one step.
 */
export async function snapshotBeforeOutsideWrite(args: {
  worldId: string;
  userId: string;
  actor: string;
  schema: Record<string, unknown>;
}): Promise<void> {
  const label = `Before: ${args.actor}`.slice(0, 200);
  const since = new Date(Date.now() - SNAPSHOT_WINDOW_MS);
  const [recent] = await db.select({ id: worldSnapshots.id }).from(worldSnapshots)
    .where(and(eq(worldSnapshots.worldId, args.worldId), like(worldSnapshots.label, `${label}%`), gte(worldSnapshots.createdAt, since)))
    .limit(1);
  if (recent) return;
  await db.insert(worldSnapshots).values({ worldId: args.worldId, userId: args.userId, schemaData: args.schema, label });
  const extra = await db.select({ id: worldSnapshots.id }).from(worldSnapshots)
    .where(eq(worldSnapshots.worldId, args.worldId))
    .orderBy(desc(worldSnapshots.createdAt))
    .offset(SNAPSHOTS_KEPT);
  for (const row of extra) await db.delete(worldSnapshots).where(eq(worldSnapshots.id, row.id));
}

/** Cards an outside AI may start for one creator per day. */
export const CARDS_PER_DAY = 20;

export async function canCreateCard(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [row] = await db.select({ n: count() }).from(worlds)
    .where(and(eq(worlds.creatorId, userId), gte(worlds.createdAt, since)));
  return (row?.n ?? 0) < CARDS_PER_DAY;
}

/**
 * Playtest turns an outside AI may spend per creator per hour. A turn costs
 * what the creator's own turn costs; an agent stuck in a loop must not burn
 * the balance. Counted per server instance — a ceiling, not an invoice.
 */
export const PLAYTEST_TURNS_PER_HOUR = 30;
const playtestTurns = new Map<string, number[]>();

/** How many of `wanted` turns this creator may still play this hour. */
export function takePlaytestTurns(userId: string, wanted: number): number {
  const now = Date.now();
  const recent = (playtestTurns.get(userId) ?? []).filter((t) => now - t < 3600_000);
  const allowed = Math.max(0, Math.min(wanted, PLAYTEST_TURNS_PER_HOUR - recent.length));
  for (let i = 0; i < allowed; i++) recent.push(now);
  playtestTurns.set(userId, recent);
  return allowed;
}
