import Redis from "ioredis";
import { env } from "./env.js";
import { captureServerError } from "./posthog.js";

/**
 * Shared Redis client for rate limiting, caching, and pub/sub.
 * null in dev when REDIS_URL is not set — callers fall back to in-memory.
 */
export const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: true,
      keepAlive: 10_000,           // TCP keepalive every 10s — prevents idle disconnects across regions
      connectTimeout: 5_000,
      commandTimeout: 3_000,       // Don't let a single Redis call block for more than 3s
      // Fail commands IMMEDIATELY while disconnected instead of queueing them.
      // Queued commands stall callers for the full reconnect window; instant
      // failure lets rate limiting fail over to in-memory counters in
      // milliseconds (see middleware/rate-limit.ts) and caches fall through to
      // the DB, so a Redis blip degrades the site instead of freezing it.
      enableOfflineQueue: false,
    })
  : null;

/**
 * Dedicated Redis client for pub/sub subscriptions.
 * ioredis requires a separate connection for subscribe mode.
 */
export const redisSub = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: true,
      keepAlive: 10_000,
      connectTimeout: 5_000,
    })
  : null;

/**
 * Connect Redis clients (call at server startup). A configured-but-unreachable
 * Redis must NOT prevent boot: ioredis keeps retrying in the background per
 * its retryStrategy, and every consumer (rate limits, caches) degrades
 * gracefully while disconnected. We log loudly + capture so the degraded
 * start is impossible to miss.
 */
export async function connectRedis(): Promise<void> {
  if (redis) {
    try {
      await redis.connect();
      console.log("Redis connected (main)");
    } catch (err) {
      console.error(
        "[STARTUP] ⚠️ REDIS_URL is set but Redis is unreachable — rate limits degrade to per-instance memory, caches fall through to DB:",
        err instanceof Error ? err.message : err,
      );
      captureServerError("redis-startup-unreachable", err, { client: "main" });
    }
  }
  if (redisSub) {
    try {
      await redisSub.connect();
      console.log("Redis connected (subscriber)");
    } catch (err) {
      console.error("[STARTUP] ⚠️ Redis subscriber unreachable — pub/sub notifications degraded:", err instanceof Error ? err.message : err);
      captureServerError("redis-startup-unreachable", err, { client: "sub" });
    }
  }
}

/** Graceful shutdown for Redis clients. */
export async function disconnectRedis(): Promise<void> {
  await redis?.quit().catch(() => {});
  await redisSub?.quit().catch(() => {});
}
