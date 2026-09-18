import { eq, and } from "drizzle-orm";
import { readOwn } from "../db/index.js";
import { userExtensions } from "../db/schema.js";
import { redis } from "./redis.js";
import { getExtensionKeyForCapability } from "@yumina/shared";

// ─── Extension entitlement gate ─────────────────────────────────────
//
// The single source of truth for "is this first-party feature enabled for this
// user". status='installed' = ON; 'uninstalled' or no row = OFF (data retained).
//
// ── Recipe for gating a future first-party extension ──────────────────────────
// SERVER:
//   1. Find the narrowest existing settings/resolver seam the feature already
//      fans out through, and make an entitlement-aware resolver that returns the
//      feature-OFF value when !isExtensionInstalled (don't scatter `if` checks).
//      (Example: resolveMemorySystemSettings in lib/memory-systems.ts.)
//   2. Self-defend async/background entry points (schedulers, queue drains) with
//      their own isExtensionInstalled no-op check.
//   3. Gate the feature's API router with ONE 403 middleware after authMiddleware.
//   4. Leave pure data-lifecycle ops (branch/copy/clear/checkpoint) ungated so
//      uninstall keeps data and reinstall resumes.
//   5. Uninstall hook (in routes/extensions.ts DELETE): stop scheduling + stop
//      injecting; NEVER delete the feature's columns/rows.
// CLIENT:
//   useIsExtensionInstalled(key) → hide trigger + feature UI; default hidden
//   until known-installed. Branch shared-surface rendering on the same hook.

const CACHE_TTL_SECONDS = 60;
const cacheKey = (userId: string) => `ext:${userId}`;

/**
 * The set of extension keys currently installed for a user. Cached in Redis with
 * a short TTL plus explicit invalidation on install/uninstall/reinstall; falls
 * back to a direct primary read when Redis is absent. Uses readOwn (primary)
 * because this is an entitlement gate / read-before-write guard — consistency is
 * structural, never the replica.
 */
export async function getInstalledExtensions(userId: string): Promise<Set<string>> {
  if (redis) {
    try {
      const cached = await redis.get(cacheKey(userId));
      if (cached) return new Set(JSON.parse(cached) as string[]);
    } catch {
      /* fall through to DB */
    }
  }
  const rd = await readOwn(userId);
  const rows = await rd
    .select({ key: userExtensions.extensionKey })
    .from(userExtensions)
    .where(and(eq(userExtensions.userId, userId), eq(userExtensions.status, "installed")));
  const keys = rows.map((r) => r.key);
  if (redis) {
    redis.set(cacheKey(userId), JSON.stringify(keys), "EX", CACHE_TTL_SECONDS).catch(() => {});
  }
  return new Set(keys);
}

/** Whether a specific extension is installed (entitlement ON) for the user. */
export async function isExtensionInstalled(userId: string, key: string): Promise<boolean> {
  const installed = await getInstalledExtensions(userId);
  return installed.has(key);
}

/** Capability-oriented gate: is the extension that owns this capability installed? */
export async function isCapabilityEnabled(userId: string, capabilityId: string): Promise<boolean> {
  const key = getExtensionKeyForCapability(capabilityId);
  if (!key) return false;
  return isExtensionInstalled(userId, key);
}

/** Drop the cached install set after an install/uninstall/reinstall. */
export function invalidateExtensionsCache(userId: string): void {
  if (redis) {
    redis.del(cacheKey(userId)).catch((err) => {
      // Entitlement gate: a failed invalidation means this user keeps their
      // OLD install set for up to CACHE_TTL_SECONDS. The TTL self-heals, but
      // the failure must be visible — silent failures on permission
      // boundaries are how stale-entitlement bugs become incidents.
      console.warn(
        `[Extensions] Cache invalidation failed for ${userId} (stale ≤${CACHE_TTL_SECONDS}s):`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}
