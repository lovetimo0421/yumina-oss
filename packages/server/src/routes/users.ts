import { Hono } from "hono";
import { eq, and, ne, sql, desc, ilike, or, inArray, type SQL } from "drizzle-orm";
import { db, readDb, readOwn, flagWrite } from "../db/index.js";
import { posthog } from "../lib/posthog.js";
import { user, worlds, bundles, follows, favorites, userLibrary, worldClickHistory, platformAchievements, profilePosts } from "../db/schema.js";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.js";
import { invalidateSessionUser } from "../lib/session-user-cache.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import { updateProfileSchema, getAgeFromBirthYear, aiConfigSchema, MAX_PROFILE_POST_LENGTH, PROFILE_POSTS_PAGE_SIZE, normalizeProfileWorldSort } from "@yumina/shared";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { sanitizeDisplayName } from "../lib/sanitize.js";
import { aggregatedCounters } from "../lib/world-aggregates.js";
import { getBlockStatus } from "../lib/blocks.js";
import {
  canViewRestrictedProfile,
  readProfileFollowDirections,
  readProfilePrivacy,
} from "../lib/profile-privacy.js";
import type { AppEnv } from "../lib/types.js";
import { resolveProfileContentLevel } from "../lib/profile-content-level.js";

async function readProfileContentLevel(viewerId: string | undefined, requestedLevel: string | undefined) {
  if (!viewerId) return "safe";
  const rd = await readOwn(viewerId);
  const [viewer] = await rd.select({ preferences: user.preferences })
    .from(user).where(eq(user.id, viewerId)).limit(1);
  return resolveProfileContentLevel(true, requestedLevel, viewer?.preferences);
}

function readProfileBannerCrop(preferences: unknown): unknown {
  const prefs = (preferences as Record<string, unknown> | null | undefined) ?? {};
  return prefs.profileBannerCrop ?? null;
}

function readProfileWorldSort(preferences: unknown) {
  const prefs = (preferences as Record<string, unknown> | null | undefined) ?? {};
  return normalizeProfileWorldSort(prefs.profileWorldSort);
}

// The platform achievement a user chose to showcase — its title + badge render
// in place of the "Creator" label / Award icon on profile surfaces. Reads the
// primary DB so a just-set showcase reflects immediately.
async function fetchShowcasedAchievement(achievementId: string | null | undefined, ownerUserId: string) {
  if (!achievementId) return null;
  const rows = await db
    .select({
      id: platformAchievements.id,
      key: platformAchievements.key,
      title: platformAchievements.title,
      badge: platformAchievements.badge,
    })
    .from(platformAchievements)
    .where(eq(platformAchievements.id, achievementId))
    .limit(1);
  const ach = rows[0];
  if (!ach) return null;
  // Showcased badge = the owner's HIGHEST earned tier medal for this achievement.
  const res = await db.execute(sql`
    SELECT t.badge AS badge, u2.tier_level AS level
    FROM user_platform_achievements u2
    JOIN platform_achievement_tiers t ON t.achievement_id = u2.achievement_id AND t.level = u2.tier_level
    WHERE u2.user_id = ${ownerUserId} AND u2.achievement_id = ${achievementId}
    ORDER BY CASE u2.tier_level WHEN 'diamond' THEN 4 WHEN 'gold' THEN 3 WHEN 'silver' THEN 2 ELSE 1 END DESC
    LIMIT 1`);
  const trows = (Array.isArray(res) ? res : ((res as { rows?: Array<Record<string, unknown>> }).rows ?? [])) as Array<{ badge?: string; level?: string }>;
  return { id: ach.id, key: ach.key, title: ach.title, badge: trows[0]?.badge ?? ach.badge, tier: trows[0]?.level ?? null };
}

// Trigger-maintained derived columns — never extract these from `schema`
// (jsonb extraction detoasts the multi-MB blob per row; see db/schema.ts).
const coverCropCols = {
  coverCrop: worlds.coverCrop,
  galleryCoverCrop: worlds.galleryCoverCrop,
};

const users = new Hono<AppEnv>();

