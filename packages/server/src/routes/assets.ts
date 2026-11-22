import { discoverAccess } from "../lib/discover-access.js";
import { assetIsVersioned } from "../lib/world-version-store.js";
import { worldsUsingAsCover } from "../lib/asset-cover-use.js";
import { assetHeldByLiveBundle } from "../lib/retained-user-assets.js";
import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { assetFolders, assets, worlds, userAssets, worldFolderBindings } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  isS3Configured,
  generateUploadUrl,
  deleteObject,
} from "../lib/s3.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import type { AppEnv } from "../lib/types.js";
import { normalizeAssetMimeType } from "../lib/asset-mime.js";
import { ALLOWED_MIME_TYPES, uploadTypeRefusal } from "../lib/asset-upload-types.js";
import { applyWorldCover, applyWorldGallery } from "../lib/pending-edit.js";
import { shareArtworkWithLanguageSiblings } from "../lib/language-group-artwork.js";
import { discardDirectImageUpload, publishStoredImage } from "../lib/image-resize.js";
import { validateImageUploadSize } from "../lib/image-upload-policy.js";
import { COVER_UPLOAD_TYPES, validateCoverUploadSize } from "../lib/cover-upload.js";
import { coverUploadJobs } from "../lib/cover-upload-jobs.js";
import { canEdit, getWorldAccess, grantWorldIds, type WorldAccess } from "../lib/world-collaborators.js";
import { descendantFolderIds } from "../lib/studio-tools/asset-catalog.js";

const assetRoutes = new Hono<AppEnv>();
const ASSET_TYPES = ["image", "video", "audio", "font", "txt", "other"] as const;
type AssetType = (typeof ASSET_TYPES)[number];

function isAssetType(value: string | undefined): value is AssetType {
  return !!value && (ASSET_TYPES as readonly string[]).includes(value);
}

assetRoutes.use("/*", authMiddleware);

// ─── Constants ──────────────────────────────────────────────────────



function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

// ─── Helper: verify world access ────────────────────────────────────

/**
 * The caller's access when it covers `need`, else null. "edit": the creator or
 * an editor collaborator (upload, delete, cover, gallery). "read": anyone on
 * the card, viewers included (listing). Writes record the world's own
 * creatorId (access.creatorId), never the collaborator's.
 */
async function verifyWorldAccess(worldId: string, userId: string, need: "edit" | "read" = "edit"): Promise<WorldAccess | null> {
  const access = await getWorldAccess(userId, worldId);
  if (!access) return null;
  return need === "read" || canEdit(access) ? access : null;
}


/**
 * The stored key of an image the caller may make this card's cover or put in
 * its gallery: an upload of this card (or one of its language variants), an
 * image in the caller's own library, a public library image, or — for a
 * collaborator — one in the creator's folders bound to the card. Anything else
 * (another card's upload, someone's private library) is "not found".
 */
