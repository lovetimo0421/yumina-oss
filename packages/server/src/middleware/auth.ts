import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import type { AppEnv, SessionUser } from "../lib/types.js";
import { auth, COOKIE_PREFIX } from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/schema.js";
import { readCachedSessionUser, writeCachedSessionUser } from "../lib/session-user-cache.js";

const SESSION_CACHE_TTL = 300; // 5 minutes

// Cache key prefix bumped 2026-05-20 when the cached payload shape changed
// from { user, session } → { userId, sessionId, sessionExpiresAtMs }. Old
// "session:" entries in Redis from before the deploy are orphaned and expire
// on their own TTL — new code won't read them under the new prefix.
const SESSION_CACHE_KEY = (token: string) => `session-v2:${token}`;

// Match the session-token cookie name for either the dev (no __Secure-)
// or production (__Secure-) variant. Driven by COOKIE_PREFIX so a config
// change in auth.ts can't silently desync the Redis cache key extractor.
const SESSION_COOKIE_REGEX = new RegExp(
  `(?:^|;\\s*)(?:${COOKIE_PREFIX}\\.session_token|__Secure-${COOKIE_PREFIX}\\.session_token)=([^;]+)`,
);

/** Extract session token from cookie header for cache key */
export function getSessionToken(headers: Headers): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(SESSION_COOKIE_REGEX);
  return match?.[1]?.split(".")[0] ?? null; // Use token prefix (before the signature dot)
}

// The cached payload stores ONLY session-validity proof. User-mutable fields
// (name, image, email, role, isBanned, ...) are intentionally NOT cached.
//
// History: an earlier version of this middleware (5ff2ceb1, 2026-03-29) cached
// the full { user, session } payload for 5 minutes. That created real
// production bugs because nothing invalidated the cache on user writes:
//   - Stripe customer created with a stale email (5-min window) — see
//     routes/stripe.ts getOrCreateStripeCustomer call sites.
//   - notify() denormalized stale name/avatar into notifications.payload
//     JSONB — permanent dirty data, since rows aren't rewritten.
//   - currentUser.role checks in community routes lagged 5 min on admin
//     promote/demote (c3ea90ad point-patched only the admin panel paths).
//
// The fix is structural, not a point-patch: cache only what is immutable for
// the session's lifetime (the session validity itself). Re-fetch the user row
// fresh on every request (~1ms PK lookup). We keep the perf-critical part
// (avoiding Better-Auth's getSession DB JOIN) and trade a cheap PK query for
// correctness everywhere.
//
// DO NOT add user fields to this payload. If a future handler needs to avoid
// the user fetch entirely, add an explicit `c.get("userId")` accessor instead.
type SessionCacheEntry = {
  userId: string;
  sessionId: string;
  sessionExpiresAtMs: number;
};

function isSessionCacheEntry(v: unknown): v is SessionCacheEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.userId === "string"
    && typeof o.sessionId === "string"
    && typeof o.sessionExpiresAtMs === "number";
}