// GET /api/users/me (auth required)
users.get("/me", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const result = await rd
    .select()
    .from(user)
    .where(eq(user.id, currentUser.id))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  const row = result[0]!;
  row.image = resolveImageCdn(row.image);
  row.banner = resolveImageCdn(row.banner);

  const showcasedAchievement = await fetchShowcasedAchievement(row.showcasedAchievementId, currentUser.id);

  return c.json({ data: { ...row, showcasedAchievement } });
});

// GET /api/users/me/playtime — hours played in last 14 days
users.get("/me/playtime", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);

  const result = await rd
    .select({
      lifetimePlaytimeSeconds: user.lifetimePlaytimeSeconds,
    })
    .from(user)
    .where(eq(user.id, currentUser.id));

  const totalSeconds = Math.max(0, result[0]?.lifetimePlaytimeSeconds ?? 0);

  // Compute creator totals used by profile surfaces
  const [interactionsResult, worldDownloadsResult, bundleDownloadsResult, worldLikesResult] = await Promise.all([
    rd
      .select({ total: sql<number>`coalesce(sum(${worlds.messageCount}), 0)::int` })
      .from(worlds)
      .where(eq(worlds.creatorId, currentUser.id)),
    rd
      .select({ total: sql<number>`coalesce(sum(${worlds.downloadCount}), 0)::int` })
      .from(worlds)
      .where(eq(worlds.creatorId, currentUser.id)),
    rd
      .select({ total: sql<number>`coalesce(sum(${bundles.downloadCount}), 0)::int` })
      .from(bundles)
      .where(eq(bundles.userId, currentUser.id)),
    rd
      .select({ total: sql<number>`coalesce(sum(${worlds.favoriteCount}), 0)::int` })
      .from(worlds)
      .where(eq(worlds.creatorId, currentUser.id)),
  ]);
  const totalInteractions = interactionsResult[0]?.total ?? 0;
  const totalDownloads = (worldDownloadsResult[0]?.total ?? 0) + (bundleDownloadsResult[0]?.total ?? 0);
  const totalLikes = worldLikesResult[0]?.total ?? 0;

  return c.json({
    data: {
      totalSeconds,
      totalInteractions,
      totalDownloads,
      totalLikes,
    },
  });
});

// POST /api/users/me/history-clicks - record discovery/library click history
users.post("/me/history-clicks", authMiddleware, async (c) => {
  const currentUser = c.get("user");

  try {
    const body = await c.req.json();
    const worldId = typeof body.worldId === "string" ? body.worldId.trim() : "";
    const worldName = typeof body.worldName === "string" ? body.worldName.trim() : "";
    const worldThumbnailUrl =
      typeof body.worldThumbnailUrl === "string" && body.worldThumbnailUrl.trim().length > 0
        ? body.worldThumbnailUrl.trim()
        : null;
    const source = body.source === "discovery" || body.source === "library" ? body.source : null;
    const interaction =
      body.interaction === "card-click" || body.interaction === "play-click"
        ? body.interaction
        : null;

    if (!worldId || !worldName || !source || !interaction) {
      return c.json({ error: "Invalid history click payload" }, 400);
    }

    await db.insert(worldClickHistory).values({
      userId: currentUser.id,
      worldId,
      worldName,
      worldThumbnailUrl,
      source,
      interaction,
    });

    flagWrite(currentUser.id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[USERS] Failed to record history click:", err);
    return c.json({ error: "Failed to record history click" }, 500);
  }
});

// GET /api/users/me/history-clicks - recent discovery/library click history
users.get("/me/history-clicks", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 100);

  const rows = await rd
    .select({
      id: worldClickHistory.id,
      worldId: worldClickHistory.worldId,
      worldName: worldClickHistory.worldName,
      worldThumbnailUrl: worldClickHistory.worldThumbnailUrl,
      source: worldClickHistory.source,
      interaction: worldClickHistory.interaction,
      createdAt: worldClickHistory.createdAt,
    })
    .from(worldClickHistory)
    .where(eq(worldClickHistory.userId, currentUser.id))
    .orderBy(desc(worldClickHistory.createdAt))
    .limit(limit);

  const resolved = rows.map((row) => ({
    ...row,
    worldThumbnailUrl: resolveImageCdn(row.worldThumbnailUrl),
  }));

  return c.json({ data: resolved });
});

