import { worldVersionRoutes } from "./world-versions.js";
import { captureAutomaticVersion, capturePublishVersion, lockVersionDraft } from "../lib/world-version-history.js";
import { communityMuteMiddleware } from "../middleware/community-mute.js";
import { Hono } from "hono";
import { reviewPlaytimeQuery } from "../lib/review-playtime.js";
import { eq, or, and, desc, ilike, sql, inArray, isNotNull } from "drizzle-orm";
import { db, readDb, readOwn, flagWrite } from "../db/index.js";
import { worlds, user, assetReferences, userLibrary, worldPendingEdits, worldUpdates, follows, reviews, worldRatings, contentTranslations, worldReviewSubmissions } from "../db/schema.js";
import { estimateTokens } from "@yumina/engine";
import { generateUploadUrl } from "../lib/s3.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { MAX_REVIEW_CONTENT, clampWorldTags, OFFICIAL_WORLD_TAGS, PLAYED_TAG_FILTER_THRESHOLD, MAX_DYNAMIC_FILTER_TAGS } from "@yumina/shared";
import { canonicalizeTag } from "@yumina/shared";
import { buildHubTagQuery, parseContentLevelParam } from "../lib/hub-tags.js";
import { resolveWorldAudience, resolveWorldAudienceEdit } from "../lib/world-audience.js";
import {
  buildHubBaseFilters,
  createEmptyRecommendationProfile,
  completeRecommendedCatalogPage,
  generateRecommendationCandidates,
  invalidateRecommendationProfile,
  invalidateRecommendationFeed,
  loadRecommendationProfile,
  normalizeHubLanguage,
  normalizeWorldLanguage,
  resolveHubLanguageScope,
  rankRecommendedWorlds,
  recommendedFeedCacheKey,
  readCachedFeedPage,
  writeCachedFeedPage,
} from "../lib/recommendations.js";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.js";
import { createDiscoveryRolloutMiddleware } from "../middleware/discovery-rollout.js";
import { buildDiscoveryInterestQuery, parseDiscoveryStarter } from "../lib/discovery-starter.js";
import { accountDiscoveryStarter, loadStarterAccountPreferences } from "../lib/discovery-starter-preferences.js";
import { withDatabaseQueryTimeout } from "../db/query-deadline.js";
import { rateLimitMiddleware, ipRateLimitMiddleware } from "../middleware/rate-limit.js";
import { env } from "../lib/env.js";
import { serveDiscoveryFeed, DISCOVERY_POLICY_VERSION, DiscoveryCursorError, DiscoveryAdmissionError, discoveryMeasurementEnabled, recordDiscoveryServe } from "../lib/discovery-feed.js";
import { edition } from "../edition/index.js";
import { sanitizeContent } from "../lib/sanitize.js";
import { createWorldSchema, updateWorldSchema } from "@yumina/shared";
import { hasPublishableCover, isDefaultWorldName } from "@yumina/shared";
import { scanWorldSchemaForInlineAssets } from "../lib/asset-validation.js";
import {
  notify,
  notifyMany,
  notifyCoalescedByGroup,
  notifyWorldReview,
  recentWorldRatingNotification,
  removeWorldReviewCommentNotification,
  reviewNotificationExcerpt,
  worldRatingNotificationEventId,
} from "../lib/notify.js";
import { onReview } from "../lib/achievements/engine.js";
import { detectLang } from "../lib/detect-lang.js";
import { translateContent } from "../lib/translate.js";
import { aggregatedCounters } from "../lib/world-aggregates.js";
import { syncSearchDocNormalized } from "../lib/normalize-search.js";
import { captureHubEvent, newFeedRequestId } from "../lib/analytics.js";
import { feedVariantFor, loadEngagementContext, variantUsesEngagement } from "../lib/engagement.js";
import { loadPublishedRankerModel } from "../lib/ranker-model.js";
import { logFeedServe } from "../lib/feed-log.js";
import { loadFeaturedHeroSlots, loadFeaturedSlots } from "../lib/editorial.js";
import { resolveHeroWorlds, type HeroSlot } from "../lib/hero-worlds.js";
import type { AppEnv, SessionUser } from "../lib/types.js";
import { blockedJson, getBlockStatus, listBlockedUsersForHiding } from "../lib/blocks.js";
import { findVariantSiblings, isEligibleForReviewSubmit } from "../lib/review.js";
import { approveGroup } from "../lib/approve-review.js";
import {
  getPendingEdit,
  getPendingEditSummaries,
  planMaterialHold,
  applyHoldPlan,
  summarizePendingEdit,
  resolveWorldCopyMaterial,
  submitPendingEdit,
  withdrawPendingEdit,
  setPendingEditUpdateNote,
} from "../lib/pending-edit.js";
import { isStaleDraftSave } from "../lib/world-save-guard.js";
import { computeWorldContextRequirement } from "../lib/context-requirement.js";
import { hasWorldDmShareGrant } from "../lib/dm-world-grant.js";
import { WORLD_STATUS_TAKEN_DOWN } from "../lib/fork-orphan.js";
import { estimateWorldCopyTokens } from "../lib/world-copy-material.js";
import { parseWorldUpdateNoteBody } from "../lib/world-update-note.js";
import { createWorldUpdateEditRoutes } from "./world-update-edits.js";
import {
  canReadWorldUpdateHistory,
  hasMoreWorldUpdates,
  normalizeWorldUpdateOffset,
  WORLD_UPDATE_PAGE_SIZE,
} from "../lib/world-update-history.js";

const VALID_LANGUAGE_CODES = new Set(["en", "zh", "ja", "ko", "es", "fr", "de", "pt", "ru", "ar"]);


/**
 * Fold typed tags onto their stored form. The alias table used to live here as
 * a hand-kept mirror of the app's copy — fine at ten entries, unmaintainable at
 * ~280, and a divergence between the two forks a tag in storage. Both sides now
 * read the same table from @yumina/shared.
 */
function normalizeTagsForStorage(tags: string[]): string[] {
  const mapped = tags.map((tag) => canonicalizeTag(tag));
  // clampWorldTags de-dupes + caps at MAX_WORLD_TAGS so no storage write —
  // create, update, remix, seed — can exceed the limit even when the caller
  // skipped the create/update Zod schema.
  return clampWorldTags(mapped);
}

const worldRoutes = new Hono<AppEnv>();

/** Compatibility bound for explicit filtered/default feeds. Clean Recommended
 * instead continues through its eligible catalog with bounded page hydration. */
const MAX_FEED_OFFSET = 600;

function isCleanRecommendedQuery(query: Record<string, string>): boolean {
  return query.feed === "recommended" && !query.q?.trim() && !query.tag && !query.tags
    && !query.creatorId && query.followedOnly !== "true";
}

// No global auth — browse routes use optionalAuthMiddleware, write routes use authMiddleware

// Public list rows keep their own native-language fields. The retired Hub
// Translation payload is intentionally absent from hubWorldListSelect.


/**
 * Ensure every language inside a variant group has exactly one primary (主).
 * Only PROMOTES a primary-less language (oldest row wins) — never demotes — so
 * it cannot create a duplicate (safe against worlds_primary_variant_uniq) and is
 * idempotent. Call after any mutation that could leave a language with zero
 * primaries (e.g. a variant's language changing away from where it was the 主).
 */
async function ensureGroupPrimaries(database: typeof db, groupId: string): Promise<void> {
  const rows = await database
    .select({
      id: worlds.id,
      language: worlds.language,
      isPrimaryVariant: worlds.isPrimaryVariant,
      isPublished: worlds.isPublished,
      status: worlds.status,
      createdAt: worlds.createdAt,
    })
    .from(worlds)
    .where(eq(worlds.languageGroupId, groupId));

  const byLang = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.language ?? "";
    const list = byLang.get(key) ?? [];
    list.push(r);
    byLang.set(key, list);
  }

  const isLive = (r: { isPublished: boolean | null; status: string | null }) =>
    r.isPublished === true && r.status === "published";

  for (const list of byLang.values()) {
    if (list.some((r) => r.isPrimaryVariant)) continue; // language already has a 主
    // Promote a published row first (so the hub keeps a live representative),
    // falling back to the oldest row when none are published.
    list.sort((a, b) => {
      const ap = isLive(a) ? 0 : 1;
      const bp = isLive(b) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
    });
    await database.update(worlds).set({ isPrimaryVariant: true }).where(eq(worlds.id, list[0]!.id));
  }
}

/**
 * Matches the source row a fork was *actually* derived from — excluding the
 * author's own translations of their own card.
 *
 * A language variant is usually produced by copying the original and then
 * linking the copy into the same language group (`/import` + `/link-variant`),
 * which leaves `source_world_id` pointing at what is now a sibling. That
 * pointer is lineage, not attribution: rendering it made the English card
 * claim "Based on 绝世唐门 by mia~" — an English card credited to its own
 * Chinese self. Same creator + same language group means translation, so no
 * attribution. A source by a *different* creator stays attributed even inside
 * a shared group (e.g. Abandoned Academy → 废弃学院 by kljws); that credit is
 * real and must not be stripped.
 */
const forkSourceMatch = sql`
  sw.id = ${worlds.sourceWorldId}
  AND NOT (
    sw.creator_id = ${worlds.creatorId}
    AND sw.language_group_id IS NOT NULL
    AND sw.language_group_id = ${worlds.languageGroupId}
  )
`;

/**
 * Correlated subqueries that resolve the original world a fork was derived
 * from. Cheap (PK lookups on `worlds` + `user`) and only fire when
 * `source_world_id` is non-null — otherwise NULL bubbles up cleanly.
 *
 * Drop these into any `.select({...})` returning the WorldItem/HubWorld
 * shape so the client can render "based on X by Y" attribution without
 * needing the source world to be in any local store.
 */
const sourceWorldCols = {
  sourceWorldName: sql<string | null>`(
    SELECT sw.name FROM worlds sw WHERE ${forkSourceMatch}
  )`.as("source_world_name"),
  sourceCreatorId: sql<string | null>`(
    SELECT sw.creator_id FROM worlds sw WHERE ${forkSourceMatch}
  )`.as("source_creator_id"),
  sourceCreatorName: sql<string | null>`(
    SELECT u.name FROM worlds sw JOIN "user" u ON u.id = sw.creator_id WHERE ${forkSourceMatch}
  )`.as("source_creator_name"),
};

// Trigger-maintained derived columns — never extract these from `schema`
// (jsonb extraction detoasts the multi-MB blob per row; see db/schema.ts).
const coverCropCols = {
  coverCrop: worlds.coverCrop,
  galleryCoverCrop: worlds.galleryCoverCrop,
};

const hubWorldListSelect = {
  id: worlds.id,
  gamePath: worlds.gamePath,
  creatorId: worlds.creatorId,
  name: worlds.name,
  description: worlds.description,
  thumbnailUrl: worlds.thumbnailUrl,
  coverCrop: coverCropCols.coverCrop,
  galleryCoverCrop: coverCropCols.galleryCoverCrop,
  isPublished: worlds.isPublished,
  isNsfw: worlds.isNsfw,
  allowEdit: worlds.allowEdit,
  allowCustomApi: worlds.allowCustomApi,
  allowReviews: worlds.allowReviews,
  allowSessionSharing: worlds.allowSessionSharing,
  allowCommunityCitations: worlds.allowCommunityCitations,
  blurCover: worlds.blurCover,
  ageRating: worlds.ageRating,
  targetAudience: worlds.targetAudience,
  visibility: worlds.visibility,
  downloadCount: aggregatedCounters.downloadCount,
  tags: worlds.tags,
  announcement: worlds.announcement,
  totalTokens: worlds.totalTokens,
  approxTime: worlds.approxTime,
  language: worlds.language,
  languageGroupId: worlds.languageGroupId,
  variantLabel: worlds.variantLabel,
  publishedAt: worlds.publishedAt,
  createdAt: worlds.createdAt,
  updatedAt: worlds.updatedAt,
  creatorName: user.name,
  creatorImage: user.image,
  messageCount: aggregatedCounters.messageCount,
  favoriteCount: aggregatedCounters.favoriteCount,
  sourceWorldId: worlds.sourceWorldId,
  sourceWorldName: sourceWorldCols.sourceWorldName,
  sourceCreatorId: sourceWorldCols.sourceCreatorId,
  sourceCreatorName: sourceWorldCols.sourceCreatorName,
};

const hubNewestSortExpr = sql<Date>`COALESCE(${worlds.publishedAt}, ${worlds.reviewedAt}, ${worlds.createdAt})`;

function getOptionalUser(c: { get: (key: "user") => SessionUser }) {
  try {
    return c.get("user");
  } catch {
    return null;
  }
}

function resolveHubMedia<T extends { thumbnailUrl: string | null; creatorImage: string | null }>(rows: T[]): T[] {
  return rows.map((row) => ({
    ...row,
    thumbnailUrl: resolveImageCdn(row.thumbnailUrl),
    creatorImage: resolveImageCdn(row.creatorImage),
  }));
}

function stripRecommendationInternals<
  T extends {
    reviewCount?: number;
    averageRating?: number;
    sourceWorldId?: string | null;
    candidateSource?: unknown;
    normalizedTitleKey?: string;
    // The 1536-dim pgvector used for vector scoring. It rides along on the
    // candidate for ranking but is ~17KB/world — 91% of the feed payload if it
    // leaks to the client (measured 2026-07). The frontend has no such field;
    // strip it here so it stays out of BOTH the response and the feed cache.
    embedding?: unknown;
    embeddingUpdatedAt?: unknown;
  },
>(candidate: T): Omit<T, "reviewCount" | "averageRating" | "sourceWorldId" | "candidateSource" | "normalizedTitleKey" | "embedding" | "embeddingUpdatedAt"> {
  const { reviewCount, averageRating, sourceWorldId, candidateSource, normalizedTitleKey, embedding, embeddingUpdatedAt, ...world } = candidate;
  return world;
}

// GET /api/worlds — list user's worlds + published worlds
worldRoutes.get("/", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  // "Orphaned fork" = the source card was LIVE at some point, is not live now,
  // and belongs to someone else. Reading `is_published` alone could not tell
  // "pulled" from "never published", so it struck through every copy of a
  // DM-shared DRAFT the instant it was made. "Live at some point" needs both
  // `status = 'unpublished'` (catches takedowns predating the published_at
  // backfill) and a non-null `published_at` (catches a card pulled and then
  // reverted to draft). See lib/fork-orphan.ts for the full reasoning — this is
  // its SQL mirror, keep the two in sync.
  const sourceTakenDownSq = sql<boolean | null>`(
    SELECT sw.is_published = false
       AND (sw.status = ${WORLD_STATUS_TAKEN_DOWN} OR sw.published_at IS NOT NULL)
       AND sw.creator_id <> ${worlds.creatorId}
    FROM worlds sw WHERE sw.id = ${worlds.sourceWorldId}
  )`.as("source_world_taken_down");

  // "My Projects" collapses each language group to ONE card — preferring the 主
  // (primary) of the viewer's current UI language, then oldest. Without this a
  // group surfaces every per-language primary (e.g. zh主 + ja主) as duplicate cards.
  const myWorldsLang = normalizeWorldLanguage(c.req.query("lang") ?? null);
  const myWorldsLangPref = myWorldsLang
    ? sql`(w2.language = ${myWorldsLang} OR w2.language LIKE ${`${myWorldsLang}-%`}) DESC, `
    : sql``;

  const result = await rd
    .select({
      id: worlds.id,
      creatorId: worlds.creatorId,
      name: worlds.name,
      description: worlds.description,
      thumbnailUrl: worlds.thumbnailUrl,
      coverCrop: coverCropCols.coverCrop,
      galleryCoverCrop: coverCropCols.galleryCoverCrop,
      isPublished: worlds.isPublished,
      status: worlds.status,
      isNsfw: worlds.isNsfw,
      allowEdit: worlds.allowEdit,
      allowCustomApi: worlds.allowCustomApi,
      allowReviews: worlds.allowReviews,
      allowSessionSharing: worlds.allowSessionSharing,
      allowCommunityCitations: worlds.allowCommunityCitations,
      blurCover: worlds.blurCover,
      ageRating: worlds.ageRating,
      targetAudience: worlds.targetAudience,
      visibility: worlds.visibility,
      downloadCount: aggregatedCounters.downloadCount,
      tags: worlds.tags,
      announcement: worlds.announcement,
      totalTokens: worlds.totalTokens,
      approxTime: worlds.approxTime,
      language: worlds.language,
      languageGroupId: worlds.languageGroupId,
      sourceWorldId: worlds.sourceWorldId,
      sourceWorldTakenDown: sourceTakenDownSq,
      sourceWorldName: sourceWorldCols.sourceWorldName,
      sourceCreatorId: sourceWorldCols.sourceCreatorId,
      sourceCreatorName: sourceWorldCols.sourceCreatorName,
      moderationNote: worlds.moderationNote,
      moderationAction: worlds.moderationAction,
      reviewStatus: worlds.reviewStatus,
      submittedForReviewAt: worlds.submittedForReviewAt,
      rejectionReason: worlds.rejectionReason,
      rejectionDetail: worlds.rejectionDetail,
      createdAt: worlds.createdAt,
      updatedAt: worlds.updatedAt,
      creatorName: user.name,
    })
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(
      and(
        or(eq(worlds.creatorId, currentUser.id), eq(worlds.isPublished, true)),
        // Collapse each language group to ONE representative: the 主 of the
        // viewer's language (then oldest), chosen among own-or-published rows so
        // the creator's own drafts still surface. This keeps multi-language groups
        // from showing one card per language. Other variants stay reachable via
        // the variant tab bar / version picker.
        or(
          sql`${worlds.languageGroupId} IS NULL`,
          sql`${worlds.id} = (
            SELECT w2.id FROM worlds w2
            WHERE w2.language_group_id = ${worlds.languageGroupId}
              AND (w2.creator_id = ${currentUser.id} OR w2.is_published = true)
            ORDER BY w2.is_primary_variant DESC, ${myWorldsLangPref}w2.created_at ASC, w2.id ASC
            LIMIT 1
          )`,
        ),
      ),
    );

  // Held-edit (re-review) state, ONLY for the caller's OWN cards (other people's
  // / discover rows never carry it). Lets "My Projects" surface that a published
  // card has an update 审核中 / 待提交 / 被拒 — the live `worlds.status` stays
  // 'published' and can't show this.
  const ownedIds = result.filter((w) => w.creatorId === currentUser.id).map((w) => w.id);
  const pendingEditMap = await getPendingEditSummaries(ownedIds);

  // Only resolve thumbnails for list view — gallery images resolved lazily in GET /:id
  // My Projects is a creator view and shows each primary variant as-is.
  const resolved = result.map((w) => ({
    ...w,
    thumbnailUrl: resolveImageCdn(w.thumbnailUrl),
    pendingEdit: w.creatorId === currentUser.id ? pendingEditMap.get(w.id) ?? null : null,
  }));

  return c.json({ data: resolved });
});

// GET /api/worlds/mine/published — the caller's own PUBLISHED worlds, lean
// payload (id/name/thumbnail). Backs the community "notify players of specific
// cards" picker. Registered before /:id so "mine" isn't captured as an id.
worldRoutes.get("/mine/published", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const rows = await rd
    .select({ id: worlds.id, name: worlds.name, thumbnailUrl: worlds.thumbnailUrl })
    .from(worlds)
    .where(and(eq(worlds.creatorId, currentUser.id), eq(worlds.isPublished, true)))
    .orderBy(desc(worlds.createdAt));
  return c.json({
    data: rows.map((w) => ({ ...w, thumbnailUrl: resolveImageCdn(w.thumbnailUrl) })),
  });
});

