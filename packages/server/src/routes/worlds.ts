import { canReadFollowerWorld, canResolveWorldAddress, followerWorldAudienceSql } from "../lib/world-follower-access.js";
import { nextUntitledName } from "../lib/untitled-name.js";
import { variantLanguages } from "../lib/world-language.js";
import { createWorldFeedbackService, feedbackWorldIds, visibleFeedbackPost } from "../lib/world-feedback.js";
import { createWorldFeedbackRoutes } from "./world-feedback.js";
import { cleanWorldLoraBindings, worldLoraBindings } from "../lib/per-turn-image/loras.js";
import { snapshotForeignTriggers } from "../lib/generation/lora-square.js";
import { listDescription } from "../lib/list-description.js";
import { worldAudienceCondition } from "../lib/world-publication-access.js";
import { loadColdLaneSnapshot } from "../lib/cold-lanes.js";
import { discoverAccess } from "../lib/discover-access.js";
import { libraryWorldScope } from "../lib/library-world-scope.js";
import { loadFeaturedSlots } from "../lib/editorial.js";
import { discoverPreviewMiddleware } from "../middleware/discover-preview.js";
import { checkpointWorld } from "../lib/world-version-store.js";
import { VERSION_METADATA_FIELDS, versionMetadata } from "../lib/world-version-content.js";
import { worldVersionRoutes } from "./world-versions.js";
import { lockWorldForSave } from "../lib/world-save-transaction.js";
import { captureAutomaticVersion, captureEditCheckpoint, capturePublishVersion, latestLiveVersionId, lockVersionDraft } from "../lib/world-version-history.js";
import { communityMuteMiddleware } from "../middleware/community-mute.js";
import { requireUnmuted } from "../middleware/user-mute.js";
import { Hono, type Context } from "hono";
import { averageWorldPlayerPlaytime } from "../lib/world-player-playtime.js";
import { withWorldPlaytime } from "../lib/world-playtime.js";
import { reviewPlaytimeQuery } from "../lib/review-playtime.js";
import { shareArtworkWithLanguageSiblings } from "../lib/language-group-artwork.js";
import { checkLowRating, hasPlayedWorld } from "../lib/world-rating-rules.js";
import { getTableColumns, eq, ne, or, and, asc, desc, ilike, sql, inArray, notInArray, isNotNull } from "drizzle-orm";
import { db, readDb, readForEdit, readOwn, readPublic, flagWrite, type DrizzleDB } from "../db/index.js";
import { canonicalWorldPath, findWorldById } from "../lib/world-address.js";
import { worlds, user, assetReferences, userLibrary, worldPendingEdits, worldUpdates, follows, reviews, worldRatings, contentTranslations, worldReviewSubmissions,
  worldCollaborators,
} from "../db/schema.js";
import { estimateTokens, isWorldChangeList } from "@yumina/engine";
import { applyChangeSetSave, foldSaveIntoLiveText } from "../lib/collab-save.js";
import { MAX_EVENT_CHANGES_BYTES, WORLD_SAVED_META_KEYS, publishWorldEvent } from "../lib/world-events.js";
import {
  announceAccessChange, canEditWorldSql, getWorldAccess, grantWorldIds, mayWithdrawSubmission, notifySubmissionWithdrawn,
  OWNER_ONLY_WORLD_FIELDS, updateInReviewBody,
} from "../lib/world-collaborators.js";
import { generateUploadUrl } from "../lib/s3.js";
import { discardDirectImageUpload, publishStoredImage } from "../lib/image-resize.js";
import { validateImageUploadSize } from "../lib/image-upload-policy.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { clampWorldTags, OFFICIAL_WORLD_TAGS, PLAYED_TAG_FILTER_THRESHOLD, MAX_DYNAMIC_FILTER_TAGS } from "@yumina/shared";
import { canonicalizeTag, LOW_RATING_MAX, isLowRatingReason } from "@yumina/shared";
import { buildHubTagQuery, parseContentLevelParam } from "../lib/hub-tags.js";
import { resolveWorldAudience, resolveWorldAudienceEdit } from "../lib/world-audience.js";
import {
  buildHubBaseFilters,
  buildHubSearchOrder,
  createEmptyRecommendationProfile,
  completeRecommendedCatalogPage,
  generateRecommendationCandidates,
  invalidateRecommendationProfile,
  invalidateRecommendationFeed,
  loadRecommendationProfile,
  normalizeEditorialLanguage,
  normalizeWorldLanguage,
  resolveHubLanguageScope,
  rankRecommendedWorlds,
  resolveRecommendedFeedCacheKey,
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
import { hasPublishableCover, getDiscoverCoverArtIssues, isDefaultWorldName, foreignGamePath } from "@yumina/shared";
import { scanWorldSchemaForInlineAssets } from "../lib/asset-validation.js";
import {
  notify,
  notifyMany,
  notifyCoalescedByGroup,
} from "../lib/notify.js";
import { onReview } from "../lib/achievements/engine.js";
import { detectLang } from "../lib/detect-lang.js";
import { translateContent } from "../lib/translate.js";
import { aggregatedCounters } from "../lib/world-aggregates.js";
import { syncSearchDocNormalized } from "../lib/normalize-search.js";
import { captureHubEvent, newFeedRequestId } from "../lib/analytics.js";
import { coldModelArm, feedVariantFor, loadEngagementContext, modelArmEligible, variantUsesEngagement } from "../lib/engagement.js";
import { loadPublishedRankerModel } from "../lib/ranker-model.js";
import { logFeedServe } from "../lib/feed-log.js";
import { loadFeaturedHeroSlots } from "../lib/editorial.js";
import { activeFeaturedSlots, readFeaturedCollection } from "../lib/featured-collection-store.js";
import { featuredScopeSchema, getAgeFromBirthYear, normalizeProfileWorldOrder, normaliseMultiplayer } from "@yumina/shared";
import { DEFAULT_EDITORIAL_CATEGORIES, resolveEditorialCollection, resolveActiveEditorialHero, editorialHeroCopy, type EditorialSlot } from "@yumina/shared";
import { publishedEditorial, activeEditorialSlots } from "../lib/discover-editorial.js";
import { resolveProfileContentLevel } from "../lib/profile-content-level.js";
import { resolveHeroWorlds, type HeroSlot } from "../lib/hero-worlds.js";
import type { AppEnv, SessionUser } from "../lib/types.js";
import { getBlockStatus, listBlockedUsersForHiding } from "../lib/blocks.js";
import { approveGroup } from "../lib/approve-review.js";
import { holdsSealedFrom, parseRetained, redactSchemaFor, redactWorldFor, restoreSealed, sealCopy } from "../lib/sealed-entries.js";
import { queueWorldAiReview } from "../lib/world-ai-review-run.js";
import {
  getPendingEdit,
  getPendingEditSummaries,
  planMaterialHold,
  applyHoldPlan,
  summarizePendingEdit,
  resolveWorldCopyMaterial,
  submitPendingEdit,
  withdrawPendingEdit,
  applyWorldGallery,
  setPendingEditUpdateNote,
} from "../lib/pending-edit.js";
import { isStaleDraftSave, nextWorldSaveTime } from "../lib/world-save-guard.js";
import { computeWorldContextRequirement } from "../lib/context-requirement.js";
import { hasWorldDmShareGrant } from "../lib/dm-world-grant.js";
import { isActiveWorldTester } from "../lib/world-testers.js";
import { WORLD_STATUS_TAKEN_DOWN } from "../lib/fork-orphan.js";
import { estimateWorldCopyTokens } from "../lib/world-copy-material.js";
import { getTranslateJob, quoteTranslation, startTranslateJob, TranslateJobError } from "../lib/card-translate-job.js";
import { parseWorldUpdateNoteBody } from "../lib/world-update-note.js";
import { createWorldUnpublishRoutes } from "./world-unpublish.js";
import { stampCompiledLater } from "../lib/card-code/stamp.js";
import { CARD_CODE_HEADER, playerSchema } from "../lib/card-code/source.js";
import { REMIX_PUBLISH_MESSAGES, remixPublishBlock } from "../lib/remix-publish.js";
import { createWorldUpdateEditRoutes } from "./world-update-edits.js";
import {
  canReadWorldUpdateHistory,
  hasMoreWorldUpdates,
  normalizeWorldUpdateOffset,
  WORLD_UPDATE_PAGE_SIZE,
} from "../lib/world-update-history.js";

const VALID_LANGUAGE_CODES = new Set(["en", "zh", "ja", "ko", "id", "es", "fr", "de", "pt", "ru", "ar"]);


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
worldRoutes.use("/*", optionalAuthMiddleware, discoverPreviewMiddleware);
worldRoutes.route("/", createWorldUnpublishRoutes(db, authMiddleware, rateLimitMiddleware("publishing"), {
  flagWrite,
  notify: (userIds, payload, actorUserId) => notifyMany(userIds, "world_unpublished", payload, { actorUserId }),
}));

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
function sourceWorldCols(viewerId?: string) {
  const ownsForkOrSource = viewerId
    ? sql`(sw.creator_id = ${viewerId} OR ${worlds.creatorId} = ${viewerId})`
    : sql`FALSE`;
  const visible = sql`(sw.visibility <> 'unlisted' OR ${ownsForkOrSource}) AND ${followerWorldAudienceSql(viewerId, "sw")}`;
  return {
    sourceWorldId: sql<string | null>`(
      SELECT sw.id FROM worlds sw WHERE sw.id = ${worlds.sourceWorldId} AND ${visible}
    )`.as("source_world_id"),
    sourceWorldName: sql<string | null>`(
      SELECT sw.name FROM worlds sw WHERE ${forkSourceMatch} AND ${visible}
    )`.as("source_world_name"),
    sourceCreatorId: sql<string | null>`(
      SELECT sw.creator_id FROM worlds sw WHERE ${forkSourceMatch}
    )`.as("source_creator_id"),
    sourceCreatorName: sql<string | null>`(
      SELECT u.name FROM worlds sw JOIN "user" u ON u.id = sw.creator_id WHERE ${forkSourceMatch}
    )`.as("source_creator_name"),
  };
}

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
  landscapeCoverUrl: worlds.landscapeCoverUrl,
  landscapeCoverCrop: worlds.landscapeCoverCrop,
  isPublished: worlds.isPublished,
  isNsfw: worlds.isNsfw,
  allowEdit: worlds.allowEdit,
  allowCustomApi: worlds.allowCustomApi,
  retained: worlds.retained,
  sealedContent: worlds.sealedContent,
  allowReviews: worlds.allowReviews,
  allowSessionSharing: worlds.allowSessionSharing,
  allowCommunityCitations: worlds.allowCommunityCitations,
  allowLiveCanon: worlds.allowLiveCanon,
  allowLiveCanonAdditions: worlds.allowLiveCanonAdditions,
  blurCover: worlds.blurCover,
  ageRating: worlds.ageRating,
  targetAudience: worlds.targetAudience,
  visibility: worlds.visibility,
  downloadCount: aggregatedCounters.displayDownloadCount,
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
  creatorUsername: user.username,
  publicId: worlds.publicId,
  creatorImage: user.image,
  messageCount: aggregatedCounters.messageCount,
  favoriteCount: aggregatedCounters.favoriteCount,
  ...sourceWorldCols(),
};

const hubNewestSortExpr = sql<Date>`COALESCE(${worlds.publishedAt}, ${worlds.reviewedAt}, ${worlds.createdAt})`;

function getOptionalUser(c: { get: (key: "user") => SessionUser }) {
  try {
    return c.get("user");
  } catch {
    return null;
  }
}