// DELETE /api/users/me/history-clicks/:id - remove one history entry
users.delete("/me/history-clicks/:id", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");

  try {
    await db
      .delete(worldClickHistory)
      .where(and(eq(worldClickHistory.id, id), eq(worldClickHistory.userId, currentUser.id)));

    flagWrite(currentUser.id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[USERS] Failed to delete history click:", err);
    return c.json({ error: "Failed to delete history entry" }, 500);
  }
});

// DELETE /api/users/me/history-clicks - clear the user's entire click history
users.delete("/me/history-clicks", authMiddleware, async (c) => {
  const currentUser = c.get("user");

  try {
    await db.delete(worldClickHistory).where(eq(worldClickHistory.userId, currentUser.id));

    flagWrite(currentUser.id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[USERS] Failed to clear history clicks:", err);
    return c.json({ error: "Failed to clear history" }, 500);
  }
});

// GET /api/users/search - public player/author search for the hub search bar
users.get("/search", optionalAuthMiddleware, async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "12", 10) || 12, 1), 24);

  if (!q) {
    return c.json({ data: [] });
  }

  const rd = await readDb();
  const pattern = `%${q}%`;
  const prefix = `${q}%`;

  const rows = await rd
    .select({
      id: user.id,
      name: user.name,
      username: user.username,
      displayUsername: user.displayUsername,
      image: user.image,
    })
    .from(user)
    .where(
      and(
        eq(user.isBanned, false),
        eq(user.isSuspended, false),
        or(
          ilike(user.username, pattern),
          and(
            sql`lower(${user.displayUsername}) = lower(${user.username})`,
            ilike(user.displayUsername, pattern),
          ),
          ilike(user.name, pattern),
        ),
      ),
    )
    .orderBy(
      sql`CASE
        WHEN lower(${user.username}) = lower(${q}) THEN 0
        WHEN ${user.username} ILIKE ${prefix} THEN 1
        WHEN lower(${user.displayUsername}) = lower(${user.username}) AND ${user.displayUsername} ILIKE ${prefix} THEN 2
        WHEN ${user.name} ILIKE ${prefix} THEN 3
        ELSE 4
      END`,
      sql`(
        SELECT count(DISTINCT COALESCE(w.language_group_id, w.id))
        FROM worlds w
        WHERE w.creator_id = ${user.id}
          AND w.is_published = true
          AND w.status = 'published'
          AND w.visibility = 'public'
      ) DESC`,
      sql`(
        SELECT count(*)
        FROM ${follows}
        WHERE ${follows.followingId} = ${user.id}
      ) DESC`,
      desc(user.createdAt),
    )
    .limit(limit);

  const userIds = rows.map((row) => row.id);
  const [worldCountRows, followerCountRows] = userIds.length > 0
    ? await Promise.all([
        rd
          .select({
            creatorId: worlds.creatorId,
            count: sql<number>`count(DISTINCT COALESCE(${worlds.languageGroupId}, ${worlds.id}))::int`,
          })
          .from(worlds)
          .where(and(
            inArray(worlds.creatorId, userIds),
            eq(worlds.isPublished, true),
            eq(worlds.status, "published"),
            eq(worlds.visibility, "public"),
          ))
          .groupBy(worlds.creatorId),
        rd
          .select({
            userId: follows.followingId,
            count: sql<number>`count(*)::int`,
          })
          .from(follows)
          .where(inArray(follows.followingId, userIds))
          .groupBy(follows.followingId),
      ])
    : [[], []];

  const worldCounts = new Map(worldCountRows.map((row) => [row.creatorId, row.count ?? 0]));
  const followerCounts = new Map(followerCountRows.map((row) => [row.userId, row.count ?? 0]));

  return c.json({
    data: rows.map((row) => {
      const displayUsername =
        row.username && row.displayUsername && row.displayUsername.toLowerCase() === row.username.toLowerCase()
          ? row.displayUsername
          : row.username ?? row.displayUsername;
      return {
        ...row,
        displayUsername,
        image: resolveImageCdn(row.image),
        publishedWorldsCount: worldCounts.get(row.id) ?? 0,
        followersCount: followerCounts.get(row.id) ?? 0,
      };
    }),
  });
});