// GET /api/worlds/mine/shareable — the caller's own cards that are eligible to be
// shared into a DM: published (anyone can already see them) plus drafts (the
// recipient gets a preview-only read via the DM grant, see lib/dm-world-grant).
// pending_review / rejected / unpublished are deliberately excluded — a card mid
// review or withdrawn shouldn't travel further than its creator.
//
// Purpose-built and lean rather than reusing GET /api/worlds: that one returns
// own-or-ANY-published rows, i.e. the whole platform's published catalogue, which
// is far too heavy for a picker. Registered before /:id so "mine" isn't read as an id.
worldRoutes.get("/mine/shareable", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "30") || 30, 1), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0") || 0, 0);
  const q = c.req.query("q")?.trim();

  const conditions = [
    eq(worlds.creatorId, currentUser.id),
    inArray(worlds.status, ["published", "draft"]),
    // Collapse each language group to ONE row so a zh/ja/en trio doesn't occupy
    // three picker slots. Prefers the group's primary variant, then the oldest.
    // The representative is picked from among SHAREABLE rows only — mirroring the
    // creator + status filters above. Without the status match here a group whose
    // primary variant sits in review would elect that variant, then fail the outer
    // status filter, and the whole group would vanish from the picker even when it
    // has a perfectly shareable published sibling.
    or(
      sql`${worlds.languageGroupId} IS NULL`,
      sql`${worlds.id} = (
        SELECT w2.id FROM worlds w2
        WHERE w2.language_group_id = ${worlds.languageGroupId}
          AND w2.creator_id = ${currentUser.id}
          AND w2.status IN ('published', 'draft')
        ORDER BY w2.is_primary_variant DESC, w2.created_at ASC, w2.id ASC
        LIMIT 1
      )`,
    ),
  ];
  if (q) conditions.push(ilike(worlds.name, `%${q}%`));

  const rows = await rd
    .select({
      id: worlds.id,
      name: worlds.name,
      description: worlds.description,
      thumbnailUrl: worlds.thumbnailUrl,
      // The creator's saved focal crop. Without it a wide banner cover renders as
      // a meaningless center patch in the picker's small square frame.
      coverCrop: coverCropCols.coverCrop,
      status: worlds.status,
      isPublished: worlds.isPublished,
      allowEdit: worlds.allowEdit,
      tags: worlds.tags,
      language: worlds.language,
      updatedAt: worlds.updatedAt,
      downloadCount: aggregatedCounters.downloadCount,
    })
    .from(worlds)
    .where(and(...conditions))
    .orderBy(desc(worlds.updatedAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  return c.json({
    data: rows.slice(0, limit).map((w) => ({ ...w, thumbnailUrl: resolveImageCdn(w.thumbnailUrl) })),
    hasMore,
  });
});

// GET /api/worlds/hub/tags — popular shortcuts without q; full-catalog tag
// search with q, including rare tags and localized labels. Both follow the
// viewer's content, language and access scope.
worldRoutes.get("/hub/interests", async (c, next) => {
  if (!edition.info().features.hub) return c.notFound();
  return next();
}, optionalAuthMiddleware, ipRateLimitMiddleware(60, 60, 'discovery-interests'), async (c) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie');
  const currentUser = getOptionalUser(c);
  const rd = await readDb(currentUser?.id);
  try {
    const options = await withDatabaseQueryTimeout(2500, async () => {
      const lang = c.req.query('lang') || null;
      const filters = await buildHubBaseFilters(rd, {
        currentUserId: currentUser?.id, lang, feed: 'recommended',
        preferredLang: resolveHubLanguageScope(lang, c.req.query('includeOtherLanguages') === 'true'),
        contentLevelParam: parseContentLevelParam(c.req.query('contentLevel')),
        nsfwOnly: c.req.query('nsfwOnly') === 'true',
      });
      if (filters.noResults) return [];
      const result = await rd.execute(buildDiscoveryInterestQuery(filters.conditions, currentUser?.id));
      return (result.rows as Array<{ id: string; family_count: number }>).map(row => ({ id: row.id, familyCount: Number(row.family_count) }));
    });
    return c.json({ options });
  } catch {
    c.header('Retry-After', '5');
    return c.json({ error: 'Interests are temporarily unavailable' }, 503);
  }
});

worldRoutes.get("/hub/tags", optionalAuthMiddleware, async (c) => {
  const currentUser = getOptionalUser(c);
  const rd = await readDb(currentUser?.id);
  const result = await rd.execute(buildHubTagQuery({
    currentUserId: currentUser?.id,
    query: c.req.query("q"),
    lang: c.req.query("lang"),
    contentLevel: c.req.query("contentLevel"),
    includeOtherLanguages: c.req.query("includeOtherLanguages") === "true",
    nsfwOnly: c.req.query("nsfwOnly") === "true",
    limit: parseInt(c.req.query("limit") || "20"),
  }));
  const tags = (result.rows as Array<{ tag: string; count: string }>).map((r) => ({
    tag: r.tag,
    count: Number(r.count),
  }));
  c.header("Vary", "Cookie");
  c.header("Cache-Control", currentUser
    ? "private, no-store"
    : "public, max-age=0, s-maxage=300, stale-while-revalidate=600");
  return c.json({ data: tags });
});

// GET /api/worlds/hub/my-filter-tags — the viewer's earned dynamic filter tags.
// A non-official tag surfaces once PLAYED_TAG_FILTER_THRESHOLD distinct cards
// the player has actually played carry it ("played" = a non-ephemeral session
// with at least one user message, so opening a card or Studio playtests don't
// count). The 7 official tags are excluded — the filter always shows those.
worldRoutes.get("/hub/my-filter-tags", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  // Own play history → primary (readOwn), never the replica.
  const rd = await readOwn(currentUser.id);
  const officialList = sql.join(
    OFFICIAL_WORLD_TAGS.map((tag) => sql`${tag}`),
    sql`, `
  );
  const result = await rd.execute(
    sql`SELECT tag.value AS tag, COUNT(DISTINCT ps.world_id) AS count
        FROM play_sessions ps
        JOIN worlds w ON w.id = ps.world_id
        CROSS JOIN LATERAL jsonb_array_elements_text(w.tags) AS tag(value)
        WHERE ps.user_id = ${currentUser.id}
          AND ps.ephemeral = false
          AND tag.value NOT IN (${officialList})
          AND EXISTS (
            SELECT 1 FROM messages m
            WHERE m.session_id = ps.id AND m.role = 'user'
          )
        GROUP BY tag.value
        HAVING COUNT(DISTINCT ps.world_id) >= ${PLAYED_TAG_FILTER_THRESHOLD}
        ORDER BY count DESC, tag.value
        LIMIT ${MAX_DYNAMIC_FILTER_TAGS}`
  );
  const tags = (result.rows as Array<{ tag: string; count: string }>).map((r) => ({
    tag: r.tag,
    count: Number(r.count),
  }));
  return c.json({ data: tags });
});

// GET /api/worlds/hub/hero-worlds - editorially curated hero worlds.
//
// Source of truth is the featured_hero_worlds DB table for the requested
// language (admin-editable via /api/admin/editorial/hero-worlds/*). Migration
// 0028 seeds the legacy hardcoded slots so day-one behavior is preserved.
//
// If the table is missing (pre-0028 environment) or the query throws, we
// return an empty list rather than fall back to a stale hardcoded copy —
// admins should clear via the admin UI, not by code.
worldRoutes.get("/hub/hero-worlds", optionalAuthMiddleware, async (c) => {
  const currentUser = getOptionalUser(c);
  const rd = await readDb(currentUser?.id);
  const preferredLang = normalizeHubLanguage(c.req.query("lang")) ?? "en";
  const contentLevelParam = parseContentLevelParam(c.req.query("contentLevel"));

  let slots: HeroSlot[];
  try {
    const dbSlots = await loadFeaturedHeroSlots(rd, preferredLang);
    slots = dbSlots;
  } catch {
    // featured_hero_worlds table missing (migration 0028 hasn't run) — return
    // an empty list. Better to render a blank carousel than reintroduce a
    // hardcoded copy that drifts from what admins see in the editorial page.
    slots = [];
  }

  const worldIds = slots.filter((slot) => slot.kind === "world").map((slot) => slot.id);
  const groupIds = slots.filter((slot) => slot.kind === "group").map((slot) => slot.id);
  const slotCondition =
    worldIds.length > 0 && groupIds.length > 0
      ? or(inArray(worlds.id, worldIds), inArray(worlds.languageGroupId, groupIds))
      : worldIds.length > 0
        ? inArray(worlds.id, worldIds)
        : groupIds.length > 0
          ? inArray(worlds.languageGroupId, groupIds)
          : undefined;

  if (!slotCondition) {
    return c.json({ data: [] });
  }

  const baseFilters = await buildHubBaseFilters(rd, {
    currentUserId: currentUser?.id,
    contentLevelParam,
    preferredLang,
    includeLanguageVariants: true,
  });

  if (baseFilters.noResults) {
    return c.json({ data: [] });
  }

  const result = await rd
    .select({ ...hubWorldListSelect, isPrimaryVariant: worlds.isPrimaryVariant })
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(...baseFilters.conditions, slotCondition))
    .orderBy(desc(worlds.updatedAt), desc(worlds.createdAt));

  const mediaResolved = resolveHubMedia(result);
  const ordered = resolveHeroWorlds(slots, mediaResolved, preferredLang);

  c.header("Cache-Control", currentUser ? "private, max-age=30, stale-while-revalidate=120" : "public, max-age=0, s-maxage=120, stale-while-revalidate=300");
  c.header("Vary", "Cookie");
  return c.json({ data: ordered });
});

