import { createMiddleware } from "hono/factory";
import { redis } from "./redis.js";
import type { AppEnv } from "./types.js";

/**
 * Admin dashboard response cache — stale-while-revalidate + single-flight.
 *
 * The admin analytics endpoints run multi-second aggregations over the raw
 * `messages` (10GB) / `usage_logs` (1.18M rows) tables. Recomputing them on
 * every page load is what made the dashboard take 5-22s. This middleware puts
 * an industry-standard cache layer in front:
 *
 *  - **Single-flight**: when a key is cold/stale, only ONE request recomputes
 *    (Redis SET NX lock). Concurrent loads (the overview page fires 4 endpoints
 *    at once; multiple admins) don't stampede the DB with parallel 11s scans.
 *  - **Stale-while-revalidate (SWR)**: a stale-but-present value is served
 *    INSTANTLY while one request refreshes in the background. After the first
 *    warmup, admins effectively never wait — same pattern as HTTP
 *    `Cache-Control: stale-while-revalidate`, Next.js ISR, Cloudflare grace.
 *  - **Serve-stale-on-error**: if a refresh errors, the last good copy is
 *    served instead of a 500.
 *  - **Fail-open**: Redis null (dev) or any Redis error falls through to a live
 *    compute. The cache can only make the dashboard faster, never break it.
 *
 * Apply AFTER auth + admin middleware so cache is never read/written for
 * unauthorized requests. Keys are shared across all admins (analytics are
 * global, not per-user), so one admin's load warms the dashboard for everyone.
 *
 * `?fresh=1` forces a recompute (the manual Refresh button), bypassing the
 * freshness check but still repopulating the cache.
 */

const GRACE_SEC = 6 * 60 * 60; // how long a stale copy survives for serve-stale
const LOCK_MS = 30_000; // max time a single recompute holds the refresh lock

/** TTL presets (seconds) — the soft-freshness window before a background refresh. */
export const ADMIN_CACHE_TTL = {
  /** Live-ish KPIs admins watch tick over (the "today" view). */
  SHORT: 60,
  /** Most analytics: totals, costs, distributions, per-user tables. */
  MED: 300,
  /** Slow-moving cohort / retention matrices (daily granularity). */
  LONG: 1_800,
} as const;

function jsonResponse(body: string, cache: "HIT" | "MISS" | "STALE" | "BYPASS"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "x-admin-cache": cache },
  });
}

export function cacheGet(ttlSeconds: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // Old open tabs must not restart the retired full-history scans after cutover.
    if(process.env.ADMIN_ANALYTICS_ENABLED==='true'&&c.req.path.startsWith('/api/admin/usage/'))
      return c.json({error:'Usage and engagement have moved to Overview. Reload the admin panel.'},410);
    // No Redis (dev) or non-GET → straight to live compute.
    if (c.req.method !== "GET" || !redis) return next();
    const r = redis;

    const q = c.req.query();
    const sortedQs = Object.keys(q)
      .filter((k) => k !== "fresh")
      .sort()
      .map((k) => `${k}=${q[k]}`)
      .join("&");
    const key = `admincache:${c.req.path}?${sortedQs}`;
    const freshKey = `${key}:f`;
    const lockKey = `${key}:l`;
    const bypass = q.fresh != null;

    // Read the cached body + its freshness flag up front (one round trip each).
    let cached: string | null = null;
    let fresh = false;
    if (!bypass) {
      try {
        [cached, fresh] = await Promise.all([
          r.get(key),
          r.get(freshKey).then((v) => v != null),
        ]);
      } catch {
        return next(); // Redis unhealthy — compute live.
      }
      // Fast path: fresh hit.
      if (cached != null && fresh) return jsonResponse(cached, "HIT");
    }

    // We need to (re)compute. Single-flight: only the lock winner recomputes.
    let gotLock = false;
    try {
      gotLock = (await r.set(lockKey, "1", "PX", LOCK_MS, "NX")) === "OK";
    } catch {
      // Lock unavailable — fall through and compute (correctness over de-dup).
      gotLock = true;
    }

    // Stale-while-revalidate: if we have a stale copy and we're NOT the
    // refresher, serve stale instantly (someone else is refreshing it).
    if (!gotLock && cached != null && !bypass) return jsonResponse(cached, "STALE");

    // Cold key and we lost the lock: briefly wait for the winner's result
    // rather than launching a duplicate 11s scan. Bounded so we never hang.
    if (!gotLock && cached == null && !bypass) {
      for (let i = 0; i < 10; i++) {
        await new Promise((res) => setTimeout(res, 250));
        try {
          const v = await r.get(key);
          if (v != null) return jsonResponse(v, "HIT");
        } catch {
          break;
        }
      }
      // Winner still not done after ~2.5s — compute inline as a safety net.
    }

    // Recompute path: run the downstream handler.
    await next();

    if (c.res.status === 200) {
      try {
        const body = await c.res.clone().text();
        // Hard TTL = soft TTL + grace so the stale copy outlives its freshness
        // window and remains available for serve-stale on the next miss.
        r.set(key, body, "EX", ttlSeconds + GRACE_SEC).catch(() => {});
        r.set(freshKey, "1", "EX", ttlSeconds).catch(() => {});
        try {
          c.res.headers.set("x-admin-cache", bypass ? "BYPASS" : "MISS");
        } catch {
          /* immutable headers on some runtimes — non-fatal */
        }
      } catch {
        /* body unreadable — response still goes out, just uncached */
      }
    } else if (cached != null && !bypass) {
      // Refresh failed (non-200). Don't propagate the error if we have a last
      // good copy — serve stale instead. This keeps a transient DB blip from
      // blanking the dashboard.
      c.res = jsonResponse(cached, "STALE");
    }
    if (gotLock) r.del(lockKey).catch(() => {});
  });
}

/**
 * Functional cache helper for code paths that aren't HTTP middleware (e.g. the
 * Phase 2 rollup refreshers). Same fail-open contract: returns the live compute
 * on Redis miss/down, best-effort populate.
 */
export async function cachedJson<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw != null) return JSON.parse(raw) as T;
    } catch {
      /* fall through to compute */
    }
  }
  const value = await compute();
  redis?.set(key, JSON.stringify(value), "EX", ttlSeconds).catch(() => {});
  return value;
}
