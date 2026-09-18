import { redis } from "./redis.js";
import type { SessionUser } from "./types.js";

/**
 * Short-lived cache of the SessionUser row the auth middleware attaches to
 * every authenticated request.
 *
 * Why it exists: that lookup ran ~4.2M times a day on the primary (177M calls
 * in six weeks per pg_stat_statements). Each is trivial to execute but costs a
 * pooled connection round trip on every request — and under load it queued
 * behind heavier statements like everything else.
 *
 * Why it is safe where the 2026-03 full-payload cache was not: the TTL is 60s
 * (not 5 min) AND every write path that changes a cached field invalidates the
 * key explicitly — ban/suspend/unban, skipReview, tier (invite codes), profile
 * edits, account deletion, and Better Auth's own user updates via its
 * databaseHooks. Fields NOT in SessionUser (preferences, stripe ids, playtime)
 * never touch the cache. Redis unavailable → straight to the database.
 */
const KEY = (userId: string) => `su:v1:${userId}`;
export const SESSION_USER_CACHE_TTL_S = 60;

type Wire = Omit<SessionUser, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string };

export async function readCachedSessionUser(userId: string): Promise<SessionUser | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(KEY(userId));
    if (!raw) return null;
    const wire = JSON.parse(raw) as Wire;
    if (!wire || typeof wire.id !== "string" || wire.id !== userId) return null;
    return {
      ...wire,
      createdAt: new Date(wire.createdAt),
      updatedAt: new Date(wire.updatedAt),
    } as SessionUser;
  } catch {
    return null;
  }
}

export function writeCachedSessionUser(user: SessionUser): void {
  if (!redis) return;
  redis.set(KEY(user.id), JSON.stringify(user), "EX", SESSION_USER_CACHE_TTL_S).catch(() => {});
}

/** Call after ANY write that changes a SessionUser field. Never throws. */
export async function invalidateSessionUser(userId: string): Promise<void> {
  if (!redis || !userId) return;
  try {
    await redis.del(KEY(userId));
  } catch {
    // The 60s TTL bounds staleness if Redis is unreachable right now.
  }
}