// GET /api/worlds/batch - fetch multiple worlds by ID (for featured section, etc.)
worldRoutes.get("/batch", optionalAuthMiddleware, async (c) => {
  const currentUser = getOptionalUser(c);
  const idsParam = c.req.query("ids");
  if (!idsParam) return c.json({ data: [] });
  const ids = idsParam.split(",").slice(0, 20); // Max 20
  if (ids.length === 0) return c.json({ data: [] });

  const rd = await readDb();
  const result = await rd
    .select(hubWorldListSelect)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(
      inArray(worlds.id, ids),
      eq(worlds.isPublished, true),
      // Guests never receive Limitless rows, even by direct ID.
      ...(currentUser ? [] : [eq(worlds.ageRating, "all")]),
    ));

  const mediaResolved = resolveHubMedia(result);

  // Preserve requested order
  const byId = new Map(mediaResolved.map((w) => [w.id, w]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  c.header("Cache-Control", "public, max-age=0, s-maxage=120, stale-while-revalidate=300");
  return c.json({ data: ordered });
});

// GET /api/worlds/hub — public browse
const discoveryRateLimit = ipRateLimitMiddleware(180, 60, "discovery");
worldRoutes.get("/hub", async (c, next) => {
  if (!edition.info().features.hub) return c.notFound();
  return next();
}, optionalAuthMiddleware, createDiscoveryRolloutMiddleware({
  secret: env.BETTER_AUTH_SECRET, rateLimit: discoveryRateLimit,
}), async (c, next) => {
  // The cohort middleware limits only admitted cursor traffic. Baseline and
  // positive-offset continuation need the same origin protection independently.
  if (!c.get("discoveryCursorActor") && isCleanRecommendedQuery(c.req.query())) {
    const response = await discoveryRateLimit(c, next);
    if (response instanceof Response) {
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("CDN-Cache-Control", "no-store");
      response.headers.set("Vary", "Cookie");
      return response;
    }
    return;
  }
  return next();
}, async (c) => {
  try {
  const currentUser = getOptionalUser(c);
  const cursorActor = c.get("discoveryCursorActor");
  const cursorRequested = cursorActor !== undefined;
  const rd = cursorRequested ? db : await readDb(currentUser?.id);
  const lang = c.req.query("lang") || null;
  const includeOtherLanguages = c.req.query("includeOtherLanguages") === "true";
  const preferredLang = resolveHubLanguageScope(lang, includeOtherLanguages);
  const q = c.req.query("q")?.trim();
  const tag = c.req.query("tag");
  const tagsParam = c.req.query("tags");
  const sort = c.req.query("sort") === "popular" ? "popular" : "newest";
  const feed = c.req.query("feed") === "recommended" ? "recommended" : "default";
  const showNsfwParam = c.req.query("showNsfw") === "true";
  const contentLevelParam = parseContentLevelParam(c.req.query("contentLevel"));
  const nsfwOnly = c.req.query("nsfwOnly") === "true";
  const creatorId = c.req.query("creatorId");
  const followedOnly = c.req.query("followedOnly") === "true";
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50") || 50, 1), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0") || 0, 0);
  const completeCatalog = isCleanRecommendedQuery(c.req.query());
  // Account preferences are canonical across browsers, including an untouched
  // account. Read primary before the output-cache lookup; reuse this snapshot
  // for content/audience filtering instead of performing a second prefs read.
  const accountPreferences = completeCatalog && currentUser
    ? await loadStarterAccountPreferences(db, currentUser.id) : undefined;
  let starter: ReturnType<typeof parseDiscoveryStarter>;
  try { starter = completeCatalog
    ? currentUser ? accountDiscoveryStarter(accountPreferences ?? null) : parseDiscoveryStarter(c.req.query())
    : undefined; }
  catch { return c.json({ error: 'Invalid discovery interests' }, 400); }
  if (completeCatalog && !Number.isSafeInteger(offset)) {
    return c.json({ error: "Invalid recommendation offset" }, 400);
  }
  // Clean Recommended has a bounded ranked head plus catalog continuation.
  // Keep the older cap only for other feed modes; request limits and query
  // deadlines protect Recommended without inventing an end to its inventory.
  if (!cursorRequested && !completeCatalog && offset >= MAX_FEED_OFFSET) {
    return c.json({ data: [], total: offset, feedRequestId: null });
  }

  // Phase 3 (analytics): id scoping this particular hub response. Shared
  // between the recommended + default code paths so callers don't care
  // which one served them. Returned in the JSON body so the client can
  // echo it back on every hub_impression / hub_click emitted from cards
  // that came from this response.
  const feedRequestId = newFeedRequestId();
  // Ship-2 ranking experiment arms. The model handle is process-cached
  // (5-min DB head poll) so this await is ~free. No published model →
  // 50/50 control/engage_v1; model published → 20/40/40 with engage_v2.
  // Guests single-arm on the best-known treatment (shared CF-cached feed).
  const rankerModel = await loadPublishedRankerModel(rd);
  const rankingVariant = feedVariantFor(currentUser?.id, rankerModel !== null);
  // Per-visit rotation (2026-08-20): authed treatment users get a 45-min
  // "visit bucket" that seeds a small score jitter + newcomer rotation, so
  // returning to Discover shows a freshly ordered feed while pages WITHIN
  // one visit stay coherent (offset pagination must not reshuffle mid-
  // scroll). The bucket rides the feed cache key so a new visit is a
  // cache miss by construction. Guests stay deterministic (shared cache).
  const rotationBucket =
    currentUser && rankingVariant !== "control"
      ? String(Math.floor(Date.now() / 2_700_000))
      : null;
  const rotationSeed = rotationBucket ? `${currentUser!.id}:${rotationBucket}` : null;
  // Analytics surface: coarse bucket that pairs with the client-side
  // HubCard `surface` prop. Keeps dashboards comparable.
  const analyticsSurface: "recommended" | "popular" | "newest" | "following" | "search" =
    q
      ? "search"
      : followedOnly
        ? "following"
        : feed === "recommended"
          ? "recommended"
          : sort === "popular"
            ? "popular"
            : "newest";

  const baseFilters = await buildHubBaseFilters(rd, {
    currentUserId: currentUser?.id,
    accountPreferences,
    q,
    tag,
    tagsParam,
    contentLevelParam,
    showNsfwParam,
    nsfwOnly,
    creatorId,
    followedOnly,
    lang,
    feed,
    preferredLang,
  });

  if (baseFilters.noResults) {
    return c.json({ data: [], total: 0 });
  }

  const whereClause = and(...baseFilters.conditions);

  if (cursorActor) {
    try {
      const startedAt = performance.now();
      const page = await serveDiscoveryFeed(rd, {
        actor: cursorActor,
        userId: currentUser?.id, filters: baseFilters, limit, nsfwOnly, cursor: c.req.query("cursor"), starter,
      });
      const data = resolveHubMedia(page.data.map(stripRecommendationInternals) as any[]);
      let attributionToken: string | undefined;
      if (discoveryMeasurementEnabled()) {
        try {
          attributionToken = await recordDiscoveryServe(db, page, cursorActor, env.BETTER_AUTH_SECRET);
        } catch {
          // Missing telemetry must never invent an attributable opportunity or
          // make a healthy feed unavailable. Coverage monitors count this gap.
          console.warn("[discovery-measurement] serving snapshot unavailable");
        }
      }
      if (!c.req.raw.signal?.aborted) {
        logFeedServe({ id: page.feedRequestId, userId: currentUser?.id ?? null, surface: "recommended", feed,
          tier: page.tier, variant: page.variant, lang: baseFilters.preferredLang, offset: page.offset, worldIds: page.servedIds });
        captureHubEvent(currentUser?.id, "hub_serve", {
          feed_request_id: page.feedRequestId, feed, surface: "recommended", sort, has_query: false, tag_count: 0,
          offset: page.offset, limit, returned_count: data.length, total_count: null,
          world_ids: page.ids, tier: page.tier, variant: page.variant, cache: "cursor",
          policy_version: DISCOVERY_POLICY_VERSION, catalog_scans: page.scans,
          duration_ms: Math.round(performance.now() - startedAt), has_more: page.hasMore,
          measurement_status: discoveryMeasurementEnabled() ? (attributionToken ? "recorded" : "unavailable") : "off",
          snapshot_bytes: attributionToken ? Buffer.byteLength(JSON.stringify(page.snapshots), "utf8") : 0,
        });
      }
      return c.json({ data, feedRequestId: page.feedRequestId, offset: page.offset,
        positions: page.positions, nextCursor: page.nextCursor, hasMore: page.hasMore, ...(attributionToken ? { attributionToken } : {}) });
    } catch (error) {
      if (error instanceof DiscoveryCursorError) {
        return c.json({ error: "Your Discover session has changed. Refresh to continue.", code: "discovery_cursor_expired" }, 409);
      }
      if (error instanceof DiscoveryAdmissionError && !c.req.query("cursor")) {
        // Finished visits and other filter scopes still occupy bounded Redis
        // slots until expiry. A new visit can use the existing offset feed;
        // its positive-offset requests stay on that transport in middleware.
        // Never replace an established cursor stream or weaken storage caps.
        console.warn("[discovery] fresh session capacity reached; serving baseline feed:", error.scope);
      } else {
        console.warn("[discovery] cursor page failed:", error instanceof Error ? error.message : error);
        c.header("Retry-After", "1");
        return c.json({ error: "Discover is temporarily unavailable. Please retry.", code: "discovery_retry" }, 503);
      }
    }
  }

  if (feed === "recommended") {
    // Only the CLEAN discovery path participates in the output cache: no search,
    // no tag/creator narrowing, not followed-only. Those variants are rarer and
    // narrower (already cheap) and would explode the key space. Everything that
    // changes the OUTPUT is encoded in the key — user/guest, lang, sort, the
    // EFFECTIVE contentLevel + nsfwOnly (so a safe-mode user is never served a
    // cached adult feed), and the page window.
    const feedCacheKey =
      !q && baseFilters.tagList.length === 0 && !creatorId && !baseFilters.followedOnly
        ? recommendedFeedCacheKey({
            userId: currentUser?.id,
            preferredLang: baseFilters.preferredLang,
            sort,
            contentLevel: baseFilters.contentLevel,
            nsfwOnly,
            offset,
            limit,
            rotationBucket,
            starterKey: starter?.key,
          })
        : null;

    if (feedCacheKey) {
      const cached = await readCachedFeedPage(feedCacheKey);
      if (cached) {
        // Cache hit: skip the entire ~2s pipeline (profile load + multi-route
        // candidate SQL + listwise rerank + variant resolution). One Redis GET.
        if (!c.req.raw.signal?.aborted) {
          const cachedWorldIds = (cached.data as Array<{ id?: string }>)
            .map((w) => w.id)
            .filter((id): id is string => typeof id === "string");
          captureHubEvent(currentUser?.id, "hub_serve", {
            feed_request_id: feedRequestId,
            feed: "recommended",
            surface: analyticsSurface,
            sort,
            has_query: false,
            tag_count: 0,
            offset,
            limit,
            returned_count: cached.data.length,
            total_count: cached.total,
            world_ids: cachedWorldIds,
            tier: cached.tier,
            cache: "hit",
            starter_policy: starter ? 'catalog-hints-v1' : null,
            variant: rankingVariant,
          });
          // Cache hits are still slates the user saw — log them or the
          // training data under-counts exposure for popular pages.
          logFeedServe({
            id: feedRequestId,
            userId: currentUser?.id ?? null,
            surface: analyticsSurface,
            feed: "recommended",
            tier: cached.tier,
            variant: rankingVariant,
            lang: baseFilters.preferredLang,
            offset,
            worldIds: cachedWorldIds,
          });
        }
        c.header("Cache-Control", currentUser ? "private, max-age=30, stale-while-revalidate=120" : "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
        c.header("Vary", "Cookie");
        return c.json({ data: cached.data, total: cached.total, feedRequestId });
      }
    }

    try {
      // Profile (taste), engagement (stats + dismissals + fatigue +
      // session signals), and the user's recent plays (co_played seeds)
      // load in parallel — none adds meaningful latency to the profile's
      // 5-query load, and all of this only runs on feed-cache misses.
      const [profile, engagement, recentPlayedRows] = await Promise.all([
        currentUser
          ? loadRecommendationProfile(rd, currentUser.id, baseFilters.preferredLang)
          : Promise.resolve(createEmptyRecommendationProfile()),
        loadEngagementContext(rd, currentUser?.id ?? null, rankingVariant, { model: rankerModel, rotationSeed }),
        currentUser
          ? rd
              .select({ worldId: userLibrary.worldId })
              .from(userLibrary)
              .where(and(eq(userLibrary.userId, currentUser.id), isNotNull(userLibrary.lastPlayedAt)))
              .orderBy(desc(userLibrary.lastPlayedAt))
              .limit(5)
          : Promise.resolve([] as Array<{ worldId: string }>),
      ]);
      // The ranker model's tier features and the user's revealed craft
      // taste come from the profile, which loads in parallel with the
      // context — attach them now.
      engagement.tier = profile.tier;
      engagement.craft = profile.craftAffinity;
      // Dismissals are product behavior, not an experiment: both arms
      // honor them. Search still bypasses exclusions (matchesFilters), so
      // a dismissed world stays findable by name.
      for (const id of engagement.dismissedWorldIds) {
        profile.excludedWorldIds.add(id);
      }
      const candidates = await generateRecommendationCandidates(rd, {
        profile,
        filters: baseFilters,
        sort,
        coPlayedSeedIds: recentPlayedRows.map((r) => r.worldId),
        starter,
      });

      const ranking = rankRecommendedWorlds(candidates, profile, {
        starter,
        sort,
        limit: completeCatalog ? candidates.length : limit,
        offset: completeCatalog ? 0 : offset,
        // ALL treatment arms (engage_v1 AND engage_v2) must receive the
        // engagement context — v2 is where the learned model lift lives.
        // This was `=== "engage_v1"` (written in Ship 1 before v2 existed),
        // which silently made engage_v2 score byte-identically to control:
        // the published model never ran and v2 users lost session/craft/
        // fatigue/coPlay/rotation too. See variantUsesEngagement (pinned by
        // test); scoreEngagement + injectDeepExploration already no-op for
        // control, so passing it for every non-control arm is correct.
        engagement: variantUsesEngagement(rankingVariant) ? engagement : undefined,
        filters: {
          query: q,
          tagList: baseFilters.tagList,
          contentLevel: baseFilters.contentLevel,
          nsfwOnly,
          creatorId,
          followedOnly: baseFilters.followedOnly,
          followedCreatorIds:
            baseFilters.followedCreatorIds.length > 0
              ? baseFilters.followedCreatorIds
              : profile.followedCreatorIds,
        },
      });

      const ranked = completeCatalog
        ? await completeRecommendedCatalogPage(rd, ranking.data, baseFilters, { userId: currentUser?.id, offset, limit })
        : ranking;

      const stripped = ranked.data.map((candidate) => stripRecommendationInternals(candidate));
      const mediaResolved = resolveHubMedia(stripped as any[]);

      // Populate the output cache. Fire-and-forget: never add a Redis round-trip
      // to the (already slow) cold path before responding. The helper swallows
      // its own errors, so there's no unhandled rejection to worry about.
      if (feedCacheKey) {
        void writeCachedFeedPage(feedCacheKey, currentUser?.id, {
          data: mediaResolved,
          total: ranked.total,
          tier: profile.tier,
        });
      }

      // Phase 3 analytics: log which worlds we served, in rank order, so
      // joining against client hub_impression / hub_click events yields
      // CTR-by-position and per-surface funnel data. Skip the emit when
      // the client has already disconnected (e.g. React-strict-mode dev
      // double-fire abort, navigation, tab close) — the response will
      // never reach the user, no impressions/clicks can join, so the
      // event would just inflate hub_serve count without ever closing
      // a funnel.
      if (!c.req.raw.signal?.aborted) {
        const servedWorldIds = mediaResolved
          .map((w) => w.id)
          .filter((id): id is string => typeof id === "string");
        captureHubEvent(currentUser?.id, "hub_serve", {
          feed_request_id: feedRequestId,
          feed: "recommended",
          surface: analyticsSurface,
          sort,
          has_query: Boolean(q),
          tag_count: baseFilters.tagList.length,
          offset,
          limit,
          returned_count: mediaResolved.length,
          total_count: ranked.total,
          world_ids: servedWorldIds,
          tier: profile.tier,
          cache: "miss",
          starter_policy: starter ? 'catalog-hints-v1' : null,
          variant: rankingVariant,
        });
        logFeedServe({
          id: feedRequestId,
          userId: currentUser?.id ?? null,
          surface: analyticsSurface,
          feed: "recommended",
          tier: profile.tier,
          variant: rankingVariant,
          lang: baseFilters.preferredLang,
          offset,
          worldIds: servedWorldIds,
        });
      }

      // Guests get a deterministic empty-profile feed → edge-cache it so CF serves
      // it instead of recomputing the ~2s ranking on every load. Authed is
      // personalized → short PRIVATE browser cache for instant re-navigation, never
      // CDN. Vary:Cookie keeps the guest-cached copy from being served to authed
      // users. (2026-06-05 Discover-latency fix — was unconditional no-store.)
      c.header("Cache-Control", currentUser ? "private, max-age=30, stale-while-revalidate=120" : "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
      c.header("Vary", "Cookie");
      return c.json({ data: mediaResolved, total: ranked.total, feedRequestId });
    } catch (error) {
      if (completeCatalog) {
        // A timeout/outage is not exhaustion and must not switch this stream
        // to a differently ordered feed without Library exclusions.
        console.warn("[HUB] Recommended catalog page unavailable");
        c.header("Cache-Control", "private, no-store");
        c.header("CDN-Cache-Control", "no-store");
        c.header("Vary", "Cookie");
        c.header("Retry-After", "1");
        return c.json({ error: "Discover is temporarily unavailable. Please retry.", code: "discovery_retry" }, 503);
      }
      console.warn("[HUB] Recommended feed failed, falling back to default sort:", error);
    }
  }

  // Phase 2: when the user is searching, order by relevance first (ts_rank)
  // and only use popular/newest as a tiebreaker. Keeps results clustered
  // by "how well does this match your query" rather than "when was it
  // published." Without a query, use the existing feed sort unchanged.
  // Phase 2.5: only the Latin-friendly search_doc has tsvector ranking;
  // trad↔simp matches on the normalized text column don't contribute
  // to the rank but still appear in results via the WHERE clause OR.
  const trimmedQuery = q?.trim();
  const newestOrder = desc(hubNewestSortExpr);
  const popularOrder = desc(aggregatedCounters.downloadCount);
  const orderBy = trimmedQuery
    ? [
        sql`ts_rank_cd(${worlds.searchDoc}, plainto_tsquery('simple', ${trimmedQuery})) DESC`,
        ...(sort === "popular" ? [popularOrder, newestOrder] : [newestOrder, popularOrder]),
      ]
    : sort === "popular"
      ? [popularOrder, newestOrder]
      : [newestOrder, popularOrder];

  const [result, countResult] = await Promise.all([
    rd
      .select(hubWorldListSelect)
      .from(worlds)
      .leftJoin(user, eq(worlds.creatorId, user.id))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    rd
      .select({ count: sql<number>`count(*)::int` })
      .from(worlds)
      .where(whereClause),
  ]);

  const mediaResolved = resolveHubMedia(result);

  // Phase 3 analytics: log every served feed — not just the recommended
  // path — so we can compare CTR across surfaces. `tier` is null here
  // because we didn't build a profile on the default path. Skip when the
  // client has disconnected — see the recommended-feed branch for why.
  if (!c.req.raw.signal?.aborted) {
    const servedWorldIds = mediaResolved
      .map((w) => w.id)
      .filter((id): id is string => typeof id === "string");
    captureHubEvent(currentUser?.id, "hub_serve", {
      feed_request_id: feedRequestId,
      feed: "default",
      surface: analyticsSurface,
      sort,
      has_query: Boolean(q),
      tag_count: baseFilters.tagList.length,
      offset,
      limit,
      returned_count: mediaResolved.length,
      total_count: countResult[0]?.count ?? 0,
      world_ids: servedWorldIds,
      tier: null,
    });
    logFeedServe({
      id: feedRequestId,
      userId: currentUser?.id ?? null,
      surface: analyticsSurface,
      feed: "default",
      tier: null,
      variant: rankingVariant,
      lang: baseFilters.preferredLang,
      offset,
      worldIds: servedWorldIds,
    });
  }

  // Guest browsing: Cloudflare serves cached for 60s, stale-while-revalidate for 5min
  // Authenticated: personalized → short private browser cache (instant re-nav), never CDN
  c.header("Cache-Control", currentUser ? "private, max-age=30, stale-while-revalidate=120" : "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  c.header("Vary", "Cookie");
  return c.json({ data: mediaResolved, total: countResult[0]?.count ?? 0, feedRequestId });
  } catch (err) {
    console.error("[HUB] Error fetching hub data:", err);
    return c.json({ error: "Failed to load discover feed" }, 500);
  }
});

// GET /api/worlds/featured — public, returns editorial featured worlds in slot order
worldRoutes.get("/featured", optionalAuthMiddleware, async (c) => {
  const preferredLang = normalizeHubLanguage(c.req.query("lang"));
  let currentUser: { id: string } | null = null;
  try { currentUser = c.get("user"); } catch { /* anonymous */ }
  const rd = await readDb(currentUser?.id);

  const slots = await loadFeaturedSlots(rd);
  if (slots.length === 0) return c.json({ data: [] });
  const ids = slots.map((s) => s.worldId);

  const rows = await rd
    .select(hubWorldListSelect)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(
      eq(worlds.isPublished, true),
      eq(worlds.status, "published"),
      inArray(worlds.id, ids),
      // Guests never receive Limitless rows in the featured rail.
      ...(currentUser ? [] : [eq(worlds.ageRating, "all")]),
    ));

  // Editorial slots historically pin one concrete world ID. When that world
  // belongs to a language group, select the viewer's real published sibling
  // row instead of painting that sibling's fields onto the pinned ID. This
  // keeps the featured card and the preview/detail route on the same variant.
  const groupIds = [...new Set(rows
    .map((row) => row.languageGroupId)
    .filter((groupId): groupId is string => Boolean(groupId)))];
  const preferredByGroup = new Map<string, (typeof rows)[number]>();
  if (preferredLang && groupIds.length > 0) {
    const langPrefix = `${preferredLang}-%`;
    const preferredRows = await rd
      .select(hubWorldListSelect)
      .from(worlds)
      .leftJoin(user, eq(worlds.creatorId, user.id))
      .where(and(
        inArray(worlds.languageGroupId, groupIds),
        eq(worlds.isPublished, true),
        eq(worlds.status, "published"),
        // Featured slots are public surface — never swap in a followers-only
        // sibling a non-follower can't open.
        eq(worlds.visibility, "public"),
        ...(currentUser ? [] : [eq(worlds.ageRating, "all")]),
        or(
          eq(worlds.language, preferredLang),
          sql`${worlds.language} LIKE ${langPrefix}`,
        ),
      ))
      .orderBy(
        sql`CASE WHEN ${worlds.language} = ${preferredLang} THEN 0 ELSE 1 END`,
        desc(worlds.isPrimaryVariant),
        worlds.createdAt,
        worlds.id,
      );
    for (const row of preferredRows) {
      if (row.languageGroupId && !preferredByGroup.has(row.languageGroupId)) {
        preferredByGroup.set(row.languageGroupId, row);
      }
    }
  }

  // Preserve slot order
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = slots
    .map((slot) => {
      const pinned = byId.get(slot.worldId);
      return pinned?.languageGroupId
        ? preferredByGroup.get(pinned.languageGroupId) ?? pinned
        : pinned;
    })
    .filter((r): r is NonNullable<typeof r> => !!r);

  const mediaResolved = resolveHubMedia(ordered);

  c.header("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
  return c.json({ data: mediaResolved });
});

// GET /api/worlds/:id/activity — aggregate engagement shown in Library details.
// Published worlds expose only anonymous totals. Draft/review/unpublished rows
// stay creator-only, matching the detail route's content-access boundary.
worldRoutes.get("/:id/activity", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const currentUser = c.get("user");
  const rd = currentUser ? await readOwn(currentUser.id) : await readDb();

  const [world] = await rd
    .select({
      creatorId: worlds.creatorId,
      isPublished: worlds.isPublished,
      status: worlds.status,
      totalUniquePlayers: sql<number>`(
        SELECT count(DISTINCT ps.user_id)::int
        FROM play_sessions ps
        WHERE ps.ephemeral = false
          AND ps.world_id IN (
            SELECT w_activity.id
            FROM worlds w_activity
            WHERE w_activity.id = ${worldId}
               OR (
                 w_activity.language_group_id IS NOT NULL
                 AND w_activity.language_group_id = worlds.language_group_id
               )
          )
      )`,
      avgSessionSeconds: sql<number>`(
        SELECT COALESCE(round(avg(COALESCE(ps.playtime_seconds, 0))), 0)::int
        FROM play_sessions ps
        WHERE ps.ephemeral = false
          AND ps.world_id IN (
            SELECT w_activity.id
            FROM worlds w_activity
            WHERE w_activity.id = ${worldId}
               OR (
                 w_activity.language_group_id IS NOT NULL
                 AND w_activity.language_group_id = worlds.language_group_id
               )
          )
      )`,
      averageRating: aggregatedCounters.averageRating,
      reviewCount: aggregatedCounters.reviewCount,
    })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);

  if (!world) return c.json({ error: "World not found" }, 404);

  const worldStatus = world.status ?? (world.isPublished ? "published" : "draft");
  const isCreator = currentUser?.id === world.creatorId;
  if (worldStatus !== "published" && !isCreator) {
    return c.json({ error: "World not found" }, 404);
  }

  c.header(
    "Cache-Control",
    currentUser
      ? "private, no-store"
      : "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
  );
  c.header("Vary", "Cookie");
  return c.json({
    data: {
      totalUniquePlayers: Number(world.totalUniquePlayers ?? 0),
      avgSessionSeconds: Number(world.avgSessionSeconds ?? 0),
      averageRating: Number(world.averageRating ?? 0),
      reviewCount: Number(world.reviewCount ?? 0),
    },
  });
});

// GET /api/worlds/:id — public (for published worlds)
worldRoutes.get("/:id", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  let currentUser: { id: string } | null = null;
  try { currentUser = c.get("user"); } catch { /* unauthenticated */ }
  // Editor's own view (forEdit=1) must reflect writes immediately. The Studio agent
  // writes the master over a minutes-long streaming run; the 5s read-after-write flag
  // (set at stream-open) is long expired by the time the editor refreshes, so readDb()
  // would route to a lagging replica and show stale pre-edit content ("AI changes lost").
  // forEdit reads are creator/admin-gated + low volume → always serve from primary.
  // Public (non-forEdit) detail views stay on the replica for browse load-shedding.
  const forEdit = c.req.query("forEdit") === "1";
  const rd = forEdit ? db : await readDb(currentUser?.id);
  const isPreview = c.req.query("preview") === "true";

  // Preview mode: return only display fields (excludes multi-MB schema JSONB)
  const result = isPreview
    ? await rd.select({
        id: worlds.id,
        creatorId: worlds.creatorId,
        name: worlds.name,
        description: worlds.description,
        thumbnailUrl: worlds.thumbnailUrl,
        coverCrop: coverCropCols.coverCrop,
        galleryCoverCrop: coverCropCols.galleryCoverCrop,
        isPublished: worlds.isPublished,
        status: worlds.status,
        submittedForReviewAt: worlds.submittedForReviewAt,
        isNsfw: worlds.isNsfw,
        allowEdit: worlds.allowEdit,
        allowCustomApi: worlds.allowCustomApi,
        allowReviews: worlds.allowReviews,
        allowSessionSharing: worlds.allowSessionSharing,
        allowCommunityCitations: worlds.allowCommunityCitations,
        blurCover: worlds.blurCover,
        ageRating: worlds.ageRating,
        targetAudience: worlds.targetAudience,
        visibility: worlds.visibility,
        downloadCount: aggregatedCounters.downloadCount,
        messageCount: aggregatedCounters.messageCount,
        favoriteCount: aggregatedCounters.favoriteCount,
        tags: worlds.tags,
        galleryImages: worlds.galleryImages,
        announcement: worlds.announcement,
        totalTokens: worlds.totalTokens,
        approxTime: worlds.approxTime,
        language: worlds.language,
        languageGroupId: worlds.languageGroupId,
        gamePath: worlds.gamePath,
        multilanguageOverview: worlds.multilanguageOverview,
        createdAt: worlds.createdAt,
        updatedAt: worlds.updatedAt,
        creatorName: user.name,
        creatorImage: user.image,
        sourceWorldId: worlds.sourceWorldId,
        sourceWorldName: sourceWorldCols.sourceWorldName,
        sourceCreatorId: sourceWorldCols.sourceCreatorId,
        sourceCreatorName: sourceWorldCols.sourceCreatorName,
      }).from(worlds).leftJoin(user, eq(worlds.creatorId, user.id)).where(eq(worlds.id, worldId))
    : await rd.select().from(worlds).where(eq(worlds.id, worldId));

  if (result.length === 0) {
    return c.json({ error: "World not found" }, 404);
  }

  const world = result[0]!;

  // Access control: status-based with library tombstone support
  const isCreator = currentUser && world.creatorId === currentUser.id;
  const worldStatus = world.status ?? (world.isPublished ? "published" : "draft");

  // Admins can read any world regardless of status (for moderation inspect).
  // Resolved lazily so we don't pay a role lookup for the published-world hot path.
  let isAdmin = false;
  async function ensureAdminFlag() {
    if (!currentUser || isAdmin) return;
    const [row] = await rd
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, currentUser.id))
      .limit(1);
    isAdmin = row?.role === "admin";
  }

  // DM share grant: a creator who hands an unpublished DRAFT to someone in a DM
  // grants that recipient a preview-only read — cover, name, description, the
  // fork-permission flags. Deliberately gated on `isPreview`, so the branch below
  // can never serve the full `schema` (the only payload that carries the card's
  // actual prompt/lorebook source) to a non-creator. Resolved lazily so the
  // published hot path never pays for the lookup.
  let dmGrantResolved = false;
  let hasDmGrant = false;
  async function ensureDmGrantFlag() {
    if (dmGrantResolved) return;
    dmGrantResolved = true;
    if (!currentUser || !isPreview) return;
    hasDmGrant = await hasWorldDmShareGrant(currentUser.id, worldId, world.creatorId);
  }

  if (worldStatus === "draft" && !isCreator) {
    await ensureDmGrantFlag();
    if (!hasDmGrant) {
      await ensureAdminFlag();
      if (!isAdmin) return c.json({ error: "World not found" }, 404);
    }
  }

  // Pre-publish review states must not leak to non-creator non-admin users.
  // Without this guard any logged-in user with a worldId can pull the full
  // schema of an in-review or just-rejected world.
  if ((worldStatus === "pending_review" || worldStatus === "rejected") && !isCreator) {
    await ensureAdminFlag();
    if (!isAdmin) return c.json({ error: "World not found" }, 404);
  }

  if (worldStatus === "unpublished" && !isCreator) {
    // Check if user has this in their library
    if (currentUser) {
      const [libEntry] = await rd
        .select({ id: userLibrary.id })
        .from(userLibrary)
        .where(and(eq(userLibrary.userId, currentUser.id), eq(userLibrary.worldId, worldId)))
        .limit(1);

      if (libEntry) {
        return c.json({
          data: {
            id: world.id,
            name: world.name,
            thumbnailUrl: world.thumbnailUrl,
            status: "unpublished",
            tombstone: true,
          },
        });
      }
    }
    return c.json({ error: "World not found" }, 404);
  }

  // Guests must never receive Limitless card content — name, description,
  // tags, cover, schema. Payment-network content monitors browse logged-out,
  // so the wall is server-side; the client renders a sign-in gate off
  // `requiresAuth`. Login is the only key (client-side blur is not a wall).
  if (!currentUser && (world.ageRating ?? "all") !== "all") {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: {
        id: world.id,
        status: worldStatus,
        ageRating: world.ageRating,
        isNsfw: true,
        requiresAuth: true,
      },
    });
  }

  // Edit re-review: for the OWNER of a published world, surface the held-edit
  // state and — when the editor asks via ?forEdit=1 — overlay the pending
  // working copy so the creator edits their in-progress version. Players and
  // every other viewer always receive the live / last-approved content.
  if (isCreator && !isPreview && worldStatus === "published") {
    const pend = await getPendingEdit(worldId);
    if (pend) {
      (world as any).pendingEdit = summarizePendingEdit(pend);
      if (c.req.query("forEdit") === "1") {
        (world as any).schema = pend.schema;
        if (pend.thumbnailUrl != null) (world as any).thumbnailUrl = pend.thumbnailUrl;
        if (pend.ageRating != null) {
          (world as any).ageRating = pend.ageRating;
          (world as any).isNsfw = pend.ageRating !== "all";
        }
      }
    } else {
      (world as any).pendingEdit = null;
    }
  }

  // (2026-06-01) No cross-variant field swap on the detail page. Under the
  // 主/副 model each variant is its own card and renders in its OWN language —
  // an en visitor opening a zh card sees the zh card, not an en sibling's cover
  // swapped onto it (the retired Hub-Translation behavior). The hub LIST already
  // returns the correct per-language representative row, so localization happens
  // by row selection, not by mutating one row's fields from its siblings.

  // Resolve S3 keys → CDN URLs
  world.thumbnailUrl = resolveImageCdn(world.thumbnailUrl);

  // Resolve gallery S3 keys to CDN URLs
  if (world.galleryImages && Array.isArray(world.galleryImages)) {
    world.galleryImages = (world.galleryImages as string[]).map((img) => resolveImageCdn(img) ?? img);
  }

  // Resolve S3 keys inside multilanguageOverview entries (editor needs CDN URLs)
  if (world.multilanguageOverview) {
    const mlo = world.multilanguageOverview as Record<string, Record<string, unknown>>;
    for (const langKey of Object.keys(mlo)) {
      const entry = mlo[langKey]!;
      if (entry.thumbnailUrl && typeof entry.thumbnailUrl === "string") {
        entry.thumbnailUrl = resolveImageCdn(entry.thumbnailUrl as string) ?? entry.thumbnailUrl;
      }
      if (entry.galleryImages && Array.isArray(entry.galleryImages)) {
        entry.galleryImages = (entry.galleryImages as string[]).map((img) => resolveImageCdn(img) ?? img);
      }
    }
  }

  // Attach creator info for non-preview mode (preview mode already has it from the JOIN)
  if (!isPreview && world.creatorId) {
    const [creator] = await rd
      .select({ name: user.name, image: user.image })
      .from(user)
      .where(eq(user.id, world.creatorId))
      .limit(1);
    (world as any).creatorName = creator?.name ?? null;
    (world as any).creatorImage = resolveImageCdn(creator?.image ?? null);
  } else if (isPreview) {
    // Preview mode: creatorImage came from the JOIN as a raw column value (possibly
    // an S3 key). Resolve to a CDN URL so the client can render it.
    (world as any).creatorImage = resolveImageCdn((world as any).creatorImage ?? null);
  }

  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  return c.json({ data: world });
});

