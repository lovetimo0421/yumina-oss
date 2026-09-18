import type { Context, MiddlewareHandler, Next } from "hono";
import { RATE_LIMITS, TRUSTED_PUBLISHING_RATE_LIMIT, type RateLimitTier, type RateLimitConfig } from "@yumina/shared";
import { redis } from "../lib/redis.js";
import { posthog, captureServerError } from "../lib/posthog.js";

// ─── Configuration ──────────────────────────────────────────────────

const DEFAULT_MAX_PER_MINUTE = 6;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 10;
/** Safety TTL for concurrency slots — auto-release if releaseConcurrency is never called */
const CONCURRENCY_TTL_S = 90;

// ─── In-memory fallback (dev / no Redis / Redis runtime failure) ────

const memTimestamps = new Map<string, number[]>();
/** In-memory concurrency: tracks count + timestamp of last acquire for TTL eviction */
const memInflight = new Map<string, { count: number; lastAcquire: number; ttlSeconds: number }>();

// ─── Redis runtime failover ─────────────────────────────────────────
// A Redis blip must DEGRADE rate limiting, not block traffic: before this,
// a down Redis meant every rate-limited request (including message sends)
// stalled on the command timeout and then failed closed — a sitewide outage
// mode. On any Redis error we now fall over to the per-instance in-memory
// counters with HALVED limits (each instance counts independently; halving
// roughly restores the intended global ceiling across 2-3 instances), and
// alert loudly so the degradation is visible the moment it starts.

let lastFallbackAlertAt = 0;
function alertRedisFallback(op: string, err: unknown): void {
  console.error(
    `[RateLimit] Redis ${op} failed — in-memory fallback engaged:`,
    err instanceof Error ? err.message : err,
  );
  const now = Date.now();
  if (now - lastFallbackAlertAt < 30_000) return; // throttle alert events during an incident
  lastFallbackAlertAt = now;
  captureServerError("redis-rate-limit-fallback", err, { op });
  posthog.capture({ distinctId: "server", event: "redis_rate_limit_fallback", properties: { op } });
}

/** Halved-but-never-zero limit for the per-instance fallback counters. */
function fallbackMax(max: number): number {
  return Math.max(1, Math.floor(max / 2));
}

function memSlidingWindowCheck(
  key: string,
  max: number,
  windowMs: number,
): { error: string; code: string; retryAfter: number } | null {
  const now = Date.now();
  const timestamps = memTimestamps.get(key) ?? [];
  const recent = timestamps.filter((t) => now - t < windowMs);

  if (recent.length >= max) {
    const retryAfter = Math.ceil((windowMs - (now - recent[0]!)) / 1000);
    return {
      error: `Too many requests. Please wait ${retryAfter} ${retryAfter === 1 ? "second" : "seconds"}.`,
      code: "RATE_LIMITED",
      retryAfter,
    };
  }

  recent.push(now);
  memTimestamps.set(key, recent);
  return null;
}

// ─── Generic sliding-window check ──────────────────────────────────
// Supports arbitrary window sizes (not just 60s).

async function slidingWindowCheck(
  key: string,
  max: number,
  windowMs: number,
): Promise<{ error: string; code: string; retryAfter: number } | null> {
  if (redis) {
    try {
      const now = Date.now();
      const cutoff = now - windowMs;
      const redisTtl = Math.ceil(windowMs / 1000) + 60;

      const member = `${now}-${Math.random().toString(36).slice(2, 6)}`;
      const results = await redis
        .multi()
        .zremrangebyscore(key, 0, cutoff)
        .zadd(key, now, member)
        .zcard(key)
        .expire(key, redisTtl)
        .exec();

      if (!results) throw new Error("pipeline returned null");
      if (results[2]?.[0]) throw results[2][0];
      const count = (results[2]![1] as number) ?? 0;
      if (count > max) {
        // Over limit: remove the entry we just added so a rejected request neither
        // counts toward the limit nor pollutes the sliding window. (The previous
        // code removed the OLDEST member, which over-throttled callers and skewed
        // retryAfter — and diverged from the in-memory fallback below.)
        await redis.zrem(key, member);
        const oldest = await redis.zrangebyscore(key, "-inf", "+inf", "LIMIT", 0, 1);
        const oldestTs = oldest[0] ? parseInt(oldest[0], 10) : now;
        const retryAfter = Math.ceil((windowMs - (now - oldestTs)) / 1000);
        return {
          error: `Too many requests. Please wait ${retryAfter} ${retryAfter === 1 ? "second" : "seconds"}.`,
          code: "RATE_LIMITED",
          retryAfter,
        };
      }
      return null;
    } catch (err) {
      alertRedisFallback("slidingWindow", err);
      return memSlidingWindowCheck(key, fallbackMax(max), windowMs);
    }
  }

  return memSlidingWindowCheck(key, max, windowMs);
}

