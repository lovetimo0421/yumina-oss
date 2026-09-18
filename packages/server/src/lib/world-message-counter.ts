import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { redis } from "./redis.js";
import { runExclusive } from "./leader.js";

/**
 * Batched world message counters (hot-row fix, 2026-07-06).
 *
 * Every message send/regen used to run
 *   UPDATE worlds SET message_count = message_count + 1 WHERE id = $1 OR ...
 * immediately. On a popular world, every concurrent player's turn serializes
 * on that ONE row's lock — a convoy measured at 339 slow updates/week that
 * also stretched neighboring transactions.
 *
 * Now bumps accumulate in a Redis hash (HINCRBY, no locks, sub-ms) and a
 * leader-elected flusher applies one UPDATE per world every 30s. The counter
 * is an eventually-consistent popularity display, so 30s of lag is invisible.
 *
 * Durability: pending counts live in Redis, so they survive deploys/restarts
 * of the app fleet (the next leader flushes them). A Redis restart loses at
 * most the unflushed window — acceptable for a display counter. If Redis is
 * unavailable the bump falls back to the original direct UPDATE.
 */

const HASH_KEY = "wmc:pending";
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_LOCK_TTL_S = 25;

function directBump(worldId: string, n: number): void {
  db.execute(sql`
    UPDATE worlds SET message_count = message_count + ${n}
    WHERE id = ${worldId}
       OR id = (SELECT source_world_id FROM worlds WHERE id = ${worldId} AND source_world_id IS NOT NULL)
  `).catch(() => {});
}

/** Fire-and-forget bump — never throws, never blocks the send path. */
export function bumpWorldMessageCount(worldId: string): void {
  if (!redis) {
    directBump(worldId, 1);
    return;
  }
  redis.hincrby(HASH_KEY, worldId, 1).catch(() => directBump(worldId, 1));
}

/**
 * Apply pending bumps. Decrements (not deletes) each field after applying so
 * bumps that arrive mid-flush are never lost; a failed UPDATE leaves the
 * count in the hash for the next cycle. The variant→source aggregation
 * semantics of the original per-message UPDATE are preserved per world.
 */
export async function flushWorldMessageCounts(): Promise<void> {
  if (!redis) return;
  let pending: Record<string, string>;
  try {
    pending = await redis.hgetall(HASH_KEY);
  } catch {
    return; // Redis blip — nothing to do, counts are safe where they are
  }
  for (const [worldId, raw] of Object.entries(pending)) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    try {
      await db.execute(sql`
        UPDATE worlds SET message_count = message_count + ${n}
        WHERE id = ${worldId}
           OR id = (SELECT source_world_id FROM worlds WHERE id = ${worldId} AND source_world_id IS NOT NULL)
      `);
      await redis.hincrby(HASH_KEY, worldId, -n);
    } catch (err) {
      console.error(`[WMC] flush failed for world ${worldId}:`, err instanceof Error ? err.message : err);
      // leave the count in the hash — retried next cycle
    }
  }
}

let flushHandle: ReturnType<typeof setInterval> | null = null;

export function startWorldMessageCountFlusher(): void {
  if (flushHandle || !redis) return;
  flushHandle = setInterval(() => {
    void runExclusive("wmc-flush", FLUSH_LOCK_TTL_S, flushWorldMessageCounts);
  }, FLUSH_INTERVAL_MS);
  flushHandle.unref();
}

export function stopWorldMessageCountFlusher(): void {
  if (flushHandle) {
    clearInterval(flushHandle);
    flushHandle = null;
  }
}