// GET /api/worlds/:id/context-requirement — estimated minimum context (tokens)
// to play this card without omitting lore. Used by the client-side play gate.
// Clients treat any failure as "no warning" (fail-open), so access here is
// deliberately simple: published worlds are public, everything else is
// creator-only (admins fall through to no-warning rather than getting a 403).
worldRoutes.get("/:id/context-requirement", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  let currentUser: { id: string } | null = null;
  try { currentUser = c.get("user"); } catch { /* unauthenticated */ }

  const rd = await readDb(currentUser?.id);
  const [row] = await rd
    .select({
      creatorId: worlds.creatorId,
      status: worlds.status,
      isPublished: worlds.isPublished,
      updatedAt: worlds.updatedAt,
      schema: worlds.schema,
    })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);

  if (!row) return c.json({ error: "World not found" }, 404);

  const worldStatus = row.status ?? (row.isPublished ? "published" : "draft");
  const isCreator = currentUser != null && row.creatorId === currentUser.id;
  if (worldStatus !== "published" && !isCreator) {
    return c.json({ error: "World not found" }, 404);
  }

  const cacheKey = `${worldId}:${row.updatedAt ? new Date(row.updatedAt).getTime() : 0}`;
  const requirement = computeWorldContextRequirement(row.schema, cacheKey);
  if (!requirement) return c.json({ error: "World has no schema" }, 404);

  // Pure function of the world version — let the browser cache briefly.
  // `private` because draft/unpublished worlds are creator-gated and a shared
  // cache must not replay one viewer's 200 to another viewer.
  c.header("Cache-Control", "private, max-age=300");
  return c.json({ data: requirement });
});

// POST /api/worlds (auth required)
worldRoutes.post("/", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");

  // Check if user is banned
  const [userRow] = await db
    .select({ isBanned: user.isBanned })
    .from(user)
    .where(eq(user.id, currentUser.id));
  if (userRow?.isBanned) {
    return c.json({ error: "Your account is restricted. You cannot create new worlds." }, 403);
  }

  const body = await c.req.json();
  const parsed = createWorldSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  let totalTokens = 0;
  try {
    const entries = ((parsed.data.schema as any)?.entries as Array<{ content?: string }>) ?? [];
    totalTokens = entries.reduce((sum: number, e: { content?: string }) => sum + estimateTokens(e.content ?? ""), 0);
  } catch {
    // Malformed schema — default to 0 tokens rather than crashing
  }

  // Extract language from schema if not provided at top level. Normalize the
  // resolved value so regional codes from imported card JSON ("zh-CN" from
  // SillyTavern exports) collapse to their base ("zh") — matches Discover's
  // tolerant scope filter and prevents future creators from re-introducing
  // the dirty values that hid 桃花妖妇 / 圣奥古斯丁皇家学院 from Latest.
  const schemaLanguageValue = (parsed.data.schema as Record<string, unknown> | undefined)?.["language"];
  const schemaLanguage = typeof schemaLanguageValue === "string" ? schemaLanguageValue : null;
  const language = normalizeWorldLanguage(parsed.data.language ?? schemaLanguage);

  const normalizedTags = parsed.data.tags
    ? normalizeTagsForStorage(parsed.data.tags)
    : undefined;

  // Same name ↔ schema.name invariant as PATCH /:id — a create that ships
  // divergent copies (seed/import pipelines have done this) would re-plant the
  // exact drift the PATCH-side sync exists to prevent.
  if (parsed.data.name !== undefined && parsed.data.schema) {
    (parsed.data.schema as Record<string, unknown>).name = parsed.data.name;
  }

  const result = await db
    .insert(worlds)
    .values({
      ...parsed.data,
      ...(normalizedTags ? { tags: normalizedTags } : {}),
      language,
      creatorId: currentUser.id,
      totalTokens,
    })
    .returning();

  // Phase 2.5: populate search_doc_normalized after the row is committed.
  // Non-blocking — search still works via search_doc if this fails.
  if (result[0]?.id) {
    await syncSearchDocNormalized(db, result[0].id).catch((err) => {
      console.warn("[WORLDS] syncSearchDocNormalized failed on insert:", err);
    });
  }

  return c.json({ data: result[0] }, 201);
});

// PATCH /api/worlds/:id — update world (owner only, auth required)
worldRoutes.patch("/:id", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const body = await c.req.json();

  // Optimistic-concurrency token for the draft save-clobber guard (see below).
  // Read from the RAW body: updateWorldSchema is a non-strict z.object, so an
  // unknown `baseUpdatedAt` is stripped on parse and never reaches the row.
  const clientBaseUpdatedAt =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).baseUpdatedAt === "string"
      ? ((body as Record<string, unknown>).baseUpdatedAt as string)
      : null;

  const parsed = updateWorldSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  // Consolidated read of the live row — drives the in-review lock, the inline-
  // asset check, and the published-world material-edit routing below.
  const [liveRow] = await db
    .select({
      status: worlds.status,
      schema: worlds.schema,
      thumbnailUrl: worlds.thumbnailUrl,
      ageRating: worlds.ageRating,
      languageGroupId: worlds.languageGroupId,
      language: worlds.language,
      isPrimaryVariant: worlds.isPrimaryVariant,
      updatedAt: worlds.updatedAt,
    })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)))
    .limit(1);

  // Hub Translation (multilanguage_overview) is retired — never persist it,
  // regardless of what a stale client bundle still sends in the PATCH body.
  delete (parsed.data as Record<string, unknown>).multilanguageOverview;
  // Publish state is owned by POST /:id/status — never let the metadata PATCH set
  // it, even from a forged/stale request (Zod already strips these since they were
  // removed from updateWorldSchema; this is defense-in-depth).
  delete (parsed.data as Record<string, unknown>).status;
  delete (parsed.data as Record<string, unknown>).isPublished;

  // ── name ↔ schema.name invariant ──
  // worlds.name is the single display-name truth (hub, review queue, library,
  // publish NAME_REQUIRED gate), but a copy lives inside the schema blob where
  // it reaches the AI prompt (PromptBuilder's character-name fallback) and the
  // editor header. A patch carrying both must never let them diverge; mutating
  // parsed.data.schema HERE (before the material-edit gate) also carries the
  // synced name into a held working copy. A name-only patch (the publish-modal
  // rename) heals the stored schema copy inside the UPDATE below. Name is
  // explicitly non-material (see MaterialChangeReason), so none of this
  // triggers re-review.
  if (parsed.data.name !== undefined && parsed.data.schema) {
    (parsed.data.schema as Record<string, unknown>).name = parsed.data.name;
  }

  // Detect a real language change on a grouped variant. The moved row is
  // demoted to 副 in the same UPDATE (avoids violating worlds_primary_variant_uniq
  // when the target language already has a 主), then ensureGroupPrimaries() below
  // re-promotes it iff the target language had no primary, and back-fills the
  // vacated language. Ungrouped rows are skipped (always primary).
  const nextLanguageNormalized =
    parsed.data.language !== undefined ? normalizeWorldLanguage(parsed.data.language) : undefined;
  const languageActuallyChanged =
    !!liveRow?.languageGroupId &&
    parsed.data.language !== undefined &&
    (nextLanguageNormalized ?? "") !== (liveRow.language ?? "");

  // Edits while the world is in first-publish review are ALLOWED (the old
  // WORLD_IN_REVIEW 409 is gone). The admin reviews the live row directly —
  // first-publish submissions snapshot only settings, not content — so the
  // review inherently covers the latest saved version. The editor's review
  // control offers "update review to latest" (resurface/bump the submission)
  // and "withdraw" instead of hard-locking saves.

  // ── Draft save-clobber guard (optimistic concurrency) ──────────────────────
  // The editor saves the WHOLE world blob. If the Studio agent wrote to this
  // world after the editor loaded it (e.g. created entry-categorization folders
  // and filed entries into them), a stale blob save would silently wipe the
  // agent's work — the entry-folder data-loss bug. When the editor sends the
  // updatedAt it last synced (baseUpdatedAt) and the live row has moved since,
  // reject with 409 STALE_WORLD so the editor reloads + merges instead of
  // clobbering.
  //
  // Scoped to NON-published worlds: a published world's editor save flows
  // through the held-edit working copy, which has its own baseUpdatedAt conflict
  // handling (pending-edit.ts) and is actively being reworked alongside the
  // working-copy feature — we deliberately do not double-guard it here.
  // Decision extracted to isStaleDraftSave() for unit testing.
  if (
    isStaleDraftSave({
      clientBaseUpdatedAt,
      liveStatus: liveRow?.status,
      liveUpdatedAt: liveRow?.updatedAt,
    })
  ) {
    return c.json(
      {
        error:
          "This world changed since you opened it — the assistant may have edited it. Reload to merge before saving.",
        code: "STALE_WORLD",
        // Guaranteed present: isStaleDraftSave() only returns true when liveRow
        // and its updatedAt exist (TS can't narrow through the helper call).
        currentUpdatedAt: liveRow!.updatedAt!.toISOString(),
      },
      409,
    );
  }

  // A published world whose held edit is already submitted to the moderation
  // queue is NOT locked: editing simply supersedes the submission, pulling it
  // back to a draft so the creator can keep working (mirrors the Studio-AI write
  // path). The live card is never touched, and the admin only ever reviews a
  // still-submitted hold — so this keeps "review = latest" while removing the
  // withdraw-first friction. We mark the in-flight submission withdrawn inside
  // the same transaction as the hold write below.
  const isPublishedWorld = liveRow?.status === "published";
  let existingPending = isPublishedWorld ? await getPendingEdit(worldId) : null;
  const supersededReview = existingPending?.status === "pending";

  // Reject saves that INTRODUCE new inline base64 data URIs. Legacy worlds with
  // existing bloat can still be edited (renaming, adding variables, etc.) — the
  // check compares total data-URI instances against the current DB schema and
  // only rejects if the save would add new ones. Every save is also a chance
  // for the creator to reduce bloat (replacing a data URI with an @asset: ref
  // removes from the count, which is allowed).
  if (parsed.data.schema) {
    const newInline = scanWorldSchemaForInlineAssets(parsed.data.schema);
    if (newInline.length > 0) {
      const currentSchema = liveRow?.schema;
      const currentInline = currentSchema ? scanWorldSchemaForInlineAssets(currentSchema) : [];

      const newCount = newInline.reduce((sum, m) => sum + m.count, 0);
      const currentCount = currentInline.reduce((sum, m) => sum + m.count, 0);

      if (newCount > currentCount) {
        const addedCount = newCount - currentCount;
        const newTotalKb = Math.max(1, Math.round(newInline.reduce((sum, m) => sum + m.totalBytes, 0) / 1024));
        const details = newInline.slice(0, 5).map((m) => `${m.location}: ${m.count}×${Math.round(m.totalBytes / 1024)}KB`).join("; ");
        const moreNote = newInline.length > 5 ? ` (+ ${newInline.length - 5} more)` : "";
        return c.json(
          {
            error: "Save rejected: new inline base64 data URIs",
            message: `This save would add ${addedCount} new inline base64 data URI(s) (total ~${newTotalKb}KB across: ${details}${moreNote}). Yumina uses @asset:{assetId} (CDN-backed) or external https:// URLs — inline data URIs defeat CDN caching and bloat your world on every load. Upload each embedded asset via the Library, then reference it with @asset:{assetId}. (Existing data URIs in your world are still allowed — this check only blocks new ones.)`,
            issues: newInline,
          },
          400
        );
      }
    }
  }

  // ─── Published-world material-edit gate ──────────────────────────
  // A change to one of the four material surfaces (lorebook entries, frontend
  // rootComponent, age rating, cover) on an ALREADY-PUBLISHED world must NOT go
  // live — it is parked in world_pending_edits so the live card keeps serving
  // the last-approved content until an admin approves the change. Non-material
  // edits (variables, behaviors, audio, name, description, tags, permissions,
  // visibility…) fall through and apply to the live row instantly, as before.
  let heldReasons: string[] = [];
  // Planned (but not yet written) world_pending_edits mutation. Applied below in
  // the SAME transaction as the live worlds UPDATE so the hold and the patch
  // commit atomically (no orphaned hold / lost draft on a mid-write failure).
  let holdPlan: ReturnType<typeof planMaterialHold> | null = null;
  if (isPublishedWorld && liveRow) {
    const base = existingPending ?? {
      schema: liveRow.schema,
      thumbnailUrl: liveRow.thumbnailUrl,
      ageRating: liveRow.ageRating,
    };
    const proposedSchema = (parsed.data.schema ?? base.schema) as Record<string, unknown>;
    const proposedThumbnailUrl =
      parsed.data.thumbnailUrl !== undefined ? parsed.data.thumbnailUrl : (base.thumbnailUrl ?? null);
    const proposedAgeRating =
      parsed.data.ageRating !== undefined ? parsed.data.ageRating : (base.ageRating ?? liveRow.ageRating ?? "all");

    holdPlan = planMaterialHold({
      worldId,
      creatorId: currentUser.id,
      live: {
        schema: liveRow.schema,
        thumbnailUrl: liveRow.thumbnailUrl,
        ageRating: liveRow.ageRating ?? "all",
        languageGroupId: liveRow.languageGroupId,
        updatedAt: liveRow.updatedAt,
      },
      proposedSchema,
      proposedThumbnailUrl,
      proposedAgeRating,
      // Coerce a submitted hold to 'draft' so a revert-to-live correctly CLEARS
      // it (planMaterialHold only clears non-pending holds) and a re-edit lands
      // as a fresh draft — the submission row is marked withdrawn in the tx below.
      existing: existingPending ? { ...existingPending, status: "draft" } : null,
    });
    heldReasons = holdPlan.reasons;

    // Keep the held working copy's schema.name in sync with a rename that
    // rides along on this patch (or a name-only patch re-holding an existing
    // draft): the hold's schema goes live verbatim on approve, so a stale name
    // inside it would resurrect the pre-rename title.
    if (parsed.data.name !== undefined && holdPlan.upsert?.schema) {
      (holdPlan.upsert.schema as Record<string, unknown>).name = parsed.data.name;
    }

    if (holdPlan.upsert) {
      // Strip the material carriers from the live patch — they now live in the
      // held edit. Everything else in the patch still applies to the live row.
      delete (parsed.data as Record<string, unknown>).schema;
      delete (parsed.data as Record<string, unknown>).thumbnailUrl;
      delete (parsed.data as Record<string, unknown>).ageRating;
      delete (parsed.data as Record<string, unknown>).isNsfw;
    } else {
      // No material divergence from live: any stale draft hold was just cleared.
      existingPending = null;
    }
  }

  let computedTokens: Record<string, number> = {};
  if (parsed.data.schema) {
    try {
      const entries = ((parsed.data.schema as any).entries as Array<{ content?: string }>) ?? [];
      computedTokens = { totalTokens: entries.reduce((sum: number, e: { content?: string }) => sum + estimateTokens(e.content ?? ""), 0) };
    } catch {
      computedTokens = { totalTokens: 0 };
    }
  }

  const normalizedTags = parsed.data.tags
    ? normalizeTagsForStorage(parsed.data.tags)
    : undefined;

  // Apply the held-edit mutation (if any) and the live worlds UPDATE atomically.
  const result = await db.transaction(async (tx) => {
    // Serialize held-edit creation with standalone update-note publication.
    // Both paths lock the live world first, so their pending-edit check/write
    // order is linearizable even when the author triggers them concurrently.
    const [lockedWorld] = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.id, worldId))
      .for("update");

    // A save planned before a version switch must not apply its old hold plan
    // afterwards. The editor handles STALE_WORLD by merging its unsaved edits.
    if (lockedWorld && (lockedWorld.updatedAt?.getTime() !== liveRow?.updatedAt?.getTime()
      || (body.schema && clientBaseUpdatedAt && lockedWorld.updatedAt?.toISOString() !== clientBaseUpdatedAt))) {
      return { conflict: true as const, currentUpdatedAt: lockedWorld.updatedAt?.toISOString() };
    }
    const savePublishVersion = body.saveVersionOnPublish === true;

    // Read existing tags under the same lock used by publishing so a stale
    // form cannot overwrite a concurrent tag save. Newly added dual tags win;
    // an existing dual card can deliberately switch to one audience.
    const audienceUpdate = parsed.data.targetAudience
      ? resolveWorldAudienceEdit(
          lockedWorld?.tags ?? [],
          normalizedTags,
          parsed.data.targetAudience,
        )
      : {};

    // Editing a card whose update is in review pulls that submission out of the
    // queue (back to draft) so the admin never approves a stale version and the
    // creator can keep working without an explicit withdraw.
    if (supersededReview) {
      await tx
        .update(worldReviewSubmissions)
        .set({ decision: "withdrawn", decidedBy: currentUser.id, decidedAt: new Date() })
        .where(and(
          eq(worldReviewSubmissions.worldId, worldId),
          eq(worldReviewSubmissions.decision, "pending"),
          eq(worldReviewSubmissions.submissionType, "edit"),
        ));
    }
    if (holdPlan) await applyHoldPlan(holdPlan, tx);
    const rows = await tx
      .update(worlds)
      .set({
        ...parsed.data,
        // Name-only patch (publish-modal rename): heal the name copy embedded
        // in the stored schema blob so the editor header and the AI prompt
        // fallback can't keep serving the stale template name. When the patch
        // carries a schema, its name was force-synced above instead. Gated on
        // the name actually differing from the stored schema copy — the editor
        // sends `name` on every metadata save, and an unconditional jsonb_set
        // would rewrite the whole (multi-MB on big cards) schema blob each time.
        ...(parsed.data.name !== undefined &&
        parsed.data.schema === undefined &&
        parsed.data.name !== (liveRow?.schema as Record<string, unknown> | null | undefined)?.name
          ? { schema: sql`jsonb_set(${worlds.schema}, '{name}', to_jsonb(${parsed.data.name}::text))` }
          : {}),
        ...(normalizedTags ? { tags: normalizedTags } : {}),
        ...audienceUpdate,
        // Normalize only when the patch actually touches `language`, so an
        // unrelated PATCH (e.g. tags-only) never overwrites the existing
        // value. The override comes after `...parsed.data` because object
        // spread is last-wins.
        ...(parsed.data.language !== undefined
          ? { language: normalizeWorldLanguage(parsed.data.language) }
          : {}),
        // Demote the moved row to 副 when its language changes (reconciled below).
        ...(languageActuallyChanged ? { isPrimaryVariant: false } : {}),
        ...computedTokens,
        updatedAt: new Date(),
      })
      .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)))
      .returning();

    // Rebalance 主/副 in the SAME transaction so the demote above and the
    // re-promote commit atomically — a mid-flight failure can never strand a
    // (group, language) with zero primaries. ensureGroupPrimaries only ever
    // promotes a primary-less language, so it can't create a duplicate.
    if (languageActuallyChanged && rows[0]?.languageGroupId) {
      await ensureGroupPrimaries(tx as unknown as typeof db, rows[0].languageGroupId);
    }
    if (savePublishVersion && rows[0]) {
      const working = await lockVersionDraft(tx, worldId);
      // Held content is captured atomically by /pending/submit. Avoid two
      // indistinguishable publish records for a single click in the modal.
      if (!working) {
        await captureAutomaticVersion(tx, rows[0], "publish", rows[0]);
        if (rows[0].status === "published" && rows[0].isPublished) {
          await captureAutomaticVersion(tx, rows[0], "live", rows[0]);
        }
      }
    }
    return rows;
  });

  if (!Array.isArray(result)) {
    return c.json({ error: "This world changed. Reload to merge before saving.", code: "STALE_WORLD", currentUpdatedAt: result.currentUpdatedAt }, 409);
  }
  if (result.length === 0) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // Phase 2.5: re-sync normalized search tsvector if any searchable text
  // field was patched. Cheap no-op if the fields weren't touched.
  // (extendedDescription isn't in updateWorldSchema today, so it's not
  // guarded here; when that field is added, extend this condition.)
  if (parsed.data.name !== undefined || parsed.data.description !== undefined) {
    await syncSearchDocNormalized(db, worldId).catch((err) => {
      console.warn("[WORLDS] syncSearchDocNormalized failed on update:", err);
    });
  }

  // (2026-06-01) Removed the PATCH publish-status sibling propagation. The author
  // metadata PATCH no longer carries status/isPublished (removed from
  // updateWorldSchema), so this was both dead and the moderation-bypass vector
  // (a forged PATCH could flip a whole variant group live without review).
  // Publish/unpublish + the sibling fan-out live solely in POST /:id/status.
  const updated = result[0]!;

  // (主/副 rebalance after a language change now runs INSIDE the transaction
  // above — see ensureGroupPrimaries(tx, ...) — so it is atomic with the demote.)

  // Tell the editor whether any material change was held back from the live
  // card (so it can show the "changes held for review" banner + a Submit
  // button) and surface the current held-edit state.
  if (isPublishedWorld) {
    const pend = await getPendingEdit(worldId);
    (updated as any).pendingEdit = pend ? summarizePendingEdit(pend) : null;
    (updated as any).heldForReview = heldReasons.length > 0 ? heldReasons : undefined;
    // Editing pulled an in-review submission back to draft — the editor toasts
    // this so the creator knows they must re-submit to re-enter the queue.
    (updated as any).supersededReview = supersededReview ? true : undefined;
  }

  return c.json({ data: updated });
});