async function readCachedSession(token: string): Promise<SessionCacheEntry | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(SESSION_CACHE_KEY(token));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isSessionCacheEntry(parsed)) return null;
    if (parsed.sessionExpiresAtMs < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedSession(token: string, sessionId: string, userId: string, expiresAt: Date): void {
  if (!redis) return;
  const entry: SessionCacheEntry = {
    userId,
    sessionId,
    sessionExpiresAtMs: expiresAt.getTime(),
  };
  redis.set(
    SESSION_CACHE_KEY(token),
    JSON.stringify(entry),
    "EX",
    SESSION_CACHE_TTL,
  ).catch(() => {});
}

async function loadUserFresh(userId: string): Promise<SessionUser | null> {
  // 60s Redis cache with explicit invalidation at every writer of a cached
  // field (see lib/session-user-cache.ts). This lookup was ~4.2M primary
  // round trips a day; deleted accounts are still rejected because their
  // session rows and session-cache keys are removed before this runs.
  const cached = await readCachedSessionUser(userId);
  if (cached) return cached;
  // Authentication/existence checks are correctness-sensitive and must never
  // consult a lagging replica after the primary has deleted the account.
  const rd = db;
  // Select ONLY the SessionUser columns. This runs on EVERY authed request, and
  // active players (playtime ticks every few seconds) are perpetually flagged for
  // read-after-write, so it lands on the primary. `SELECT *` detoasted the
  // `preferences` JSONB + a dozen profile columns (banner/bio/location/…) on every
  // hit for no reason — c.get("user") is typed SessionUser, so nothing downstream
  // can even read them. Narrowing keeps the row a single small heap fetch.
  const [row] = await rd
    .select({
      id: userTable.id,
      name: userTable.name,
      username: userTable.username,
      displayUsername: userTable.displayUsername,
      email: userTable.email,
      emailVerified: userTable.emailVerified,
      image: userTable.image,
      createdAt: userTable.createdAt,
      updatedAt: userTable.updatedAt,
      role: userTable.role,
      isSuspended: userTable.isSuspended,
      isBanned: userTable.isBanned,
      tier: userTable.tier,
      skipReview: userTable.skipReview,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!row) return null;
  writeCachedSessionUser(row as SessionUser);
  return row as SessionUser;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token = getSessionToken(c.req.raw.headers);

  // Fast path: validate session via Redis (cheap), then fetch user fresh from
  // DB. Avoids Better-Auth's full getSession() JOIN query on cache hit.
  if (token) {
    const cached = await readCachedSession(token);
    if (cached) {
      const user = await loadUserFresh(cached.userId);
      if (user) {
        c.set("user", user);
        c.set("session", {
          id: cached.sessionId,
          userId: cached.userId,
          expiresAt: new Date(cached.sessionExpiresAtMs),
          token,
        });
        return next();
      }
      // User row missing (deleted account but cached session token).
      // Drop to full Better-Auth lookup which will 401.
    }
  }

  const result = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!result) {
    const hasCookie = !!token;
    console.warn(
      `[auth] 401 on ${c.req.method} ${c.req.path} — cookie=${hasCookie ? "present" : "missing"}`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Better Auth may still accept a signed cookie-cache payload (or a stale
  // secondary-storage entry) briefly after account deletion. Never trust that
  // embedded user object as proof the account still exists.
  const freshUser = await loadUserFresh(result.user.id);
  if (!freshUser) {
    if (token && redis) {
      redis.del(
        SESSION_CACHE_KEY(token),
        `session:${token}`,
        `ba:rl:${token}`,
      ).catch(() => {});
    }
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", freshUser);
  c.set("session", result.session as AppEnv["Variables"]["session"]);

  if (token) {
    writeCachedSession(token, result.session.id, result.session.userId, new Date(result.session.expiresAt));
  }

  await next();
});

/**
 * Optional auth — sets user context if authenticated, but lets guests through.
 * Use on public browse routes where auth is nice-to-have (e.g. personalized results).
 */
export const optionalAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  try {
    const token = getSessionToken(c.req.raw.headers);
    if (token) {
      const cached = await readCachedSession(token);
      if (cached) {
        const user = await loadUserFresh(cached.userId);
        if (user) {
          c.set("user", user);
          c.set("session", {
            id: cached.sessionId,
            userId: cached.userId,
            expiresAt: new Date(cached.sessionExpiresAtMs),
            token,
          });
          return next();
        }
      }
    }

    const result = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (result) {
      const freshUser = await loadUserFresh(result.user.id);
      if (!freshUser) {
        if (token && redis) {
          redis.del(
            SESSION_CACHE_KEY(token),
            `session:${token}`,
            `ba:rl:${token}`,
          ).catch(() => {});
        }
        return next();
      }
      c.set("user", freshUser);
      c.set("session", result.session as AppEnv["Variables"]["session"]);
      if (token) {
        writeCachedSession(token, result.session.id, result.session.userId, new Date(result.session.expiresAt));
      }
    }
  } catch {
    // Guest user — no session, continue without auth context
  }
  await next();
});