// GET /api/users/:id (public profile — optional auth for privacy checks)
users.get("/:id", optionalAuthMiddleware, async (c) => {
  const userId = c.req.param("id");
  const viewer = c.get("user");
  // Scope replica routing to the profile owner. Privacy-setting and follow
  // writes flag that owner, so viewers see the grant immediately from primary.
  const rd = await readDb(userId);

  const result = await rd
    .select({
      id: user.id,
      name: user.name,
      username: user.username,
      image: user.image,
      banner: user.banner,
      bio: user.bio,
      location: user.location,
      website: user.website,
      featuredWorldId: user.featuredWorldId,
      showcasedAchievementId: user.showcasedAchievementId,
      createdAt: user.createdAt,
      preferences: user.preferences,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  const profile = result[0]!;
  profile.image = resolveImageCdn(profile.image);
  profile.banner = resolveImageCdn(profile.banner);

  const privacy = readProfilePrivacy(profile.preferences);
  const isSelf = viewer?.id === userId;
  let viewerFollows = false;
  let ownerFollowsViewer = false;
  let viewerBlockStatus: Awaited<ReturnType<typeof getBlockStatus>> = { blocked: false, direction: null };
  if (!isSelf && viewer) {
    const followDirections = await readProfileFollowDirections(rd, userId, viewer.id);
    viewerFollows = followDirections.viewerFollowsOwner;
    ownerFollowsViewer = followDirections.ownerFollowsViewer;
    viewerBlockStatus = await getBlockStatus(viewer.id, userId);
  }

  // Compute counts
  const [followersResult, followingResult, worldsResult, interactionsResult, playtimeResult, worldDownloadsResult, bundleDownloadsResult, worldLikesResult] =
    await Promise.all([
      rd
        .select({ count: sql<number>`count(*)::int` })
        .from(follows)
        .where(eq(follows.followingId, userId)),
      rd
        .select({ count: sql<number>`count(*)::int` })
        .from(follows)
        .where(eq(follows.followerId, userId)),
      rd
        .select({ count: sql<number>`count(*)::int` })
        .from(worlds)
        .where(and(eq(worlds.creatorId, userId), eq(worlds.isPublished, true))),
      rd
        .select({ total: sql<number>`coalesce(sum(${worlds.messageCount}), 0)::int` })
        .from(worlds)
        .where(eq(worlds.creatorId, userId)),
      rd
        .select({
          lifetimePlaytimeSeconds: user.lifetimePlaytimeSeconds,
        })
        .from(user)
        .where(eq(user.id, userId)),
      rd
        .select({ total: sql<number>`coalesce(sum(${worlds.downloadCount}), 0)::int` })
        .from(worlds)
        .where(eq(worlds.creatorId, userId)),
      rd
        .select({ total: sql<number>`coalesce(sum(${bundles.downloadCount}), 0)::int` })
        .from(bundles)
        .where(eq(bundles.userId, userId)),
      rd
        .select({ total: sql<number>`coalesce(sum(${worlds.favoriteCount}), 0)::int` })
        .from(worlds)
        .where(eq(worlds.creatorId, userId)),
    ]);

  const totalPlaytimeSeconds = Math.max(0, playtimeResult[0]?.lifetimePlaytimeSeconds ?? 0);
  const hiddenByPrivate = !canViewRestrictedProfile({
    profileVisibility: privacy.profileVisibility,
    isSelf,
    ownerFollowsViewer,
  });
  const hideStats = false;
  const profileBannerCrop = readProfileBannerCrop(profile.preferences);
  const profileWorldSort = readProfileWorldSort(profile.preferences);
  const showcasedAchievement = await fetchShowcasedAchievement(profile.showcasedAchievementId, userId);

  // Strip preferences from the response body — caller only needs the derived flags.
  const { preferences: _prefs, ...publicProfile } = profile;

  return c.json({
    data: {
      ...publicProfile,
      profileBannerCrop,
      profileWorldSort,
      showcasedAchievement,
      bio: publicProfile.bio,
      location: publicProfile.location,
      website: publicProfile.website,
      followersCount: followersResult[0]?.count ?? 0,
      followingCount: followingResult[0]?.count ?? 0,
      publishedWorldsCount: worldsResult[0]?.count ?? 0,
      totalInteractions: hideStats ? null : (interactionsResult[0]?.total ?? 0),
      totalPlaytimeSeconds: hideStats ? null : totalPlaytimeSeconds,
      totalDownloads: hideStats
        ? null
        : (worldDownloadsResult[0]?.total ?? 0) + (bundleDownloadsResult[0]?.total ?? 0),
      totalLikes: hideStats ? null : (worldLikesResult[0]?.total ?? 0),
      profileVisibility: privacy.profileVisibility,
      isPrivateAccount: privacy.profileVisibility !== "public",
      allowDMs: privacy.allowDMs,
      showRecentPlay: privacy.showPlayHistory,
      showPlayHistory: privacy.showPlayHistory,
      showStats: privacy.showStats,
      showFavorites: privacy.showFavorites,
      hiddenByPrivate,
      hiddenStats: hideStats,
      viewerIsSelf: isSelf,
      viewerFollows,
      viewerIsFollowedByUser: ownerFollowsViewer,
      viewerBlockStatus,
    },
  });
});

// GET /api/users/:id/recent-played (public — recently played worlds from library)
users.get("/:id/recent-played", optionalAuthMiddleware, async (c) => {
  const userId = c.req.param("id");
  const viewer = c.get("user");
  const rd = await readDb(userId);
  const isSelf = viewer?.id === userId;

  // Load target user's privacy prefs.
  const [targetRow] = await rd
    .select({ preferences: user.preferences })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  const privacy = readProfilePrivacy(targetRow?.preferences);
  if (!isSelf && !privacy.showPlayHistory) {
    return c.json({ data: [] });
  }
  const ownerFollowsViewer = privacy.profileVisibility === "followers" && !isSelf
    ? (await readProfileFollowDirections(rd, userId, viewer?.id)).ownerFollowsViewer
    : false;
  if (!canViewRestrictedProfile({ profileVisibility: privacy.profileVisibility, isSelf, ownerFollowsViewer })) {
    return c.json({ data: [] });
  }

  const contentLevel = await readProfileContentLevel(viewer?.id, c.req.query("contentLevel"));
  const rows = await rd
    .select({
      id: worlds.id,
      name: worlds.name,
      thumbnailUrl: worlds.thumbnailUrl,
      coverCrop: coverCropCols.coverCrop,
      galleryCoverCrop: coverCropCols.galleryCoverCrop,
      ageRating: worlds.ageRating,
      isNsfw: worlds.isNsfw,
      blurCover: worlds.blurCover,
      lastPlayedAt: sql<Date>`COALESCE(${userLibrary.lastPlayedAt}, ${userLibrary.createdAt})`.as("last_played_at"),
    })
    .from(userLibrary)
    .innerJoin(worlds, eq(userLibrary.worldId, worlds.id))
    .where(and(
      eq(userLibrary.userId, userId),
      eq(worlds.isPublished, true),
      ...(contentLevel === "safe" ? [eq(worlds.ageRating, "all")] : []),
    ))
    .orderBy(sql`COALESCE(${userLibrary.lastPlayedAt}, ${userLibrary.createdAt}) DESC`)
    .limit(5);

  const resolved = rows.map((r) => ({
    id: r.id,
    name: r.name,
    thumbnailUrl: resolveImageCdn(r.thumbnailUrl),
    coverCrop: r.coverCrop,
    galleryCoverCrop: r.galleryCoverCrop,
    ageRating: r.ageRating,
    isNsfw: r.isNsfw,
    lastPlayedAt: r.lastPlayedAt,
  }));

  return c.json({ data: resolved });
});

// GET /api/users/:id/library (public — user's library of published worlds)
users.get("/:id/library", optionalAuthMiddleware, async (c) => {
  const userId = c.req.param("id");
  const viewer = c.get("user");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "12") || 12, 1), 50);
  const offset = Math.max(parseInt(c.req.query("offset") || "0") || 0, 0);
  const rd = await readDb(userId);
  const isSelf = viewer?.id === userId;

  const [targetRow] = await rd
    .select({ preferences: user.preferences })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const privacy = readProfilePrivacy(targetRow?.preferences);
  if (!isSelf && !privacy.showFavorites) {
    return c.json({ data: [], total: 0, limit, offset });
  }
  const ownerFollowsViewer = privacy.profileVisibility === "followers" && !isSelf
    ? (await readProfileFollowDirections(rd, userId, viewer?.id)).ownerFollowsViewer
    : false;
  if (!canViewRestrictedProfile({ profileVisibility: privacy.profileVisibility, isSelf, ownerFollowsViewer })) {
    return c.json({ data: [], total: 0, limit, offset });
  }

  const contentLevel = await readProfileContentLevel(viewer?.id, c.req.query("contentLevel"));
  const items = await rd
    .select({
      worldId: worlds.id,
      worldName: worlds.name,
      worldDescription: worlds.description,
      worldThumbnailUrl: worlds.thumbnailUrl,
      worldCoverCrop: coverCropCols.coverCrop,
      worldGalleryCoverCrop: coverCropCols.galleryCoverCrop,
      worldTags: worlds.tags,
      worldAgeRating: worlds.ageRating,
      worldIsNsfw: worlds.isNsfw,
      worldBlurCover: worlds.blurCover,
      worldDownloadCount: aggregatedCounters.downloadCount,
      worldMessageCount: aggregatedCounters.messageCount,
      creatorId: worlds.creatorId,
      creatorName: user.name,
      creatorImage: user.image,
      addedAt: favorites.createdAt,
    })
    .from(favorites)
    .innerJoin(worlds, eq(favorites.worldId, worlds.id))
    .innerJoin(user, eq(worlds.creatorId, user.id))
    .where(and(
      eq(favorites.userId, userId),
      eq(worlds.isPublished, true),
      ...(contentLevel === "safe" ? [eq(worlds.ageRating, "all")] : []),
    ))
    .orderBy(sql`${favorites.createdAt} DESC`)
    .limit(limit)
    .offset(offset);

  const [totalResult] = await rd
    .select({ count: sql<number>`count(*)::int` })
    .from(favorites)
    .innerJoin(worlds, eq(favorites.worldId, worlds.id))
    .where(and(
      eq(favorites.userId, userId),
      eq(worlds.isPublished, true),
      ...(contentLevel === "safe" ? [eq(worlds.ageRating, "all")] : []),
    ));
  const total = totalResult?.count ?? 0;

  const resolved = items.map((item) => ({
    ...item,
    worldThumbnailUrl: resolveImageCdn(item.worldThumbnailUrl),
  }));

  return c.json({ data: resolved, total, limit, offset });
});