/** Guest identity comes from a server-signed anonymous token, never a user-supplied ID. */
export async function checkGameGuestTicketRate(guestId: string) {
  return slidingWindowCheck(`rl:game-guest:${guestId}`, 30, 60_000);
}

// ─── Legacy wrapper (AI generation, plan-specific limits) ──────────
// Kept for backwards compat with messages.ts / credit-guard.ts
// (completions.ts uses the dedicated side-call limiter below)

export async function checkRateLimit(
  userId: string,
  maxPerMinute: number = DEFAULT_MAX_PER_MINUTE,
): Promise<{ error: string; code: string; retryAfter: number } | null> {
  return slidingWindowCheck(`rate:${userId}`, maxPerMinute, DEFAULT_WINDOW_MS);
}

// ─── Side-call limiter (custom-UI ai.complete → /completions) ──────
// Side calls are tiny NPC-decision prompts that interactive cards fire in
// bursts (e.g. one per werewolf per night). Sharing the main chat window
// starved those cards — a 10-player game needs ~20 calls per game-day while
// the main pool allowed 10 — so they get their own key and a much higher
// ceiling. Credits remain the real cost gate; this only stops runaway loops.

/** Max side completions per minute, all plans. */
export const SIDE_CALL_MAX_PER_MINUTE = 100;

/** Max concurrent side-completion streams per user. Without this, the 100/min
 *  pool + deduct-after-stream billing would let a near-zero-balance account
 *  hold ~100 premium-model streams open at once at platform expense — the old
 *  shared 10/min window used to bound that incidentally. Callers acquire with
 *  the `side:` prefix so the slot pool is separate from main chat's. */
export const SIDE_CALL_MAX_CONCURRENT = 10;

export async function checkSideCallRateLimit(
  userId: string,
  maxPerMinute: number = SIDE_CALL_MAX_PER_MINUTE,
): Promise<{ error: string; code: string; retryAfter: number } | null> {
  return slidingWindowCheck(`rate:side:${userId}`, maxPerMinute, DEFAULT_WINDOW_MS);
}

// ─── krew.io identity-token limiter ────────────────────────────────
// Per USER, not per IP (same NAT/VPN philosophy as everything else here). The
// /krew page asks for one token per game load / reconnect; 30 a minute is far
// above any honest pattern and still bounds a stuck reconnect loop.
export const KREW_TOKEN_MAX_PER_MINUTE = 30;
export async function checkKrewTokenRate(userId: string) {
  return slidingWindowCheck(`rate:krew-token:${userId}`, KREW_TOKEN_MAX_PER_MINUTE, DEFAULT_WINDOW_MS);
}

// ─── Password-reset limiter (inbox-bombing defense, NAT-safe) ───────
// Keyed on the EMAIL, never the IP — it stops someone spamming reset mail at a
// single victim without penalizing VPN / carrier-NAT users who share an exit IP
// (the same per-account philosophy as lib/auth.ts). Per-IP protection for this
// endpoint lives in lib/auth.ts customRules and is deliberately generous.
// Better Auth's own limiter runs underneath as well.

/** Max reset emails per address per 15 minutes. Generous enough that a confused
 *  user can resend a few times; low enough to kill inbox bombing. */
export const PWRESET_MAX_PER_EMAIL = 5;
const PWRESET_EMAIL_WINDOW_MS = 15 * 60_000;

export async function checkPasswordResetRateLimit(
  email: string,
): Promise<{ error: string; code: string; retryAfter: number } | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;
  return slidingWindowCheck(
    `rl:pwreset:email:${normalizedEmail}`,
    PWRESET_MAX_PER_EMAIL,
    PWRESET_EMAIL_WINDOW_MS,
  );
}

// ─── Hono middleware factory for tiered rate limiting ───────────────

/** Per-user limit for a tier. Trusted (skip_review) creators get the wider
 *  publishing window — their submits auto-publish with no admin queue to
 *  protect, so the base cap only stalled legitimate bulk catalog updates.
 *  Other tiers are unaffected by the flag. */
export function effectiveRateLimit(tier: RateLimitTier, skipReview: boolean | undefined): RateLimitConfig {
  if (tier === "publishing" && skipReview) return TRUSTED_PUBLISHING_RATE_LIMIT;
  return RATE_LIMITS[tier];
}