async function resolveHubMedia<T extends { id: string; gamePath?: string | null; description?: string | null; thumbnailUrl: string | null; landscapeCoverUrl?: string | null; creatorImage: string | null }>(rows: T[], preview = false) {
  const resolved = rows.map((row) => ({
    ...row,
    // Every browse list (and the feed cache) passes through here.
    ...(row.description !== undefined ? { description: listDescription(row.description) } : {}),
    thumbnailUrl: resolveImageCdn(row.thumbnailUrl),
    landscapeCoverUrl: resolveImageCdn(row.landscapeCoverUrl ?? null),
    creatorImage: resolveImageCdn(row.creatorImage),
  }));
  return preview ? withWorldPlaytime(resolved) : resolved;
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
  // Opt-in: existing pickers keep their catalogue contract. Library only needs
  // owned/saved/favorited metadata plus a directly linked world. Auth and the
  // existing representative selection below still apply to every returned row.
  const requestedLibraryWorld = c.req.query("scope") === "library" ? c.req.query("worldId") : undefined;
  const libraryScope = c.req.query("scope") === "library"
    ? libraryWorldScope(currentUser.id, requestedLibraryWorld)
    : undefined;
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
      landscapeCoverUrl: worlds.landscapeCoverUrl,
      landscapeCoverCrop: worlds.landscapeCoverCrop,
      isPublished: worlds.isPublished,
      status: worlds.status,
      isNsfw: worlds.isNsfw,
      allowEdit: worlds.allowEdit,
      allowCustomApi: worlds.allowCustomApi,
      allowReviews: worlds.allowReviews,
      allowSessionSharing: worlds.allowSessionSharing,
      allowCommunityCitations: worlds.allowCommunityCitations,
      allowLiveCanon: worlds.allowLiveCanon,
      allowLiveCanonAdditions: worlds.allowLiveCanonAdditions,
      blurCover: worlds.blurCover,
      ageRating: worlds.ageRating,
      targetAudience: worlds.targetAudience,
      visibility: worlds.visibility,
      downloadCount: aggregatedCounters.displayDownloadCount,
      tags: worlds.tags,
      announcement: worlds.announcement,
      totalTokens: worlds.totalTokens,
      approxTime: worlds.approxTime,
      language: worlds.language,
      languageGroupId: worlds.languageGroupId,
      ...sourceWorldCols(currentUser.id),
      sourceWorldTakenDown: sourceTakenDownSq,
      moderationNote: worlds.moderationNote,
      moderationAction: worlds.moderationAction,
      reviewStatus: worlds.reviewStatus,
      submittedForReviewAt: worlds.submittedForReviewAt,
      rejectionReason: worlds.rejectionReason,
      rejectionDetail: worlds.rejectionDetail,
      createdAt: worlds.createdAt,
      updatedAt: worlds.updatedAt,
      creatorName: user.name,
      creatorUsername: user.username,
      publicId: worlds.publicId,
    })
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(
      and(
        worldAudienceCondition(worlds.creatorId),
        or(eq(worlds.creatorId, currentUser.id), eq(worlds.isPublished, true)),
        worldAudienceCondition(worlds.creatorId),
        libraryScope,
        c.req.query("scope") === "library" ? undefined : or(eq(worlds.creatorId, currentUser.id), ne(worlds.visibility, "unlisted")),
        followerWorldAudienceSql(currentUser.id),
        ...(currentUser.limitedContentOnly ? [eq(worlds.ageRating, "all"), eq(worlds.isNsfw, false)] : []),
        // Collapse each language group to ONE representative: the 主 of the
        // viewer's language (then oldest), chosen among own-or-published rows so
        // the creator's own drafts still surface. This keeps multi-language groups
        // from showing one card per language. Other variants stay reachable via
        // the variant tab bar / version picker.
        or(
          requestedLibraryWorld ? eq(worlds.id, requestedLibraryWorld) : undefined,
          sql`${worlds.languageGroupId} IS NULL`,
          sql`${worlds.id} = (
            SELECT w2.id FROM worlds w2
            WHERE w2.language_group_id = ${worlds.languageGroupId}
              AND (w2.creator_id = ${currentUser.id} OR w2.is_published = true)
              AND ${followerWorldAudienceSql(currentUser.id, "w2")}
              ${libraryScope ? sql`AND w2.id IN (SELECT ${worlds.id} FROM ${worlds} WHERE ${libraryScope})` : sql``}
              ${c.req.query("scope") === "library" ? sql`` : sql`AND (w2.creator_id = ${currentUser.id} OR w2.visibility <> 'unlisted')`}
              ${currentUser.limitedContentOnly ? sql`AND w2.age_rating = 'all' AND w2.is_nsfw = false` : sql``}
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
    landscapeCoverUrl: resolveImageCdn(w.landscapeCoverUrl ?? null),
    pendingEdit: w.creatorId === currentUser.id ? pendingEditMap.get(w.id) ?? null : null,
  }));

  // A direct link may name a different translation than the shelf representative.
  // Return it for the detail page without introducing a duplicate on the shelf.
  const linked = requestedLibraryWorld && resolved.find(world => world.id === requestedLibraryWorld);
  if (linked && linked.languageGroupId && resolved.some(world => world.id !== linked.id && world.languageGroupId === linked.languageGroupId)) {
    return c.json({ data: resolved.filter(world => world.id !== linked.id), linkedWorld: linked });
  }
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
    .where(and(
      eq(worlds.creatorId, currentUser.id),
      eq(worlds.isPublished, true),
      // ?public=1 — only cards anyone can open (the bundle 示范卡 picker; the
      // bundle PATCH applies the same rule).
      ...(c.req.query("public") === "1"
        ? [eq(worlds.status, "published"), eq(worlds.visibility, "public")]
        : []),
    ))
    .orderBy(desc(worlds.createdAt));
  return c.json({
    data: rows.map((w) => ({ ...w, thumbnailUrl: resolveImageCdn(w.thumbnailUrl) })),
  });
});

// GET /api/worlds/mine/shareable — the caller's own cards that are eligible to be
// shared into a DM: published (normal audience checks still apply) plus drafts (the
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
      visibility: worlds.visibility,
      variantLabel: worlds.variantLabel,
      isPublished: worlds.isPublished,
      allowEdit: worlds.allowEdit,
      tags: worlds.tags,
      language: worlds.language,
      updatedAt: worlds.updatedAt,
      downloadCount: aggregatedCounters.displayDownloadCount,
    })
    .from(worlds)
    .where(and(...conditions))
    .orderBy(desc(worlds.updatedAt), asc(worlds.id))
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
      const filters = await buildHubBaseFilters(currentUser ? db : rd, {
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
  const rd = db;
  const preferredLang = normalizeEditorialLanguage(c.req.query("lang")) ?? "en";
  const contentLevelParam = parseContentLevelParam(c.req.query("contentLevel"));

  let slots: HeroSlot[];
  let configuredSlots: EditorialSlot[] | undefined;
  let configuredContentLevel: "safe" | "r18" | undefined;
  try {
    const published = c.get("discoverPreviewEnabled") ? await publishedEditorial(db) : undefined;
    if (published) {
      const [profile] = currentUser ? await db.select({ preferences: user.preferences, birthYear: user.birthYear }).from(user).where(eq(user.id, currentUser.id)).limit(1) : [];
      const minor = profile?.birthYear != null && getAgeFromBirthYear(profile.birthYear) < 18;
      const mode = minor || currentUser?.limitedContentOnly ? "safe" : resolveProfileContentLevel(!!currentUser, contentLevelParam === "safe" ? "safe" : undefined, profile?.preferences);
      configuredContentLevel = mode;
      configuredSlots = activeEditorialSlots(resolveActiveEditorialHero(published.config, preferredLang, mode === "safe" ? "safe" : "sensitive")?.slots ?? []);
      const pins = configuredSlots.length ? await db.select({ id: worlds.id, languageGroupId: worlds.languageGroupId }).from(worlds).where(inArray(worlds.id, configuredSlots.map(s => s.worldId))) : [];
      slots = pins.map((w, slot) => ({ slot, kind: "world", id: w.id }));
      slots.push(...pins.flatMap((w, slot) => w.languageGroupId ? [{ slot, kind: "group" as const, id: w.languageGroupId }] : []));
    } else {
      slots = await loadFeaturedHeroSlots(rd, preferredLang);
    }
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

  const baseFilters = await buildHubBaseFilters(currentUser ? db : rd, {
    currentUserId: currentUser?.id,
    contentLevelParam: configuredContentLevel ?? contentLevelParam,
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
    .where(and(...baseFilters.conditions, slotCondition, ...(configuredSlots ? [eq(worlds.visibility, "public")] : [])))
    .orderBy(desc(worlds.updatedAt), desc(worlds.createdAt));

  const mediaResolved = await resolveHubMedia(result, c.get("discoverPreviewEnabled"));
  const configuredWorlds = configuredSlots?.flatMap(slot => {
    const pinned = mediaResolved.find(w => w.id === slot.worldId);
    if (!pinned) return [];
    const chain = variantLanguages(c.req.query("lang"), preferredLang);
    const rankOf = (w: { language: string | null }) => { const i = chain.indexOf(normalizeWorldLanguage(w.language) ?? ""); return i < 0 ? chain.length : i; };
    const matching = pinned.languageGroupId ? mediaResolved.filter(w => w.languageGroupId === pinned.languageGroupId && rankOf(w) < chain.length)
      .sort((a, b) => rankOf(a) - rankOf(b) || Number(b.isPrimaryVariant) - Number(a.isPrimaryVariant) || Number(a.language !== preferredLang) - Number(b.language !== preferredLang) || a.id.localeCompare(b.id))[0] : undefined;
    return [{ ...(matching ?? pinned), ...editorialHeroCopy(slot, c.req.query("lang") ?? "en") }];
  });
  const ordered = configuredWorlds ? configuredWorlds.filter((w, i, all) => all.findIndex(other => (other.languageGroupId ?? other.id) === (w.languageGroupId ?? w.id)) === i) : resolveHeroWorlds(slots, mediaResolved, c.req.query("lang") ?? preferredLang);

  c.header("Cache-Control", currentUser ? "private, no-store" : "public, max-age=0, s-maxage=120, stale-while-revalidate=300");
  c.header("Vary", "Cookie");
  return c.json({ data: ordered });
});

// GET /api/worlds/batch - fetch multiple worlds by ID (for featured section, etc.)
worldRoutes.get("/batch", optionalAuthMiddleware, async (c) => {
  const currentUser = getOptionalUser(c);
  const blocks = currentUser ? await listBlockedUsersForHiding(currentUser.id) : null;
  const hiddenCreatorIds = blocks ? [...new Set([...blocks.hideWorldCreatorIds, ...blocks.hiddenByCreatorIds])] : [];
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
      followerWorldAudienceSql(currentUser?.id),
      ne(worlds.visibility, "unlisted"),
      worldAudienceCondition(worlds.creatorId),
      eq(worlds.isPublished, true),
      ...(hiddenCreatorIds.length > 0 ? [notInArray(worlds.creatorId, hiddenCreatorIds)] : []),
      // Guests never receive Limitless rows, even by direct ID.
      ...(currentUser && !currentUser.limitedContentOnly ? [] : [eq(worlds.ageRating, "all")]),
    ));

  const mediaResolved = await resolveHubMedia(result, c.get("discoverPreviewEnabled"));

  // Preserve requested order
  const byId = new Map(mediaResolved.map((w) => [w.id, w]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  c.header("Cache-Control", currentUser ? "private, no-store" : "public, max-age=0, s-maxage=120, stale-while-revalidate=300");
  c.header("Vary", "Cookie");
  return c.json({ data: ordered });
});

// GET /api/worlds/hub — public browse
const discoveryRateLimit = ipRateLimitMiddleware(180, 60, "discovery");
worldRoutes.get("/hub", async (c, next) => {
  if (!edition.info().features.hub) return c.notFound();
  const startedAt = performance.now();
  await next();
  if (c.req.query("feed") === "recommended") {
    c.header("Server-Timing", `discover;dur=${(performance.now() - startedAt).toFixed(1)}`, { append: true });
  }
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
  // Every Recommended response must reach authoritative delivery validation;
  // browser/CDN stale copies would bypass both it and generation invalidation.
  if (c.req.query("feed") === "recommended") {
    c.header("Cache-Control", "private, no-store");
    c.header("CDN-Cache-Control", "no-store");
    c.header("Vary", "Cookie");
  }
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
  const feed = !q && c.req.query("feed") === "recommended" ? "recommended" : "default";
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
  // Ranking arms (2026-09-24): everyone rides engage_v1; a published
  // time-spent model opens engage_v2 for half of the accounts. The model
  // handle is process-cached (5-min DB head poll) so this await is ~free.
  const rankerModel = await loadPublishedRankerModel(rd);
  const rankingVariant = feedVariantFor(currentUser?.id, modelArmEligible(rankerModel));
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

  const filtersStartedAt = performance.now();
  const baseFilters = await buildHubBaseFilters(currentUser ? db : rd, {
    currentUserId: currentUser?.id,
    accountPreferences,
    limitedContentOnly: currentUser?.limitedContentOnly,
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
  const filtersMs = performance.now() - filtersStartedAt;

  if (baseFilters.noResults) {
    return c.json({ data: [], total: 0 });
  }

  const whereClause = and(...baseFilters.conditions);

  if (cursorActor) {
    try {
      const startedAt = performance.now();
      // A client scroll id is a random UUID; anything else is ignored.
      const scrollParam = c.req.query("scroll");
      const scrollId = scrollParam && /^[0-9a-f-]{36}$/i.test(scrollParam) ? scrollParam.toLowerCase() : undefined;
      const page = await serveDiscoveryFeed(rd, {
        actor: cursorActor,
        userId: currentUser?.id, filters: baseFilters, limit, nsfwOnly, cursor: c.req.query("cursor"), starter, scrollId,
        // The reader's 90-day history scan (453 ms a call, the primary's top disk
        // reader) runs on the replica even when a fresh write pins rd to the primary:
        // a click from seconds ago missing from taste signals changes nothing.
        signalDatabase: readPublic(),
      });
      const rankingMs = performance.now() - startedAt;
      const data = await resolveHubMedia(page.data.map(stripRecommendationInternals) as any[], c.get("discoverPreviewEnabled"));
      let attributionToken: string | undefined;
      const measurementStartedAt = performance.now();
      if (discoveryMeasurementEnabled()) {
        try {
          attributionToken = await recordDiscoveryServe(db, page, cursorActor, env.BETTER_AUTH_SECRET);
        } catch {
          // Missing telemetry must never invent an attributable opportunity or
          // make a healthy feed unavailable. Coverage monitors count this gap.
          console.warn("[discovery-measurement] serving snapshot unavailable");
        }
      }
      const measurementMs = performance.now() - measurementStartedAt;
      const marks = Object.entries(page.timings ?? {}).map(([name, ms]) => `${name.replace(/_ms$/, "")};dur=${ms.toFixed(1)}`).join(", ");
      c.header("Server-Timing", `filters;dur=${filtersMs.toFixed(1)}, rank;dur=${rankingMs.toFixed(1)}, measure;dur=${measurementMs.toFixed(1)}${marks ? ", " + marks : ""}`);
      if (!c.req.raw.signal?.aborted) {
        logFeedServe({ id: page.feedRequestId, userId: currentUser?.id ?? null, surface: "recommended", feed,
          tier: page.tier, variant: page.variant, lang: baseFilters.preferredLang, offset: page.offset, worldIds: page.servedIds });
        captureHubEvent(currentUser?.id, "hub_serve", {
          feed_request_id: page.feedRequestId, feed, surface: "recommended", sort, has_query: false, tag_count: 0,
          offset: page.offset, limit, returned_count: data.length, total_count: null,
          world_ids: page.ids, tier: page.tier, variant: page.variant, cache: "cursor",
          policy_version: DISCOVERY_POLICY_VERSION, catalog_scans: page.scans,
          duration_ms: Math.round(performance.now() - startedAt), has_more: page.hasMore,
          caught_up_index: page.caughtUpIndex ?? null, scroll_continuity: Boolean(scrollId),
          ranking_ms: Math.round(rankingMs), measurement_ms: Math.round(measurementMs), filters_ms: Math.round(filtersMs),
          // Where a fresh visit spent its ranking time (see serveDiscoveryFeed).
          ...Object.fromEntries(Object.entries(page.timings ?? {}).map(([name, ms]) => ["t_" + name, Math.round(ms)])),
          authenticated: Boolean(currentUser),
          measurement_status: discoveryMeasurementEnabled() ? (attributionToken ? "recorded" : "unavailable") : "off",
          snapshot_bytes: attributionToken ? Buffer.byteLength(JSON.stringify(page.snapshots), "utf8") : 0,
        });
      }
      return c.json({ data, feedRequestId: page.feedRequestId, offset: page.offset,
        positions: page.positions, nextCursor: page.nextCursor, hasMore: page.hasMore, ...(attributionToken ? { attributionToken } : {}),
        ...(page.caughtUpIndex !== undefined ? { caughtUpIndex: page.caughtUpIndex } : {}) });
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
        ? await resolveRecommendedFeedCacheKey({
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
      const cached = await readCachedFeedPage(feedCacheKey, baseFilters, { userId: currentUser?.id, offset, limit });
      if (cached) {
        // Current eligibility passed on primary. Retain the cached rank order
        // without repeating profile loading, candidate generation and reranking.
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
        c.header("Vary", "Cookie");
        return c.json({ data: c.get("discoverPreviewEnabled") ? await withWorldPlaytime(cached.data as Array<{ id: string; gamePath?: string | null }>) : cached.data, total: cached.total, feedRequestId });
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
      engagement.tasteCentroid = profile.userEmbeddingCentroid;
      engagement.profileSignalCount = profile.effectiveSignalCount;
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
        coldLanes: profile.tier === "cold" ? await loadColdLaneSnapshot(rd) : null,
        coldLaneLanguage: baseFilters.preferredLang ?? null,
        coldModel: coldModelArm(currentUser?.id),
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
        ? await completeRecommendedCatalogPage(db, ranking.data, baseFilters, { userId: currentUser?.id, offset, limit })
        : ranking;

      const stripped = ranked.data.map((candidate) => stripRecommendationInternals(candidate));
      const mediaResolved = await resolveHubMedia(stripped as any[], c.get("discoverPreviewEnabled"));

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

  // Search puts the visitor's language first, then relevance and feed sort.
  // Apply priority in SQL so it holds across every page of opt-in results.
  // Phase 2.5: only the Latin-friendly search_doc has tsvector ranking;
  // trad↔simp matches on the normalized text column don't contribute
  // to the rank but still appear in results via the WHERE clause OR.
  const trimmedQuery = q?.trim();
  const newestOrder = desc(hubNewestSortExpr);
  const popularOrder = desc(aggregatedCounters.downloadCount);
  // One creator's works (their profile) can also be listed by name, or in the
  // order the creator set themselves; works they have not placed follow, newest
  // first. Read from the primary: the owner sees the order they just saved.
  const profileSort = creatorId ? c.req.query("sort") : undefined;
  let sortOrder = sort === "popular" ? [popularOrder, newestOrder] : [newestOrder, popularOrder];
  if (profileSort === "alphabetical") {
    sortOrder = [asc(sql`lower(${worlds.name})`), newestOrder];
  } else if (profileSort === "custom") {
    const [creatorRow] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, creatorId!)).limit(1);
    const placed = normalizeProfileWorldOrder((creatorRow?.preferences as Record<string, unknown> | null)?.profileWorldOrder);
    if (placed.length > 0) {
      const position = sql`array_position(ARRAY[${sql.join(placed.map((id) => sql`${id}`), sql`, `)}]::text[], ${worlds.id})`;
      sortOrder = [sql`${position} asc nulls last`, newestOrder];
    }
  }
  const orderBy = trimmedQuery
    ? buildHubSearchOrder(trimmedQuery, lang, sortOrder)
    : sortOrder;

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

  const mediaResolved = await resolveHubMedia(result, c.get("discoverPreviewEnabled"));

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
  // Block changes must take effect on the next authenticated request.
  if (feed !== "recommended") c.header("Cache-Control", currentUser ? "private, no-store" : "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  c.header("Vary", "Cookie");
  return c.json({ data: mediaResolved, total: countResult[0]?.count ?? 0, feedRequestId });
  } catch (err) {
    console.error("[HUB] Error fetching hub data:", err);
    return c.json({ error: "Failed to load discover feed" }, 500);
  }
});

worldRoutes.get("/featured-categories", async c => {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  if (!c.get("discoverPreviewEnabled")) return c.json({ error: "Not found" }, 404);
  const published = c.get("discoverPreviewEnabled") ? await publishedEditorial(db) : undefined;
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: (published?.config.categories ?? DEFAULT_EDITORIAL_CATEGORIES).filter(category => !category.hidden) });
});

// GET /api/worlds/featured — public, returns editorial featured worlds in slot order
worldRoutes.get("/featured", optionalAuthMiddleware, async (c, next) => {
  if (c.get("discoverPreviewEnabled")) return next();
  const preferredLang = normalizeEditorialLanguage(c.req.query("lang"));
  let currentUser: SessionUser | null = null;
  try { currentUser = c.get("user"); } catch { /* anonymous */ }
  const blocks = currentUser ? await listBlockedUsersForHiding(currentUser.id) : null;
  const hiddenCreatorIds = blocks ? [...new Set([...blocks.hideWorldCreatorIds, ...blocks.hiddenByCreatorIds])] : [];
  const rd = await readDb(currentUser?.id);
  const [profile] = currentUser ? await rd.select({ preferences: user.preferences, birthYear: user.birthYear })
    .from(user).where(eq(user.id, currentUser.id)).limit(1) : [];
  const minor = profile?.birthYear != null && getAgeFromBirthYear(profile.birthYear) < 18;
  const effectiveMode = minor || currentUser?.limitedContentOnly ? "safe" : resolveProfileContentLevel(!!currentUser,
    c.req.query("contentLevel") === "safe" ? "safe" : undefined, profile?.preferences);
  const safe = effectiveMode === "safe";

  const slots = await loadFeaturedSlots(rd);
  if (slots.length === 0) return c.json({ data: [] });
  const ids = slots.map((s) => s.worldId);

  const rows = await rd
    .select(hubWorldListSelect)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(
      worldAudienceCondition(worlds.creatorId),
      eq(worlds.isPublished, true),
      eq(worlds.status, "published"),
      inArray(worlds.id, ids),
      ...(hiddenCreatorIds.length > 0 ? [notInArray(worlds.creatorId, hiddenCreatorIds)] : []),
      // Guests never receive Limitless rows in the featured rail.
      ...(safe ? [eq(worlds.ageRating, "all"), eq(worlds.isNsfw, false)] : []),
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
    const variantLangs = variantLanguages(c.req.query("lang"), preferredLang);
    const preferredRows = await rd
      .select(hubWorldListSelect)
      .from(worlds)
      .leftJoin(user, eq(worlds.creatorId, user.id))
      .where(and(
        inArray(worlds.languageGroupId, groupIds),
        ...(hiddenCreatorIds.length > 0 ? [notInArray(worlds.creatorId, hiddenCreatorIds)] : []),
        worldAudienceCondition(worlds.creatorId),
      eq(worlds.isPublished, true),
        eq(worlds.status, "published"),
        // Featured slots are public surface — never swap in a followers-only
        // sibling a non-follower can't open.
        eq(worlds.visibility, "public"),
        ...(safe ? [eq(worlds.ageRating, "all"), eq(worlds.isNsfw, false)] : []),
        or(...variantLangs.flatMap((l) => [eq(worlds.language, l), sql`${worlds.language} LIKE ${`${l}-%`}`])),
      ))
      .orderBy(
        sql`CASE ${sql.join(variantLangs.map((l, i) => sql`WHEN ${worlds.language} = ${l} OR ${worlds.language} LIKE ${`${l}-%`} THEN ${sql.raw(String(i))}`), sql` `)} ELSE ${sql.raw(String(variantLangs.length))} END`,
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

  const mediaResolved = await resolveHubMedia(ordered);

  c.header("Cache-Control", currentUser ? "private, no-store" : "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
  c.header("Vary", "Cookie");
  return c.json({ data: mediaResolved });
});

worldRoutes.get("/featured", optionalAuthMiddleware, async (c) => {
  const preferredLang = normalizeEditorialLanguage(c.req.query("lang"));
  let currentUser: SessionUser | null = null;
  try { currentUser = c.get("user"); } catch { /* anonymous */ }
  const blocks = currentUser ? await listBlockedUsersForHiding(currentUser.id) : null;
  const hiddenCreatorIds = blocks ? [...new Set([...blocks.hideWorldCreatorIds, ...blocks.hiddenByCreatorIds])] : [];
  // Resolve audience and collection on primary so an admin save or mode change
  // cannot be served from a stale replica. This is a small editorial surface.
  const rd = db;
  const [profile] = currentUser ? await db.select({ preferences: user.preferences, birthYear: user.birthYear })
    .from(user).where(eq(user.id, currentUser.id)).limit(1) : [];
  const minor = profile?.birthYear != null && getAgeFromBirthYear(profile.birthYear) < 18;
  const effectiveMode = minor || currentUser?.limitedContentOnly ? "safe" : resolveProfileContentLevel(!!currentUser,
    c.req.query("contentLevel") === "safe" ? "safe" : undefined, profile?.preferences);
  const safe = effectiveMode === "safe";
  const published = c.get("discoverPreviewEnabled") ? await publishedEditorial(db) : undefined;
  const channel = c.req.query("channel") ?? "all";
  const scope = featuredScopeSchema.safeParse({ channel,
    language: preferredLang ?? "default", contentMode: safe ? "safe" : "sensitive" });
  const category = published?.config.categories.find(c => c.id === channel);
  if (published ? !category : !scope.success) return c.json({ error: "Invalid Featured category" }, 400);
  const collection = published ? resolveEditorialCollection(published.config, channel, preferredLang ?? "default", safe ? "safe" : "sensitive") : undefined;
  const layout = collection?.layout ?? "mosaic";
  const slots = published ? (category?.hidden ? [] : activeEditorialSlots(collection?.slots ?? [])) : activeFeaturedSlots((await readFeaturedCollection(db, scope.success ? scope.data : { channel: "all", language: "default", contentMode: "default" })).slots);
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  if (slots.length === 0) return c.json({ data: [], layout });
  const ids = slots.map((s) => s.worldId);

  const rows = await rd
    .select(hubWorldListSelect)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(
      eq(worlds.isPublished, true),
      eq(worlds.status, "published"),
      inArray(worlds.id, ids),
      eq(worlds.visibility, "public"),
      ...(hiddenCreatorIds.length > 0 ? [notInArray(worlds.creatorId, hiddenCreatorIds)] : []),
      // Guests never receive Limitless rows in the featured rail.
      ...(safe ? [eq(worlds.ageRating, "all"), eq(worlds.isNsfw, false)] : []),
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
    const variantLangs = variantLanguages(c.req.query("lang"), preferredLang);
    const preferredRows = await rd
      .select(hubWorldListSelect)
      .from(worlds)
      .leftJoin(user, eq(worlds.creatorId, user.id))
      .where(and(
        inArray(worlds.languageGroupId, groupIds),
        ...(hiddenCreatorIds.length > 0 ? [notInArray(worlds.creatorId, hiddenCreatorIds)] : []),
        eq(worlds.isPublished, true),
        eq(worlds.status, "published"),
        // Featured slots are public surface — never swap in a followers-only
        // sibling a non-follower can't open.
        eq(worlds.visibility, "public"),
        ...(safe ? [eq(worlds.ageRating, "all"), eq(worlds.isNsfw, false)] : []),
        or(...variantLangs.flatMap((l) => [eq(worlds.language, l), sql`${worlds.language} LIKE ${`${l}-%`}`])),
      ))
      .orderBy(
        sql`CASE ${sql.join(variantLangs.map((l, i) => sql`WHEN ${worlds.language} = ${l} OR ${worlds.language} LIKE ${`${l}-%`} THEN ${sql.raw(String(i))}`), sql` `)} ELSE ${sql.raw(String(variantLangs.length))} END`,
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

  const unique = ordered.filter((row, i, all) => all.findIndex(other => (other.languageGroupId ?? other.id) === (row.languageGroupId ?? row.id)) === i);
  const mediaResolved = await resolveHubMedia(unique, c.get("discoverPreviewEnabled"));

  return c.json({ data: mediaResolved, layout });
});

// GET /api/worlds/:id/activity — aggregate engagement shown in a card's details
// (Library and the Discover preview). Published worlds expose only anonymous
// totals. Draft/review/unpublished rows stay creator-only, matching the detail
// route's content-access boundary.
worldRoutes.get("/:id/activity", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const currentUser = c.get("user");

  // Who may see the totals is decided on the primary (one row by key): a card
  // unpublished a moment ago must not keep answering from a lagging replica.
  const [gate] = await db
    .select({ creatorId: worlds.creatorId, isPublished: worlds.isPublished, status: worlds.status })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  if (!gate || !await canReadFollowerWorld(worldId, currentUser?.id)) return c.json({ error: "World not found" }, 404);
  if (currentUser && currentUser.id !== gate.creatorId && (await getBlockStatus(currentUser.id, gate.creatorId)).blocked) {
    return c.json({ error: "World not found" }, 404);
  }
  const worldStatus = gate.status ?? (gate.isPublished ? "published" : "draft");
  const isCreator = currentUser?.id === gate.creatorId;
  if (worldStatus !== "published" && !isCreator) {
    return c.json({ error: "World not found" }, 404);
  }

  // Every Discover preview opens this, so a published card's totals are read
  // from the replica (public aggregates; a few seconds stale is fine). The
  // author's unpublished card, or a row the replica lacks yet, reads primary.
  const selectActivity = (rd: DrizzleDB) => rd
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
      avgPlaytimePerPlayerSeconds: averageWorldPlayerPlaytime(worldId),
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

  let [world] = worldStatus === "published" ? await selectActivity(readPublic()) : [];
  if (!world) [world] = await selectActivity(db);
  if (!world) return c.json({ error: "World not found" }, 404);

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
      avgPlaytimePerPlayerSeconds: Number(world.avgPlaytimePerPlayerSeconds ?? 0),
      avgSessionSeconds: Number(world.avgSessionSeconds ?? 0),
      averageRating: Number(world.averageRating ?? 0),
      reviewCount: Number(world.reviewCount ?? 0),
    },
  });
});

// GET /api/worlds/:id — public (for published worlds)
// The world's current public address, for share buttons on screens whose data
// predates addresses (library, cached feeds). Published public worlds only, plus
// the owner's own drafts.
worldRoutes.get("/:id/address", optionalAuthMiddleware, async (c) => {
  const world = await findWorldById(c.req.param("id")).catch(() => null);
  const viewer = c.get("user");
  if (!world || !await canResolveWorldAddress(world.id, viewer?.id)) return c.json({ error: "World not found" }, 404);
  const path = canonicalWorldPath(world);
  if (!path) return c.json({ error: "World not found" }, 404);
  return c.json({ data: { path } });
});

// Public address lookup: the permanent short id in /@user/name-<publicId> -> world id.
// Published public worlds only, plus the owner's own drafts.
worldRoutes.get("/resolve/:publicId", optionalAuthMiddleware, async (c) => {
  const publicId = c.req.param("publicId").trim().toLowerCase();
  if (!/^[0-9a-f]{8,32}$/.test(publicId)) return c.json({ error: "World not found" }, 404);
  const [row] = await readPublic()
    .select({
      id: worlds.id,
      status: worlds.status,
      isPublished: worlds.isPublished,
      visibility: worlds.visibility,
      creatorId: worlds.creatorId,
    })
    .from(worlds)
    .where(eq(worlds.publicId, publicId))
    .limit(1);
  const viewer = c.get("user");
  if (!row || !await canResolveWorldAddress(row.id, viewer?.id)) return c.json({ error: "World not found" }, 404);
  return c.json({ data: { id: row.id } });
});

worldRoutes.get("/:id", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  let currentUser: SessionUser | null = null;
  try { currentUser = c.get("user"); } catch { /* unauthenticated */ }
  // Editor's own view (forEdit=1) must reflect writes immediately. The Studio agent
  // writes the master over a minutes-long streaming run; the 5s read-after-write flag
  // (set at stream-open) is long expired by the time the editor refreshes, so readDb()
  // would route to a lagging replica and show stale pre-edit content ("AI changes lost").
  // forEdit reads are low volume (and gated below for no-remix cards) → always serve from primary.
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
        landscapeCoverUrl: worlds.landscapeCoverUrl,
        landscapeCoverCrop: worlds.landscapeCoverCrop,
        isPublished: worlds.isPublished,
        status: worlds.status,
        submittedForReviewAt: worlds.submittedForReviewAt,
        isNsfw: worlds.isNsfw,
        allowEdit: worlds.allowEdit,
        allowCustomApi: worlds.allowCustomApi,
        allowReviews: worlds.allowReviews,
        allowSessionSharing: worlds.allowSessionSharing,
        allowCommunityCitations: worlds.allowCommunityCitations,
        allowLiveCanon: worlds.allowLiveCanon,
        allowLiveCanonAdditions: worlds.allowLiveCanonAdditions,
        blurCover: worlds.blurCover,
        ageRating: worlds.ageRating,
        targetAudience: worlds.targetAudience,
        visibility: worlds.visibility,
        downloadCount: aggregatedCounters.displayDownloadCount,
        messageCount: aggregatedCounters.messageCount,
        favoriteCount: aggregatedCounters.favoriteCount,
        // The preview header's stars, before its Reviews tab loads the full summary.
        reviewCount: aggregatedCounters.reviewCount,
        averageRating: aggregatedCounters.averageRating,
        tags: worlds.tags,
        galleryImages: worlds.galleryImages,
        announcement: worlds.announcement,
        totalTokens: worlds.totalTokens,
        approxTime: worlds.approxTime,
        language: worlds.language,
        languageGroupId: worlds.languageGroupId,
        gamePath: worlds.gamePath,
        multilanguageOverview: worlds.multilanguageOverview,
        // The card page's "play with friends" (normalised below; null = off).
        multiplayer: sql<unknown>`${worlds.schema}->'settings'->'multiplayer'`,
        // Character portraits by entry id: a multiplayer role linked to a character wears theirs.
        rolePortraits: sql<Record<string, string> | null>`(
          SELECT jsonb_object_agg(e->>'id', e->>'portrait')
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${worlds.schema}->'entries') = 'array' THEN ${worlds.schema}->'entries' ELSE '[]'::jsonb END) e
          WHERE e->>'role' = 'character' AND coalesce(e->>'portrait', '') <> '')`,
        createdAt: worlds.createdAt,
        updatedAt: worlds.updatedAt,
        creatorName: user.name,
        creatorUsername: user.username,
        publicId: worlds.publicId,
        creatorImage: user.image,
        ...sourceWorldCols(currentUser?.id),
      }).from(worlds).leftJoin(user, eq(worlds.creatorId, user.id)).where(eq(worlds.id, worldId))
    : await rd.select({ ...getTableColumns(worlds), ...sourceWorldCols(currentUser?.id) }).from(worlds).where(eq(worlds.id, worldId));

  if (result.length === 0) {
    return c.json({ error: "World not found" }, 404);
  }

  const world = result[0]!;
  // The live row's code, before any held-edit overlay below: without a
  // precompiled copy it is stamped in the background (lib/card-code/stamp.ts).
  // The editor's own read stamps at save instead.
  if (!isPreview && !forEdit && "schema" in world) stampCompiledLater(world);

  if (currentUser && currentUser.id !== world.creatorId && (await getBlockStatus(currentUser.id, world.creatorId)).blocked) {
    return c.json({ error: "World not found" }, 404);
  }

  // Access control: status-based with library tombstone support
  const isCreator = currentUser && world.creatorId === currentUser.id;
  const worldStatus = world.status ?? (world.isPublished ? "published" : "draft");
  // A collaborator opening the card in Studio reads what the creator reads.
  const collaboratorAccess = forEdit && currentUser && !isCreator && !isPreview
    ? await getWorldAccess(currentUser.id, worldId, db)
    : null;
  const isTeam = !!isCreator || !!collaboratorAccess;
  if (!isTeam && !await canReadFollowerWorld(worldId, currentUser?.id)) return c.json({ error: "World not found" }, 404);

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

  // Testers: friends the creator lets play this world before it is published
  // (lib/world-testers.ts). Unlike the DM grant above they get the play read,
  // never the Studio read. Resolved lazily, off the published hot path.
  let testerResolved = false;
  let isTester = false;
  async function ensureTesterFlag() {
    if (testerResolved) return;
    testerResolved = true;
    isTester = await isActiveWorldTester(worldId, currentUser?.id);
  }

  if (worldStatus === "draft" && !isTeam) {
    await ensureTesterFlag();
    if (!isTester) {
      await ensureDmGrantFlag();
      if (!hasDmGrant) {
        await ensureAdminFlag();
        if (!isAdmin) return c.json({ error: "World not found" }, 404);
      }
    }
  }

  // Pre-publish review states must not leak to non-creator non-admin users.
  // Without this guard any logged-in user with a worldId can pull the full
  // schema of an in-review or just-rejected world.
  if ((worldStatus === "pending_review" || worldStatus === "rejected") && !isTeam) {
    await ensureTesterFlag();
    if (!isTester) {
      await ensureAdminFlag();
      if (!isAdmin) return c.json({ error: "World not found" }, 404);
    }
  }

  if (worldStatus === "unpublished" && !isTeam) await ensureTesterFlag();
  if (worldStatus === "unpublished" && !isTeam && !isTester) {
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
  if ((!currentUser || currentUser.limitedContentOnly) && (world.ageRating ?? "all") !== "all") {
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

  // forEdit=1 is the editor / Download JSON read. Anyone else gets it only for a
  // card whose creator allows remixing — the same rule /duplicate enforces — so
  // a no-remix card's source can't be pulled through the export path.
  if (forEdit && !isTeam && (world.allowEdit === false || isTester)) {
    await ensureAdminFlag();
    if (!isAdmin) return c.json({ error: "World not found" }, 404);
  }

  // Edit re-review: for the OWNER of a published world, surface the held-edit
  // state and — when the editor asks via ?forEdit=1 — overlay the pending
  // working copy so the creator edits their in-progress version. Players and
  // every other viewer always receive the live / last-approved content.
  if (isTeam && !isPreview && worldStatus === "published") {
    const pend = await getPendingEdit(worldId);
    if (pend) {
      (world as any).pendingEdit = summarizePendingEdit(pend);
      if (c.req.query("forEdit") === "1") {
        Object.assign(world, pend.metadata ?? {});
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
  world.landscapeCoverUrl = resolveImageCdn(world.landscapeCoverUrl);

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
      .select({ name: user.name, image: user.image, username: user.username })
      .from(user)
      .where(eq(user.id, world.creatorId))
      .limit(1);
    (world as any).creatorName = creator?.name ?? null;
    (world as any).creatorUsername = creator?.username ?? null;
    (world as any).creatorImage = resolveImageCdn(creator?.image ?? null);
  } else if (isPreview) {
    // Preview mode: creatorImage came from the JOIN as a raw column value (possibly
    // an S3 key). Resolve to a CDN URL so the client can render it.
    (world as any).creatorImage = resolveImageCdn((world as any).creatorImage ?? null);
  }

  // What this person may do with it in Studio.
  if (forEdit && isTeam) {
    (world as any).access = isCreator
      ? { role: "owner", canPublish: true }
      : { role: collaboratorAccess!.role, canPublish: collaboratorAccess!.canPublish };
  }

  // Entries the author kept never leave for anyone outside the card's team
  // (lib/sealed-entries.ts).
  if (!isPreview && "schema" in world) {
    (world as { schema: unknown }).schema = redactSchemaFor(
      { id: world.id, creatorId: world.creatorId, schema: world.schema, retained: (world as { retained?: unknown }).retained, team: isTeam },
      world.schema,
      currentUser?.id,
      forEdit ? "edit" : "play",
    );
  }

  // Which entries are kept is the author's own setting; nobody outside the team is told.
  if (currentUser?.id !== world.creatorId && !isTeam && "retained" in world) {
    (world as { retained?: unknown }).retained = null;
  }

  // A player's copy carries the interface's compiled code without its source
  // (lib/card-code/source.ts).
  if (!isPreview && !forEdit && "schema" in world) {
    (world as { schema: unknown }).schema = playerSchema(world, {
      clientFormat: c.req.header(CARD_CODE_HEADER),
      isCreator: currentUser?.id === world.creatorId,
    });
  }

  // Lets the client label the card and offer "Leave test".
  if (isTester) (world as any).viewerIsTester = true;

  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  if (isPreview && "multiplayer" in world) {
    const mp = normaliseMultiplayer(world.multiplayer);
    const holder = world as { multiplayer: unknown; rolePortraits?: Record<string, string> | null };
    const portraits = holder.rolePortraits ?? null;
    // The card page's 联机 tab draws each role's picture: its own, else its character's portrait.
    if (mp) {
      mp.roles = mp.roles.map((r) => {
        const ref = r.image ?? (r.entryId ? portraits?.[r.entryId] : undefined);
        const image = ref ? resolveImageCdn(ref) : null;
        return image ? { ...r, image } : r;
      });
    }
    holder.multiplayer = mp;
    delete holder.rolePortraits;
  }
  return c.json({ data: isPreview && c.get("discoverPreviewEnabled") ? (await withWorldPlaytime([world]))[0] : world });
});

// GET /api/worlds/:id/context-requirement — estimated minimum context (tokens)
// to play this card without omitting lore. Used by the client-side play gate.
// Clients treat any failure as "no warning" (fail-open), so access here is
// deliberately simple: published worlds are public, everything else is
// creator-only (admins fall through to no-warning rather than getting a 403).
worldRoutes.get("/:id/context-requirement", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  let currentUser: SessionUser | null = null;
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

  if (!row || !await canReadFollowerWorld(worldId, currentUser?.id)) return c.json({ error: "World not found" }, 404);

  const worldStatus = row.status ?? (row.isPublished ? "published" : "draft");
  const isCreator = currentUser != null && row.creatorId === currentUser.id;
  if (worldStatus !== "published" && !isCreator && !await isActiveWorldTester(worldId, currentUser?.id)) {
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
  cleanWorldLoraBindings(parsed.data.schema);
  // Someone else's LoRA keeps the trigger it has now (its author can't change this card later).
  await snapshotForeignTriggers(worldLoraBindings(parsed.data.schema), currentUser.id);
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

  const { numberUntitled, ...data } = parsed.data;
  const result = await db.transaction(async tx => {
    if (numberUntitled && data.name) {
      // One at a time per creator, so two cards made at once get two numbers.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`world-untitled:${currentUser.id}`}, 0))`);
      const base = data.name.trim();
      const taken = await tx.select({ name: worlds.name }).from(worlds).where(and(
        eq(worlds.creatorId, currentUser.id),
        sql`(${worlds.name} = ${base} OR ${worlds.name} LIKE ${`${base.replace(/[\\%_]/g, "\\$&")} %`})`,
      ));
      data.name = nextUntitledName(base, taken.map((row) => row.name));
      if (data.schema) (data.schema as Record<string, unknown>).name = data.name;
    }
    const result = await tx
    .insert(worlds)
    .values({
      ...data,
      ...(normalizedTags ? { tags: normalizedTags } : {}),
      language,
      creatorId: currentUser.id,
      totalTokens,
    })
    .returning();
    if (result[0]) await checkpointWorld(tx, result[0].id, "save");
    return result;
  });

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
  let clientBaseUpdatedAt =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).baseUpdatedAt === "string"
      ? ((body as Record<string, unknown>).baseUpdatedAt as string)
      : null;
  // Autosave sends what changed (`schemaChanges`) instead of the whole world;
  // the tab's id rides along so its own echo can be told apart.
  const rawSchemaChanges = body && typeof body === "object" ? (body as Record<string, unknown>).schemaChanges : undefined;
  const changeSetSave = rawSchemaChanges !== undefined;
  const saveClientId =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).clientId === "string"
      ? ((body as Record<string, unknown>).clientId as string).slice(0, 64)
      : null;

  const parsed = updateWorldSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }
  if (parsed.data.allowLiveCanon === false) {
    parsed.data.allowLiveCanonAdditions = false;
  }

  // Consolidated read of the live row — drives the in-review lock, the inline-
  // asset check, and the published-world material-edit routing below.
  // The creator, or a collaborator they made an editor.
  const [liveRow] = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), canEditWorldSql(currentUser.id)))
    .limit(1);
  // Saves, holds and checkpoints stay in the creator's name; a collaborator
  // is recorded as the actor where it matters.
  const ownerId = liveRow?.creatorId ?? currentUser.id;
  const isCollaboratorSave = !!liveRow && liveRow.creatorId !== currentUser.id;
  if (isCollaboratorSave) {
    for (const key of OWNER_ONLY_WORLD_FIELDS) delete (parsed.data as Record<string, unknown>)[key];
  }
  // What this collaborator may do with a published card's update: the creator
  // and editors allowed to publish submit and withdraw it; other editors only
  // add to the working copy (see the hold below).
  const collaboratorCanPublish = isCollaboratorSave
    ? mayWithdrawSubmission((await getWorldAccess(currentUser.id, worldId)) ?? { role: "viewer", canPublish: false })
    : true;
  // The card fields this save sets outside the schema, as everyone else's
  // editor should show them (a held edit keeps them too, so they're read
  // before the material gate below moves them there).
  const savedMeta: Record<string, unknown> = {};
  for (const key of WORLD_SAVED_META_KEYS) {
    const value = (parsed.data as Record<string, unknown>)[key];
    if (value !== undefined) savedMeta[key] = key === "tags" ? normalizeTagsForStorage(value as string[]) : value;
  }

  // ── Change-set save ──────────────────────────────────────────────────────
  // Applied onto the CURRENT working copy (the held edit on a published card,
  // else the live row), so another tab's or person's save in between is kept
  // rather than reported stale: field-level last-write-wins, like Figma. The
  // rest of this handler then runs exactly as for a whole-world save.
  let changeSetWorking: unknown = undefined;
  if (changeSetSave) {
    if (!isWorldChangeList(rawSchemaChanges) || parsed.data.schema !== undefined) {
      return c.json({ error: "Invalid schemaChanges", code: "INVALID_CHANGES" }, 400);
    }
    if (!liveRow) return c.json({ error: "World not found or not authorized" }, 404);
    const working = liveRow.status === "published"
      ? ((await getPendingEdit(worldId))?.schema ?? liveRow.schema)
      : liveRow.schema;
    // An edit to a row someone deleted, or to a value someone else changed
    // since this editor read it, is refused rather than dropped or written
    // over: the editor merges and saves again.
    const applied = applyChangeSetSave(working, rawSchemaChanges, body);
    if (!applied.ok) {
      return c.json({ error: "Someone else changed this meanwhile", code: "CHANGES_CONFLICT", missing: applied.missing, conflicts: applied.conflicts,
        currentUpdatedAt: liveRow.updatedAt?.toISOString() ?? null }, 409);
    }
    parsed.data.schema = applied.schema;
    changeSetWorking = working;
    // The changes were applied to the row as read just now; the lock below
    // re-checks that nothing moved in between.
    clientBaseUpdatedAt = liveRow.updatedAt?.toISOString() ?? null;
  }

  // Hub Translation (multilanguage_overview) is retired — never persist it,
  // regardless of what a stale client bundle still sends in the PATCH body.
  delete (parsed.data as Record<string, unknown>).multilanguageOverview;
  // Publish state is owned by POST /:id/status — never let the metadata PATCH set
  // it, even from a forged/stale request (Zod already strips these since they were
  // removed from updateWorldSchema; this is defense-in-depth).
  delete (parsed.data as Record<string, unknown>).status;
  delete (parsed.data as Record<string, unknown>).isPublished;

  // Kept entries: a copy's owner saves the blanked entries they were sent, so
  // put the real text back before anything below reads the schema.
  if (liveRow && parsed.data.schema) {
    const stored = liveRow.status === "published" ? ((await getPendingEdit(worldId))?.schema ?? liveRow.schema) : liveRow.schema;
    parsed.data.schema = restoreSealed(stored, parsed.data.schema, currentUser.id);
  }
  // Story-illustration LoRA bindings: trigger words cleaned like looks before they're stored.
  if (parsed.data.schema) {
    cleanWorldLoraBindings(parsed.data.schema);
    // Someone else's LoRA keeps the trigger it has now (its author can't change this card later).
    await snapshotForeignTriggers(worldLoraBindings(parsed.data.schema), liveRow?.creatorId ?? currentUser.id);
  }
  // Keeping entries means others remix the card, and their own API provider
  // would log the kept text, so both settings follow from the choice.
  if (parsed.data.retained !== undefined) {
    parsed.data.retained = parseRetained(parsed.data.retained);
    if (parsed.data.retained) {
      parsed.data.allowEdit = true;
      parsed.data.allowCustomApi = false;
    }
  } else if (parseRetained(liveRow?.retained)) {
    if (parsed.data.allowCustomApi === true) parsed.data.allowCustomApi = false;
    // Turning remixing off drops the choice: nothing is left to keep from.
    if (parsed.data.allowEdit === false) (parsed.data as Record<string, unknown>).retained = null;
  }
  if (liveRow?.sealedContent && parsed.data.allowCustomApi === true) parsed.data.allowCustomApi = false;

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
  // The working copy this save writes, for the live text fields (the gate
  // below may move it into the held edit).
  const textAfter = parsed.data.schema ?? null;

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
  // Published working copies use the same save token: a restore must not be
  // silently overwritten by an autosave from a page opened before it.
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
  if (liveRow?.status === "pending_review" && parsed.data.visibility !== undefined && parsed.data.visibility !== liveRow.visibility) {
    return c.json({ error: "Withdraw the submission before changing its visibility", code: "REVIEW_VISIBILITY_LOCKED" }, 409);
  }
  const isPublishedWorld = liveRow?.status === "published";
  let existingPending = isPublishedWorld ? await getPendingEdit(worldId) : null;
  const observedPendingUpdatedAt = existingPending?.updatedAt ?? null;
  const visibilityOnly = parsed.data.visibility !== undefined && Object.keys(parsed.data).every(key => key === "visibility");
  const textBefore = changeSetWorking !== undefined ? changeSetWorking : (existingPending?.schema ?? liveRow?.schema ?? null);
  const supersededReview = !visibilityOnly && existingPending?.status === "pending";
  // An editor who can't publish must not pull the creator's submitted update
  // out of review with a routine save. Refuse instead: their editor keeps the
  // change unsaved and says why, and it saves once the review is decided or
  // withdrawn. (Adding it to the submitted copy would put unreviewed content
  // in front of the moderator's approval.)
  if (supersededReview && !collaboratorCanPublish) return c.json(updateInReviewBody(), 409);

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

  let normalizedTags = parsed.data.tags
    ? normalizeTagsForStorage(parsed.data.tags)
    : undefined;


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
  if (isPublishedWorld && liveRow && !visibilityOnly) {
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
      creatorId: ownerId,
      live: {
        schema: liveRow.schema,
        thumbnailUrl: liveRow.thumbnailUrl,
        ageRating: liveRow.ageRating ?? "all",
        languageGroupId: liveRow.languageGroupId,
        updatedAt: liveRow.updatedAt,
      },
      proposedSchema,
      liveMetadata: versionMetadata(liveRow),
      proposedMetadata: versionMetadata({ ...liveRow, ...existingPending?.metadata, ...parsed.data,
        ...(normalizedTags ? { tags: normalizedTags } : {}),
        thumbnailUrl: proposedThumbnailUrl, ageRating: proposedAgeRating }),
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
      for (const key of VERSION_METADATA_FIELDS) delete (parsed.data as Record<string, unknown>)[key];
      normalizedTags = undefined;
      delete (parsed.data as Record<string, unknown>).schema;
      delete (parsed.data as Record<string, unknown>).thumbnailUrl;
      delete (parsed.data as Record<string, unknown>).ageRating;
      delete (parsed.data as Record<string, unknown>).isNsfw;
    } else {
      // No material divergence from live: any stale draft hold was just cleared.
      existingPending = null;
    }
    // An editor without publish rights never writes the live card: whatever
    // the hold above didn't take (e.g. the variant label, which no update
    // carries) is dropped rather than going live unreviewed by the creator.
    if (!collaboratorCanPublish) {
      for (const key of Object.keys(parsed.data)) delete (parsed.data as Record<string, unknown>)[key];
      normalizedTags = undefined;
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

  // Apply the held-edit mutation (if any) and the live worlds UPDATE atomically.
  const result = await db.transaction(async (tx) => {
    // Serialize held-edit creation with standalone update-note publication.
    // Both paths lock the live world first, so their pending-edit check/write
    // order is linearizable even when the author triggers them concurrently.
    // A save planned before a version switch must not apply its old hold plan
    // afterwards. The editor handles STALE_WORLD by merging its unsaved edits.
    // The shared helper re-checks live status, live updatedAt, the held-edit
    // updatedAt and the client's base token under the row lock.
    const locked = await lockWorldForSave(tx, {
      worldId,
      creatorId: ownerId,
      clientBaseUpdatedAt,
      observedStatus: liveRow?.status,
      observedUpdatedAt: liveRow?.updatedAt,
      observedPendingUpdatedAt,
    });
    if (locked.kind === "notFound") return [];
    if (locked.kind === "stale") return { conflict: true as const, currentUpdatedAt: locked.currentUpdatedAt };
    const savePublishVersion = body.saveVersionOnPublish === true;

    // Read existing tags under the same lock used by publishing so a stale
    // form cannot overwrite a concurrent tag save. Newly added dual tags win;
    // an existing dual card can deliberately switch to one audience.
    const [lockedWorld] = parsed.data.targetAudience
      ? await tx.select({ tags: worlds.tags }).from(worlds).where(eq(worlds.id, worldId)).limit(1)
      : [];
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
      const withdrawn = await tx
        .update(worldReviewSubmissions)
        .set({ decision: "withdrawn", decidedBy: currentUser.id, decidedAt: new Date() })
        .where(and(
          eq(worldReviewSubmissions.worldId, worldId),
          eq(worldReviewSubmissions.decision, "pending"),
          eq(worldReviewSubmissions.submissionType, "edit"),
        ))
        .returning();
      // An editor allowed to publish did it: the creator hears their update left the queue.
      if (withdrawn.length > 0 && isCollaboratorSave) notifySubmissionWithdrawn({ worldId, creatorId: ownerId, actorId: currentUser.id });
    }
    // Autosave replaced the Save button, so history marks the spot instead:
    // keep the working copy this save overwrites, once per editing stretch.
    if (liveRow && (parsed.data.schema !== undefined || holdPlan?.upsert)) {
      const working = existingPending ?? liveRow;
      await captureEditCheckpoint(tx, liveRow, {
        schema: working.schema as Record<string, unknown>,
        thumbnailUrl: working.thumbnailUrl ?? null,
        ageRating: working.ageRating ?? "all",
      }, new Date(), isCollaboratorSave ? currentUser.id : null);
    }
    // The card saves itself, so history marks the spot instead of a Save
    // button: keep the working copy this save overwrites, once per stretch.
    if (liveRow && (parsed.data.schema !== undefined || holdPlan?.upsert)) {
      const working = existingPending ?? liveRow;
      await captureEditCheckpoint(tx, liveRow, {
        schema: working.schema as Record<string, unknown>,
        thumbnailUrl: working.thumbnailUrl ?? null,
        ageRating: working.ageRating ?? "all",
      });
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
        updatedAt: nextWorldSaveTime(liveRow?.updatedAt),
      })
      .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, ownerId)))
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
    if (changeSetSave) {
      // Someone saved between our read and the lock. The change set is still
      // good — the editor just sends it again.
      return c.json({ error: "The world changed while saving. Retry.", code: "CHANGES_RETRY", currentUpdatedAt: result.currentUpdatedAt }, 409);
    }
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
  // Publish/unpublish transitions live solely in POST /:id/status.
  const updated = result[0]!;
  let promotedPath: string | null = null;
  if (liveRow?.visibility === "unlisted" && updated.visibility === "public" && updated.status === "published" && updated.isPublished) {
    const [creator] = await db.select({ name: user.name, username: user.username }).from(user).where(eq(user.id, updated.creatorId)).limit(1);
    notifyFollowersOfPublish(updated.creatorId, creator?.name ?? currentUser.name, updated.id, updated.name, updated.thumbnailUrl);
    // The approved live content is becoming discoverable; held edits remain held.
    const { embedAndStoreWorld } = await import("../lib/embeddings.js");
    embedAndStoreWorld({ worldId: updated.id, name: updated.name, description: updated.description,
      tags: updated.tags, announcement: updated.announcement, schema: updated.schema }).catch(() => {});
    promotedPath = canonicalWorldPath({ ...updated, creatorUsername: creator?.username ?? null });
  }

  if (parsed.data.visibility !== undefined && liveRow?.visibility !== updated.visibility) {
    edition.worldVisibilityChanged?.(promotedPath);
  }

  // Cover set on one translation: the others that have none take it (see lib/language-group-artwork).
  if (updated.languageGroupId && (parsed.data.schema !== undefined || parsed.data.thumbnailUrl !== undefined)) {
    await shareArtworkWithLanguageSiblings(worldId, currentUser.id).catch((err) => console.warn("[WORLDS] sibling cover share failed:", err));
  }

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

  const previousUpdatedAt = liveRow?.updatedAt?.toISOString() ?? null;
  // Entries someone else kept on this copy are compared (and sent back) blank,
  // exactly as the card's team loaded them: their real text never rides the
  // live-text relay. The caller may edit (canEditWorldSql above), so it reads
  // as the team.
  const teamView = (schema: unknown) => schema && typeof schema === "object"
    ? redactSchemaFor({ id: worldId, creatorId: ownerId, schema, team: true }, schema, currentUser.id, "edit")
    : schema;
  foldSaveIntoLiveText(worldId, teamView(textBefore), teamView(textAfter), currentUser.id, body);
  if (updated.updatedAt) {
    const changesJson = changeSetSave ? JSON.stringify(rawSchemaChanges) : null;
    publishWorldEvent(worldId, {
      kind: "saved",
      updatedAt: updated.updatedAt.toISOString(),
      previousUpdatedAt,
      clientId: saveClientId,
      actorUserId: currentUser.id,
      ...(changesJson && changesJson.length <= MAX_EVENT_CHANGES_BYTES ? { changes: rawSchemaChanges as unknown[] } : {}),
      ...(Object.keys(savedMeta).length ? { meta: savedMeta } : {}),
    });
  }

  if (changeSetSave) {
    // The editor already has the world; send back the save token and review
    // state, not the whole (possibly multi-MB) row.
    const u = updated as typeof updated & { pendingEdit?: unknown; heldForReview?: unknown; supersededReview?: unknown };
    return c.json({ data: {
      id: updated.id,
      updatedAt: updated.updatedAt,
      previousUpdatedAt,
      ...(u.pendingEdit !== undefined ? { pendingEdit: u.pendingEdit } : {}),
      ...(u.heldForReview !== undefined ? { heldForReview: u.heldForReview } : {}),
      ...(u.supersededReview !== undefined ? { supersededReview: u.supersededReview } : {}),
    } });
  }
  // The row holds the real text of entries someone else kept on this copy.
  return c.json({ data: { ...updated, schema: teamView(updated.schema) as typeof updated.schema, previousUpdatedAt } });
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

  // A grant on this variant also covers its other languages: move it to one
  // of them so deleting a translation doesn't end anyone's access to the rest.
  await db.execute(sql`
    UPDATE world_collaborators wc SET world_id = s.id
    FROM worlds d, LATERAL (
      SELECT v.id FROM worlds v
      WHERE v.creator_id = d.creator_id AND v.language_group_id = d.language_group_id AND v.id <> d.id
      ORDER BY v.id LIMIT 1) s
    WHERE d.id = ${worldId} AND d.creator_id = ${currentUser.id} AND d.language_group_id IS NOT NULL
      AND wc.world_id = d.id
      AND NOT EXISTS (SELECT 1 FROM world_collaborators o WHERE o.world_id = s.id AND o.user_id = wc.user_id)`);

  // The people who lose the card with it, read before the rows cascade away.
  const team = await db.select({ userId: worldCollaborators.userId, status: worldCollaborators.status })
    .from(worldCollaborators).innerJoin(worlds, eq(worlds.id, worldCollaborators.worldId))
    .where(and(eq(worldCollaborators.worldId, worldId), eq(worlds.creatorId, currentUser.id),
      sql`NOT EXISTS (SELECT 1 FROM world_collaborators o JOIN worlds v ON v.id = o.world_id
        WHERE o.user_id = ${worldCollaborators.userId} AND v.id <> ${worldId}
          AND v.creator_id = ${worlds.creatorId} AND v.language_group_id = ${worlds.languageGroupId})`));

  const result = await db
    .delete(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // Anyone with it open is shut out now, and collaborators hear why.
  publishWorldEvent(worldId, { kind: "access-changed", userId: "*", at: new Date().toISOString() });
  for (const member of team) {
    if (member.status !== "accepted") continue;
    notify(member.userId, "world_collab_removed", { worldId, worldName: result[0]!.name, reason: "deleted", byName: currentUser.name }, { actorUserId: currentUser.id, dedupeKey: `${worldId}:${member.userId}:deleted` }).catch(() => {});
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

  let body: { status: string; isNsfw?: boolean; allowEdit?: boolean; allowCustomApi?: boolean; allowReviews?: boolean; allowSessionSharing?: boolean; allowCommunityCitations?: boolean; allowLiveCanon?: boolean; allowLiveCanonAdditions?: boolean; blurCover?: boolean | null; ageRating?: string; visibility?: string; targetAudience?: string };
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
      landscapeCoverUrl: worlds.landscapeCoverUrl,
      coverCrop: worlds.coverCrop,
      landscapeCoverCrop: worlds.landscapeCoverCrop,
      retained: worlds.retained,
      sealedContent: worlds.sealedContent,
      sourceWorldId: worlds.sourceWorldId,
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

  // Banned users cannot submit for review. There is no trusted-creator bypass
  // any more (11/07): every submission gets the AI first look.
  if (newStatus === "pending_review") {
    const [userRow] = await db
      .select({ isBanned: user.isBanned })
      .from(user)
      .where(eq(user.id, currentUser.id));
    if (userRow?.isBanned) {
      return c.json({ error: "Your account is restricted. You cannot submit worlds for review." }, 403);
    }
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
    const visibility = body.visibility && ["public", "followers", "unlisted"].includes(body.visibility)
      ? body.visibility
      : "public";
    const targetAudience = body.targetAudience && ["male", "female", "all"].includes(body.targetAudience)
      ? body.targetAudience
      : (isNsfw ? "male" : "all");
    const allowEdit = body.allowEdit ?? true;
    // A card with kept entries, or a copy holding someone's kept text, plays
    // on official keys only.
    const allowCustomApi = existing[0]!.sealedContent || parseRetained(existing[0]!.retained) ? false : (body.allowCustomApi ?? true);
    const allowReviews = body.allowReviews ?? true;
    const allowSessionSharing = body.allowSessionSharing ?? true;
    const allowCommunityCitations = body.allowCommunityCitations ?? true;
    const allowLiveCanon = body.allowLiveCanon ?? false;
    const allowLiveCanonAdditions = allowLiveCanon && (body.allowLiveCanonAdditions ?? false);
    // Cover blur is the creator's choice on a Limitless card (clients that omit
    // it get the legacy default, blurred). A Limited card never blurs: a cover
    // that needs hiding means the card belongs in Limitless (Jason, 11/09).
    const blurCover = isNsfw ? (body.blurCover ?? true) : false;

    // The creator picked one card. Language siblings may be unfinished drafts
    // or separate releases, so neither validate nor submit them implicitly.
    // Ownership and this card's transition were checked above.
    const submittable = [existing[0]!];

    // A copy of someone else's card goes out as a remix, credited to the
    // original on its page, while that original is on Discover and still lets
    // others edit (lib/remix-publish.ts).
    if (existing[0]!.sourceWorldId) {
      const [source] = await db
        .select({ creatorId: worlds.creatorId, status: worlds.status, isPublished: worlds.isPublished, allowEdit: worlds.allowEdit })
        .from(worlds)
        .where(eq(worlds.id, existing[0]!.sourceWorldId))
        .limit(1);
      const blocked = remixPublishBlock(source ?? null, currentUser.id);
      if (blocked) return c.json({ error: REMIX_PUBLISH_MESSAGES[blocked], code: blocked }, 403);
    }

    // A card's game page opens in a first-party frame with the player's
    // session. Review reads the story, not this field, so a card naming any
    // page but one of ours is stopped here, before it can reach review at all.
    const [gameRow] = await db
      .select({ path: sql<string | null>`${worlds.schema}->'game'->>'path'` })
      .from(worlds)
      .where(eq(worlds.id, worldId))
      .limit(1);
    if (foreignGamePath({ game: { path: gameRow?.path } })) {
      return c.json({ error: "This card's game page is not one the platform provides, so it cannot be published. Remove the game page setting, or upload the game as a web game instead.", code: "GAME_PATH_NOT_ALLOWED" }, 400);
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
        artworkFailures: [{ worldId: coverless.id, name: coverless.name, language: coverless.language, missing: ["portraitImage"] }],
      }, 400);
    }

    if ((await discoverAccess(currentUser.id)).enabled) {
      const artworkFailures = submittable.map(s => ({ worldId: s.id, name: s.name, language: s.language, missing: getDiscoverCoverArtIssues(s) }))
        .filter(failure => failure.missing.length > 0);
      if (artworkFailures.length > 0) {
        return c.json({ error: "Set up portrait (2:3) and landscape (16:9) artwork in Overview and confirm both crops before publishing.", code: "COVER_ART_REQUIRED", artworkFailures }, 400);
      }
    }

    const groupKey = existing[0]!.languageGroupId ?? worldId;
    const now = new Date();
    const submittableIds = submittable.map((s) => s.id);

    await db.transaction(async (tx) => {
      for (const id of [...submittableIds].sort()) await tx.execute(sql`SELECT id FROM worlds WHERE id = ${id} FOR UPDATE`);
      const tagRows = await tx
        .select({ id: worlds.id, tags: worlds.tags })
        .from(worlds)
        .where(inArray(worlds.id, submittableIds))
        .orderBy(worlds.id)
        .for("update");

      const audienceById = new Map<string, "male" | "female" | "all">();
      const versionsById = new Map<string, { versionId: string; baseVersionId: string | null }>();

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
            allowLiveCanon,
            allowLiveCanonAdditions,
            blurCover,
            updatedAt: now,
          })
          .where(eq(worlds.id, row.id)).returning();
        if (submitted) {
          // A card that was live before (unpublished, then resubmitted) is
          // reviewed against what players last saw, not as a new card.
          versionsById.set(row.id, {
            versionId: await capturePublishVersion(tx, submitted, null),
            baseVersionId: await latestLiveVersionId(tx, row.id),
          });
        }
      }

      for (const s of submittable) {
        await tx.insert(worldReviewSubmissions).values({
          worldId: s.id,
          groupKey,
          submittedBy: currentUser.id,
          submittedAt: now,
          decision: "pending",
          ...versionsById.get(s.id),
          snapshotAgeRating: ageRating,
          snapshotIsNsfw: isNsfw,
          snapshotTargetAudience: audienceById.get(s.id) ?? targetAudience,
          snapshotVisibility: visibility,
          snapshotAllowEdit: allowEdit,
          snapshotAllowReviews: allowReviews,
        });
      }
    });

    notify(currentUser.id, "world_submitted_for_review", {
      worldId,
      worldName: existing[0]!.name,
      thumbnailUrl: existing[0]!.thumbnailUrl,
      variantCount: submittable.length,
    }).catch(() => {});
    // The AI looks first; admins are pinged only if it hands the card to a person.
    queueWorldAiReview(groupKey, () => notifyAdminsOfNewReview(worldId, existing[0]!.name, existing[0]!.thumbnailUrl, currentUser.id, currentUser.name, groupKey));

    const [updated] = await db
      .select()
      .from(worlds)
      .where(eq(worlds.id, worldId));
    return c.json({ data: updated ? redactWorldFor(updated, currentUser.id, "edit") : updated });
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

  // Withdraw only this version, matching the author's independent submission.
  if (currentStatus === "pending_review" && newStatus === "draft") {
    await db.transaction(async (tx) => {
      await tx
        .update(worldReviewSubmissions)
        .set({ decision: "withdrawn", decidedBy: currentUser.id, decidedAt: new Date() })
        .where(and(
          eq(worldReviewSubmissions.worldId, worldId),
          eq(worldReviewSubmissions.submissionType, "initial"),
          eq(worldReviewSubmissions.decision, "pending"),
        ));
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

  return c.json({ data: updated ? redactWorldFor(updated, currentUser.id, "edit") : updated });
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

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(worldReviewSubmissions)
      .set({ decision: "withdrawn", decidedBy: currentUser.id, decidedAt: now })
      .where(and(
        eq(worldReviewSubmissions.worldId, worldId),
        eq(worldReviewSubmissions.submissionType, "initial"),
        eq(worldReviewSubmissions.decision, "pending"),
      ));

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
        eq(worlds.id, worldId),
        eq(worlds.creatorId, currentUser.id),
        eq(worlds.status, "pending_review"),
      ));
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

  const now = new Date();

  await db.transaction(async (tx) => {
    const reviewWorlds = await tx.select().from(worlds).where(and(
      eq(worlds.id, worldId),
      eq(worlds.creatorId, currentUser.id), eq(worlds.status, "pending_review"),
    )).orderBy(worlds.id).for("update");
    let versionId: string | undefined;
    for (const row of reviewWorlds) versionId = await capturePublishVersion(tx, row, null);
    await tx
      .update(worldReviewSubmissions)
      .set({ submittedAt: now, ignoredAt: null, ignoredBy: null, ...(versionId ? { versionId } : {}) })
      .where(and(
        eq(worldReviewSubmissions.worldId, worldId),
        eq(worldReviewSubmissions.submissionType, "initial"),
        eq(worldReviewSubmissions.decision, "pending"),
      ));

    // Deliberately do NOT touch worlds.updatedAt: this is not a content
    // change, and bumping it would trip the editor's STALE_WORLD save guard
    // (baseUpdatedAt mismatch) on the very next save after pressing the button.
    await tx
      .update(worlds)
      .set({ submittedForReviewAt: now })
      .where(and(
        eq(worlds.id, worldId),
        eq(worlds.creatorId, currentUser.id),
        eq(worlds.status, "pending_review"),
      ));
  });

  return c.json({ data: { refreshed: true } });
});

