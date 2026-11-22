/**
 * Image gallery (生图广场). A player publishes one of their own pictures with
 * the recipe that made it: a picture from the image page, or a story
 * illustration from chat (which links back to its card while the card is
 * public). An AI looks first and may approve a plain picture; everything else
 * waits for an admin (lib/image-post-review.ts). Approved posts are public, to
 * guests too (browse only, from the read replica); sensitive ones only to adults
 * whose content mode is r18.
 * Reports pull a post back into review. Deleting the picture deletes the post.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { and, desc, eq, gt, inArray, notInArray, or, sql, isNull, isNotNull } from "drizzle-orm";
import { z } from "zod";
import sharp from "sharp";
import {
  IMAGE_POST_PENDING_MAX, IMAGE_POST_REPORT_HIDE_AT, IMAGE_POST_REPORT_REASONS, IMAGE_POST_TITLE_MAX, getAgeFromBirthYear,
  type ImagePostItem, type ImagePostRecipe,
} from "@yumina/shared";
import { db, readOwn, readPublic } from "../db/index.js";
import {
  generationJobs, generationModels, imagePostLikes, imagePosts, messages, playSessions, reports, turnImages, user, userAssets, worlds,
} from "../db/schema.js";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.js";
import { adminMiddleware } from "../middleware/admin.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import { listBlockedUsersForHiding } from "../lib/blocks.js";
import { resolveProfileContentLevel } from "../lib/profile-content-level.js";
import { buildImagePostRecipe, recipeModelIds } from "../lib/image-post-recipe.js";
import { runImagePostAiReview } from "../lib/image-post-review.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { getObjectBuffer } from "../lib/s3.js";
import { notify } from "../lib/notify.js";
import { liveCharactersFor } from "../lib/rig/jobs.js";
import type { AppEnv } from "../lib/types.js";

export const imagePostRoutes = new Hono<AppEnv>();
/** Guests may browse: the gallery list and one post (GET). Everything that writes, or reads someone's own
 *  posts, needs an account. */
const PUBLIC_BROWSE = /\/image-posts(\/(?!mine$)[^/]+)?$/;
const browseOrAuth: MiddlewareHandler<AppEnv> = (c, next) =>
  (c.req.method === "GET" && PUBLIC_BROWSE.test(c.req.path) ? optionalAuthMiddleware : authMiddleware)(c, next);
imagePostRoutes.use("/image-posts/*", browseOrAuth);
imagePostRoutes.use("/image-posts", browseOrAuth);
imagePostRoutes.use("/admin/image-posts/*", authMiddleware, adminMiddleware);
imagePostRoutes.use("/admin/image-posts", authMiddleware, adminMiddleware);

/** The AI first review, started after every publish. Tests swap it out. */
export const imagePostAiReview = { run: (postId: string) => runImagePostAiReview(postId) };
export function startAiReview(postId: string) {
  void Promise.resolve().then(() => imagePostAiReview.run(postId))
    .catch((error) => console.warn(`[ImagePosts] AI review of ${postId} failed:`, error instanceof Error ? error.message : error));
}

const PAGE_MAX = 60;

export const postColumns = (viewerId: string) => ({
  post: imagePosts,
  authorName: user.name,
  authorUsername: user.username,
  authorImage: user.image,
  liked: sql<boolean>`EXISTS (SELECT 1 FROM image_post_likes l WHERE l.post_id = ${imagePosts.id} AND l.user_id = ${viewerId})`,
  worldName: worlds.name,
  worldThumbnail: worlds.thumbnailUrl,
  // A card is linked only while anyone could open it.
  worldOpen: sql<boolean>`coalesce(${worlds.status} = 'published' AND ${worlds.visibility} = 'public', false)`,
});
export type PostRow = {
  post: typeof imagePosts.$inferSelect;
  authorName: string | null; authorUsername: string | null; authorImage: string | null; liked: boolean;
  worldName: string | null; worldThumbnail: string | null; worldOpen: boolean;
};