// ── Profile announcement wall ─────────────────────────────
// Short owner-authored posts on a profile (plans, delays, character updates).
// This persistent profile surface complements broader community discussion.

// GET /api/users/:id/wall (public — respects the profile's visibility prefs)
users.get("/:id/wall", optionalAuthMiddleware, async (c) => {
  const userId = c.req.param("id");
  const viewer = c.get("user");
  const isSelf = viewer?.id === userId;
  const rd = await readDb(userId);

  const [targetRow] = await rd
    .select({ preferences: user.preferences })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!targetRow) return c.json({ error: "User not found" }, 404);

  const privacy = readProfilePrivacy(targetRow.preferences);
  const ownerFollowsViewer = privacy.profileVisibility === "followers" && !isSelf
    ? (await readProfileFollowDirections(rd, userId, viewer?.id)).ownerFollowsViewer
    : false;
  if (!canViewRestrictedProfile({ profileVisibility: privacy.profileVisibility, isSelf, ownerFollowsViewer })) {
    return c.json({ data: [], total: 0 });
  }

  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || String(PROFILE_POSTS_PAGE_SIZE)) || PROFILE_POSTS_PAGE_SIZE, 1), 50);
  const offset = Math.max(parseInt(c.req.query("offset") || "0") || 0, 0);

  const rows = await rd
    .select()
    .from(profilePosts)
    .where(eq(profilePosts.userId, userId))
    .orderBy(desc(profilePosts.isPinned), desc(profilePosts.createdAt))
    .limit(limit)
    .offset(offset);
  const [totalRow] = await rd
    .select({ count: sql<number>`count(*)::int` })
    .from(profilePosts)
    .where(eq(profilePosts.userId, userId));

  return c.json({ data: rows, total: totalRow?.count ?? 0, limit, offset });
});