/**
 * Whose card a review action acts on: the caller's own, or the card of a
 * creator who let this editor publish updates. Null when neither.
 */
async function reviewActorCreatorId(userId: string, worldId: string): Promise<string | null> {
  const access = await getWorldAccess(userId, worldId);
  if (!access) return null;
  if (access.role === "owner") return access.creatorId;
  return access.role === "editor" && access.canPublish ? access.creatorId : null;
}

// POST /api/worlds/:id/pending/submit — submit a held material edit (to an
// already-published world) into the moderation queue. The live card stays up.
worldRoutes.post("/:id/pending/submit", authMiddleware, rateLimitMiddleware("publishing"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  // The creator, or an editor they let publish updates (on the creator's behalf).
  const creatorId = await reviewActorCreatorId(currentUser.id, worldId);
  if (!creatorId) return c.json({ error: "World not found", code: "NOT_FOUND" }, 404);
  const res = await submitPendingEdit({ worldId, creatorId, actorId: currentUser.id });
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
  const creatorId = await reviewActorCreatorId(currentUser.id, worldId);
  if (!creatorId) return c.json({ error: "World not found", code: "NOT_FOUND" }, 404);
  const res = await withdrawPendingEdit({ worldId, creatorId, actorId: currentUser.id });
  if (!res.ok) return c.json({ error: res.error, code: res.code }, 400);
  notifySubmissionWithdrawn({ worldId, creatorId, actorId: currentUser.id });
  const pend = await getPendingEdit(worldId);
  return c.json({ data: { withdrawn: true, pendingEdit: pend ? summarizePendingEdit(pend) : null } });
});

