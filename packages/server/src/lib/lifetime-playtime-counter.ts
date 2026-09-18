import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
import { redis } from "./redis.js";
import { runExclusive } from "./leader.js";
import { drainLifetimePlaytime, enqueueLifetimePlaytime, LIFETIME_PLAYTIME_PENDING_DDL } from "./lifetime-playtime-sql.js";

/**
 * Batched lifetime-playtime accrual (same pattern as world-message-counter.ts).
 *
 * Every playtime tick used to run `UPDATE "user" SET lifetime_playtime_seconds
 * += Δ` inside the tick's transaction — 20.3M updates on the most-read table in
 * the database over six weeks (pg_stat_statements, 2026-09-07), each one a row
 * lock on the same row the auth middleware reads, plus WAL. The value is a
 * profile display ("total time played"), so 30s of lag is invisible.
 *
 * Seconds now accumulate durably in playtime_lifetime_pending in the SAME
 * transaction as the session tick. The flusher credits accounts and removes
 * pending increments atomically, preserving batching without Redis data loss.
 * The old Redis hash is drained during rolling deployment compatibility only.
 */
const HASH_KEY = "lpt:pending";
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_LOCK_TTL_S = 25;

export async function ensureLifetimePlaytimePending(): Promise<void> {
  await db.execute(sql.raw(LIFETIME_PLAYTIME_PENDING_DDL));
}

/** Compatibility for standalone game activity. Chat ticks enqueue inside
 * their session transaction so both counters commit together. */
export function bumpLifetimePlaytime(userId: string, seconds: number): void {
  if (!Number.isFinite(seconds) || Math.trunc(seconds) <= 0) return;
  db.execute(enqueueLifetimePlaytime(userId, Math.trunc(seconds)))
    .catch(error => console.error("[LPT] standalone activity enqueue failed:", error));
}

/** Atomically apply durable increments, then drain the legacy Redis queue. */
export async function flushLifetimePlaytime(): Promise<void> {
  // Row locks make overlapping workers safe even without Redis. Bound each
  // run while allowing a large active population to drain more than one batch.
  for (let batch = 0; batch < 10; batch++) {
    const result = await db.execute(drainLifetimePlaytime());
    if (result.rows.length < 500) break;
  }
  // Legacy pending seconds may still arrive from an old replica during rollout.
  if (!redis) return;
  let pending: Record<string, string>;
  try {
    pending = await redis.hgetall(HASH_KEY);
  } catch {
    return;
  }
  for (const [userId, raw] of Object.entries(pending)) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    try {
      await db
        .update(user)
        .set({ lifetimePlaytimeSeconds: sql`${user.lifetimePlaytimeSeconds} + ${n}` })
        .where(eq(user.id, userId));
      await redis.hincrby(HASH_KEY, userId, -n);
    } catch (err) {
      console.error(`[LPT] flush failed for user ${userId}:`, err instanceof Error ? err.message : err);
    }
  }
}

let flushHandle: ReturnType<typeof setInterval> | null = null;

export function startLifetimePlaytimeFlusher(): void {
  if (flushHandle) return;
  flushHandle = setInterval(() => {
    void runExclusive("lpt-flush", FLUSH_LOCK_TTL_S, flushLifetimePlaytime)
      .catch(error => console.error("[LPT] durable flush failed; pending seconds retained:", error));
  }, FLUSH_INTERVAL_MS);
  flushHandle.unref();
}

export function stopLifetimePlaytimeFlusher(): void {
  if (flushHandle) {
    clearInterval(flushHandle);
    flushHandle = null;
  }
}