const keyPath = (key: string) => `/cdn/key/${Buffer.from(key).toString("base64url")}`;

/** The picture's same-origin path. */
export function imagePostUrl(post: { assetId: string | null; imageKey: string | null }): string {
  return post.assetId ? `/cdn/${post.assetId}` : post.imageKey ? keyPath(post.imageKey) : "";
}

export function toItem(row: PostRow, viewerId: string, admin = false): ImagePostItem {
  const p = row.post;
  return {
    id: p.id,
    source: p.source,
    assetId: p.assetId,
    imageUrl: imagePostUrl(p),
    title: p.title,
    recipe: p.hidePrompt && p.userId !== viewerId && !admin
      ? { ...(p.recipe as ImagePostRecipe), prompt: "", seed: null, advanced: null, models: [], omittedModels: 0 }
      : p.recipe as ImagePostRecipe,
    world: p.worldId && row.worldName && (row.worldOpen || admin)
      ? { id: p.worldId, name: row.worldName, thumbnailUrl: resolveImageCdn(row.worldThumbnail) }
      : null,
    width: p.width,
    height: p.height,
    status: p.status,
    isSensitive: p.isSensitive,
    rejectReason: p.userId === viewerId || admin ? p.rejectReason : null,
    likeCount: p.likeCount,
    liked: !!row.liked,
    isMine: p.userId === viewerId,
    author: { id: p.userId, name: row.authorName ?? "", username: row.authorUsername, image: resolveImageCdn(row.authorImage) },
    createdAt: new Date(p.createdAt).toISOString(),
    approvedAt: p.approvedAt ? new Date(p.approvedAt).toISOString() : null,
    ...(admin ? { aiReview: p.aiReview ?? null, reportCount: p.reportCount } : {}),
  };
}

/**
 * Which 广场 zone a list shows, as cards are split: Limited (nothing sensitive)
 * or Limitless (only sensitive, adults in r18 mode only). No zone asked: a
 * safe viewer gets Limited, an r18 viewer both (older clients).
 */
export function plazaZone(raw: string | undefined, level: "safe" | "r18"): "limited" | "limitless" | null {
  if (raw === "limitless") return level === "r18" ? "limitless" : "limited";
  if (raw === "limited" || level === "safe") return "limited";
  return null;
}

/** "safe" for guests, minors and anyone not in r18 mode. */
export async function viewerContentLevel(viewerId: string, requested: string | undefined): Promise<"safe" | "r18"> {
  if (!viewerId) return "safe";
  const [profile] = await db.select({ preferences: user.preferences, birthYear: user.birthYear }).from(user).where(eq(user.id, viewerId)).limit(1);
  if (profile?.birthYear != null && getAgeFromBirthYear(profile.birthYear) < 18) return "safe";
  // The query may only narrow to "safe" (as on Discover); r18 comes from the
  // player's own saved setting, never from a URL.
  return resolveProfileContentLevel(true, requested === "safe" ? "safe" : undefined, profile?.preferences as Record<string, unknown> | null);
}