// DELETE /api/worlds/:id — delete world (auth required)
worldRoutes.delete("/:id", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  // Withdraw undecided review submissions BEFORE the world row goes away —
  // the FK is onDelete:'set null', so afterwards the rows can't be matched by
  // world_id and would sit in the admin queue forever as "(untitled)" ghosts.
  // Decided (approved/rejected) history stays untouched. Ownership is enforced
  // by the USING join, mirroring the world delete below.
  await db.execute(sql`
    DELETE FROM world_review_submissions s
    USING worlds w
    WHERE s.world_id = w.id
      AND w.id = ${worldId}
      AND w.creator_id = ${currentUser.id}
      AND s.decision = 'pending'
  `);

  const result = await db
    .delete(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // Clean up variant group: if the deleted world belonged to a group,
  // dissolve a now-singleton group, and keep the 主/副 invariant intact.
  const deleted = result[0]!;
  if (deleted.languageGroupId) {
    try {
      const siblings = await db
        .select({ id: worlds.id, language: worlds.language, isPrimaryVariant: worlds.isPrimaryVariant, isPublished: worlds.isPublished, status: worlds.status, createdAt: worlds.createdAt })
        .from(worlds)
        .where(eq(worlds.languageGroupId, deleted.languageGroupId));

      if (siblings.length === 1) {
        // Only one variant left — dissolve the group. An ungrouped card is
        // always its own primary, so force the flag true regardless of its
        // prior 主/副 state.
        await db
          .update(worlds)
          .set({ languageGroupId: null, isPrimaryVariant: true })
          .where(eq(worlds.id, siblings[0]!.id));
      } else if (deleted.isPrimaryVariant) {
        // Deleted the 主 of its language — promote a remaining same-language
        // sibling, preferring a PUBLISHED one (so the hub keeps a live
        // representative), then oldest.
        const isLive = (s: { isPublished: boolean | null; status: string | null }) =>
          s.isPublished === true && s.status === "published";
        const sameLang = siblings
          .filter((s) => (s.language ?? "") === (deleted.language ?? ""))
          .sort((a, b) => {
            const ap = isLive(a) ? 0 : 1;
            const bp = isLive(b) ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
          });
        if (sameLang.length > 0 && !sameLang.some((s) => s.isPrimaryVariant)) {
          await db
            .update(worlds)
            .set({ isPrimaryVariant: true })
            .where(eq(worlds.id, sameLang[0]!.id));
        }
      }
    } catch (err) {
      console.error("[DELETE] Failed to clean up variant group:", err);
      // Non-fatal — the delete itself succeeded
    }
  }

  return c.json({ data: { deleted: true } });
});

// POST /api/worlds/:id/publish — DEPRECATED.
// Removed 2026-05-21 when the publish-review system landed. The old toggle
// allowed authors to bypass admin review with a single click, which defeats
// the whole point of pre-publish gating. Use POST /:id/status with
// { status: "pending_review", ... } for first publish, or the admin
// moderation routes for approve/unpublish.
worldRoutes.post("/:id/publish", authMiddleware, rateLimitMiddleware("publishing"), async (c) => {
  return c.json({
    error: "Endpoint removed. Submit via POST /api/worlds/:id/status with { status: 'pending_review' }",
    code: "ENDPOINT_REMOVED",
  }, 410);
});

// POST /api/worlds/:id/status — change world status
// Author-driven transitions only. Admin approval / rejection lives in
// admin-moderation.ts. Direct draft -> published and unpublished -> published
// are no longer allowed: the author must go through pending_review.
worldRoutes.post("/:id/status", authMiddleware, rateLimitMiddleware("publishing"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  let body: { status: string; isNsfw?: boolean; allowEdit?: boolean; allowCustomApi?: boolean; allowReviews?: boolean; allowSessionSharing?: boolean; allowCommunityCitations?: boolean; blurCover?: boolean | null; ageRating?: string; visibility?: string; targetAudience?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Backward-compat: users with stale browser bundles still send the old
  // pre-review-system status="published" value from the publish modal. Map it
  // to pending_review so the publish flow doesn't 400 mid-session — they'll
  // pick up the new bundle on next page load.
  if (body.status === "published") {
    body.status = "pending_review";
  }

  if (!["draft", "pending_review", "unpublished"].includes(body.status)) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const existing = await db
    .select({
      id: worlds.id,
      status: worlds.status,
      creatorId: worlds.creatorId,
      name: worlds.name,
      thumbnailUrl: worlds.thumbnailUrl,
      languageGroupId: worlds.languageGroupId,
      language: worlds.language,
      tags: worlds.tags,
    })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (existing.length === 0) return c.json({ error: "World not found" }, 404);

  const currentStatus = existing[0]!.status;
  const newStatus = body.status;

  // Author-side state machine. Approve/reject is admin-only and lives in
  // admin-moderation.ts; it bypasses this validator.
  const validTransitions: Record<string, string[]> = {
    draft: ["pending_review"],
    pending_review: ["draft"], // self-withdraw shortcut
    rejected: ["pending_review", "draft"],
    published: ["unpublished"],
    unpublished: ["pending_review", "draft"],
  };

  if (!validTransitions[currentStatus]?.includes(newStatus)) {
    return c.json({ error: `Cannot transition from '${currentStatus}' to '${newStatus}'` }, 400);
  }

  // Banned users cannot submit for review. Trusted creators (admin-granted
  // skipReview) auto-publish instead of queuing — captured here, applied after
  // the submit transaction below. Ban is checked first and always wins.
  let creatorSkipReview = false;
  if (newStatus === "pending_review") {
    const [userRow] = await db
      .select({ isBanned: user.isBanned, skipReview: user.skipReview })
      .from(user)
      .where(eq(user.id, currentUser.id));
    if (userRow?.isBanned) {
      return c.json({ error: "Your account is restricted. You cannot submit worlds for review." }, 403);
    }
    creatorSkipReview = userRow?.skipReview ?? false;
  }

  // ─── Submit-for-review branch ─────────────────────────────────────
  if (newStatus === "pending_review") {
    // Discover routes filter by `worlds.language`; cards published with
    // a NULL/empty language used to leak across every Discover language
    // (the old buildWorldLanguageScopeCondition treated NULL as a
    // "legacy" wildcard). Block submission instead — the author can set
    // a language in the editor in one click. Pairs with the removal of
    // the `language IS NULL` branch in recommendations.ts.
    if (!existing[0]!.language || existing[0]!.language.trim() === "") {
      return c.json({
        error: "World is missing a language. Set the primary language in the editor before submitting for review.",
        code: "LANGUAGE_REQUIRED",
      }, 400);
    }

    // Canonical adult value is "sensitive" (migration 0027 / commit 60fc8321).
    // The publish modal sends "sensitive"; older clients may send "r18"/"r18g".
    // Always store "sensitive" for Limitless mode so the value cannot drift back
    // to the legacy "r18" that the "敏感内容" filters no longer key off.
    const requestedAge = body.ageRating;
    const isAdult =
      requestedAge === "sensitive" ||
      requestedAge === "r18" ||
      requestedAge === "r18g" ||
      (requestedAge !== "all" && body.isNsfw === true);
    const ageRating = isAdult ? "sensitive" : "all";
    const isNsfw = ageRating !== "all";
    const visibility = body.visibility && ["public", "followers"].includes(body.visibility)
      ? body.visibility
      : "public";
    const targetAudience = body.targetAudience && ["male", "female", "all"].includes(body.targetAudience)
      ? body.targetAudience
      : (isNsfw ? "male" : "all");
    const allowEdit = body.allowEdit ?? true;
    const allowCustomApi = body.allowCustomApi ?? true;
    const allowReviews = body.allowReviews ?? true;
    const allowSessionSharing = body.allowSessionSharing ?? true;
    const allowCommunityCitations = body.allowCommunityCitations ?? true;
    // Cover blur is creator-controlled and decoupled from age rating. Clients
    // that omit it (older bundles) fall back to the legacy rating-derived
    // default so nothing changes for them; the publish modal sends explicit
    // true/false.
    const blurCover = body.blurCover === undefined ? isNsfw : body.blurCover;

    const siblings = await findVariantSiblings(
      currentUser.id,
      existing[0]!.languageGroupId,
      worldId,
    );

    const submittable = siblings.filter((s) => isEligibleForReviewSubmit(s.status));
    if (submittable.length === 0) {
      return c.json({ error: "No siblings are eligible to enter review" }, 400);
    }

    // A card must carry a real, creator-chosen name before it can go live. The
    // default placeholder ("未命名" / "Untitled", numbered or not) is rejected so
    // the hub never fills with indistinguishable duplicate-named cards. Detection
    // is name-based (see isDefaultWorldName) — renaming in the editor clears it.
    const unnamed = submittable.find((s) => isDefaultWorldName(s.name));
    if (unnamed) {
      return c.json({
        error: "Give your card a name before publishing — the default name can't be used. Rename it in the editor, then submit again.",
        code: "NAME_REQUIRED",
      }, 400);
    }

    // Every card entering review must carry a cover (rule since 2026-09-05).
    // Cards published before the rule are untouched — this only runs on new
    // submissions. The publish modal mirrors the check with hasPublishableCover
    // and offers an inline upload, so a creator normally never sees this 400.
    const coverless = submittable.find((s) => !hasPublishableCover(s.thumbnailUrl));
    if (coverless) {
      return c.json({
        error: "Add a cover image before publishing — every published card needs one. Upload it in the editor's Overview section, then submit again.",
        code: "COVER_REQUIRED",
      }, 400);
    }

    const groupKey = existing[0]!.languageGroupId ?? worldId;
    const now = new Date();
    const submittableIds = submittable.map((s) => s.id);

    await db.transaction(async (tx) => {
      const tagRows = await tx
        .select({ id: worlds.id, tags: worlds.tags })
        .from(worlds)
        .where(inArray(worlds.id, submittableIds))
        .orderBy(worlds.id)
        .for("update");

      const audienceById = new Map<string, "male" | "female" | "all">();

      for (const row of tagRows) {
        const audienceUpdate = resolveWorldAudience(row.tags ?? [], targetAudience as "male" | "female" | "all");
        audienceById.set(row.id, audienceUpdate.targetAudience);
        const [submitted] = await tx
          .update(worlds)
          .set({
            status: "pending_review",
            isPublished: false,
            reviewStatus: "pending_review",
            submittedForReviewAt: now,
            reviewedBy: null,
            reviewedAt: null,
            rejectionReason: null,
            rejectionDetail: null,
            ageRating,
            isNsfw,
            visibility,
            ...audienceUpdate,
            allowEdit,
            allowCustomApi,
            allowReviews,
            allowSessionSharing,
            allowCommunityCitations,
            blurCover,
            updatedAt: now,
          })
          .where(eq(worlds.id, row.id)).returning();
        if (submitted) await capturePublishVersion(tx, submitted, null);
      }

      for (const s of submittable) {
        await tx.insert(worldReviewSubmissions).values({
          worldId: s.id,
          groupKey,
          submittedBy: currentUser.id,
          submittedAt: now,
          decision: "pending",
          snapshotAgeRating: ageRating,
          snapshotIsNsfw: isNsfw,
          snapshotTargetAudience: audienceById.get(s.id) ?? targetAudience,
          snapshotVisibility: visibility,
          snapshotAllowEdit: allowEdit,
          snapshotAllowReviews: allowReviews,
        });
      }
    });

    if (creatorSkipReview) {
      // Trusted creator: auto-publish ONLY the variants this request just
      // submitted (submittableIds) — never the whole group — so a sibling that
      // was already queued BEFORE the creator was trusted is left for a human
      // (the spec's future-only invariant). Routed through approveGroup so
      // embed / follower-notify / sibling-sync / idempotency match a normal
      // admin approve; it re-checks banned authors too. No admin "new review"
      // ping (nothing to action) and no "submitted for review" creator ping
      // (it never queued) — approveGroup sends the single "approved" notice.
      // The re-select below then reflects `published`.
      await approveGroup(groupKey, { reviewerId: null, source: "skipReview", onlyWorldIds: submittableIds }).catch((err) => {
        console.error("[skipReview] gate-1 auto-publish failed:", (err as Error)?.message);
      });
    } else {
      notify(currentUser.id, "world_submitted_for_review", {
        worldId,
        worldName: existing[0]!.name,
        thumbnailUrl: existing[0]!.thumbnailUrl,
        variantCount: submittable.length,
      }).catch(() => {});
      notifyAdminsOfNewReview(worldId, existing[0]!.name, existing[0]!.thumbnailUrl, currentUser.id, currentUser.name, groupKey).catch(() => {});
    }

    const [updated] = await db
      .select()
      .from(worlds)
      .where(eq(worlds.id, worldId));
    return c.json({ data: updated });
  }

  // ─── Withdraw / unpublish / back-to-draft branches ───────────────
  const updates: Record<string, unknown> = {
    status: newStatus,
    isPublished: false,
    updatedAt: new Date(),
  };

  if (currentStatus === "pending_review" && newStatus === "draft") {
    updates.reviewStatus = null;
    updates.submittedForReviewAt = null;
  }

  // Defense-in-depth: the `existing` query above already gates on creatorId,
  // but the explicit creator check here means a future refactor can't
  // accidentally let an unprivileged caller mutate a world they don't own.
  const [updated] = await db
    .update(worlds)
    .set(updates)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)))
    .returning();

  // Withdraw fan-out across variant siblings + mark submissions withdrawn.
  if (currentStatus === "pending_review" && newStatus === "draft") {
    const groupKey = existing[0]!.languageGroupId ?? worldId;
    await db.transaction(async (tx) => {
      await tx
        .update(worldReviewSubmissions)
        .set({ decision: "withdrawn", decidedBy: currentUser.id, decidedAt: new Date() })
        .where(and(
          eq(worldReviewSubmissions.groupKey, groupKey),
          eq(worldReviewSubmissions.decision, "pending"),
        ));

      if (existing[0]!.languageGroupId) {
        await tx
          .update(worlds)
          .set({
            status: "draft",
            isPublished: false,
            reviewStatus: null,
            submittedForReviewAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(worlds.languageGroupId, existing[0]!.languageGroupId),
            eq(worlds.creatorId, currentUser.id),
            eq(worlds.status, "pending_review"),
          ));
      }
    });
  }

  if (newStatus === "unpublished") {
    const libraryUsers = await db
      .select({ userId: userLibrary.userId })
      .from(userLibrary)
      .where(eq(userLibrary.worldId, worldId));

    if (libraryUsers.length > 0) {
      await notifyMany(
        libraryUsers.map((lu) => lu.userId),
        "world_unpublished",
        { worldId, worldName: existing[0]!.name, thumbnailUrl: existing[0]!.thumbnailUrl, creatorUserId: currentUser.id },
        { actorUserId: currentUser.id },
      );
    }
  }

  return c.json({ data: updated });
});

// POST /api/worlds/:id/withdraw-review — author withdraws a pending submission
worldRoutes.post("/:id/withdraw-review", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  const [w] = await db
    .select({ status: worlds.status, languageGroupId: worlds.languageGroupId, name: worlds.name })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (!w) return c.json({ error: "World not found" }, 404);
  if (w.status !== "pending_review") {
    return c.json({ error: "World is not currently in review" }, 400);
  }

  const groupKey = w.languageGroupId ?? worldId;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(worldReviewSubmissions)
      .set({ decision: "withdrawn", decidedBy: currentUser.id, decidedAt: now })
      .where(and(
        eq(worldReviewSubmissions.groupKey, groupKey),
        eq(worldReviewSubmissions.decision, "pending"),
      ));

    if (w.languageGroupId) {
      await tx
        .update(worlds)
        .set({
          status: "draft",
          isPublished: false,
          reviewStatus: null,
          submittedForReviewAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(worlds.languageGroupId, w.languageGroupId),
          eq(worlds.creatorId, currentUser.id),
          eq(worlds.status, "pending_review"),
        ));
    } else {
      await tx
        .update(worlds)
        .set({
          status: "draft",
          isPublished: false,
          reviewStatus: null,
          submittedForReviewAt: null,
          updatedAt: now,
        })
        .where(eq(worlds.id, worldId));
    }
  });

  return c.json({ data: { withdrawn: true } });
});