export function rateLimitMiddleware(tier: RateLimitTier): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const user = c.get("user") as { id: string; skipReview?: boolean } | undefined;
    const userId = user?.id;
    if (!userId) return next();

    // Same Redis key regardless of trust level, so toggling skip_review
    // changes the allowance without resetting the counted window.
    const config = effectiveRateLimit(tier, user?.skipReview);
    const result = await slidingWindowCheck(
      `rl:${tier}:${userId}`,
      config.max,
      config.windowSeconds * 1000,
    );

    if (result) {
      c.header("Retry-After", String(result.retryAfter));
      return c.json({ error: result.error, code: result.code }, 429);
    }

    return next();
  };
}

// ─── IP-based rate limiting for unauthenticated endpoints (auth) ────

export function ipRateLimitMiddleware(max: number, windowSeconds: number, scope?: string) {
  const windowMs = windowSeconds * 1000;

  return async (c: Context, next: Next) => {
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";

    const result = await slidingWindowCheck(scope ? `rl:ip:${scope}:${ip}` : `rl:ip:${ip}`, max, windowMs);

    if (result) {
      c.header("Retry-After", String(result.retryAfter));
      return c.json({ error: result.error, code: result.code }, 429);
    }

    return next();
  };
}

// ─── Concurrency control (explicit acquire/release) ─────────────────
// Not middleware — streamSSE returns before the stream ends, so
// middleware finally{} fires too early. Handlers call these directly.

function memAcquireConcurrency(userId: string, maxConcurrent: number, ttlSeconds: number): boolean {
  const now = Date.now();
  const entry = memInflight.get(userId);
  // Evict stale slots: if last acquire was longer ago than the TTL, reset
  if (entry && now - entry.lastAcquire > entry.ttlSeconds * 1000) {
    memInflight.delete(userId);
  }
  const current = memInflight.get(userId)?.count ?? 0;
  if (current >= maxConcurrent) return false;
  memInflight.set(userId, { count: current + 1, lastAcquire: now, ttlSeconds });
  return true;
}

function memReleaseConcurrency(userId: string): void {
  const entry = memInflight.get(userId);
  if (!entry || entry.count <= 1) {
    memInflight.delete(userId);
  } else {
    memInflight.set(userId, { ...entry, count: entry.count - 1 });
  }
}

export async function acquireConcurrency(
  userId: string,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  ttlSeconds: number = CONCURRENCY_TTL_S,
): Promise<boolean> {
  if (redis) {
    try {
      const key = `concurrent:${userId}`;
      const results = await redis.multi()
        .incr(key)
        .expire(key, ttlSeconds)
        .exec();
      if (!results) throw new Error("pipeline returned null");
      if (results[0]?.[0]) throw results[0][0];
      const current = (results[0]![1] as number) ?? 1;
      if (current > maxConcurrent) {
        await redis.decr(key).catch(() => {});
        return false;
      }
      return true;
    } catch (err) {
      alertRedisFallback("acquireConcurrency", err);
      return memAcquireConcurrency(userId, fallbackMax(maxConcurrent), ttlSeconds);
    }
  }

  return memAcquireConcurrency(userId, maxConcurrent, ttlSeconds);
}

export async function releaseConcurrency(userId: string): Promise<void> {
  if (redis) {
    try {
      const key = `concurrent:${userId}`;
      const val = await redis.decr(key);
      if (val <= 0) await redis.del(key);
      return;
    } catch (err) {
      alertRedisFallback("releaseConcurrency", err);
      // Fall through: if the matching acquire fell back to memory during the
      // same Redis incident, this balances it. A memory entry orphaned by a
      // Redis-side acquire is bounded by the 90s TTL eviction either way.
    }
  }

  memReleaseConcurrency(userId);
}

// ─── Periodic cleanup (in-memory only, every 60s) ─────────────────

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const rateCutoff = now - DEFAULT_WINDOW_MS;
  for (const [userId, timestamps] of memTimestamps) {
    const fresh = timestamps.filter((t) => t > rateCutoff);
    if (fresh.length === 0) memTimestamps.delete(userId);
    else memTimestamps.set(userId, fresh);
  }
  for (const [userId, entry] of memInflight) {
    if (now - entry.lastAcquire > entry.ttlSeconds * 1000) memInflight.delete(userId);
  }
}, 60 * 1000);
// A housekeeping timer must never keep the process alive on its own — without
// this, any process that imports this module (tests, scripts, a draining
// server) hangs at exit until stopRateLimitCleanup() is called.
cleanupInterval.unref();

export function stopRateLimitCleanup(): void {
  clearInterval(cleanupInterval);
}
