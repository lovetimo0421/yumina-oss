import { communityMuteMiddleware } from "../middleware/community-mute.js";
import { Hono } from "hono";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { db, readDb, readOwn, readPublic, flagWrite, type Database } from "../db/index.js";
import { userExtensions, extensionRatings, extensionReviews, extensionStats, user } from "../db/schema.js";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import { sanitizeContent } from "../lib/sanitize.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { invalidateExtensionsCache } from "../lib/extensions.js";
import { discardQueuedStoryCompactionsForUser } from "../lib/session-compaction.js";
import { discardQueuedSessionMemoryUpdatesForUser } from "../lib/session-memory.js";
import {
  EXTENSION_REGISTRY,
  getVisibleExtensions,
  getExtensionDefinition,
  SESSION_MEMORY_EXTENSION_KEY,
  MAX_REVIEW_CONTENT,
  type ExtensionDefinition,
  type ExtensionStats,
  type ExtensionInstallState,
  type ExtensionSummary,
  type ExtensionDetail,
} from "@yumina/shared";
import type { AppEnv } from "../lib/types.js";

const extensionRoutes = new Hono<AppEnv>();

// No global auth — hub/detail/rating are public; personal actions use authMiddleware.

type InstallRow = { status: string; installedAt: Date | null; uninstalledAt: Date | null };

const EMPTY_STATS: ExtensionStats = { downloadCount: 0, reviewCount: 0, averageRating: 0 };

function toInstallState(row: InstallRow | undefined): ExtensionInstallState {
  if (!row) return { status: "not-installed", installedAt: null, uninstalledAt: null };
  return {
    status: row.status === "installed" ? "installed" : "uninstalled",
    installedAt: row.installedAt ? row.installedAt.toISOString() : null,
    uninstalledAt: row.uninstalledAt ? row.uninstalledAt.toISOString() : null,
  };
}

function statsFromMap(map: Map<string, ExtensionStats>, key: string): ExtensionStats {
  const s = map.get(key) ?? EMPTY_STATS;
  return {
    downloadCount: s.downloadCount,
    reviewCount: s.reviewCount,
    averageRating: Math.round(s.averageRating * 10) / 10,
  };
}

function buildSummary(
  def: ExtensionDefinition,
  statsMap: Map<string, ExtensionStats>,
  installRow: InstallRow | undefined,
  includeInstallState: boolean,
): ExtensionSummary {
  const summary: ExtensionSummary = {
    key: def.key,
    name: def.name,
    shortDescription: def.shortDescription,
    icon: def.icon,
    category: def.category,
    tags: def.tags,
    author: def.author,
    version: def.version,
    stats: statsFromMap(statsMap, def.key),
  };
  if (includeInstallState) summary.installState = toInstallState(installRow);
  return summary;
}

async function loadStatsMap(rd: Database, keys: string[]): Promise<Map<string, ExtensionStats>> {
  const map = new Map<string, ExtensionStats>();
  if (keys.length === 0) return map;
  const rows = await rd
    .select()
    .from(extensionStats)
    .where(inArray(extensionStats.extensionKey, keys));
  for (const r of rows) {
    map.set(r.extensionKey, {
      downloadCount: r.downloadCount,
      reviewCount: r.reviewCount,
      averageRating: r.averageRating,
    });
  }
  return map;
}

// Stats are global (not per-user) and change only on install/review writes, so
// every hub/mine/detail load hitting the DB for them is wasted work. Cached
// per-process for 60s with explicit invalidation at the two write sites below;
// other instances serve ≤60s-stale storefront numbers, which is harmless.
let statsCache: { map: Map<string, ExtensionStats>; expiresAt: number } | null = null;
const STATS_CACHE_TTL_MS = 60_000;