export async function pickableImageKey(assetId: string, worldId: string, userId: string, access: WorldAccess, opts: { allowVideo?: boolean } = {}):
  Promise<{ key: string } | { error: string; status: 400 | 404 }> {
  const [worldAsset] = await db.select({ url: assets.url, type: assets.type }).from(assets)
    .where(and(eq(assets.id, assetId), inArray(assets.worldId, await grantWorldIds(worldId))));
  const [libraryAsset] = worldAsset ? [] : await db
    .select({ url: userAssets.url, type: userAssets.type, userId: userAssets.userId, folderId: userAssets.folderId, isPublic: userAssets.isPublic })
    .from(userAssets).where(eq(userAssets.id, assetId));
  let allowed = Boolean(worldAsset);
  if (libraryAsset) {
    allowed = libraryAsset.userId === userId || libraryAsset.isPublic;
    if (!allowed && libraryAsset.userId === access.creatorId && libraryAsset.folderId) {
      const [folders, bindings] = await Promise.all([
        db.select({ id: assetFolders.id, parentFolderId: assetFolders.parentFolderId }).from(assetFolders)
          .where(eq(assetFolders.userId, access.creatorId)),
        db.select({ folderId: worldFolderBindings.folderId }).from(worldFolderBindings)
          .where(eq(worldFolderBindings.worldId, worldId)),
      ]);
      allowed = descendantFolderIds(folders, bindings.map((b) => b.folderId)).includes(libraryAsset.folderId);
    }
  }
  const found = worldAsset ?? libraryAsset;
  if (!found || !allowed) return { error: "Asset not found", status: 404 };
  // A cover may also be a video (animated covers); the gallery takes images only.
  if (opts.allowVideo ? !["image", "video"].includes(found.type) : found.type !== "image") {
    return { error: opts.allowVideo ? "Choose an image or video." : "Asset must be an image", status: 400 };
  }
  return { key: found.url };
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
    sizeBytes?: number;
  }>();

  if (!body.filename || !body.type) {
    return c.json({ error: "filename and type are required" }, 400);
  }

  if (!isAssetType(body.type)) {
    return c.json({ error: "Invalid asset type" }, 400);
  }
  const assetType = body.type;

  const contentType = normalizeAssetMimeType(body.filename, body.contentType);

  const refusal = uploadTypeRefusal(assetType, contentType);
  if (refusal) return c.json({ error: refusal }, 400);

  if (!(await verifyWorldAccess(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // Generate S3 key
  const safeName = sanitizeFilename(body.filename);
  const key = `worlds/${worldId}/${assetType}/${contentType.startsWith("image/") ? "pending/" : ""}${crypto.randomUUID()}-${safeName}`;

  const size = contentType.startsWith("image/") ? validateImageUploadSize(body.sizeBytes) : undefined;
  const uploadUrl = await generateUploadUrl(key, contentType, size ? { contentLength: size, expiresIn: 600 } : undefined);

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

  if (!(await verifyWorldAccess(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const mimeType = normalizeAssetMimeType(body.filename, body.mimeType);
  // Registration is checked like the upload: the two requests are separate, and
  // this one names the stored type again.
  const registerRefusal = uploadTypeRefusal(body.type, mimeType);
  if (registerRefusal && body.type !== "image") return c.json({ error: registerRefusal }, 400);
  if (body.type === "image" && !ALLOWED_MIME_TYPES.image.includes(mimeType)) return c.json({ error: "Only JPEG, PNG, WebP and GIF images are allowed" }, 400);
  const normalized = mimeType.startsWith("image/") ? await publishStoredImage(body.key, `worlds/${worldId}/image/processed`, mimeType) : null;

  const [result] = await db
    .insert(assets)
    .values({
      worldId,
      type: body.type,
      filename: body.filename,
      url: normalized?.key ?? body.key,
      sizeBytes: normalized?.sizeBytes ?? body.sizeBytes,
      mimeType,
    })
    .returning();

  if (normalized) await discardDirectImageUpload(body.key, `worlds/${worldId}/${body.type}/pending/`);

  // Return with CDN URL
  const downloadUrl = resolveImageCdn(result!.url) ?? "";

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

  if (!(await verifyWorldAccess(worldId, currentUser.id, "read"))) {
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

  const access = await verifyWorldAccess(worldId, currentUser.id);
  if (!access) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }
  // Deleting removes the file for good, and uploads don't record who made
  // them: only the creator may, so a collaborator can't destroy their work.
  if (access.role !== "owner") {
    return c.json({ error: "Only the card's creator can delete its files", code: "NOT_OWNER" }, 403);
  }

  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.worldId, worldId)));

  if (rows.length === 0) {
    return c.json({ error: "Asset not found" }, 404);
  }

  // Still a card's cover (this card or a translation of it): keep the file.
  const covers = await worldsUsingAsCover(db, assetId, rows[0]!.url);
  if (covers.length) return c.json({ error: "This image is still a card's cover.", code: "ASSET_IN_USE", worlds: covers }, 409);

  // A live public resource pack still ships this file to its installers.
  if (await assetHeldByLiveBundle(db, assetId, rows[0]!.url, currentUser.id)) {
    return c.json({ error: "A published resource pack still uses this file.", code: "ASSET_IN_BUNDLE" }, 409);
  }

  const retained = await db.transaction(async tx => {
    // Serialize against checkpoint insertion until deletion completes.
    await tx.execute(sql`LOCK TABLE world_versions IN SHARE ROW EXCLUSIVE MODE`);
    if (await assetIsVersioned(tx, assetId, rows[0]!.url)) return true;
    if (isS3Configured()) await deleteObject(rows[0]!.url);
    await tx.delete(assets).where(eq(assets.id, assetId));
    return false;
  });
  if (retained) return c.json({ error: "This asset is retained by a saved version and cannot be deleted.", code: "ASSET_VERSIONED" }, 409);

  return c.json({ data: { deleted: true } });
});

// POST /api/worlds/:worldId/thumbnail — get thumbnail upload URL
assetRoutes.post("/worlds/:worldId/thumbnail", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ filename: string; contentType: string; animated?: boolean; sizeBytes?: number }>();

  if (!body.filename || !body.contentType) {
    return c.json({ error: "filename and contentType are required" }, 400);
  }

  if (!(COVER_UPLOAD_TYPES as readonly string[]).includes(body.contentType)) {
    return c.json({ error: "Use a JPEG, PNG, GIF, WebP, MP4 or WebM cover." }, 400);
  }

  if (!(await verifyWorldAccess(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const ext = sanitizeFilename(body.filename.split(".").pop() ?? "png");
  // `.anim.` marks an animated cover (the uploader sniffs the file): the app
  // paints its still first frame from the CDN and fades the animation in, so a
  // Discover card is never a dark slot while the animation downloads. The
  // marker only changes how the cover is rendered; GIFs are always treated as
  // animated and need no marker.
  const marker = body.animated === true && ext.toLowerCase() !== "gif" ? ".anim" : "";
  const key = `worlds/${worldId}/thumbnail/pending/${crypto.randomUUID()}${marker}.${ext}`;
  const uploadUrl = await generateUploadUrl(key, body.contentType, { contentLength: validateCoverUploadSize(body.sizeBytes), expiresIn: 600 });

  return c.json({ data: { uploadUrl, key } });
});

// POST /api/worlds/:worldId/thumbnail/confirm — confirm thumbnail upload
assetRoutes.post("/worlds/:worldId/thumbnail/confirm", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ key: string; target?: "portrait" | "landscape"; processingMode?: "async" }>();

  if (!body.key || !body.key.startsWith(`worlds/${worldId}/thumbnail/`)) {
    return c.json({ error: "Invalid thumbnail key" }, 400);
  }

  if (body.target !== undefined && body.target !== "portrait" && body.target !== "landscape") return c.json({ error: "Invalid cover target" }, 400);
  const discoverPreview = (await discoverAccess(currentUser.id)).enabled;
  if (body.target === "landscape" && !discoverPreview) return c.json({ error: "Discover preview access required" }, 403);

  // For a published world the cover is a material change: hold it for re-review
  // instead of overwriting the live cover. applyWorldCover authorizes the
  // creator or an editor collaborator and records the hold as the creator's;
  // the access check comes first so nobody else gets an upload processed.
  if (!(await verifyWorldAccess(worldId, currentUser.id))) return c.json({ error: "World not found or not authorized" }, 404);
  const prefix = `worlds/${worldId}/thumbnail/processed`;
  const normalized = body.processingMode === "async"
    ? coverUploadJobs.poll(body.key, prefix) : await coverUploadJobs.complete(body.key, prefix);
  if (!normalized) { c.header("Retry-After", "2"); return c.json({ code: "COVER_PROCESSING" }, 202); }
  const applied = await applyWorldCover({ worldId, actorId: currentUser.id, newKey: normalized.key, target: body.target, discoverPreview });
  if (!applied.ok) {
    return c.json({ error: applied.error, ...(applied.code ? { code: applied.code } : {}) }, applied.status);
  }
  // The other translations of this card take the new cover if they have none yet.
  await shareArtworkWithLanguageSiblings(worldId, currentUser.id).catch((err) => console.warn("[COVER] sibling share failed:", err));

  await discardDirectImageUpload(body.key, `worlds/${worldId}/thumbnail/pending/`);
  return c.json({ data: { thumbnailUrl: applied.thumbnailUrl, heldForReview: applied.held, previousUpdatedAt: applied.previousUpdatedAt, updatedAt: applied.updatedAt } });
});