// POST /api/users/me/wall (auth — create a post on your own wall)
users.post("/me/wall", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => null);
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) return c.json({ error: "Content is required" }, 400);
  if (content.length > MAX_PROFILE_POST_LENGTH) {
    return c.json({ error: `Content exceeds ${MAX_PROFILE_POST_LENGTH} characters` }, 400);
  }
  const [post] = await db
    .insert(profilePosts)
    .values({ userId: currentUser.id, content })
    .returning();
  flagWrite(currentUser.id);
  return c.json({ data: post }, 201);
});

// PATCH /api/users/me/wall/:postId (auth — edit / pin your own post)
users.on(["POST", "PATCH"], "/me/wall/:postId", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");
  const postId = c.req.param("postId");
  const body = await c.req.json().catch(() => null);
  const updates: Partial<{ content: string; isPinned: boolean; updatedAt: Date }> = {};
  if (typeof body?.content === "string") {
    const content = body.content.trim();
    if (!content) return c.json({ error: "Content is required" }, 400);
    if (content.length > MAX_PROFILE_POST_LENGTH) {
      return c.json({ error: `Content exceeds ${MAX_PROFILE_POST_LENGTH} characters` }, 400);
    }
    updates.content = content;
  }
  if (typeof body?.isPinned === "boolean") updates.isPinned = body.isPinned;
  if (Object.keys(updates).length === 0) return c.json({ error: "Nothing to update" }, 400);
  updates.updatedAt = new Date();
  const [post] = await db
    .update(profilePosts)
    .set(updates)
    .where(and(eq(profilePosts.id, postId), eq(profilePosts.userId, currentUser.id)))
    .returning();
  if (!post) return c.json({ error: "Post not found" }, 404);
  flagWrite(currentUser.id);
  return c.json({ data: post });
});

