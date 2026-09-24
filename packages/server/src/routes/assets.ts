import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { assets, worlds, userAssets } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  isS3Configured,
  generateUploadUrl,
  deleteObject,
} from "../lib/s3.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import type { AppEnv } from "../lib/types.js";
import { normalizeAssetMimeType } from "../lib/asset-mime.js";
import { applyWorldCover } from "../lib/pending-edit.js";
import { resizeUploadedImageInBackground } from "../lib/image-resize.js";

const assetRoutes = new Hono<AppEnv>();
const ASSET_TYPES = ["image", "video", "audio", "font", "txt", "other"] as const;
type AssetType = (typeof ASSET_TYPES)[number];

function isAssetType(value: string | undefined): value is AssetType {
  return !!value && (ASSET_TYPES as readonly string[]).includes(value);
}

assetRoutes.use("/*", authMiddleware);

// ─── Constants ──────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES: Record<AssetType, string[]> = {
  video: ["video/mp4", "video/webm"],
  image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  audio: [
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/aac",
    "audio/mp4",
    "audio/x-wav",
  ],
  font: [
    "font/woff",
    "font/woff2",
    "font/ttf",
    "font/otf",
    "application/font-woff",
    "application/font-woff2",
    "application/x-font-woff",
    "application/x-font-woff2",
    "application/x-font-ttf",
    "application/x-font-truetype",
    "application/x-font-otf",
    "application/vnd.ms-opentype",
    "application/font-sfnt",
    "font/sfnt",
  ],
  txt: [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ],
  other: [],
};


function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

// ─── Helper: verify world ownership ─────────────────────────────────

async function verifyWorldOwnership(worldId: string, userId: string) {
  const rows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)));
  return rows.length > 0;
}

// ─── Routes ─────────────────────────────────────────────────────────

// POST /api/worlds/:worldId/assets/upload-url — get presigned upload URL
assetRoutes.post("/worlds/:worldId/assets/upload-url", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{
    filename: string;
    contentType?: string;
    type: string;
  }>();

  if (!body.filename || !body.type) {
    return c.json({ error: "filename and type are required" }, 400);
  }

  if (!isAssetType(body.type)) {
    return c.json({ error: "Invalid asset type" }, 400);
  }
  const assetType = body.type;

  const contentType = normalizeAssetMimeType(body.filename, body.contentType);

  // Validate MIME type
  const allowed = ALLOWED_MIME_TYPES[assetType];
  if (allowed && allowed.length > 0 && !allowed.includes(contentType)) {
    return c.json({ error: `Invalid content type for ${assetType}` }, 400);
  }

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // Generate S3 key
  const safeName = sanitizeFilename(body.filename);
  const key = `worlds/${worldId}/${assetType}/${crypto.randomUUID()}-${safeName}`;

  const uploadUrl = await generateUploadUrl(key, contentType);

  return c.json({
    data: {
      uploadUrl,
      key,
    },
  });
});

// POST /api/worlds/:worldId/assets — register asset after upload
assetRoutes.post("/worlds/:worldId/assets", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{
    key: string;
    filename: string;
    type: string;
    mimeType?: string;
    sizeBytes: number;
  }>();

  if (!body.key || !body.filename || !body.type) {
    return c.json({ error: "key, filename, and type are required" }, 400);
  }

  if (!isAssetType(body.type)) {
    return c.json({ error: "Invalid asset type" }, 400);
  }

  // Validate key belongs to this world
  if (!body.key.startsWith(`worlds/${worldId}/`)) {
    return c.json({ error: "Invalid asset key" }, 400);
  }

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const mimeType = normalizeAssetMimeType(body.filename, body.mimeType);

  const [result] = await db
    .insert(assets)
    .values({
      worldId,
      type: body.type,
      filename: body.filename,
      url: body.key, // Store S3 key, not presigned URL
      sizeBytes: body.sizeBytes,
      mimeType,
    })
    .returning();

  // Cap oversized in-game image art in place — new uploads only, same URL +
  // format, transparency preserved. Fire-and-forget: never blocks the response.
  if (body.type === "image") {
    resizeUploadedImageInBackground(result!.url, mimeType);
  }

  // Return with CDN URL
  const downloadUrl = resolveImageCdn(body.key) ?? "";

  return c.json(
    {
      data: {
        ...result!,
        url: downloadUrl,
      },
    },
    201
  );
});

// GET /api/worlds/:worldId/assets — list assets for a world
assetRoutes.get("/worlds/:worldId/assets", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const typeFilter = c.req.query("type");

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const conditions = [eq(assets.worldId, worldId)];
  if (isAssetType(typeFilter)) {
    conditions.push(eq(assets.type, typeFilter));
  }

  const rows = await db
    .select()
    .from(assets)
    .where(and(...conditions))
    .orderBy(assets.createdAt);

  // Resolve URLs to CDN paths
  const withUrls = rows.map((row) => ({
    ...row,
    url: resolveImageCdn(row.url) ?? row.url,
  }));

  return c.json({ data: withUrls });
});

// GET /api/assets/:id/url — get presigned URL for a single asset
// Works for: asset owner, players of published worlds referencing the asset, public assets
assetRoutes.get("/assets/:id/url", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const assetId = c.req.param("id");

  // Check legacy assets table first
  const rows = await db
    .select()
    .from(assets)
    .where(eq(assets.id, assetId));

  if (rows.length > 0) {
    return c.json({ data: { url: `/cdn/${assetId}` } });
  }

  // Check userAssets table (for @asset:{id} refs pointing at global assets)
  const userRows = await db
    .select()
    .from(userAssets)
    .where(eq(userAssets.id, assetId));

  if (userRows.length > 0) {
    return c.json({ data: { url: `/cdn/${assetId}` } });
  }

  return c.json({ error: "Asset not found" }, 404);
});