// GET /api/image-posts?sort=new|top&offset&limit&mine=1 (a guest: the public list, safe mode)
imagePostRoutes.get("/image-posts", async (c) => {
  const viewer = c.get("user") as AppEnv["Variables"]["user"] | undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), PAGE_MAX);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const sort = c.req.query("sort") === "top" ? "top" : "new";
  const mine = c.req.query("mine") === "1";

  if (mine && !viewer) return c.json({ error: "Unauthorized" }, 401);
  if (mine && viewer) {
    const rd = await readOwn(viewer.id);
    const rows = await rd.select(postColumns(viewer.id)).from(imagePosts)
      .innerJoin(user, eq(user.id, imagePosts.userId))
      .leftJoin(worlds, eq(worlds.id, imagePosts.worldId))
      .where(and(eq(imagePosts.userId, viewer.id), eq(imagePosts.mediaKind, "image")))
      .orderBy(desc(imagePosts.createdAt)).limit(limit + 1).offset(offset);
    return c.json({ posts: rows.slice(0, limit).map((r) => toItem(r, viewer.id)), hasMore: rows.length > limit });
  }

  const viewerId = viewer?.id ?? "";
  const [level, blocks] = await Promise.all([
    viewerContentLevel(viewerId, c.req.query("contentLevel")),
    viewer ? listBlockedUsersForHiding(viewer.id) : null,
  ]);
  const hidden = blocks ? hiddenAuthors(blocks) : [];
  const conditions = [
    eq(imagePosts.status, "approved"),
    // The picture gallery: videos, sounds and live characters are listed by /api/workbench/works.
    eq(imagePosts.mediaKind, "image"),
    eq(user.isBanned, false),
    ...zoneFilter(plazaZone(c.req.query("zone"), level)),
    ...(hidden.length ? [notInArray(imagePosts.userId, hidden)] : []),
  ];
  // A guest's browse is public and stale-tolerant: the replica. A player's stays on the primary (their likes).
  const rows = await (viewer ? db : readPublic()).select(postColumns(viewerId)).from(imagePosts)
    .innerJoin(user, eq(user.id, imagePosts.userId))
    .leftJoin(worlds, eq(worlds.id, imagePosts.worldId))
    .where(and(...conditions))
    .orderBy(...(sort === "top"
      ? [desc(imagePosts.likeCount), desc(imagePosts.approvedAt)]
      : [desc(imagePosts.approvedAt)]), desc(imagePosts.id))
    .limit(limit + 1).offset(offset);
  return c.json({ posts: rows.slice(0, limit).map((r) => toItem(r, viewerId)), hasMore: rows.length > limit, contentLevel: level });
});

// GET /api/image-posts/mine/assets — which of my pictures are already posted.
imagePostRoutes.get("/image-posts/mine/assets", async (c) => {
  const viewer = c.get("user");
  const rd = await readOwn(viewer.id);
  const rows = await rd.select({ assetId: imagePosts.assetId, status: imagePosts.status, id: imagePosts.id })
    .from(imagePosts).where(and(eq(imagePosts.userId, viewer.id), eq(imagePosts.source, "generation")));
  return c.json({ posts: rows });
});

/** The image_posts condition for a zone (plazaZone). */
export function zoneFilter(zone: "limited" | "limitless" | null) {
  return zone ? [eq(imagePosts.isSensitive, zone === "limitless")] : [];
}

export function hiddenAuthors(blocks: Awaited<ReturnType<typeof listBlockedUsersForHiding>>): string[] {
  return [...new Set([...blocks.hideActivityUserIds, ...blocks.hiddenByCreatorIds, ...blocks.hideWorldCreatorIds])];
}

/** The gallery's visibility rules for one post seen by someone other than its
 *  author — the same ones the list applies (approved, author not banned, not
 *  hidden by a block, sensitive only at r18), so an id can't reach what the
 *  list would never show. */
export async function visibleToViewer(post: { userId: string; status: string; isSensitive: boolean }, viewerId: string): Promise<boolean> {
  if (viewerId && post.userId === viewerId) return true;
  if (post.status !== "approved") return false;
  const [author] = await (viewerId ? db : readPublic()).select({ isBanned: user.isBanned }).from(user).where(eq(user.id, post.userId)).limit(1);
  if (!author || author.isBanned) return false;
  if (viewerId && hiddenAuthors(await listBlockedUsersForHiding(viewerId)).includes(post.userId)) return false;
  if (post.isSensitive && await viewerContentLevel(viewerId, undefined) === "safe") return false;
  return true;
}