// POST /api/worlds/:id/refresh-review — author "updates" an in-flight
// first-publish review to their newest saved version. Content-wise this is
// automatic (the admin reviews the live row, and saving during review is
// allowed), so what this actually does is re-assert the submission: bump the
// submitted timestamps so the queue reflects the update, and clear an admin's
// "ignored" flag so a parked submission resurfaces with the new content.
worldRoutes.post("/:id/refresh-review", authMiddleware, rateLimitMiddleware("publishing"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  const [w] = await db
    .select({ status: worlds.status, languageGroupId: worlds.languageGroupId })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (!w) return c.json({ error: "World not found" }, 404);
  if (w.status !== "pending_review") {
    return c.json({ error: "World is not currently in review" }, 400);
  }

  const groupKey = w.languageGroupId ?? worldId;
  const now = new Date();

  await db.transaction(async (tx) => {
    const reviewWorlds = await tx.select().from(worlds).where(and(
      sql`coalesce(${worlds.languageGroupId}, ${worlds.id}) = ${groupKey}`,
      eq(worlds.creatorId, currentUser.id), eq(worlds.status, "pending_review"),
    )).orderBy(worlds.id).for("update");
    for (const row of reviewWorlds) await capturePublishVersion(tx, row, null);
    await tx
      .update(worldReviewSubmissions)
      .set({ submittedAt: now, ignoredAt: null, ignoredBy: null })
      .where(and(
        eq(worldReviewSubmissions.groupKey, groupKey),
        eq(worldReviewSubmissions.decision, "pending"),
      ));

    // Deliberately do NOT touch worlds.updatedAt: this is not a content
    // change, and bumping it would trip the editor's STALE_WORLD save guard
    // (baseUpdatedAt mismatch) on the very next save after pressing the button.
    if (w.languageGroupId) {
      await tx
        .update(worlds)
        .set({ submittedForReviewAt: now })
        .where(and(
          eq(worlds.languageGroupId, w.languageGroupId),
          eq(worlds.creatorId, currentUser.id),
          eq(worlds.status, "pending_review"),
        ));
    } else {
      await tx
        .update(worlds)
        .set({ submittedForReviewAt: now })
        .where(eq(worlds.id, worldId));
    }
  });

  return c.json({ data: { refreshed: true } });
});

// POST /api/worlds/:id/pending/submit — submit a held material edit (to an
// already-published world) into the moderation queue. The live card stays up.
worldRoutes.post("/:id/pending/submit", authMiddleware, rateLimitMiddleware("publishing"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const res = await submitPendingEdit({ worldId, creatorId: currentUser.id });
  if (!res.ok) return c.json({ error: res.error, code: res.code }, res.code === "NOT_FOUND" ? 404 : 400);
  const pend = await getPendingEdit(worldId);
  // autoApproved=true → trusted (skip-review) creator: the edit went live
  // immediately, so the client shows "approved & live" instead of "submitted".
  return c.json({ data: { submitted: true, autoApproved: res.autoApproved, pendingEdit: pend ? summarizePendingEdit(pend) : null } });
});

// POST /api/worlds/:id/pending/withdraw — pull a submitted held edit back out
// of the moderation queue so the creator can keep editing it.
worldRoutes.post("/:id/pending/withdraw", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const res = await withdrawPendingEdit({ worldId, creatorId: currentUser.id });
  if (!res.ok) return c.json({ error: res.error, code: res.code }, 400);
  const pend = await getPendingEdit(worldId);
  return c.json({ data: { withdrawn: true, pendingEdit: pend ? summarizePendingEdit(pend) : null } });
});

// POST /api/worlds/:id/pending/update-note — attach a "what's new" note to a held
// edit. It is posted to players (world_updates) only when the edit is approved
// and goes live, so we never announce an update that hasn't shipped.
worldRoutes.post("/:id/pending/update-note", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = parseWorldUpdateNoteBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const res = await setPendingEditUpdateNote({
    worldId,
    creatorId: currentUser.id,
    ...parsed.data,
  });
  if (!res.ok) {
    if (res.code === "IN_REVIEW") {
      return c.json({ error: "This update is in review. Withdraw it to change the note.", code: "WORLD_EDIT_IN_REVIEW" }, 409);
    }
    return c.json({ error: "No held changes to attach a note to", code: "NO_PENDING_EDIT" }, 400);
  }
  return c.json({ data: { ok: true } });
});

// GET /api/worlds/:id/review-history — author-only view of past decisions
worldRoutes.get("/:id/review-history", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  const [w] = await db
    .select({ creatorId: worlds.creatorId, languageGroupId: worlds.languageGroupId })
    .from(worlds)
    .where(eq(worlds.id, worldId));

  if (!w) return c.json({ error: "World not found" }, 404);
  if (w.creatorId !== currentUser.id) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const groupKey = w.languageGroupId ?? worldId;
  const history = await db
    .select()
    .from(worldReviewSubmissions)
    .where(eq(worldReviewSubmissions.groupKey, groupKey))
    .orderBy(desc(worldReviewSubmissions.submittedAt));

  return c.json({ data: history });
});

// POST /api/worlds/:id/duplicate — clone a world for remixing (auth required)
worldRoutes.post("/:id/duplicate", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  const existing = await db
    .select()
    .from(worlds)
    .where(eq(worlds.id, worldId));

  if (existing.length === 0) {
    return c.json({ error: "World not found" }, 404);
  }

  const source = existing[0]!;

  const isOwnSource = source.creatorId === currentUser.id;

  // Block duplicate if creator disallowed editing (applies to both forks and project copies)
  if (!source.allowEdit && !isOwnSource) {
    return c.json({ error: "This world does not allow forking" }, 403);
  }

  // A card that isn't publicly visible can only be forked by someone the creator
  // personally handed it to in a DM. Without this gate, `allowEdit` defaulting to
  // true meant ANY logged-in user who learned an unpublished world's id could fork
  // the creator's private draft. Statuses other than draft (pending_review /
  // rejected / unpublished) stay unforkable by non-creators outright: forking a
  // card mid-review or after withdrawal would launder content around moderation.
  if (!isOwnSource) {
    const sourceStatus = source.status ?? (source.isPublished ? "published" : "draft");
    if (sourceStatus !== "published") {
      const granted =
        sourceStatus === "draft" &&
        (await hasWorldDmShareGrant(currentUser.id, worldId, source.creatorId));
      if (!granted) return c.json({ error: "World not found" }, 404);
    }
  }

  // A published creator can be editing/playing a held working copy while the
  // live row still serves the last-approved version to everyone else. Clone
  // the same material this viewer is authorized to see; otherwise duplicating
  // an owner's card can resurrect an old rootComponent and hide its chat UI.
  const copyMaterial = await resolveWorldCopyMaterial(source, currentUser.id);

  const copyTotalTokens = estimateWorldCopyTokens(copyMaterial.schema);

  // Find next available conflict number and insert atomically (#39)
  const baseName = source.name.replace(/\s*\(\d+\)$/, "");

  const result = await db.transaction(async (tx) => {
    const siblings = await tx
      .select({ name: worlds.name })
      .from(worlds)
      .where(and(eq(worlds.creatorId, currentUser.id), ilike(worlds.name, `${baseName}%`)));
    const usedNumbers = siblings
      .map((s) => {
        const match = (s.name ?? "").match(/\((\d+)\)$/);
        return match?.[1] ? parseInt(match[1]) : 0;
      })
      .filter((n) => n > 0);
    const nextNum = usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;

    // Copy only the clicked variant (independent copy, no languageGroupId)
    const [newWorld] = await tx
      .insert(worlds)
      .values({
        creatorId: currentUser.id,
        name: `${baseName} (${nextNum})`,
        description: source.description,
        schema: copyMaterial.schema,
        thumbnailUrl: copyMaterial.thumbnailUrl,
        tags: clampWorldTags(source.tags ?? []),
        isPublished: false,
        isNsfw: copyMaterial.isNsfw ?? false,
        allowEdit: source.allowEdit ?? true,
        allowReviews: source.allowReviews ?? true,
        sourceWorldId: source.id,
        totalTokens: copyTotalTokens,
        approxTime: source.approxTime,
        language: source.language,
        languageGroupId: null,
        variantLabel: null,
        announcement: source.announcement,
        galleryImages: source.galleryImages,
        ageRating: copyMaterial.ageRating,
        blurCover: source.blurCover,
      })
      .returning();

    // Copy asset references
    const sourceRefs = await tx
      .select()
      .from(assetReferences)
      .where(eq(assetReferences.worldId, source.id));

    if (sourceRefs.length > 0) {
      await tx.insert(assetReferences).values(
        sourceRefs.map((ref) => ({
          worldId: newWorld!.id,
          assetId: ref.assetId,
        }))
      );
    }

    // Increment download count on source world
    await tx
      .update(worlds)
      .set({ downloadCount: sql`${worlds.downloadCount} + 1` })
      .where(eq(worlds.id, worldId));

    return newWorld!;
  });

  // Enrich the response so the optimistic UI in the library detail panel
  // can render correctly without waiting for the next list re-fetch:
  // - creatorName/creatorImage (otherwise the panel shows "Unknown")
  // - sourceWorldName + sourceCreator{Id,Name} for the "Based on X by Y"
  //   attribution
  // - CDN-resolved thumbnail/gallery URLs (raw rows hold S3 keys)
  const enriched = {
    ...result,
    thumbnailUrl: resolveImageCdn(result.thumbnailUrl),
    galleryImages: Array.isArray(result.galleryImages)
      ? (result.galleryImages as string[]).map((img) => resolveImageCdn(img) ?? img)
      : result.galleryImages,
    creatorName: currentUser.name,
    creatorImage: resolveImageCdn((currentUser as { image?: string | null }).image ?? null),
    sourceWorldName: source.name,
    sourceCreatorId: source.creatorId,
    sourceCreatorName: null as string | null,
  };

  if (source.creatorId) {
    const [sourceCreator] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, source.creatorId))
      .limit(1);
    enriched.sourceCreatorName = sourceCreator?.name ?? null;
  }

  return c.json({ data: enriched }, 201);
});

// GET /api/worlds/:id/my-copy — auth required
worldRoutes.get("/:id/my-copy", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const worldId = c.req.param("id");

  const copies = await rd
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.sourceWorldId, worldId), eq(worlds.creatorId, currentUser.id)))
    .limit(1);

  if (copies.length > 0) {
    return c.json({ data: { exists: true, worldId: copies[0]!.id } });
  }

  // Also check if the user IS the creator of this world
  const owned = await rd
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)))
    .limit(1);

  if (owned.length > 0) {
    return c.json({ data: { exists: true, worldId: owned[0]!.id } });
  }

  return c.json({ data: { exists: false } });
});

// POST /api/worlds/:id/gallery/upload-url — get presigned URL for gallery image
worldRoutes.post("/:id/gallery/upload-url", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  const existing = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (existing.length === 0) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const body = await c.req.json<{ filename: string; contentType: string }>();
  if (!body.filename || !body.contentType) {
    return c.json({ error: "filename and contentType are required" }, 400);
  }

  const ext = body.filename.split(".").pop() ?? "png";
  const key = `worlds/${worldId}/gallery/${crypto.randomUUID()}.${ext}`;

  const uploadUrl = await generateUploadUrl(key, body.contentType);
  return c.json({ data: { uploadUrl, key } });
});

// POST /api/worlds/:id/gallery/confirm — confirm gallery upload, append to array
worldRoutes.post("/:id/gallery/confirm", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const body = await c.req.json<{ key: string }>();

  if (!body.key || !body.key.startsWith(`worlds/${worldId}/gallery/`)) {
    return c.json({ error: "Invalid gallery key" }, 400);
  }

  const existing = await db
    .select({ galleryImages: worlds.galleryImages })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (existing.length === 0) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const currentImages = (existing[0]!.galleryImages as string[] | null) ?? [];
  if (currentImages.length >= 8) {
    return c.json({ error: "Maximum 8 gallery images allowed" }, 400);
  }

  const updatedImages = [...currentImages, body.key];

  await db
    .update(worlds)
    .set({ galleryImages: updatedImages, updatedAt: new Date() })
    .where(eq(worlds.id, worldId));

  // Return CDN URL for the new image
  const url = resolveImageCdn(body.key) ?? body.key;

  return c.json({ data: { url, galleryImages: updatedImages } });
});

// DELETE /api/worlds/:id/gallery/:index — remove a gallery image by index
worldRoutes.delete("/:id/gallery/:index", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const index = parseInt(c.req.param("index"));

  if (isNaN(index) || index < 0) {
    return c.json({ error: "Invalid index" }, 400);
  }

  const existing = await db
    .select({ galleryImages: worlds.galleryImages })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (existing.length === 0) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const currentImages = (existing[0]!.galleryImages as string[] | null) ?? [];
  if (index >= currentImages.length) {
    return c.json({ error: "Index out of range" }, 400);
  }

  const updatedImages = currentImages.filter((_, i) => i !== index);

  await db
    .update(worlds)
    .set({ galleryImages: updatedImages, updatedAt: new Date() })
    .where(eq(worlds.id, worldId));

  return c.json({ data: { galleryImages: updatedImages } });
});

// GET /api/worlds/:id/friends-playing — auth required
worldRoutes.get("/:id/friends-playing", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const worldId = c.req.param("id");

  // Find users that current user follows who have play sessions for this world
  const result = await rd.execute(
    sql`SELECT DISTINCT u.id, u.name, u.image, u.username
        FROM follows f
        JOIN play_sessions ps ON ps.user_id = f.following_id
        JOIN "user" u ON u.id = f.following_id
        WHERE f.follower_id = ${currentUser.id}
          AND ps.world_id = ${worldId}
        LIMIT 10`
  );

  return c.json({ data: { users: result.rows } });
});

// POST /api/worlds/:id/updates — create a record, optionally notify library users
worldRoutes.post("/:id/updates", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = parseWorldUpdateNoteBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const note = parsed.data;
  const requestedNotify = (body as Record<string, unknown>).notifyPlayers;
  if (requestedNotify !== undefined && typeof requestedNotify !== "boolean") {
    return c.json({ error: "notifyPlayers must be a boolean" }, 400);
  }
  // Preserve the existing notify-dialog contract for clients that omit this
  // field. Independent history entries opt out explicitly.
  const notifyPlayers = requestedNotify !== false;

  const creation = await db.transaction(async (tx) => {
    const [world] = await tx
      .select({ id: worlds.id, name: worlds.name, status: worlds.status })
      .from(worlds)
      .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)))
      .for("update")
      .limit(1);
    if (!world) return { kind: "not_found" as const };
    const [pending] = await tx
      .select({ worldId: worldPendingEdits.worldId })
      .from(worldPendingEdits)
      .where(eq(worldPendingEdits.worldId, worldId))
      .limit(1);
    if (pending) return { kind: "pending" as const };
    if (!["published", "draft", "unpublished", "rejected"].includes(world.status)) {
      return { kind: "unavailable" as const };
    }
    if (notifyPlayers && world.status !== "published") {
      return { kind: "cannot_notify" as const };
    }

    const [update] = await tx
      .insert(worldUpdates)
      .values({
        worldId,
        title: note.title,
        content: note.content,
        isMajor: note.isMajor,
      })
      .returning();
    return { kind: "created" as const, world, update: update! };
  });

  if (creation.kind === "not_found") return c.json({ error: "World not found" }, 404);
  if (creation.kind === "unavailable") {
    return c.json({ error: "Update records cannot be added in this world state", code: "WORLD_UPDATE_UNAVAILABLE" }, 409);
  }
  if (creation.kind === "cannot_notify") {
    return c.json({ error: "Only published worlds can notify players", code: "WORLD_UPDATE_NOTIFY_UNAVAILABLE" }, 400);
  }
  if (creation.kind === "pending") {
    return c.json({
      error: "This world has changes waiting for review. Attach the update note to those changes instead.",
      code: "WORLD_EDIT_PENDING",
    }, 409);
  }
  const { world, update } = creation;

  // Fan out notifications. History is already durable, so every failure after
  // this point is best-effort; returning an error would invite a duplicate
  // update when the author retries the preserved dialog input.
  if (notifyPlayers) {
    try {
      const libraryUsers = await db
        .select({ userId: userLibrary.userId })
        .from(userLibrary)
        .where(eq(userLibrary.worldId, worldId));

      if (libraryUsers.length > 0) {
        await notifyMany(
          libraryUsers.map((lu) => lu.userId).filter((uid) => uid !== currentUser.id),
          "world_update",
          {
            worldId,
            worldName: world.name,
            updateId: update.id,
            title: note.title,
            isMajor: note.isMajor,
            creatorUserId: currentUser.id,
          },
          { actorUserId: currentUser.id },
        );
      }
    } catch (error) {
      console.error("World update notification fan-out failed", { worldId, updateId: update.id, error });
    }
  }

  return c.json({ data: update }, 201);
});

worldRoutes.route("/", createWorldUpdateEditRoutes(db, authMiddleware, rateLimitMiddleware("content-creation")));

// GET /api/worlds/:id/updates — list updates for a world
worldRoutes.get("/:id/updates", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const currentUser = c.get("user");
  const rd = currentUser ? await readOwn(currentUser.id) : await readDb();
  const rawOffset = c.req.query("offset") ?? "0";
  const offset = normalizeWorldUpdateOffset(rawOffset);

  const [world] = await rd
    .select({ creatorId: worlds.creatorId, status: worlds.status, visibility: worlds.visibility, ageRating: worlds.ageRating })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  if (!world) {
    return c.json({ error: "World not found" }, 404);
  }
  // Guests never read Limitless surfaces (update notes can quote card content).
  if (!currentUser && (world.ageRating ?? "all") !== "all") {
    return c.json({ error: "World not found" }, 404);
  }

  const isOwner = currentUser?.id === world.creatorId;
  const isAdmin = currentUser?.role === "admin";
  let isFollower = false;
  if (currentUser && !isOwner && !isAdmin) {
    const [follow] = await rd
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(and(eq(follows.followerId, currentUser.id), eq(follows.followingId, world.creatorId)))
      .limit(1);
    isFollower = !!follow;
  }
  const canReadRestricted = !!(isOwner || isAdmin || isFollower);
  if (!canReadWorldUpdateHistory({
    status: world.status,
    visibility: world.visibility,
    isOwner: !!isOwner,
    isAdmin,
    isFollower,
  })) {
    return c.json({ error: "World not found" }, 404);
  }

  let canCreate = false;
  if (isOwner && ["published", "draft", "unpublished", "rejected"].includes(world.status)) {
    const [pending] = await rd
      .select({ worldId: worldPendingEdits.worldId })
      .from(worldPendingEdits)
      .where(eq(worldPendingEdits.worldId, worldId))
      .limit(1);
    canCreate = !pending;
  }

  const rows = await rd
    .select({
      id: worldUpdates.id,
      worldId: worldUpdates.worldId,
      title: worldUpdates.title,
      content: worldUpdates.content,
      isMajor: worldUpdates.isMajor,
      createdAt: worldUpdates.createdAt,
      creatorName: user.name,
    })
    .from(worldUpdates)
    .innerJoin(worlds, eq(worldUpdates.worldId, worlds.id))
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(sql`${worldUpdates.worldId} IN (
      SELECT w.id FROM worlds w
      WHERE w.creator_id = (SELECT creator_id FROM worlds WHERE id = ${worldId})
        AND (w.id = ${worldId}
         OR (w.status = 'published'
             AND (${canReadRestricted} OR w.visibility = 'public')
             AND w.language_group_id IS NOT NULL
             AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId})))
    )`)
    .orderBy(desc(worldUpdates.createdAt), desc(worldUpdates.id))
    .limit(WORLD_UPDATE_PAGE_SIZE + 1)
    .offset(offset);
  const hasMore = hasMoreWorldUpdates(rows.length, offset);
  const items = rows.slice(0, WORLD_UPDATE_PAGE_SIZE);
  c.header(
    "Cache-Control",
    currentUser ? "private, no-store" : "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
  );
  c.header("Vary", "Cookie");

  return c.json({
    data: items,
    canEdit: isOwner,
    canCreate,
    canNotify: canCreate && world.status === "published",
    hasMore,
    nextOffset: hasMore ? offset + items.length : null,
  });
});