// POST /api/worlds/:id/pending/update-note — attach a "what's new" note to a held
// edit. It is posted to players (world_updates) only when the edit is approved
// and goes live, so we never announce an update that hasn't shipped.
worldRoutes.post("/:id/pending/update-note", authMiddleware, requireUnmuted, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = parseWorldUpdateNoteBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const creatorId = await reviewActorCreatorId(currentUser.id, worldId);
  if (!creatorId) return c.json({ error: "No held changes to attach a note to", code: "NO_PENDING_EDIT" }, 400);
  const res = await setPendingEditUpdateNote({
    worldId,
    creatorId,
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

  if (source.visibility === "followers" && !(await canReadFollowerWorld(worldId, currentUser.id))) {
    return c.json({ error: "World not found" }, 404);
  }

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
  // What the author kept stays theirs on the copy (lib/sealed-entries.ts).
  const copySchema = isOwnSource ? copyMaterial.schema : sealCopy(copyMaterial.schema, source);
  const copySealed = holdsSealedFrom(copySchema, currentUser.id);

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
        schema: copySchema,
        thumbnailUrl: copyMaterial.thumbnailUrl,
        tags: clampWorldTags(source.tags ?? []),
        isPublished: false,
        isNsfw: copyMaterial.isNsfw ?? false,
        allowEdit: source.allowEdit ?? true,
        // An author copying their own card keeps their choice; anyone else's
        // copy carries the marks instead.
        retained: isOwnSource ? source.retained : null,
        sealedContent: copySealed,
        ...(copySealed ? { allowCustomApi: false } : {}),
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

    // Increment download count on source world. An author copying their own
    // card is not a download.
    if (!isOwnSource) {
      await tx
        .update(worlds)
        .set({ downloadCount: sql`${worlds.downloadCount} + 1` })
        .where(eq(worlds.id, worldId));
    }

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
    schema: redactSchemaFor(result, result.schema, currentUser.id, "edit"),
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

// POST /api/worlds/:id/gallery/upload-url — get presigned URL for gallery image.
// The creator or an editor collaborator (who can change the gallery in the
// editor's save anyway).
worldRoutes.post("/:id/gallery/upload-url", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");

  const access = await getWorldAccess(currentUser.id, worldId);
  if (!access || access.role === "viewer") {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const body = await c.req.json<{ filename: string; contentType: string; sizeBytes?: number }>();
  if (!body.filename || !body.contentType) {
    return c.json({ error: "filename and contentType are required" }, 400);
  }

  const ext = body.filename.split(".").pop() ?? "png";
  const key = `worlds/${worldId}/gallery/pending/${crypto.randomUUID()}.${ext}`;

  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(body.contentType)) return c.json({ error: "Only JPEG, PNG, WebP and GIF images are allowed" }, 400);
  const uploadUrl = await generateUploadUrl(key, body.contentType, { contentLength: validateImageUploadSize(body.sizeBytes), expiresIn: 600 });
  return c.json({ data: { uploadUrl, key } });
});

// POST /api/worlds/:id/gallery/confirm — confirm gallery upload, append to array.
// A collaborator's addition to a published card waits in its held update.
worldRoutes.post("/:id/gallery/confirm", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const body = await c.req.json<{ key: string }>();

  if (!body.key || !body.key.startsWith(`worlds/${worldId}/gallery/`)) {
    return c.json({ error: "Invalid gallery key" }, 400);
  }

  // Authorize before processing the upload: the creator or an editor collaborator.
  const access = await getWorldAccess(currentUser.id, worldId);
  if (!access || access.role === "viewer") {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const normalized = await publishStoredImage(body.key, `worlds/${worldId}/gallery/processed`);
  const applied = await applyWorldGallery({ worldId, actorId: currentUser.id, change: { add: normalized.key } });
  if (!applied.ok) return c.json({ error: applied.error, ...(applied.code ? { code: applied.code } : {}) }, applied.status);

  // Return CDN URL for the new image
  await discardDirectImageUpload(body.key, `worlds/${worldId}/gallery/pending/`);
  const url = resolveImageCdn(normalized.key) ?? normalized.key;

  return c.json({ data: { url, galleryImages: applied.galleryImages, heldForReview: applied.held } });
});

// DELETE /api/worlds/:id/gallery/:index — remove a gallery image by index.
// Editors may too (the gallery is an ordinary field of their saves); the file
// itself is never deleted here, so nothing of anyone's is destroyed.
worldRoutes.delete("/:id/gallery/:index", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("id");
  const index = parseInt(c.req.param("index"));

  if (isNaN(index) || index < 0) {
    return c.json({ error: "Invalid index" }, 400);
  }

  const applied = await applyWorldGallery({ worldId, actorId: currentUser.id, change: { removeIndex: index } });
  if (!applied.ok) return c.json({ error: applied.error, ...(applied.code ? { code: applied.code } : {}) }, applied.status);

  return c.json({ data: { galleryImages: applied.galleryImages, heldForReview: applied.held } });
});

// GET /api/worlds/:id/friends-playing — auth required
worldRoutes.get("/:id/friends-playing", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const worldId = c.req.param("id");

  if (!await canReadFollowerWorld(worldId, currentUser.id)) return c.json({ error: "World not found" }, 404);

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
worldRoutes.post("/:id/updates", authMiddleware, requireUnmuted, rateLimitMiddleware("content-creation"), async (c) => {
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
  // The viewer's own state (follows, the author's held edits) always reads the primary.
  const own = currentUser ? await readOwn(currentUser.id) : null;
  const rawOffset = c.req.query("offset") ?? "0";
  const offset = normalizeWorldUpdateOffset(rawOffset);

  // Who may read the history is decided on the primary (one row by key), so a
  // card made private or restricted a moment ago stops answering at once. The
  // list itself (below) reads the replica for someone else's card.
  const [world] = await (own ?? db)
    .select({ creatorId: worlds.creatorId, status: worlds.status, visibility: worlds.visibility, ageRating: worlds.ageRating })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  if (!world) {
    return c.json({ error: "World not found" }, 404);
  }
  // Guests never read Limitless surfaces (update notes can quote card content).
  if ((!currentUser || currentUser.limitedContentOnly) && (world.ageRating ?? "all") !== "all") {
    return c.json({ error: "World not found" }, 404);
  }

  const isOwner = currentUser?.id === world.creatorId;
  const isAdmin = currentUser?.role === "admin";
  let isFollower = false;
  if (own && currentUser && !isOwner && !isAdmin) {
    const [follow] = await own
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
  if (own && isOwner && ["published", "draft", "unpublished", "rejected"].includes(world.status)) {
    const [pending] = await own
      .select({ worldId: worldPendingEdits.worldId })
      .from(worldPendingEdits)
      .where(eq(worldPendingEdits.worldId, worldId))
      .limit(1);
    canCreate = !pending;
  }

  const historyDb = await readForEdit(currentUser?.id, world.creatorId);
  const rows = await historyDb
    .select({
      id: worldUpdates.id,
      worldId: worldUpdates.worldId,
      title: worldUpdates.title,
      content: worldUpdates.content,
      isMajor: worldUpdates.isMajor,
      createdAt: worldUpdates.createdAt,
      creatorName: user.name,
      creatorUsername: user.username,
      publicId: worlds.publicId,
    })
    .from(worldUpdates)
    .innerJoin(worlds, eq(worldUpdates.worldId, worlds.id))
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(sql`${worldUpdates.worldId} IN (
      SELECT w.id FROM worlds w
      WHERE w.creator_id = (SELECT creator_id FROM worlds WHERE id = ${worldId})
        AND (w.id = ${worldId}
         OR (w.status = 'published'
             AND w.visibility <> 'unlisted'
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

  if (!world || !await canResolveWorldAddress(worldId, currentUser?.id)) return c.json({ data: [] });
  // Guests never read Limitless surfaces (variant names are content too).
  if ((!currentUser || currentUser.limitedContentOnly) && (world.ageRating ?? "all") !== "all") {
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
    ? or(and(eq(worlds.status, "published"), ne(worlds.visibility, "unlisted")), eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id))
    : or(and(eq(worlds.status, "published"), ne(worlds.visibility, "unlisted")), eq(worlds.id, worldId));

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
        followerWorldAudienceSql(currentUser?.id),
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
  // Grants now cover the linked card too: open editors re-read their access.
  announceAccessChange(worldId, "*").catch(() => {});

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
  // Grants stop crossing between it and its old siblings: everyone re-reads access.
  const formerCard = await grantWorldIds(worldId);

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
  const at = new Date().toISOString();
  for (const id of formerCard) publishWorldEvent(id, { kind: "access-changed", userId: "*", at });

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
        // A copy's owner translates the blanked entries they were sent: the
        // variant gets the kept text back, still kept.
        schema: source.sealedContent ? restoreSealed(source.schema, body.schema, currentUser.id) : body.schema,
        retained: source.retained,
        sealedContent: source.sealedContent,
        ...(source.sealedContent || source.retained ? { allowCustomApi: false } : {}),
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

  return c.json({ data: { world: redactWorldFor(result, currentUser.id, "edit"), languageGroupId: groupId } }, 201);
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
        retained: source.retained,
        sealedContent: source.sealedContent,
        ...(source.sealedContent || source.retained ? { allowCustomApi: false } : {}),
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

  return c.json({ data: { world: redactWorldFor(result, currentUser.id, "edit"), languageGroupId: groupId } }, 201);
});

// ─── AI translation into another language version ────────────────────────────
// Quote -> start (background job, see lib/card-translate-job.ts) -> poll. The
// result is a DRAFT variant in the same language group; the creator reviews
// and publishes it like any other version. Charged only on success.

function translateJobErrorResponse(c: Context, e: unknown) {
  if (e instanceof TranslateJobError) {
    const status = e.code === "not_found" ? 404 : e.code === "insufficient_credits" ? 402 : e.code === "unavailable" ? 503 : e.code === "exists" || e.code === "running" ? 409 : 400;
    return c.json({ error: e.message, code: e.code, ...(e.extra ?? {}) }, status);
  }
  throw e;
}

worldRoutes.get("/:id/translate/quote", authMiddleware, async (c) => {
  try {
    return c.json({ data: await quoteTranslation(c.get("user").id, c.req.param("id"), c.req.query("language") ?? "") });
  } catch (e) {
    return translateJobErrorResponse(c, e);
  }
});

worldRoutes.post("/:id/translate", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  let body: { language?: string; update?: boolean };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  try {
    return c.json({ data: await startTranslateJob(c.get("user").id, c.req.param("id"), body.language ?? "", { update: body.update === true }) }, 202);
  } catch (e) {
    return translateJobErrorResponse(c, e);
  }
});

worldRoutes.get("/:id/translate/jobs/:jobId", authMiddleware, async (c) => {
  const job = await getTranslateJob(c.get("user").id, c.req.param("jobId"));
  if (!job || job.sourceWorldId !== c.req.param("id")) return c.json({ error: "Job not found" }, 404);
  return c.json({ data: job });
});

// ─── World Reviews ────────────────────────────────────────────────────────────
// Moved here from reviewsRoutes so they share the /api/worlds mount prefix
// and don't depend on cross-prefix routing (which caused 401s for public GET).

const worldFeedback = createWorldFeedbackService(db, {
  playtime: async (actorId, worldId, gamePath) => {
    const result = await db.execute(reviewPlaytimeQuery(worldId, [actorId], gamePath));
    return Number(result.rows[0]?.seconds ?? 0);
  },
  hasPlayed: (actorId, worldId, gamePath) => hasPlayedWorld(db, actorId, worldId, gamePath),
  isBlocked: async (actorId, otherId) => (await getBlockStatus(actorId, otherId)).blocked,
});
worldRoutes.route("/", createWorldFeedbackRoutes(db, worldFeedback, {
  auth: authMiddleware, optionalAuth: optionalAuthMiddleware,
  write: [communityMuteMiddleware, rateLimitMiddleware("content-creation")],
  hiddenUsers: async actorId => (await listBlockedUsersForHiding(actorId)).hideActivityUserIds,
  changed: async (actor, _worldId, authorId) => {
    await flagWrite(actor.id);
    await Promise.allSettled([invalidateRecommendationProfile(authorId ?? actor.id), invalidateRecommendationFeed(authorId ?? actor.id)]);
  },
  playtimes: async (worldId, userIds) => {
    const [world] = await db.select({ gamePath: worlds.gamePath }).from(worlds).where(eq(worlds.id, worldId));
    const result = await db.execute(reviewPlaytimeQuery(worldId, userIds, world?.gamePath));
    return Object.fromEntries(result.rows.map(row => [String(row.user_id), Number(row.seconds)]));
  },
  published: async (actorId, worldId, postId, sourceType, content, kind) => {
    await Promise.allSettled([
      ...(content ? [translateContent(postId, sourceType, detectLang(content), content, actorId)] : []),
      ...(kind === "review" ? [onReview(actorId, worldId)] : []),
    ]);
  },
  notify: async (userId, payload) => { await notify(userId, "world_feedback", payload); },
}));

// GET /api/worlds/:id/rating — average rating, rater count, star distribution
// (public), plus the viewer's own rating when authenticated. Ratings live in
// world_ratings (one row per user per language group), so comment volume never
// moves these numbers.
worldRoutes.get("/:id/rating", optionalAuthMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const currentUser = c.get("user");
  if (!await canResolveWorldAddress(worldId, currentUser?.id)) return c.json({ error: "World not found" }, 404);
  await worldFeedback.world(worldId, currentUser);
  c.header("Cache-Control", "private, no-store");
  // Authed reads go to primary so a just-saved rating is visible immediately.
  const rd = currentUser ? await readOwn(currentUser.id) : await readDb();

  const accessibleWorlds = feedbackWorldIds(worldId, currentUser);
  const groupFilter = sql`${worldRatings.worldId} IN (${accessibleWorlds})`;
  const commentGroupFilter = sql`${reviews.worldId} IN (${accessibleWorlds})`;

  const [summary, distributionRows, myRatingRows, commentSummary, canRate, lowReasonRows] = await Promise.all([
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
          .select({ rating: worldRatings.rating, lowReason: worldRatings.lowReason })
          .from(worldRatings)
          .where(and(eq(worldRatings.userId, currentUser.id), groupFilter))
          .limit(1)
      : Promise.resolve([] as Array<{ rating: number; lowReason: string | null }>),
    rd
      .select({ count: sql<number>`count(*)::int` })
      .from(reviews)
      .where(
        and(
          commentGroupFilter, visibleFeedbackPost,
          sql`${reviews.kind} = 'review' AND ${reviews.deletedAt} IS NULL AND ${reviews.supersededByReviewId} IS NULL`
        )
      ),
    // null for guests: the sign-in prompt comes first, then the play check.
    currentUser
      ? rd
          .select({ gamePath: worlds.gamePath })
          .from(worlds)
          .where(eq(worlds.id, worldId))
          .limit(1)
          .then(([w]) => (w ? hasPlayedWorld(rd, currentUser.id, worldId, w.gamePath) : false))
      : Promise.resolve(null),
    // Why people rated 1–2★, so a low score with no comment still tells the
    // creator (and other players) something.
    rd
      .select({
        reason: sql<string>`r.reason`,
        count: sql<number>`count(*)::int`,
      })
      .from(sql`${worldRatings}, unnest(string_to_array(${worldRatings.lowReason}, ',')) AS r(reason)`)
      .where(and(groupFilter, sql`${worldRatings.rating} <= ${LOW_RATING_MAX}`))
      .groupBy(sql`r.reason`),
  ]);

  const lowReasons: Record<string, number> = {};
  for (const row of lowReasonRows) {
    if (isLowRatingReason(row.reason)) lowReasons[row.reason] = row.count;
  }

  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of distributionRows) {
    if (row.rating >= 1 && row.rating <= 5) distribution[row.rating] = row.count;
  }

  c.header("Vary", "Cookie");
  return c.json({
    data: {
      averageRating: Math.round((summary[0]?.avg ?? 0) * 10) / 10,
      reviewCount: summary[0]?.count ?? 0,
      commentCount: commentSummary[0]?.count ?? 0,
      distribution,
      myRating: myRatingRows[0]?.rating ?? null,
      myLowReason: myRatingRows[0]?.lowReason ?? null,
      canRate,
      lowReasons,
    },
  });
});

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
  return (async () => {
    const [live] = await db.select({ status: worlds.status, isPublished: worlds.isPublished, visibility: worlds.visibility })
      .from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (!live || live.status !== "published" || !live.isPublished || live.visibility === "unlisted") return;
    const followerRows = await db
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(eq(follows.followingId, creatorId));
    if (followerRows.length > 0) {
      await notifyMany(
        followerRows.map((f) => f.followerId),
        "followed_user_published",
        { creatorUserId: creatorId, creatorName, worldId, worldName, thumbnailUrl },
        { actorUserId: creatorId, dedupeKey: `world-published:${worldId}` },
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