// GET /api/image-posts/:id — approved (and visible to this viewer), or my own. A live character's work only where
// live characters are open to the viewer (LIVE_CHARACTERS), as /api/workbench/works/:id.
imagePostRoutes.get("/image-posts/:id", async (c) => {
  const viewerAccount = c.get("user") as AppEnv["Variables"]["user"] | undefined;
  const viewerId = viewerAccount?.id ?? "";
  const [row] = await (viewerId ? db : readPublic()).select(postColumns(viewerId)).from(imagePosts)
    .innerJoin(user, eq(user.id, imagePosts.userId))
    .leftJoin(worlds, eq(worlds.id, imagePosts.worldId))
    .where(eq(imagePosts.id, c.req.param("id"))).limit(1);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!await visibleToViewer(row.post, viewerId)) return c.json({ error: "Not found" }, 404);
  if (row.post.mediaKind === "live" && !liveCharactersFor(viewerAccount)) return c.json({ error: "Not found" }, 404);
  return c.json({ post: toItem(row, viewerId) });
});

const publishSchema = z.object({
  jobId: z.string().min(1).max(100),
  assetId: z.string().min(1).max(100),
  title: z.string().max(IMAGE_POST_TITLE_MAX).optional(),
  sensitive: z.boolean().optional(),
});

/** "3:4" → [3, 4]. */
function ratioSize(ratio: unknown): [number, number] | null {
  if (typeof ratio !== "string") return null;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio);
  return m ? [Math.round(Number(m[1]) * 100), Math.round(Number(m[2]) * 100)] : null;
}

/** Shared publish gates: restricted accounts can't post (as with generation),
 *  and a player has at most IMAGE_POST_PENDING_MAX posts waiting. */
export async function publishBlocked(viewer: { id: string; isBanned?: boolean | null; isSuspended?: boolean | null }) {
  if (viewer.isBanned || viewer.isSuspended) return { error: "Your account is restricted.", code: "ACCOUNT_RESTRICTED", status: 403 as const };
  const [pendingRow] = await db.select({ pending: sql<number>`count(*)::int` }).from(imagePosts)
    .where(and(eq(imagePosts.userId, viewer.id), eq(imagePosts.status, "pending")));
  if ((pendingRow?.pending ?? 0) >= IMAGE_POST_PENDING_MAX) return { error: "Too many posts waiting for review", code: "TOO_MANY_PENDING", status: 429 as const };
  return null;
}

// POST /api/image-posts — publish one of my finished pictures (goes to review).
imagePostRoutes.post("/image-posts", rateLimitMiddleware("content-creation"), async (c) => {
  const viewer = c.get("user");
  const parsed = publishSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { jobId, assetId } = parsed.data;

  const [job] = await db.select().from(generationJobs)
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, viewer.id))).limit(1);
  if (!job || job.kind !== "image" || job.status !== "succeeded") return c.json({ error: "Picture not found", code: "NOT_FOUND" }, 404);
  const outputs = Array.isArray(job.assetIds) && job.assetIds.length ? job.assetIds : job.assetId ? [job.assetId] : [];
  if (!outputs.includes(assetId)) return c.json({ error: "Picture not found", code: "NOT_FOUND" }, 404);
  const [asset] = await db.select({ id: userAssets.id }).from(userAssets)
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, viewer.id), eq(userAssets.type, "image"))).limit(1);
  if (!asset) return c.json({ error: "Picture not found", code: "NOT_FOUND" }, 404);

  const [existing] = await db.select({ id: imagePosts.id }).from(imagePosts).where(eq(imagePosts.assetId, assetId)).limit(1);
  if (existing) return c.json({ error: "Already posted", code: "ALREADY_POSTED", id: existing.id }, 409);
  const blocked = await publishBlocked(viewer);
  if (blocked) return c.json({ error: blocked.error, code: blocked.code }, blocked.status);

  const params = (job.params ?? {}) as Record<string, unknown>;
  const ids = recipeModelIds(params);
  const usableRows = ids.length ? await db.select({ id: generationModels.id, name: generationModels.name, kind: generationModels.kind })
    .from(generationModels)
    .where(and(inArray(generationModels.id, ids), eq(generationModels.status, "ready"), isNull(generationModels.takedownReason),
      or(isNull(generationModels.userId), eq(generationModels.source, "platform"), eq(generationModels.isPublic, true)))) : [];
  const recipe = buildImagePostRecipe(job.templateId, params, new Map(usableRows.map((m) => [m.id, { name: m.name, kind: m.kind }])));
  const ratio = ratioSize(recipe.cloud?.aspectRatio);
  const width = recipe.advanced?.width ?? ratio?.[0] ?? null;
  const height = recipe.advanced?.height ?? ratio?.[1] ?? null;

  const [post] = await db.insert(imagePosts).values({
    userId: viewer.id, source: "generation", jobId, assetId,
    title: (parsed.data.title ?? "").trim().slice(0, IMAGE_POST_TITLE_MAX),
    recipe, width, height, isSensitive: parsed.data.sensitive === true,
  }).onConflictDoNothing().returning();
  if (!post) return c.json({ error: "Already posted", code: "ALREADY_POSTED" }, 409);
  startAiReview(post.id);
  return c.json({ post: { id: post.id, status: post.status } }, 201);
});