// Content version history and publication rollback.
worldRoutes.route("/", worldVersionRoutes);

// GET /api/worlds/:id/in-library — check if world is in user's library
worldRoutes.get("/:id/in-library", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const worldId = c.req.param("id");

  const [libEntry] = await rd
    .select({ id: userLibrary.id })
    .from(userLibrary)
    .where(and(eq(userLibrary.userId, currentUser.id), eq(userLibrary.worldId, worldId)))
    .limit(1);

  if (libEntry) return c.json({ data: { inLibrary: true } });

  const [owned] = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)))
    .limit(1);

  return c.json({ data: { inLibrary: !!owned } });
});

// ─── Language variant endpoints ────────────────────────────────────

// POST /api/worlds/:id/set-primary — mark this variant as the 主 (primary) for
// its (language_group, language), demoting same-language siblings to 副. The hub
// shows only the 主 per language; 副 remain playable via the version picker.
worldRoutes.post("/:id/set-primary", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const [row] = await db
    .select({
      creatorId: worlds.creatorId,
      languageGroupId: worlds.languageGroupId,
      language: worlds.language,
      isPublished: worlds.isPublished,
      status: worlds.status,
    })
    .from(worlds)
    .where(eq(worlds.id, worldId));
  if (!row || row.creatorId !== currentUser.id) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }
  if (!row.languageGroupId) {
    // Ungrouped cards are trivially their own primary — nothing to do.
    return c.json({ data: { isPrimaryVariant: true } });
  }
  // Only a PUBLISHED variant may become the public face for its language. Allowing
  // a draft to be promoted would demote the live 副 and blank the card from the hub
  // (the new 主 fails the published filter, the old one is no longer primary).
  if (!(row.isPublished === true && row.status === "published")) {
    return c.json(
      { error: "Only a published version can be set as the primary. Publish this version first.", code: "PRIMARY_MUST_BE_PUBLISHED" },
      400,
    );
  }
  await db.transaction(async (tx) => {
    await tx
      .update(worlds)
      .set({ isPrimaryVariant: false, updatedAt: new Date() })
      .where(and(
        eq(worlds.languageGroupId, row.languageGroupId!),
        sql`coalesce(${worlds.language},'') = coalesce(${row.language ?? ""},'')`,
      ));
    await tx
      .update(worlds)
      .set({ isPrimaryVariant: true, updatedAt: new Date() })
      .where(eq(worlds.id, worldId));
  });
  return c.json({ data: { isPrimaryVariant: true } });
});

// GET /api/worlds/:id/language-variants — get all language siblings
//
// Response includes `allowEdit` + `creatorId` so client-side variant pickers
// (download/fork) can disable rows whose author has opted out of forking and
// short-circuit when the viewer owns one of the variants. Without these
// fields, library/hub Fork dialogs would happily POST a duplicate request
// against a `allow_edit=false` variant and fall back to a generic "复制失败"
// toast — the exact failure mode the kljws bug surfaced for `轮回：直视她的瞳`'s
// 深度思考版本/轻量版本/较稳定版本 (all `allow_edit=false`).
worldRoutes.get("/:id/language-variants", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const currentUser = getOptionalUser(c);
  const rd = await readDb(currentUser?.id);

  const [world] = await rd
    .select({
      id: worlds.id,
      languageGroupId: worlds.languageGroupId,
      language: worlds.language,
      name: worlds.name,
      thumbnailUrl: worlds.thumbnailUrl,
      variantLabel: worlds.variantLabel,
      allowEdit: worlds.allowEdit,
      creatorId: worlds.creatorId,
      isPrimaryVariant: worlds.isPrimaryVariant,
      status: worlds.status,
      ageRating: worlds.ageRating,
    })
    .from(worlds)
    .where(eq(worlds.id, worldId));

  if (!world) return c.json({ data: [] });
  // Guests never read Limitless surfaces (variant names are content too).
  if (!currentUser && (world.ageRating ?? "all") !== "all") {
    return c.json({ data: [] });
  }
  if (!world.languageGroupId) {
    return c.json({
      data: [{
        id: world.id,
        language: world.language,
        name: world.name,
        variantLabel: world.variantLabel,
        thumbnailUrl: resolveImageCdn(world.thumbnailUrl),
        allowEdit: world.allowEdit,
        creatorId: world.creatorId,
        isPrimaryVariant: world.isPrimaryVariant ?? true,
        status: world.status,
      }],
    });
  }

  // Show published siblings + the current world + any drafts owned by the current user
  const visibilityFilter = currentUser
    ? or(eq(worlds.status, "published"), eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id))
    : or(eq(worlds.status, "published"), eq(worlds.id, worldId));

  const siblings = await rd
    .select({
      id: worlds.id,
      name: worlds.name,
      language: worlds.language,
      variantLabel: worlds.variantLabel,
      thumbnailUrl: worlds.thumbnailUrl,
      allowEdit: worlds.allowEdit,
      creatorId: worlds.creatorId,
      isPrimaryVariant: worlds.isPrimaryVariant,
      status: worlds.status,
    })
    .from(worlds)
    .where(
      and(
        eq(worlds.languageGroupId, world.languageGroupId),
        visibilityFilter,
      ),
    )
    // Primary (主) first, then oldest — so the editor tab bar and player version
    // picker list the public face first within each language.
    .orderBy(sql`${worlds.isPrimaryVariant} DESC, ${worlds.createdAt} ASC`);

  const resolved = siblings.map((s) => ({
    ...s,
    thumbnailUrl: resolveImageCdn(s.thumbnailUrl),
  }));

  return c.json({ data: resolved });
});

// POST /api/worlds/:id/link-language — link another world as a language variant
worldRoutes.post("/:id/link-language", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const body = await c.req.json<{
    targetWorldId: string;
    language?: string;
    targetLanguage?: string;
  }>();

  if (!body.targetWorldId) {
    return c.json({ error: "targetWorldId is required" }, 400);
  }
  if (body.language && !VALID_LANGUAGE_CODES.has(body.language)) {
    return c.json({ error: `Invalid language code: "${body.language}"` }, 400);
  }
  if (body.targetLanguage && !VALID_LANGUAGE_CODES.has(body.targetLanguage)) {
    return c.json({ error: `Invalid language code: "${body.targetLanguage}"` }, 400);
  }

  const [source] = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  const [target] = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, body.targetWorldId), eq(worlds.creatorId, currentUser.id)));

  if (!source || !target) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // Validate against the EFFECTIVE (post-override) languages, not the raw rows —
  // a body.language/targetLanguage override could otherwise slip a same-language
  // pair past the check and collide on worlds_primary_variant_uniq.
  const effSrcLang = body.language ?? source.language;
  const effTgtLang = body.targetLanguage ?? target.language;

  // Both sides must have a language: two NULL-language rows would land as two
  // primaries the unique index can't catch (NULLs are distinct). Mirror add-variant.
  if (!effSrcLang || !effTgtLang) {
    return c.json({ error: "Both worlds need a language set before linking them as variants." }, 400);
  }
  // Validate: same language
  if (effSrcLang === effTgtLang) {
    return c.json({ error: "Both worlds have the same language. Variants must have different languages." }, 400);
  }

  // Validate: conflicting groups
  if (source.languageGroupId && target.languageGroupId && source.languageGroupId !== target.languageGroupId) {
    return c.json({ error: "These worlds belong to different language groups. Unlink one first." }, 400);
  }

  const groupId = source.languageGroupId ?? target.languageGroupId ?? crypto.randomUUID();

  // Validate: no EXISTING group member (other than these two) already uses either
  // effective language — that would create two same-language 主. Runs even for a
  // freshly-minted group (the query simply returns the two rows being linked).
  const existing = await db
    .select({ id: worlds.id, language: worlds.language })
    .from(worlds)
    .where(eq(worlds.languageGroupId, groupId));
  const collision = existing.find(
    (w) => w.id !== worldId && w.id !== body.targetWorldId &&
      (w.language === effSrcLang || w.language === effTgtLang),
  );
  if (collision) {
    return c.json({ error: `A variant with language "${collision.language}" already exists in this group.` }, 400);
  }

  await db.transaction(async (tx) => {
    // Each side is the sole row of its (distinct, collision-checked) language in
    // the group, so each is that language's 主. Different languages → no
    // worlds_primary_variant_uniq conflict.
    await tx
      .update(worlds)
      .set({
        languageGroupId: groupId,
        ...(body.language ? { language: body.language } : {}),
        isPrimaryVariant: true,
        updatedAt: new Date(),
      })
      .where(eq(worlds.id, worldId));

    await tx
      .update(worlds)
      .set({
        languageGroupId: groupId,
        ...(body.targetLanguage ? { language: body.targetLanguage } : {}),
        isPrimaryVariant: true,
        updatedAt: new Date(),
      })
      .where(eq(worlds.id, body.targetWorldId));

    // Back-fill any language a moved row vacated (e.g. source changed language and
    // left its old language primary-less). Only promotes, never duplicates.
    await ensureGroupPrimaries(tx as unknown as typeof db, groupId);
  });

  return c.json({ data: { languageGroupId: groupId } });
});

// POST /api/worlds/:id/unlink-language — remove a world from its language group
worldRoutes.post("/:id/unlink-language", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  // Get the world first to know its group
  const [world] = await db
    .select({ id: worlds.id, languageGroupId: worlds.languageGroupId })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (!world) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const oldGroupId = world.languageGroupId;

  // Clear this world's group and variant label
  await db
    .update(worlds)
    .set({ languageGroupId: null, variantLabel: null, updatedAt: new Date() })
    .where(eq(worlds.id, worldId));

  // If there was a group, check if only 1 member remains — if so, clear it too (group of 1 is meaningless)
  if (oldGroupId) {
    const remaining = await db
      .select({ id: worlds.id })
      .from(worlds)
      .where(eq(worlds.languageGroupId, oldGroupId));

    if (remaining.length === 1) {
      await db
        .update(worlds)
        .set({ languageGroupId: null, variantLabel: null, updatedAt: new Date() })
        .where(eq(worlds.id, remaining[0]!.id));
    }
  }

  return c.json({ data: { success: true } });
});

// POST /api/worlds/:id/add-language-variant — upload JSON to create a linked language variant
worldRoutes.post("/:id/add-language-variant", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const body = await c.req.json<{
    schema: Record<string, unknown>;
    language: string;
    name?: string;
    description?: string;
  }>();

  if (!body.schema || !body.language) {
    return c.json({ error: "schema and language are required" }, 400);
  }
  if (typeof body.schema !== "object" || Array.isArray(body.schema)) {
    return c.json({ error: "schema must be an object" }, 400);
  }
  if (!VALID_LANGUAGE_CODES.has(body.language)) {
    return c.json({ error: `Invalid language code: "${body.language}"` }, 400);
  }
  // Same inline-asset guard the PATCH save enforces — a freshly uploaded variant
  // must not smuggle in base64 data URIs (CDN-defeating bloat).
  const variantInline = scanWorldSchemaForInlineAssets(body.schema);
  if (variantInline.length > 0) {
    return c.json(
      {
        error: "Variant schema contains inline base64 data URIs",
        message: "Upload embedded assets via the Library and reference them with @asset:{assetId} instead of inlining data URIs.",
        issues: variantInline,
      },
      400,
    );
  }

  // Verify source world
  const [source] = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (!source) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  if (!source.language) {
    return c.json({ error: "Set a language for this world first" }, 400);
  }

  if (source.language === body.language) {
    return c.json({ error: "Variant language must differ from the source world" }, 400);
  }

  // Check no duplicate language in existing group
  const groupId = source.languageGroupId ?? crypto.randomUUID();
  if (source.languageGroupId) {
    const existing = await db
      .select({ language: worlds.language })
      .from(worlds)
      .where(eq(worlds.languageGroupId, source.languageGroupId));
    if (existing.some((w) => w.language === body.language)) {
      return c.json({ error: `A variant with language "${body.language}" already exists` }, 400);
    }
  }

  // Compute tokens
  let totalTokens = 0;
  try {
    const entries = ((body.schema as any)?.entries as Array<{ content?: string }>) ?? [];
    totalTokens = entries.reduce((sum: number, e: { content?: string }) => sum + estimateTokens(e.content ?? ""), 0);
  } catch { /* default 0 */ }

  const variantName = body.name || (body.schema as any)?.name || "Untitled";
  const variantDesc = body.description ?? (body.schema as any)?.description ?? "";

  // Create the variant world + link in a transaction
  const result = await db.transaction(async (tx) => {
    const [newWorld] = await tx
      .insert(worlds)
      .values({
        creatorId: currentUser.id,
        name: variantName,
        description: variantDesc,
        schema: body.schema,
        language: body.language,
        languageGroupId: groupId,
        // A new language variant carries caller-supplied content, so it must NOT
        // inherit the source's published status — that would put arbitrary,
        // unreviewed content live. It starts as a draft and goes through the
        // normal publish → review flow like any other world.
        status: "draft",
        isPublished: false,
        totalTokens,
      })
      .returning();

    // Ensure source world has the group ID
    if (!source.languageGroupId) {
      await tx
        .update(worlds)
        .set({ languageGroupId: groupId, updatedAt: new Date() })
        .where(eq(worlds.id, worldId));
    }

    return newWorld!;
  });

  return c.json({ data: { world: result, languageGroupId: groupId } }, 201);
});

// POST /api/worlds/:id/create-variant — clone current world as a new variant.
// `label` is optional free text; omit it and the pickers fall back to the new
// variant's own title.
worldRoutes.post("/:id/create-variant", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  let body: { label?: string; language?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (body.label != null && typeof body.label !== "string") {
    return c.json({ error: "label must be a string" }, 400);
  }
  // An omitted/blank label is the normal case for a variant in a language the
  // group doesn't have yet: the picker falls back to that variant's own title,
  // which the author translates as part of building it and which therefore
  // never goes stale. A label is only needed to tell same-language variants
  // apart, and then the client sends one.
  const label = (body.label ?? "").trim().slice(0, 100) || null;
  if (body.language && !VALID_LANGUAGE_CODES.has(body.language)) {
    return c.json({ error: "Invalid language code" }, 400);
  }

  // Verify source world
  const [source] = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (!source) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const groupId = source.languageGroupId ?? crypto.randomUUID();
  const copyMaterial = await resolveWorldCopyMaterial(source, currentUser.id);

  // Compute tokens for the clone without trusting legacy schema shape.
  const totalTokens = estimateWorldCopyTokens(copyMaterial.schema);

  const result = await db.transaction(async (tx) => {
    // The source keeps whatever label it already had — including none. We used
    // to stamp one derived from its language here, which is where every
    // "English" / "Español" row in the picker came from: a label that repeats
    // the language badge next to it and never says which card you are picking.
    // Leaving it NULL lets the picker fall back to the variant's own title.
    const sourceNeedsGroup = !source.languageGroupId;
    if (sourceNeedsGroup) {
      await tx
        .update(worlds)
        .set({ languageGroupId: groupId, updatedAt: new Date() })
        .where(eq(worlds.id, worldId));
    }

    // 主/副: the new variant becomes the primary (主) for its language ONLY if no
    // sibling already occupies that language in the group (the source counts —
    // it's in the group by now). A second same-language variant starts as 副.
    const newLang = body.language || source.language;
    const sameLangSibling = await tx
      .select({ id: worlds.id })
      .from(worlds)
      .where(and(
        eq(worlds.languageGroupId, groupId),
        sql`coalesce(${worlds.language},'') = coalesce(${newLang ?? ""},'')`,
      ))
      .limit(1);
    const newIsPrimary = sameLangSibling.length === 0;

    // Clone the world
    const [newWorld] = await tx
      .insert(worlds)
      .values({
        creatorId: currentUser.id,
        name: source.name,
        description: source.description,
        schema: copyMaterial.schema,
        thumbnailUrl: copyMaterial.thumbnailUrl,
        tags: clampWorldTags(source.tags ?? []),
        language: body.language || source.language,
        languageGroupId: groupId,
        variantLabel: label,
        isPrimaryVariant: newIsPrimary,
        // Clone starts as a draft even when the source is published: the variant
        // is a distinct world that must be published (and reviewed) on its own.
        status: "draft",
        isPublished: false,
        isNsfw: copyMaterial.isNsfw ?? false,
        allowEdit: source.allowEdit ?? true,
        allowReviews: source.allowReviews ?? true,
        ageRating: copyMaterial.ageRating,
        blurCover: source.blurCover,
        visibility: source.visibility,
        galleryImages: source.galleryImages,
        announcement: source.announcement,
        approxTime: source.approxTime,
        totalTokens,
      })
      .returning();

    // Copy asset references
    const sourceRefs = await tx
      .select()
      .from(assetReferences)
      .where(eq(assetReferences.worldId, worldId));

    if (sourceRefs.length > 0) {
      await tx.insert(assetReferences).values(
        sourceRefs.map((ref) => ({
          worldId: newWorld!.id,
          assetId: ref.assetId,
        }))
      );
    }

    return newWorld!;
  });

  return c.json({ data: { world: result, languageGroupId: groupId } }, 201);
});

// ─── World Reviews ────────────────────────────────────────────────────────────
// Moved here from reviewsRoutes so they share the /api/worlds mount prefix
// and don't depend on cross-prefix routing (which caused 401s for public GET).