// DELETE /api/worlds/:worldId/assets/:id — delete asset
assetRoutes.delete("/worlds/:worldId/assets/:id", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const assetId = c.req.param("id");

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.worldId, worldId)));

  if (rows.length === 0) {
    return c.json({ error: "Asset not found" }, 404);
  }

  // Delete from S3
  if (isS3Configured()) {
    try {
      await deleteObject(rows[0]!.url);
    } catch { /* S3 delete failed — still remove DB record */ }
  }

  await db.delete(assets).where(eq(assets.id, assetId));

  return c.json({ data: { deleted: true } });
});

// POST /api/worlds/:worldId/thumbnail — get thumbnail upload URL
assetRoutes.post("/worlds/:worldId/thumbnail", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ filename: string; contentType: string; animated?: boolean }>();

  if (!body.filename || !body.contentType) {
    return c.json({ error: "filename and contentType are required" }, 400);
  }

  if (!ALLOWED_MIME_TYPES.image!.includes(body.contentType)) {
    return c.json({ error: "Only image files allowed for thumbnails" }, 400);
  }

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const ext = body.filename.split(".").pop() ?? "png";
  // `.anim.` marks an animated cover (the uploader sniffs the file): the app
  // paints its still first frame from the CDN and fades the animation in, so a
  // Discover card is never a dark slot while the animation downloads. The
  // marker only changes how the cover is rendered; GIFs are always treated as
  // animated and need no marker.
  const marker = body.animated === true && ext.toLowerCase() !== "gif" ? ".anim" : "";
  const key = `worlds/${worldId}/thumbnail/${crypto.randomUUID()}${marker}.${ext}`;
  const uploadUrl = await generateUploadUrl(key, body.contentType);

  return c.json({ data: { uploadUrl, key } });
});

// POST /api/worlds/:worldId/thumbnail/confirm — confirm thumbnail upload
assetRoutes.post("/worlds/:worldId/thumbnail/confirm", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ key: string }>();

  if (!body.key || !body.key.startsWith(`worlds/${worldId}/thumbnail/`)) {
    return c.json({ error: "Invalid thumbnail key" }, 400);
  }

  // For a published world the cover is a material change: hold it for re-review
  // instead of overwriting the live cover.
  const applied = await applyWorldCover({ worldId, creatorId: currentUser.id, newKey: body.key });
  if (!applied.ok) {
    return c.json({ error: applied.error, ...(applied.code ? { code: applied.code } : {}) }, applied.status);
  }

  return c.json({ data: { thumbnailUrl: applied.thumbnailUrl, heldForReview: applied.held } });
});

// POST /api/worlds/:worldId/thumbnail/from-asset — set thumbnail from an existing asset
assetRoutes.post("/worlds/:worldId/thumbnail/from-asset", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ assetId: string }>();

  if (!body.assetId) {
    return c.json({ error: "assetId is required" }, 400);
  }

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // Look up asset in assets table, fallback to userAssets
  let s3Key: string | null = null;

  const assetRows = await db
    .select({ url: assets.url, type: assets.type })
    .from(assets)
    .where(eq(assets.id, body.assetId));

  if (assetRows.length > 0) {
    if (assetRows[0]!.type !== "image") {
      return c.json({ error: "Asset must be an image" }, 400);
    }
    s3Key = assetRows[0]!.url;
  } else {
    const userRows = await db
      .select({ url: userAssets.url, type: userAssets.type })
      .from(userAssets)
      .where(eq(userAssets.id, body.assetId));

    if (userRows.length > 0) {
      if (userRows[0]!.type !== "image") {
        return c.json({ error: "Asset must be an image" }, 400);
      }
      s3Key = userRows[0]!.url;
    }
  }

  if (!s3Key) {
    return c.json({ error: "Asset not found" }, 404);
  }

  const applied = await applyWorldCover({ worldId, creatorId: currentUser.id, newKey: s3Key });
  if (!applied.ok) {
    return c.json({ error: applied.error, ...(applied.code ? { code: applied.code } : {}) }, applied.status);
  }

  return c.json({ data: { thumbnailUrl: applied.thumbnailUrl, heldForReview: applied.held } });
});

// POST /api/worlds/:worldId/gallery/from-asset — add gallery image from an existing asset
assetRoutes.post("/worlds/:worldId/gallery/from-asset", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ assetId: string }>();

  if (!body.assetId) {
    return c.json({ error: "assetId is required" }, 400);
  }

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // Look up asset in assets table, fallback to userAssets
  let s3Key: string | null = null;

  const assetRows = await db
    .select({ url: assets.url, type: assets.type })
    .from(assets)
    .where(eq(assets.id, body.assetId));

  if (assetRows.length > 0) {
    if (assetRows[0]!.type !== "image") {
      return c.json({ error: "Asset must be an image" }, 400);
    }
    s3Key = assetRows[0]!.url;
  } else {
    const userRows = await db
      .select({ url: userAssets.url, type: userAssets.type })
      .from(userAssets)
      .where(eq(userAssets.id, body.assetId));

    if (userRows.length > 0) {
      if (userRows[0]!.type !== "image") {
        return c.json({ error: "Asset must be an image" }, 400);
      }
      s3Key = userRows[0]!.url;
    }
  }

  if (!s3Key) {
    return c.json({ error: "Asset not found" }, 404);
  }

  // Check 8-image limit
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

  const updatedImages = [...currentImages, s3Key];

  await db
    .update(worlds)
    .set({ galleryImages: updatedImages, updatedAt: new Date() })
    .where(eq(worlds.id, worldId));

  return c.json({ data: { url: resolveImageCdn(s3Key) ?? s3Key, galleryImages: updatedImages } });
});

export { assetRoutes };