// DELETE /api/users/me/wall/:postId (auth — delete your own post)
users.delete("/me/wall/:postId", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const postId = c.req.param("postId");
  const [deleted] = await db
    .delete(profilePosts)
    .where(and(eq(profilePosts.id, postId), eq(profilePosts.userId, currentUser.id)))
    .returning();
  if (!deleted) return c.json({ error: "Post not found" }, 404);
  flagWrite(currentUser.id);
  return c.json({ success: true });
});

// POST + PATCH /api/users/me (auth required)
// Accept POST as well as PATCH — Chinese corporate proxies and the GFW
// commonly block PATCH/PUT/DELETE, returning 400 HTML error pages.
users.on(["POST", "PATCH"], "/me", authMiddleware, rateLimitMiddleware("profile-updates"), async (c) => {
  try {
  const currentUser = c.get("user");
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  if (parsed.data.name) {
    parsed.data.name = sanitizeDisplayName(parsed.data.name);
    if (!parsed.data.name) {
      return c.json({ error: "Name cannot be empty after sanitization" }, 400);
    }
  }

  // Older clients may echo a full preferences snapshot. This namespace is
  // server-owned; only the authenticated starter endpoint may mutate it.
  if (parsed.data.preferences) {
    const { discoveryStarter: _ownedStarter, ...clientPreferences } = parsed.data.preferences;
    parsed.data.preferences = clientPreferences;
  }
  const profilePatch: Partial<typeof user.$inferInsert> = { ...parsed.data };

  // Check username uniqueness if being set. Store the canonical handle in
  // lowercase, while keeping displayUsername synced so search stops matching
  // stale handles after a profile rename.
  if (parsed.data.username) {
    const displayUsername = parsed.data.username;
    const normalizedUsername = displayUsername.toLowerCase();
    const existing = await db
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          sql`lower(${user.username}) = ${normalizedUsername}`,
          ne(user.id, currentUser.id)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return c.json({ error: "Username already taken" }, 409);
    }

    profilePatch.username = normalizedUsername;
    profilePatch.displayUsername = displayUsername;
  }

  // Merge preferences with existing rather than overwriting
  let updateData: Omit<Partial<typeof user.$inferInsert>, 'preferences'> & {
    preferences?: Record<string, unknown> | SQL | null;
  } = { ...profilePatch, updatedAt: new Date() };
  if (parsed.data.preferences) {
    const existing = await db
      .select({ preferences: user.preferences, birthYear: user.birthYear })
      .from(user)
      .where(eq(user.id, currentUser.id))
      .limit(1);
    const existingPrefs = (existing[0]?.preferences ?? {}) as Record<string, unknown>;
    const mergedPrefs = { ...existingPrefs, ...parsed.data.preferences };

    // Eligibility gate: block Limitless mode for accounts below the required age. Accepts the
    // post-rename canonical "sensitive" (migration 0027 + commit 60fc8321)
    // as well as the legacy "r18" / "r18g" values still potentially flowing
    // from older clients. Without checking "sensitive", a minor could write
    // "sensitive" directly via this PATCH and bypass the gate.
    const contentLevel = mergedPrefs.contentLevel as string | undefined;
    if (contentLevel === "sensitive" || contentLevel === "r18" || contentLevel === "r18g") {
      const by = existing[0]?.birthYear ?? parsed.data.birthYear;
      if (by && getAgeFromBirthYear(by) < 18) {
        return c.json({ error: "Limitless mode is not available for this account" }, 403);
      }
    }

    updateData = {
      ...updateData,
      // Merge against the locked current row, not the eligibility-check
      // snapshot: another device may just have changed a different key.
      preferences: sql`coalesce(${user.preferences}, '{}'::jsonb) || ${JSON.stringify(parsed.data.preferences)}::jsonb`,
    };
  }

  const result = await db
    .update(user)
    .set(updateData)
    .where(eq(user.id, currentUser.id))
    .returning();
  // name / username / image live in the cached SessionUser.
  await invalidateSessionUser(currentUser.id);

  if (result.length === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  // Route this user's reads to the primary for the next few seconds. Without
  // this, the client's immediate GET /api/users/me refetch reads the lagging
  // read replica and gets the OLD preferences, so a just-saved toggle (content
  // level, blur, etc.) appears to revert / have no effect. Mirrors the other
  // write handlers here (worldClickHistory, ai-config) which already flag.
  flagWrite(currentUser.id);

  const updated = result[0]!;
  const requestedProvider = parsed.data.preferences?.preferredProvider;
  if (requestedProvider === "official" || requestedProvider === "private") {
    // HTTP 200 alone cannot distinguish a saved switch from a stale UI.
    // Record only the mode, never the profile or API key configuration.
    const savedProvider = (updated.preferences as Record<string, unknown> | null)?.preferredProvider;
    try {
      posthog.capture({
        distinctId: currentUser.id,
        event: "provider_preference_saved",
        properties: {
          requested_provider: requestedProvider,
          saved_provider: savedProvider === "private" ? "private" : savedProvider === "official" ? "official" : "unknown",
          confirmed: savedProvider === requestedProvider,
        },
      });
    } catch { /* diagnostics must not change the result of a successful write */ }
  }
  updated.image = resolveImageCdn(updated.image);
  updated.banner = resolveImageCdn(updated.banner);

  return c.json({ data: updated });
  } catch (err) {
    console.error("[USERS] Error updating profile:", err);
    return c.json({ error: "Failed to update profile" }, 500);
  }
});