// POST /api/worlds/:worldId/thumbnail/from-asset — set thumbnail from an existing asset
assetRoutes.post("/worlds/:worldId/thumbnail/from-asset", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ assetId: string; target?: "portrait" | "landscape"; processingMode?: "async" }>();

  if (body.target !== undefined && body.target !== "portrait" && body.target !== "landscape") return c.json({ error: "Invalid cover target" }, 400);
  const discoverPreview = (await discoverAccess(currentUser.id)).enabled;
  if (body.target === "landscape" && !discoverPreview) return c.json({ error: "Discover preview access required" }, 403);
  if (!body.assetId) {
    return c.json({ error: "assetId is required" }, 400);
  }

  const access = await verifyWorldAccess(worldId, currentUser.id);
  if (!access) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const picked = await pickableImageKey(body.assetId, worldId, currentUser.id, access, { allowVideo: true });
  if ("error" in picked) return c.json({ error: picked.error }, picked.status);
  const s3Key = picked.key;

  const prefix = `worlds/${worldId}/thumbnail/processed`;
  const normalized = body.processingMode === "async"
    ? coverUploadJobs.poll(s3Key, prefix) : await coverUploadJobs.complete(s3Key, prefix);
  if (!normalized) { c.header("Retry-After", "2"); return c.json({ code: "COVER_PROCESSING" }, 202); }
  const applied = await applyWorldCover({ worldId, actorId: currentUser.id, newKey: normalized.key, target: body.target, discoverPreview });
  if (!applied.ok) {
    return c.json({ error: applied.error, ...(applied.code ? { code: applied.code } : {}) }, applied.status);
  }
  // The other translations of this card take the new cover if they have none yet.
  await shareArtworkWithLanguageSiblings(worldId, currentUser.id).catch((err) => console.warn("[COVER] sibling share failed:", err));

  return c.json({ data: { thumbnailUrl: applied.thumbnailUrl, heldForReview: applied.held, previousUpdatedAt: applied.previousUpdatedAt, updatedAt: applied.updatedAt } });
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

  const access = await verifyWorldAccess(worldId, currentUser.id);
  if (!access) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const picked = await pickableImageKey(body.assetId, worldId, currentUser.id, access);
  if ("error" in picked) return c.json({ error: picked.error }, picked.status);
  const s3Key = picked.key;

  const normalized = await publishStoredImage(s3Key, `worlds/${worldId}/gallery/processed`);
  // A collaborator's addition to a published card waits in its held update.
  const applied = await applyWorldGallery({ worldId, actorId: currentUser.id, change: { add: normalized.key } });
  if (!applied.ok) return c.json({ error: applied.error, ...(applied.code ? { code: applied.code } : {}) }, applied.status);
  const updatedImages = applied.galleryImages;

  return c.json({ data: { url: resolveImageCdn(normalized.key) ?? normalized.key, galleryImages: updatedImages, heldForReview: applied.held } });
});

export { assetRoutes };