// GET /api/worlds/:id/reviews — list reviews for a world (public, optional auth for read-after-write)
// Aggregates across sibling language variants so the list matches the rating endpoint,
// which sums counts across `language_group_id`. Without this, opening a variant whose
// reviews all live on a sibling variant shows "Reviews (N)" with an empty list.
worldRoutes.get("/:id/reviews", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const currentUser = c.get("user");
  // An authed viewer's response includes their OWN review (read-after-write must
  // surface their just-posted/edited review — see the private,no-store header
  // below), so route the authed read to primary via readOwn. Anonymous browse of
  // the public reviews list stays on the replica via readDb.
  const rd = currentUser ? await readOwn(currentUser.id) : await readDb();
  const hiddenActivityUserIds = currentUser
    ? (await listBlockedUsersForHiding(currentUser.id)).hideActivityUserIds
    : [];

  const [worldRow] = await rd
    .select({ creatorId: worlds.creatorId, ageRating: worlds.ageRating })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  const isWorldCreator = !!currentUser && !!worldRow && worldRow.creatorId === currentUser.id;
  // Guests never read Limitless surfaces (reviews quote card content).
  if (!currentUser && worldRow && (worldRow.ageRating ?? "all") !== "all") {
    return c.json({ data: [] });
  }

  const rawResult = await rd
    .select({
      id: reviews.id,
      userId: reviews.userId,
      rating: reviews.rating,
      content: reviews.content,
      replyCount: reviews.replyCount,
      hiddenByCreatorAt: reviews.hiddenByCreatorAt,
      createdAt: reviews.createdAt,
      updatedAt: reviews.updatedAt,
      userName: user.name,
      userImage: user.image,
      userUsername: user.username,
    })
    .from(reviews)
    .innerJoin(user, eq(reviews.userId, user.id))
    .where(
      and(
        sql`${reviews.worldId} IN (
          SELECT w.id FROM worlds w
          WHERE w.id = ${worldId}
             OR (w.language_group_id IS NOT NULL
                 AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId}))
        )`,
        hiddenActivityUserIds.length > 0
          ? sql`${reviews.userId} NOT IN (${sql.join(hiddenActivityUserIds.map((id) => sql`${id}`), sql`, `)})`
          : sql`TRUE`
      )
    )
    .orderBy(desc(reviews.createdAt));

  // Hide creator-soft-deleted reviews from everyone except the world's creator
  // and the review's own author (so reviewer can see their review was hidden).
  const result = rawResult.filter((r) => {
    if (!r.hiddenByCreatorAt) return true;
    if (isWorldCreator) return true;
    if (currentUser && r.userId === currentUser.id) return true;
    return false;
  });

  const authorIds = [...new Set(result.map((r) => r.userId))];
  const playtimeRows = authorIds.length
    ? await rd.execute(reviewPlaytimeQuery(worldId, authorIds))
    : { rows: [] };
  const playtimeByAuthor = new Map(playtimeRows.rows.map((row) => [
    String(row.user_id), Number(row.seconds),
  ]));

  // Enrich with translations
  const reviewIds = result.filter((r) => r.content).map((r) => r.id);
  const txMap = new Map<string, { zh: string | null; en: string | null; es: string | null; ja: string | null }>();
  if (reviewIds.length > 0) {
    const txRows = await rd
      .select({
        sourceId: contentTranslations.sourceId,
        targetLang: contentTranslations.targetLang,
        translatedContent: contentTranslations.translatedContent,
      })
      .from(contentTranslations)
      .where(
        and(
          inArray(contentTranslations.sourceId, reviewIds),
          eq(contentTranslations.sourceType, "review")
        )
      );
    for (const tx of txRows) {
      const existing = txMap.get(tx.sourceId) ?? { zh: null, en: null, es: null, ja: null };
      if (tx.targetLang === "zh") existing.zh = tx.translatedContent;
      if (tx.targetLang === "en") existing.en = tx.translatedContent;
      if (tx.targetLang === "es") existing.es = tx.translatedContent;
      if (tx.targetLang === "ja") existing.ja = tx.translatedContent;
      txMap.set(tx.sourceId, existing);
    }
  }

  const resolved = result.map((r) => {
    const tx = txMap.get(r.id);
    return {
      ...r,
      playtimeSeconds: playtimeByAuthor.get(r.userId) ?? 0,
      hiddenByCreator: !!r.hiddenByCreatorAt,
      lang: r.content ? detectLang(r.content) : "en",
      userImage: resolveImageCdn(r.userImage),
      translatedContent_zh: tx?.zh ?? null,
      translatedContent_en: tx?.en ?? null,
      translatedContent_es: tx?.es ?? null,
      translatedContent_ja: tx?.ja ?? null,
    };
  });

  // Authenticated users get fresh data (no browser/CDN cache) for read-after-write;
  // anonymous users can use shared cache for performance.
  if (currentUser) {
    c.header("Cache-Control", "private, no-store");
  } else {
    c.header("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  }
  c.header("Vary", "Cookie");
  return c.json({ data: resolved });
});

// GET /api/worlds/:id/rating — average rating, rater count, star distribution
// (public), plus the viewer's own rating when authenticated. Ratings live in
// world_ratings (one row per user per language group), so comment volume never
// moves these numbers.
worldRoutes.get("/:id/rating", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const currentUser = c.get("user");
  // Authed reads go to primary so a just-saved rating is visible immediately.
  const rd = currentUser ? await readOwn(currentUser.id) : await readDb();

  const groupFilter = sql`${worldRatings.worldId} IN (
    SELECT w.id FROM worlds w
    WHERE w.id = ${worldId}
       OR (w.language_group_id IS NOT NULL
           AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId}))
  )`;

  // Comments live in `reviews`, ratings in `world_ratings`, and the two counts
  // are NOT the same number — a rating-only submission leaves no comment row.
  // The Reviews tab labels a comment feed, so it needs the comment count; the
  // star summary keeps using reviewCount ("N ratings"). Without this, a card
  // with 3 raters and 1 comment reads "Reviews (3)" above a 1-item list.
  const commentGroupFilter = sql`${reviews.worldId} IN (
    SELECT w.id FROM worlds w
    WHERE w.id = ${worldId}
       OR (w.language_group_id IS NOT NULL
           AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId}))
  )`;

  const [summary, distributionRows, myRatingRows, commentSummary] = await Promise.all([
    rd
      .select({
        avg: sql<number>`COALESCE(AVG(${worldRatings.rating}), 0)::real`,
        count: sql<number>`count(*)::int`,
      })
      .from(worldRatings)
      .where(groupFilter),
    rd
      .select({
        rating: worldRatings.rating,
        count: sql<number>`count(*)::int`,
      })
      .from(worldRatings)
      .where(groupFilter)
      .groupBy(worldRatings.rating),
    currentUser
      ? rd
          .select({ rating: worldRatings.rating })
          .from(worldRatings)
          .where(and(eq(worldRatings.userId, currentUser.id), groupFilter))
          .limit(1)
      : Promise.resolve([] as Array<{ rating: number }>),
    rd
      .select({ count: sql<number>`count(*)::int` })
      .from(reviews)
      .where(
        and(
          commentGroupFilter,
          sql`${reviews.content} IS NOT NULL AND btrim(${reviews.content}) <> ''`,
          sql`${reviews.hiddenByCreatorAt} IS NULL`
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

// PUT /api/worlds/:id/rating — set/update the viewer's star rating (1-5).
// One rating per user per language group: an existing row on any sibling
// variant is updated in place, otherwise a new row lands on this variant.
worldRoutes.put("/:id/rating", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const body = await c.req.json();

  const rating = body.rating;
  if (!rating || typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ error: "Rating must be 1-5" }, 400);
  }

  const gate = await checkReviewGate(currentUser, worldId, { blockSelfRating: true });
  if (gate) return gate.response;

  const result = await upsertWorldRating(currentUser.id, worldId, rating);

  flagWrite(currentUser.id);
  invalidateRecommendationProfile(currentUser.id).catch(() => {});
  // Rating adds the world to the exclusion set — the cached feed pages must
  // go too, or they keep serving the now-excluded world until an unrelated
  // event clears them (this was the residual "library world still in my
  // feed" leak: ~14 stray emissions per 48h measured 2026-08-20).
  invalidateRecommendationFeed(currentUser.id).catch(() => {});
  recomputeReviewStats(result.storedWorldId);
  void onReview(currentUser.id, worldId);

  if (result.isNew) {
    (async () => {
      const [world] = await db
        .select({
          creatorId: worlds.creatorId,
          name: worlds.name,
          thumbnailUrl: worlds.thumbnailUrl,
          languageGroupId: worlds.languageGroupId,
        })
        .from(worlds)
        .where(eq(worlds.id, worldId));
      if (world && world.creatorId !== currentUser.id) {
        await notifyWorldReview(world.creatorId, {
          worldId,
          worldGroupId: world.languageGroupId ?? worldId,
          worldName: world.name,
          thumbnailUrl: world.thumbnailUrl,
          reviewerName: currentUser.name,
          reviewerUserId: currentUser.id,
          ratingEventId: result.ratingEventId,
          rating,
        });
      }
    })().catch((error) => {
      console.error("[notifications] Failed to create world rating notification:", error);
    });
  }

  return c.json({ data: { rating, isNew: result.isNew } });
});

// POST /api/worlds/:id/reviews — post a comment on the card's comment feed.
// Comments are append-only: users can post as many as they like. The optional
// `rating` field upserts the user's star rating and is stored on the comment
// row as a snapshot badge. Content may be omitted for a rating-only review.
worldRoutes.post("/:id/reviews", authMiddleware, communityMuteMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const body = await c.req.json();

  const rating = typeof body.rating === "number" && Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5
    ? body.rating
    : null;

  const rawContent = typeof body.content === "string" ? body.content.trim() : null;
  const content = rawContent ? sanitizeContent(rawContent) || null : null;
  if (content && content.length > MAX_REVIEW_CONTENT) {
    return c.json({ error: "Comment too long" }, 400);
  }
  if (!content && !rating) {
    return c.json({ error: "Comment cannot be empty" }, 400);
  }

  // Block a self-RATING even on the combined comment+rating endpoint, but
  // still allow the creator to post a plain comment on their own world.
  const gate = await checkReviewGate(currentUser, worldId, { blockSelfRating: rating !== null });
  if (gate) return gate.response;

  // A rating submitted with the optional comment updates the user's
  // one-per-card star rating exactly like PUT /:id/rating would.
  let ratingResult: Awaited<ReturnType<typeof upsertWorldRating>> | null = null;
  if (rating) {
    ratingResult = await upsertWorldRating(currentUser.id, worldId, rating);
    recomputeReviewStats(ratingResult.storedWorldId);
    void onReview(currentUser.id, worldId);
  }

  let review = null;
  if (content) {
    const inserted = await db
      .insert(reviews)
      .values({ userId: currentUser.id, worldId, rating, content })
      .returning();
    review = inserted[0];
  }

  flagWrite(currentUser.id);

  // Invalidate cached recommendation profile so the next hub load
  // reflects the new comment/rating in scoring weights and exclusion sets.
  invalidateRecommendationProfile(currentUser.id).catch(() => {});
  invalidateRecommendationFeed(currentUser.id).catch(() => {});

  // Translate comment content (fire-and-forget). No up-front delete: an edited
  // comment's cached rows stay readable until a fresh translation succeeds,
  // since translateOne detects the stale hash and overwrites on success.
  if (review && content) {
    const lang = detectLang(content);
    translateContent(review.id, "review", lang, content, currentUser.id).catch(() => {});
  }

  // The rating and optional comment for one evaluation share one notification.
  // notifyWorldReview also merges separate rating/comment requests from older
  // clients into that same notification.
  await (async () => {
    const [world] = await db
      .select({
        creatorId: worlds.creatorId,
        name: worlds.name,
        thumbnailUrl: worlds.thumbnailUrl,
        languageGroupId: worlds.languageGroupId,
      })
      .from(worlds)
      .where(eq(worlds.id, worldId));
    if (!world || world.creatorId === currentUser.id) return;
    const worldGroupId = world.languageGroupId ?? worldId;
    if (review) {
      const [savedRating] = ratingResult
        ? []
        : await db
            .select({
              id: worldRatings.id,
              rating: worldRatings.rating,
              updatedAt: worldRatings.updatedAt,
            })
            .from(worldRatings)
            .where(and(
              eq(worldRatings.userId, currentUser.id),
              sql`${worldRatings.worldId} IN (
                SELECT w.id FROM worlds w
                WHERE w.id = ${worldId}
                   OR (w.language_group_id IS NOT NULL
                       AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId}))
              )`,
            ))
            .limit(1);
      const recentSavedRating = savedRating
        ? recentWorldRatingNotification(savedRating)
        : null;
      const ratingForNotification = ratingResult
        ? { rating: rating!, ratingEventId: ratingResult.ratingEventId }
        : recentSavedRating;

      if (ratingForNotification) {
        const result = await notifyWorldReview(world.creatorId, {
          worldId,
          worldGroupId,
          worldName: world.name,
          thumbnailUrl: world.thumbnailUrl,
          reviewerName: currentUser.name,
          reviewerUserId: currentUser.id,
          rating: ratingForNotification.rating,
          ratingEventId: ratingForNotification.ratingEventId,
          commentContent: reviewNotificationExcerpt(content!),
          reviewId: review.id,
        });
        if (result !== "already_complete") return;
      }

      // A standalone feed comment is not a star-rating event. Keep the
      // established event contract for older clients while exposing the
      // content to current clients.
      await notify(world.creatorId, "new_comment", {
        worldId,
        worldName: world.name,
        thumbnailUrl: world.thumbnailUrl,
        commenterName: currentUser.name,
        commenterUserId: currentUser.id,
        commentContent: reviewNotificationExcerpt(content!),
        reviewId: review.id,
      }, { actorUserId: currentUser.id, dedupeKey: review.id });
    } else if (ratingResult?.isNew) {
      await notifyWorldReview(world.creatorId, {
        worldId,
        worldGroupId,
        worldName: world.name,
        thumbnailUrl: world.thumbnailUrl,
        reviewerName: currentUser.name,
        reviewerUserId: currentUser.id,
        ratingEventId: ratingResult.ratingEventId,
        rating,
      });
    }
  })().catch((error) => {
    console.error("[notifications] Failed to create world review notification:", error);
  });

  return c.json({ data: review ?? { rating } }, 201);
});

// DELETE /api/worlds/:id/reviews — remove the current user's star rating for
// this card (searches sibling variants; ratings are one-per-language-group).
// Comments are removed individually via DELETE /:id/reviews/:reviewId.
worldRoutes.delete("/:id/reviews", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  const removed = await db
    .delete(worldRatings)
    .where(
      and(
        eq(worldRatings.userId, currentUser.id),
        sql`${worldRatings.worldId} IN (
          SELECT w.id FROM worlds w
          WHERE w.id = ${worldId}
             OR (w.language_group_id IS NOT NULL
                 AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId}))
        )`
      )
    )
    .returning();

  flagWrite(currentUser.id);

  for (const r of removed) {
    recomputeReviewStats(r.worldId);
  }

  return c.json({ data: { deleted: true } });
});

// DELETE /api/worlds/:id/reviews/:reviewId — delete the current user's own
// comment. Replies cascade via FK; cached translations are cleaned up here.
worldRoutes.delete("/:id/reviews/:reviewId", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const reviewId = c.req.param("reviewId");

  const removed = await db
    .delete(reviews)
    .where(
      and(
        eq(reviews.id, reviewId),
        eq(reviews.userId, currentUser.id),
        sql`${reviews.worldId} IN (
          SELECT w.id FROM worlds w
          WHERE w.id = ${worldId}
             OR (w.language_group_id IS NOT NULL
                 AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId}))
        )`
      )
    )
    .returning();

  if (removed.length === 0) {
    return c.json({ error: "Comment not found" }, 404);
  }

  flagWrite(currentUser.id);

  await db
    .delete(contentTranslations)
    .where(
      and(
        inArray(contentTranslations.sourceId, removed.map((r) => r.id)),
        eq(contentTranslations.sourceType, "review"),
      ),
    );

  await removeWorldReviewCommentNotification(reviewId);

  return c.json({ data: { deleted: true } });
});

// DELETE /api/worlds/:id/reviews/:reviewId/by-creator
// The world's creator soft-hides a review on their world. Reviewer still sees
// the review (marked as hidden) and can dispute; stats exclude hidden rows.
worldRoutes.delete("/:id/reviews/:reviewId/by-creator", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const reviewId = c.req.param("reviewId");

  const [worldRow] = await db
    .select({ creatorId: worlds.creatorId, languageGroupId: worlds.languageGroupId })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);

  if (!worldRow) {
    return c.json({ error: "World not found" }, 404);
  }
  if (worldRow.creatorId !== currentUser.id) {
    return c.json({ error: "Only the world's creator can hide reviews" }, 403);
  }

  // The review row may live on this world OR a sibling language variant
  const [review] = await db
    .select({ id: reviews.id, worldId: reviews.worldId })
    .from(reviews)
    .where(
      and(
        eq(reviews.id, reviewId),
        sql`${reviews.worldId} IN (
          SELECT w.id FROM worlds w
          WHERE w.id = ${worldId}
             OR (w.language_group_id IS NOT NULL
                 AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId}))
        )`,
      )
    )
    .limit(1);

  if (!review) {
    return c.json({ error: "Review not found on this world" }, 404);
  }

  await db
    .update(reviews)
    .set({ hiddenByCreatorAt: new Date(), updatedAt: new Date() })
    .where(eq(reviews.id, reviewId));

  flagWrite(currentUser.id);
  // No stats recompute: hiding a comment affects feed visibility only —
  // star ratings live in world_ratings and are untouched by creator hides.

  return c.json({ data: { hidden: true } });
});

/**
 * Shared write-gate for rating/comment endpoints: world exists, reviews are
 * open, and neither side has blocked the other. Returns null when allowed.
 */
async function checkReviewGate(
  currentUser: { id: string },
  worldId: string,
  // Ratings feed the PUBLIC averageRating and the discovery quality term, so
  // a creator must not rate their own world (self-5★ gaming). Comments are
  // NOT blocked for the creator — replying to your own world's feed is
  // legitimate — so this flag is set only on the rating paths.
  opts?: { blockSelfRating?: boolean },
): Promise<{ response: Response } | null> {
  const [targetWorld] = await db
    .select({ creatorId: worlds.creatorId, allowReviews: worlds.allowReviews })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);

  if (!targetWorld) {
    return { response: Response.json({ error: "World not found" }, { status: 404 }) };
  }
  if (targetWorld.allowReviews === false) {
    return { response: Response.json({ error: "Reviews are closed for this world" }, { status: 403 }) };
  }
  if (opts?.blockSelfRating && targetWorld.creatorId === currentUser.id) {
    return { response: Response.json({ error: "You can't rate your own world" }, { status: 403 }) };
  }
  if (targetWorld.creatorId !== currentUser.id) {
    const blockStatus = await getBlockStatus(currentUser.id, targetWorld.creatorId);
    if (blockStatus.blocked) {
      if (blockStatus.direction === "blocked") {
        return { response: Response.json(blockedJson(), { status: 403 }) };
      }
      return { response: Response.json({ code: "you_blocked_target", error: "You have blocked this user" }, { status: 403 }) };
    }
  }
  return null;
}

/**
 * Upsert the user's one-per-language-group star rating. An existing row on
 * any sibling variant is updated in place (keeps its worldId); otherwise a
 * new row lands on the variant being viewed.
 */
async function upsertWorldRating(
  userId: string,
  worldId: string,
  rating: number,
): Promise<{ isNew: boolean; storedWorldId: string; ratingEventId: string }> {
  const existing = await db
    .select({ id: worldRatings.id, worldId: worldRatings.worldId })
    .from(worldRatings)
    .where(
      and(
        eq(worldRatings.userId, userId),
        sql`${worldRatings.worldId} IN (
          SELECT w.id FROM worlds w
          WHERE w.id = ${worldId}
             OR (w.language_group_id IS NOT NULL
                 AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId}))
        )`
      )
    )
    .limit(1);

  if (existing[0]) {
    const updatedAt = new Date();
    await db
      .update(worldRatings)
      .set({ rating, updatedAt })
      .where(eq(worldRatings.id, existing[0].id));
    return {
      isNew: false,
      storedWorldId: existing[0].worldId,
      ratingEventId: worldRatingNotificationEventId(existing[0].id, updatedAt),
    };
  }

  const id = crypto.randomUUID();
  const updatedAt = new Date();
  await db.insert(worldRatings).values({ id, userId, worldId, rating, createdAt: updatedAt, updatedAt });
  return {
    isNew: true,
    storedWorldId: worldId,
    ratingEventId: worldRatingNotificationEventId(id, updatedAt),
  };
}

/**
 * Recompute denormalized reviewCount + averageRating on the worlds table from
 * world_ratings (rater semantics: one user = one count, so comment volume
 * can't inflate a card's traction or 金牌工匠 progress).
 */
function recomputeReviewStats(worldId: string): void {
  db.execute(sql`
    UPDATE worlds SET
      review_count = (SELECT count(*)::int FROM world_ratings WHERE world_ratings.world_id = ${worldId}),
      average_rating = (SELECT COALESCE(AVG(world_ratings.rating), 0)::float FROM world_ratings WHERE world_ratings.world_id = ${worldId})
    WHERE id = ${worldId}
  `).catch(() => {});
}

/** Notify all followers of a creator that they published a new world (fire-and-forget). */
/**
 * Fire-and-forget fan-out: every follower of the creator gets a
 * "followed_user_published" notification when one of their followed creators
 * publishes a new world. Exported because admin approval (which is the only
 * remaining path that flips a world to status=published) lives in
 * admin-moderation.ts.
 */
export function notifyFollowersOfPublish(
  creatorId: string,
  creatorName: string,
  worldId: string,
  worldName: string,
  thumbnailUrl: string | null,
) {
  (async () => {
    const followerRows = await db
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(eq(follows.followingId, creatorId));
    if (followerRows.length > 0) {
      await notifyMany(
        followerRows.map((f) => f.followerId),
        "followed_user_published",
        { creatorUserId: creatorId, creatorName, worldId, worldName, thumbnailUrl },
      );
    }
  })().catch(() => {});
}

async function notifyAdminsOfNewReview(
  worldId: string,
  worldName: string,
  thumbnailUrl: string | null,
  authorUserId: string,
  authorName: string,
  groupKey: string,
): Promise<void> {
  const admins = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, "admin"));
  if (admins.length === 0) return;
  await notifyCoalescedByGroup(
    admins.map((a) => a.id),
    "new_review_pending",
    groupKey,
    { worldId, worldName, thumbnailUrl, authorUserId, authorName, groupKey },
    { actorUserId: authorUserId },
  );
}

export { worldRoutes };