async function loadStatsMapCached(rd: Database, keys: string[]): Promise<Map<string, ExtensionStats>> {
  if (statsCache && statsCache.expiresAt > Date.now()) return statsCache.map;
  const map = await loadStatsMap(rd, keys);
  statsCache = { map, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
  return map;
}

function invalidateStatsCache(): void {
  statsCache = null;
}

async function loadInstallMap(rd: Database, userId: string, keys: string[]): Promise<Map<string, InstallRow>> {
  const map = new Map<string, InstallRow>();
  if (keys.length === 0) return map;
  const rows = await rd
    .select({
      extensionKey: userExtensions.extensionKey,
      status: userExtensions.status,
      installedAt: userExtensions.installedAt,
      uninstalledAt: userExtensions.uninstalledAt,
    })
    .from(userExtensions)
    .where(and(eq(userExtensions.userId, userId), inArray(userExtensions.extensionKey, keys)));
  for (const r of rows) map.set(r.extensionKey, r);
  return map;
}

// GET /api/extensions/hub — browse the catalog (registry ⨝ stats ⨝ install state)
extensionRoutes.get("/hub", optionalAuthMiddleware, async (c) => {
  const currentUser = c.get("user");
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const category = (c.req.query("category") ?? "").trim();
  const sort = c.req.query("sort") ?? "recommended";
  const installedFilter = c.req.query("installed") === "true";

  const rd = currentUser ? await readOwn(currentUser.id) : readPublic();
  const visible = getVisibleExtensions();
  const keys = visible.map((e) => e.key);
  const statsMap = await loadStatsMapCached(rd, keys);
  const installMap = currentUser ? await loadInstallMap(rd, currentUser.id, keys) : new Map<string, InstallRow>();

  let items = visible.map((def) =>
    buildSummary(def, statsMap, installMap.get(def.key), !!currentUser),
  );

  if (q) {
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.shortDescription.toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  if (category) items = items.filter((i) => i.category === category);
  if (installedFilter) items = items.filter((i) => i.installState?.status === "installed");

  if (sort === "popular") {
    items.sort((a, b) => b.stats.downloadCount - a.stats.downloadCount);
  } else if (sort === "newest") {
    // Registry is authored newest-last; show newest first.
    items.reverse();
  }
  // "recommended" keeps authored registry order.

  // Guests get a CDN-cacheable storefront (same pattern as the worlds hub);
  // authed responses carry per-user install state, so they stay private.
  c.header(
    "Cache-Control",
    currentUser
      ? "private, max-age=30, stale-while-revalidate=120"
      : "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
  );
  return c.json({ data: items, total: items.length });
});

// GET /api/extensions/mine — installed + previously-installed lists (Manage page)
extensionRoutes.get("/mine", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const keys = EXTENSION_REGISTRY.map((e) => e.key);
  const statsMap = await loadStatsMapCached(rd, keys);
  const installMap = await loadInstallMap(rd, currentUser.id, keys);

  const installed: ExtensionSummary[] = [];
  const uninstalled: ExtensionSummary[] = [];
  for (const def of EXTENSION_REGISTRY) {
    const row = installMap.get(def.key);
    if (!row) continue; // never installed → not shown in Manage
    const summary = buildSummary(def, statsMap, row, true);
    if (row.status === "installed") installed.push(summary);
    else uninstalled.push(summary);
  }

  return c.json({ data: { installed, uninstalled } });
});

// GET /api/extensions/:key — detail + viewer install state
extensionRoutes.get("/:key", optionalAuthMiddleware, async (c) => {
  const key = c.req.param("key");
  const def = getExtensionDefinition(key);
  if (!def) return c.json({ error: "Extension not found" }, 404);

  const currentUser = c.get("user");
  const rd = currentUser ? await readOwn(currentUser.id) : readPublic();
  const statsMap = await loadStatsMapCached(rd, EXTENSION_REGISTRY.map((e) => e.key));
  const installMap = currentUser ? await loadInstallMap(rd, currentUser.id, [key]) : new Map<string, InstallRow>();

  const detail: ExtensionDetail = {
    ...buildSummary(def, statsMap, installMap.get(key), !!currentUser),
    longDescription: def.longDescription,
    screenshots: def.screenshots,
    explanations: def.explanations,
    capabilityHookIds: def.capabilityHookIds,
    firstParty: def.firstParty,
  };
  return c.json({ data: detail });
});

// GET /api/extensions/:key/install-state — viewer's install state
extensionRoutes.get("/:key/install-state", authMiddleware, async (c) => {
  const key = c.req.param("key");
  if (!getExtensionDefinition(key)) return c.json({ error: "Extension not found" }, 404);
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const [row] = await rd
    .select({
      status: userExtensions.status,
      installedAt: userExtensions.installedAt,
      uninstalledAt: userExtensions.uninstalledAt,
    })
    .from(userExtensions)
    .where(and(eq(userExtensions.userId, currentUser.id), eq(userExtensions.extensionKey, key)))
    .limit(1);
  return c.json({ data: toInstallState(row) });
});

// POST /api/extensions/:key/install — install (or reinstall an uninstalled row)
extensionRoutes.post("/:key/install", authMiddleware, rateLimitMiddleware("social-actions"), async (c) => {
  const key = c.req.param("key");
  if (!getExtensionDefinition(key)) return c.json({ error: "Extension not found" }, 404);
  const currentUser = c.get("user");

  const [existing] = await db
    .select({ id: userExtensions.id })
    .from(userExtensions)
    .where(and(eq(userExtensions.userId, currentUser.id), eq(userExtensions.extensionKey, key)))
    .limit(1);

  if (existing) {
    // Reinstall / already installed — flip status back, keep installedAt; no
    // download-count increment (this isn't a new download).
    await db
      .update(userExtensions)
      .set({ status: "installed", uninstalledAt: null, updatedAt: new Date() })
      .where(eq(userExtensions.id, existing.id));
  } else {
    await db.insert(userExtensions).values({ userId: currentUser.id, extensionKey: key, status: "installed" });
    // First-ever install → increment download count (upsert the stats row).
    await db.execute(sql`
      INSERT INTO extension_stats (extension_key, download_count, updated_at)
      VALUES (${key}, 1, NOW())
      ON CONFLICT (extension_key) DO UPDATE SET
        download_count = extension_stats.download_count + 1,
        updated_at = NOW()
    `);
    invalidateStatsCache();
  }

  flagWrite(currentUser.id);
  invalidateExtensionsCache(currentUser.id);
  return c.json({ data: { installed: true } }, 201);
});

// POST /api/extensions/:key/reinstall — re-enable a previously-uninstalled extension
extensionRoutes.post("/:key/reinstall", authMiddleware, rateLimitMiddleware("social-actions"), async (c) => {
  const key = c.req.param("key");
  if (!getExtensionDefinition(key)) return c.json({ error: "Extension not found" }, 404);
  const currentUser = c.get("user");

  const updated = await db
    .update(userExtensions)
    .set({ status: "installed", uninstalledAt: null, updatedAt: new Date() })
    .where(and(eq(userExtensions.userId, currentUser.id), eq(userExtensions.extensionKey, key)))
    .returning();

  if (updated.length === 0) {
    return c.json({ error: "Extension was never installed" }, 404);
  }

  flagWrite(currentUser.id);
  invalidateExtensionsCache(currentUser.id);
  return c.json({ data: { installed: true } });
});

// DELETE /api/extensions/:key/install — soft-uninstall (KEEPS user data)
extensionRoutes.delete("/:key/install", authMiddleware, rateLimitMiddleware("social-actions"), async (c) => {
  const key = c.req.param("key");
  if (!getExtensionDefinition(key)) return c.json({ error: "Extension not found" }, 404);
  const currentUser = c.get("user");

  await db
    .update(userExtensions)
    .set({ status: "uninstalled", uninstalledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(userExtensions.userId, currentUser.id), eq(userExtensions.extensionKey, key)));

  flagWrite(currentUser.id);
  invalidateExtensionsCache(currentUser.id);

  // Per-extension uninstall hook: stop scheduled background work. User data is
  // intentionally NOT deleted — reinstall resumes from the preserved state.
  // (Future extensions add their own hook here.)
  //
  // Discards by USER straight from the in-process job queues — synchronous,
  // no DB scan of the user's sessions (the old hook queried every session the
  // user owned just to enumerate queue keys). In-flight jobs that land late
  // are safely dropped by the optimistic-concurrency guard in
  // persistStorySummaryResult — no data corruption is possible.
  if (key === SESSION_MEMORY_EXTENSION_KEY) {
    discardQueuedStoryCompactionsForUser(currentUser.id);
    discardQueuedSessionMemoryUpdatesForUser(currentUser.id);
  }

  return c.json({ data: { installed: false } });
});

// ─── Reviews (1:1 mirror of worlds reviews, keyed on extension_key) ──

// GET /api/extensions/:key/reviews — list reviews (public, optional auth)
extensionRoutes.get("/:key/reviews", optionalAuthMiddleware, async (c) => {
  const key = c.req.param("key");
  if (!getExtensionDefinition(key)) return c.json({ error: "Extension not found" }, 404);
  const currentUser = c.get("user");
  const isAdmin = currentUser?.role === "admin";
  const rd = currentUser ? await readOwn(currentUser.id) : await readDb();

  const rawResult = await rd
    .select({
      id: extensionReviews.id,
      userId: extensionReviews.userId,
      extensionKey: extensionReviews.extensionKey,
      rating: extensionReviews.rating,
      content: extensionReviews.content,
      hiddenByCreatorAt: extensionReviews.hiddenByCreatorAt,
      createdAt: extensionReviews.createdAt,
      updatedAt: extensionReviews.updatedAt,
      userName: user.name,
      userImage: user.image,
      userUsername: user.username,
    })
    .from(extensionReviews)
    .innerJoin(user, eq(extensionReviews.userId, user.id))
    .where(eq(extensionReviews.extensionKey, key))
    .orderBy(desc(extensionReviews.createdAt));

  // Hide admin-soft-deleted reviews from everyone except admins and the author.
  const result = rawResult.filter((r) => {
    if (!r.hiddenByCreatorAt) return true;
    if (isAdmin) return true;
    if (currentUser && r.userId === currentUser.id) return true;
    return false;
  });

  const resolved = result.map((r) => ({
    id: r.id,
    userId: r.userId,
    extensionKey: r.extensionKey,
    rating: r.rating,
    content: r.content,
    hiddenByCreator: !!r.hiddenByCreatorAt,
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    userName: r.userName,
    userUsername: r.userUsername,
    userImage: resolveImageCdn(r.userImage),
  }));

  if (currentUser) {
    c.header("Cache-Control", "private, no-store");
  } else {
    c.header("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  }
  c.header("Vary", "Cookie");
  return c.json({ data: resolved });
});

// GET /api/extensions/:key/rating — star summary + comment count (public).
// reviewCount counts RATERS (one row per user in extension_ratings);
// commentCount counts the feed. They diverge whenever someone rates without
// writing, and the tab that labels the feed needs the second number.
extensionRoutes.get("/:key/rating", optionalAuthMiddleware, async (c) => {
  const key = c.req.param("key");
  const currentUser = c.get("user");
  // An authed viewer's response carries their own rating, so it must see their
  // just-saved write — primary. Anonymous browse stays on the replica.
  const rd = currentUser ? await readOwn(currentUser.id) : await readDb();

  const [summary, distributionRows, myRatingRows, commentSummary] = await Promise.all([
    rd
      .select({
        avg: sql<number>`COALESCE(AVG(${extensionRatings.rating}), 0)::real`,
        count: sql<number>`count(*)::int`,
      })
      .from(extensionRatings)
      .where(eq(extensionRatings.extensionKey, key)),
    rd
      .select({ rating: extensionRatings.rating, count: sql<number>`count(*)::int` })
      .from(extensionRatings)
      .where(eq(extensionRatings.extensionKey, key))
      .groupBy(extensionRatings.rating),
    currentUser
      ? rd
          .select({ rating: extensionRatings.rating })
          .from(extensionRatings)
          .where(and(eq(extensionRatings.userId, currentUser.id), eq(extensionRatings.extensionKey, key)))
          .limit(1)
      : Promise.resolve([] as Array<{ rating: number }>),
    rd
      .select({ count: sql<number>`count(*)::int` })
      .from(extensionReviews)
      .where(
        and(
          eq(extensionReviews.extensionKey, key),
          sql`${extensionReviews.content} IS NOT NULL AND btrim(${extensionReviews.content}) <> ''`,
          sql`${extensionReviews.hiddenByCreatorAt} IS NULL`
        )
      ),
  ]);

  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of distributionRows) {
    if (row.rating >= 1 && row.rating <= 5) distribution[row.rating] = row.count;
  }

  if (currentUser) {
    c.header("Cache-Control", "private, no-store");
  } else {
    c.header("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  }
  c.header("Vary", "Cookie");
  return c.json({
    data: {
      averageRating: Math.round((summary[0]?.avg ?? 0) * 10) / 10,
      reviewCount: summary[0]?.count ?? 0,
      commentCount: commentSummary[0]?.count ?? 0,
      distribution,
      myRating: myRatingRows[0]?.rating ?? null,
    },
  });
});

/** Upsert the viewer's one-per-extension star rating. */
async function upsertExtensionRating(userId: string, key: string, rating: number) {
  await db
    .insert(extensionRatings)
    .values({ userId, extensionKey: key, rating })
    .onConflictDoUpdate({
      target: [extensionRatings.userId, extensionRatings.extensionKey],
      set: { rating, updatedAt: new Date() },
    });
}

function parseExtensionRating(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5
    ? value
    : null;
}

// PUT /api/extensions/:key/rating — set/update the viewer's star rating.
extensionRoutes.put("/:key/rating", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const key = c.req.param("key");
  if (!getExtensionDefinition(key)) return c.json({ error: "Extension not found" }, 404);
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const rating = parseExtensionRating(body.rating);
  if (rating === null) return c.json({ error: "Rating must be 1-5" }, 400);

  await upsertExtensionRating(currentUser.id, key, rating);
  flagWrite(currentUser.id);
  recomputeExtensionStats(key);
  return c.json({ data: { rating } });
});

// POST /api/extensions/:key/reviews — post a comment on the extension's feed.
// Append-only: this used to upsert on (user, extension), so a second review
// silently replaced the first. The optional `rating` upserts the star rating
// and is snapshotted on the comment row as a badge.
extensionRoutes.post("/:key/reviews", authMiddleware, communityMuteMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const key = c.req.param("key");
  if (!getExtensionDefinition(key)) return c.json({ error: "Extension not found" }, 404);
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const rating = parseExtensionRating(body.rating);
  const rawContent = typeof body.content === "string" ? body.content.trim() : null;
  const content = rawContent ? sanitizeContent(rawContent) || null : null;
  if (content && content.length > MAX_REVIEW_CONTENT) {
    return c.json({ error: "Review too long" }, 400);
  }
  if (!content && rating === null) {
    return c.json({ error: "Comment cannot be empty" }, 400);
  }

  if (rating !== null) await upsertExtensionRating(currentUser.id, key, rating);

  let review = null;
  if (content) {
    const inserted = await db
      .insert(extensionReviews)
      .values({ userId: currentUser.id, extensionKey: key, rating, content })
      .returning();
    review = inserted[0];
  }

  flagWrite(currentUser.id);
  recomputeExtensionStats(key);
  return c.json({ data: review }, 201);
});

// DELETE /api/extensions/:key/reviews — remove the viewer's star rating.
// Comments go one at a time via the :reviewId route below; this path kept its
// name but now means "un-rate", matching the cards API.
extensionRoutes.delete("/:key/reviews", authMiddleware, async (c) => {
  const key = c.req.param("key");
  const currentUser = c.get("user");
  await db
    .delete(extensionRatings)
    .where(and(eq(extensionRatings.userId, currentUser.id), eq(extensionRatings.extensionKey, key)));
  flagWrite(currentUser.id);
  recomputeExtensionStats(key);
  return c.json({ data: { deleted: true } });
});

// DELETE /api/extensions/:key/reviews/:reviewId — delete one of the viewer's
// own comments. Their rating survives it.
extensionRoutes.delete("/:key/reviews/:reviewId", authMiddleware, async (c) => {
  const key = c.req.param("key");
  const reviewId = c.req.param("reviewId");
  const currentUser = c.get("user");

  const removed = await db
    .delete(extensionReviews)
    .where(
      and(
        eq(extensionReviews.id, reviewId),
        eq(extensionReviews.userId, currentUser.id),
        eq(extensionReviews.extensionKey, key)
      )
    )
    .returning();

  if (removed.length === 0) return c.json({ error: "Comment not found" }, 404);

  flagWrite(currentUser.id);
  return c.json({ data: { deleted: true } });
});

// DELETE /api/extensions/:key/reviews/:reviewId/by-creator — admin soft-hide.
// First-party extensions have no per-user creator, so "creator" = platform admin.
extensionRoutes.delete("/:key/reviews/:reviewId/by-creator", authMiddleware, async (c) => {
  const key = c.req.param("key");
  const reviewId = c.req.param("reviewId");
  const currentUser = c.get("user");
  if (currentUser.role !== "admin") {
    return c.json({ error: "Only an admin can hide extension reviews" }, 403);
  }
  const [review] = await db
    .select({ id: extensionReviews.id })
    .from(extensionReviews)
    .where(and(eq(extensionReviews.id, reviewId), eq(extensionReviews.extensionKey, key)))
    .limit(1);
  if (!review) return c.json({ error: "Review not found" }, 404);

  await db
    .update(extensionReviews)
    .set({ hiddenByCreatorAt: new Date(), updatedAt: new Date() })
    .where(eq(extensionReviews.id, reviewId));
  recomputeExtensionStats(key);
  return c.json({ data: { hidden: true } });
});

/**
 * Recompute denormalized reviewCount + averageRating on extension_stats.
 *
 * Rater semantics, from extension_ratings: one user counts once no matter how
 * many comments they post, and hiding a comment no longer retracts that
 * person's stars. Reading this off extension_reviews (as it used to) meant an
 * admin hiding one comment silently moved the extension's public score.
 */
function recomputeExtensionStats(key: string): void {
  db.execute(sql`
    INSERT INTO extension_stats (extension_key, review_count, average_rating, updated_at)
    VALUES (
      ${key},
      (SELECT count(*)::int FROM extension_ratings WHERE extension_key = ${key}),
      (SELECT COALESCE(AVG(rating), 0)::real FROM extension_ratings WHERE extension_key = ${key}),
      NOW()
    )
    ON CONFLICT (extension_key) DO UPDATE SET
      review_count = EXCLUDED.review_count,
      average_rating = EXCLUDED.average_rating,
      updated_at = NOW()
  `).then(() => invalidateStatsCache())
    .catch(() => {});
}

export { extensionRoutes };