const storySchema = z.object({
  messageId: z.string().min(1).max(100),
  imageUrl: z.string().min(1).max(600),
  title: z.string().max(IMAGE_POST_TITLE_MAX).optional(),
  sensitive: z.boolean().optional(),
});

/** `/cdn/key/<base64url key>` → the key, only for this player's own story illustrations. */
export function ownTurnImageKey(imageUrl: string, userId: string): string | null {
  const m = /^\/cdn\/key\/([A-Za-z0-9_-]+)$/.exec(imageUrl.split(/[?#]/)[0] ?? "");
  if (!m) return null;
  const key = Buffer.from(m[1]!, "base64url").toString("utf8");
  if (key.includes("..") || key.includes("\\")) return null;
  return key.startsWith(`users/${userId}/turn-images/`) ? key : null;
}

/** A story illustration's recipe: the tags it was drawn from, on the image
 *  page's anime template. Older pictures predate saved recipes: empty prompt. */
function storyRecipe(saved: { prompt: string; negative: string; nsfw: boolean } | undefined): ImagePostRecipe {
  return {
    templateId: "image-anime",
    prompt: saved?.prompt ?? "",
    style: saved?.nsfw ? "nsfw-anima" : "anime-anima",
    quality: null,
    aspectId: null,
    seed: null,
    cloud: null,
    advanced: saved?.negative ? { negativePrompt: saved.negative, loras: [], checkpointModelId: null } : null,
    models: [],
    omittedModels: 0,
  };
}

// POST /api/image-posts/story — post a story illustration from one of my chats.
imagePostRoutes.post("/image-posts/story", rateLimitMiddleware("content-creation"), async (c) => {
  const viewer = c.get("user");
  const parsed = storySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const imageUrl = parsed.data.imageUrl.split(/[?#]/)[0]!;
  const key = ownTurnImageKey(imageUrl, viewer.id);
  if (!key) return c.json({ error: "Picture not found", code: "NOT_FOUND" }, 404);

  // The picture must be in one of my own chats, in that message (any swipe).
  const [message] = await db.select({ worldId: playSessions.worldId, sessionId: playSessions.id }).from(messages)
    .innerJoin(playSessions, eq(playSessions.id, messages.sessionId))
    .where(and(
      eq(messages.id, parsed.data.messageId),
      eq(playSessions.userId, viewer.id),
      sql`(strpos(${messages.content}, ${imageUrl}) > 0 OR strpos(coalesce(${messages.swipes}::text, ''), ${imageUrl}) > 0)`,
    )).limit(1);
  if (!message) return c.json({ error: "Picture not found", code: "NOT_FOUND" }, 404);

  const [existing] = await db.select({ id: imagePosts.id }).from(imagePosts).where(eq(imagePosts.imageKey, key)).limit(1);
  if (existing) return c.json({ error: "Already posted", code: "ALREADY_POSTED", id: existing.id }, 409);
  const blocked = await publishBlocked(viewer);
  if (blocked) return c.json({ error: blocked.error, code: blocked.code }, blocked.status);

  const [saved] = await db.select({ prompt: turnImages.prompt, negative: turnImages.negative, nsfw: turnImages.nsfw })
    .from(turnImages).where(and(eq(turnImages.imageKey, key), eq(turnImages.userId, viewer.id))).limit(1);
  // The size lays out the gallery; without it the card just uses a default shape.
  let width: number | null = null, height: number | null = null;
  try {
    const meta = await sharp((await getObjectBuffer(key, { maxBytes: 20 * 1024 * 1024 })).buffer).metadata();
    width = meta.width ?? null; height = meta.height ?? null;
  } catch (error) {
    console.warn(`[ImagePosts] story picture size unknown (${key}):`, error instanceof Error ? error.message : error);
  }

  const [post] = await db.insert(imagePosts).values({
    userId: viewer.id, source: "story", imageKey: key, worldId: message.worldId,
    title: (parsed.data.title ?? "").trim().slice(0, IMAGE_POST_TITLE_MAX),
    recipe: storyRecipe(saved), width, height,
    // A picture drawn as explicit starts out marked; the author can't unmark it.
    isSensitive: parsed.data.sensitive === true || saved?.nsfw === true,
  }).onConflictDoNothing().returning();
  if (!post) return c.json({ error: "Already posted", code: "ALREADY_POSTED" }, 409);
  startAiReview(post.id);
  return c.json({ post: { id: post.id, status: post.status } }, 201);
});

// DELETE /api/image-posts/:id — the author takes a post down (admins too).
imagePostRoutes.delete("/image-posts/:id", async (c) => {
  const viewer = c.get("user");
  const [post] = await db.select({ userId: imagePosts.userId }).from(imagePosts).where(eq(imagePosts.id, c.req.param("id"))).limit(1);
  if (!post) return c.json({ error: "Not found" }, 404);
  if (post.userId !== viewer.id) {
    const [me] = await db.select({ role: user.role }).from(user).where(eq(user.id, viewer.id)).limit(1);
    if (me?.role !== "admin") return c.json({ error: "Not found" }, 404);
  }
  await db.delete(imagePosts).where(eq(imagePosts.id, c.req.param("id")));
  return c.json({ ok: true });
});

async function setLike(viewerId: string, postId: string, like: boolean) {
  const [target] = await db.select({ userId: imagePosts.userId, status: imagePosts.status, isSensitive: imagePosts.isSensitive })
    .from(imagePosts).where(eq(imagePosts.id, postId)).limit(1);
  if (!target || !await visibleToViewer(target, viewerId)) return null;
  return db.transaction(async (tx) => {
    const [post] = await tx.select({ status: imagePosts.status }).from(imagePosts).where(eq(imagePosts.id, postId)).for("update").limit(1);
    if (!post || post.status !== "approved") return null;
    const changed = like
      ? await tx.insert(imagePostLikes).values({ postId, userId: viewerId }).onConflictDoNothing().returning()
      : await tx.delete(imagePostLikes).where(and(eq(imagePostLikes.postId, postId), eq(imagePostLikes.userId, viewerId))).returning();
    const [row] = changed.length
      ? await tx.update(imagePosts).set({ likeCount: sql`greatest(${imagePosts.likeCount} + ${like ? 1 : -1}, 0)` })
        .where(eq(imagePosts.id, postId)).returning()
      : await tx.select({ likeCount: imagePosts.likeCount }).from(imagePosts).where(eq(imagePosts.id, postId));
    return { liked: like, likeCount: row?.likeCount ?? 0 };
  });
}

imagePostRoutes.post("/image-posts/:id/like", rateLimitMiddleware("social-actions"), async (c) => {
  const r = await setLike(c.get("user").id, c.req.param("id"), true);
  return r ? c.json(r) : c.json({ error: "Not found" }, 404);
});
imagePostRoutes.delete("/image-posts/:id/like", rateLimitMiddleware("social-actions"), async (c) => {
  const r = await setLike(c.get("user").id, c.req.param("id"), false);
  return r ? c.json(r) : c.json({ error: "Not found" }, 404);
});

const reportSchema = z.object({
  reason: z.enum(IMAGE_POST_REPORT_REASONS),
  details: z.string().max(1000).optional(),
});

// POST /api/image-posts/:id/report — once per player; enough reports send the
// post back to review (hidden until a person looks).
imagePostRoutes.post("/image-posts/:id/report", rateLimitMiddleware("reports"), async (c) => {
  const viewer = c.get("user");
  const postId = c.req.param("id");
  const parsed = reportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const [post] = await db.select({ userId: imagePosts.userId, status: imagePosts.status, isSensitive: imagePosts.isSensitive })
    .from(imagePosts).where(eq(imagePosts.id, postId)).limit(1);
  if (!post || post.userId === viewer.id || !await visibleToViewer(post, viewer.id)) return c.json({ error: "Not found" }, 404);

  const inserted = await db.insert(reports).values({
    reporterId: viewer.id, targetType: "image_post", targetId: postId,
    reason: parsed.data.reason, details: parsed.data.details?.trim() || null,
  }).onConflictDoNothing().returning();
  if (!inserted.length) return c.json({ ok: true, already: true });
  await db.update(imagePosts).set({
    reportCount: sql`${imagePosts.reportCount} + 1`,
    // A minor report, or enough of any kind, takes it down until a person looks.
    status: sql`CASE WHEN ${imagePosts.status} = 'approved' AND (${imagePosts.reportCount} + 1 >= ${IMAGE_POST_REPORT_HIDE_AT} OR ${parsed.data.reason} = 'minor') THEN 'pending' ELSE ${imagePosts.status} END`,
  }).where(eq(imagePosts.id, postId));
  return c.json({ ok: true });
});

// ── Admin review ────────────────────────────────────────────────────

// GET /api/admin/image-posts/queue-count — what on the 广场 waits for a person: works, elements, 做法.
imagePostRoutes.get("/admin/image-posts/queue-count", async (c) => {
  const [row] = (await db.execute(sql`SELECT
    (SELECT count(*)::int FROM image_posts WHERE status = 'pending') AS works,
    (SELECT count(*)::int FROM workbench_elements WHERE visibility = 'public' AND status = 'pending') AS elements,
    (SELECT count(*)::int FROM workbench_skills WHERE visibility = 'public' AND status = 'pending') AS skills`)).rows as Array<{ works: number; elements: number; skills: number }>;
  const counts = { works: Number(row?.works ?? 0), elements: Number(row?.elements ?? 0), skills: Number(row?.skills ?? 0) };
  return c.json({ count: counts.works + counts.elements + counts.skills, ...counts });
});

// GET /api/admin/image-posts?status=pending|approved|rejected|reported|ai (ai: what the AI put up on its own)
imagePostRoutes.get("/admin/image-posts", async (c) => {
  const viewer = c.get("user");
  const requested = c.req.query("status");
  const reported = requested === "reported";
  const aiOnly = requested === "ai";
  const status = aiOnly ? "approved" : (["pending", "approved", "rejected"] as const).find((s) => s === requested) ?? "pending";
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 40, 1), 100);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const rows = await db.select(postColumns(viewer.id)).from(imagePosts)
    .innerJoin(user, eq(user.id, imagePosts.userId))
    .leftJoin(worlds, eq(worlds.id, imagePosts.worldId))
    .where(reported ? gt(imagePosts.reportCount, 0)
      : aiOnly ? and(eq(imagePosts.status, "approved"), isNull(imagePosts.reviewedBy), isNotNull(imagePosts.aiReview))
      : eq(imagePosts.status, status))
    .orderBy(...(reported ? [desc(imagePosts.reportCount), desc(imagePosts.createdAt)]
      : status === "pending" ? [imagePosts.createdAt] : [desc(imagePosts.reviewedAt)]))
    .limit(limit + 1).offset(offset);
  const [counts] = await db.select({
    pending: sql<number>`count(*) filter (where ${imagePosts.status} = 'pending')::int`,
    reported: sql<number>`count(*) filter (where ${imagePosts.reportCount} > 0)::int`,
    aiApproved7d: sql<number>`count(*) filter (where ${imagePosts.status} = 'approved' and ${imagePosts.reviewedBy} is null and ${imagePosts.aiReview} is not null and ${imagePosts.approvedAt} > now() - interval '7 days')::int`,
  }).from(imagePosts);
  return c.json({ posts: rows.slice(0, limit).map((r) => toItem(r, viewer.id, true)), hasMore: rows.length > limit, pending: counts?.pending ?? 0, reported: counts?.reported ?? 0, aiApproved7d: counts?.aiApproved7d ?? 0 });
});

const reviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  sensitive: z.boolean().optional(),
  reason: z.string().max(300).optional(),
});

// POST /api/admin/image-posts/:id/review — a person's decision. It also
// settles the post's open reports, and tells the author.
imagePostRoutes.post("/admin/image-posts/:id/review", async (c) => {
  const viewer = c.get("user");
  const postId = c.req.param("id");
  const parsed = reviewSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { decision, sensitive, reason } = parsed.data;
  const now = new Date();
  const [before] = await db.select({ status: imagePosts.status }).from(imagePosts).where(eq(imagePosts.id, postId)).limit(1);
  const [post] = await db.update(imagePosts).set({
    status: decision === "approve" ? "approved" : "rejected",
    ...(sensitive !== undefined ? { isSensitive: sensitive } : {}),
    rejectReason: decision === "reject" ? (reason?.trim() || null) : null,
    reviewedBy: viewer.id,
    reviewedAt: now,
    reportCount: 0,
    approvedAt: decision === "approve" ? sql`coalesce(${imagePosts.approvedAt}, ${now})` : null,
  }).where(eq(imagePosts.id, postId)).returning();
  if (!post) return c.json({ error: "Not found" }, 404);
  await db.update(reports).set({ status: "resolved", resolution: decision === "approve" ? "kept" : "removed", resolvedBy: viewer.id, resolvedAt: now })
    .where(and(eq(reports.targetType, "image_post"), eq(reports.targetId, postId), eq(reports.status, "pending")));
  // Tell the author when the outcome is news: first decision, or a change.
  if (before?.status !== post.status) {
    await notify(post.userId, "image_post_reviewed", {
      postId: post.id, title: post.title, decision, ...(decision === "reject" && post.rejectReason ? { reason: post.rejectReason } : {}),
    }).catch(() => {});
  }
  return c.json({ post: { id: post.id, status: post.status, isSensitive: post.isSensitive } });
});

// POST /api/admin/image-posts/:id/ai-review — run the AI look again (e.g. after it errored).
imagePostRoutes.post("/admin/image-posts/:id/ai-review", async (c) => {
  await imagePostAiReview.run(c.req.param("id"));
  const [post] = await db.select({ status: imagePosts.status, aiReview: imagePosts.aiReview, isSensitive: imagePosts.isSensitive })
    .from(imagePosts).where(eq(imagePosts.id, c.req.param("id"))).limit(1);
  return post ? c.json({ post }) : c.json({ error: "Not found" }, 404);
});