// GET /api/users/me/ai-config — cross-device AI generation settings
users.get("/me/ai-config", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const [row] = await rd
    .select({ preferences: user.preferences })
    .from(user)
    .where(eq(user.id, currentUser.id))
    .limit(1);
  const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
  const aiConfig = (prefs.aiConfig ?? {}) as Record<string, unknown>;
  return c.json({ data: aiConfig });
});

// PUT /api/users/me/ai-config — partial merge into preferences.aiConfig
users.put("/me/ai-config", authMiddleware, rateLimitMiddleware("profile-updates"), async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => null);
  const parsed = aiConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const [saved] = await db
    .update(user)
    .set({ preferences: sql`coalesce(${user.preferences}, '{}'::jsonb) || jsonb_build_object('aiConfig',
      (CASE WHEN jsonb_typeof(${user.preferences}->'aiConfig') = 'object' THEN ${user.preferences}->'aiConfig' ELSE '{}'::jsonb END)
      || ${JSON.stringify(parsed.data)}::jsonb)`, updatedAt: new Date() })
    .where(eq(user.id, currentUser.id))
    .returning();

  if (!saved) return c.json({ error: 'User not found' }, 404);

  flagWrite(currentUser.id);
  return c.json({ data: saved.preferences?.aiConfig ?? {} });
});

export { users };
