import { userAssetFilters } from "../lib/user-asset-filters.js";
import { detachGenerationAsset } from "../lib/generation/asset-receipts.js";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { eq, and, sql, isNull, ilike, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { userAssets, assetFolders, user, worldFolderBindings, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  isS3Configured,
  generateUploadUrl,
  deleteObject,
  headObject,
  copyObject,
  storageKind,
} from "../lib/s3.js";
import type { AppEnv } from "../lib/types.js";
import { normalizeAssetMimeType } from "../lib/asset-mime.js";
import { PLANS } from "../lib/plan-config.js";
import { ensureWallet } from "../lib/credit-service.js";
import { resolveEffectivePlanWithEventEntitlements } from "../lib/event-plan-entitlements.js";
import { env } from "../lib/env.js";
import { resizeUploadedImageInBackground } from "../lib/image-resize.js";
import { uploadOperationId, validUploadRequestId } from "../lib/asset-upload-operation.js";
import { sessionMedia } from "../lib/session-media.js";
import { mediaRows, mediaPrefix } from "../lib/session-media-service.js";
import { admitCreativeUpload, creativeUploadPolicy } from "../lib/creative-upload-policy.js";

const userAssetRoutes = new Hono<AppEnv>();
const OUTPUT_CHAT_FOLDER_NAME = "output chat";
const SESSION_TEXT_FILENAME_PATTERN = String.raw` Session [0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}\.txt$`;
const SESSION_TEXT_RENAME_PATTERN = String.raw`^(.+) Session ([0-9]{4}-[0-9]{2}-[0-9]{2})_([0-9]{4})\.txt$`;
const SESSION_TEXT_REPLACEMENT = String.raw`\1 - Log \2 \3.txt`;
const ASSET_TYPES = ["image", "video", "audio", "font", "txt", "other"] as const;
type AssetType = (typeof ASSET_TYPES)[number];

function isAssetType(value: string | undefined): value is AssetType {
  return !!value && (ASSET_TYPES as readonly string[]).includes(value);
}

// Absolute origin for CDN URLs. Derived from BETTER_AUTH_URL (e.g. https://yumina.io)
// rather than c.req.url because Railway terminates TLS at the edge and the internal
// request arrives over plain HTTP — using c.req.url would emit http://yumina.io
// URLs, which the browser blocks as mixed content on the https page.
function getCdnOrigin(): string {
  return env.BETTER_AUTH_URL || "http://localhost:3000";
}

// GET /api/user-assets/hub — public browse (no auth required)
userAssetRoutes.get("/hub", async (c) => {
  const q = c.req.query("q")?.trim();
  const typeFilter = c.req.query("type");

  const conditions = [eq(userAssets.isPublic, true)];

  if (q) {
    conditions.push(ilike(userAssets.filename, `%${q}%`));
  }

  if (isAssetType(typeFilter)) {
    conditions.push(eq(userAssets.type, typeFilter));
  }

  const rows = await db
    .select({
      id: userAssets.id,
      userId: userAssets.userId,
      filename: userAssets.filename,
      type: userAssets.type,
      url: userAssets.url,
      sizeBytes: userAssets.sizeBytes,
      mimeType: userAssets.mimeType,
      isPublic: userAssets.isPublic,
      createdAt: userAssets.createdAt,
      creatorName: user.name,
      creatorImage: user.image,
    })
    .from(userAssets)
    .leftJoin(user, eq(userAssets.userId, user.id))
    .where(and(...conditions))
    .orderBy(desc(userAssets.createdAt))
    .limit(50);

  // Use CDN URLs instead of presigned S3 URLs
  const origin = getCdnOrigin();
  const withUrls = rows.map((row) => ({
    ...row,
    url: `${origin}/cdn/${row.id}`,
  }));

  return c.json({ data: withUrls });
});

userAssetRoutes.use("/*", authMiddleware);

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
  // `other` is the escape hatch for formats we don't enumerate (3D models,
  // sprite atlases, binary data tables). It stays open by design — but NOT to
  // active content: /cdn serves these bytes from the app's own origin, so an
  // uploaded text/html or application/javascript would be stored XSS on
  // yumina.io, and SVG carries script too. Those are denied below instead of
  // being allowlisted here, so a legitimate unknown format still uploads.
  other: [],
};

/**
 * Content types that must never be served from our own origin, whatever the
 * asset type claims to be. `X-Content-Type-Options: nosniff` on /cdn stops the
 * browser inventing an active type, but it faithfully honors a declared one.
 */
const ACTIVE_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/xml",
  "application/xml",
  "application/xhtml",
]);

async function getUserStorageLimit(userId: string): Promise<number> {
  const wallet = await ensureWallet(userId);
  const effectivePlan = await resolveEffectivePlanWithEventEntitlements(userId, wallet.plan);
  return PLANS[effectivePlan].storageCap;
}

async function getUserUploadPolicy(userId: string) {
  const wallet = await ensureWallet(userId);
  const plan = await resolveEffectivePlanWithEventEntitlements(userId, wallet.plan);
  return { ...creativeUploadPolicy(plan), storageLimit: PLANS[plan].storageCap };
}

async function activeCreativeUploads(tx: Pick<typeof db, "execute">, userId: string) {
  const [rate] = await mediaRows<{ pending: number }>(tx, sql`
    SELECT count(*)::int AS pending FROM session_media_uploads
    WHERE user_id=${userId} AND session_id IS NULL AND metadata->>'purpose'='creative-asset'
      AND metadata->>'slotReleased' IS DISTINCT FROM 'true'
      AND status IN ('pending','processing') AND expires_at>now()`);
  return rate?.pending ?? 0;
}

userAssetRoutes.get("/upload-policy", async (c) => {
  const policy = await getUserUploadPolicy(c.get("user").id);
  return c.json({ data: { concurrency: policy.concurrency } });
});

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function getReservedRootAssetFolderId(userId: string, name: string) {
  if (name.trim().toLowerCase() !== OUTPUT_CHAT_FOLDER_NAME) return null;
  const hash = createHash("md5").update(`${userId}:${OUTPUT_CHAT_FOLDER_NAME}`).digest("hex");
  return `output-chat-${hash}`;
}

async function findRootAssetFolderByName(userId: string, name: string) {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName) return null;

  const rows = await db
    .select()
    .from(assetFolders)
    .where(
      and(
        eq(assetFolders.userId, userId),
        isNull(assetFolders.parentFolderId),
        sql`lower(trim(${assetFolders.name})) = ${normalizedName}`,
      ),
    )
    .orderBy(assetFolders.createdAt)
    .limit(1);

  return rows[0] ?? null;
}

async function ensureRootAssetFolder(userId: string, name: string) {
  const folderName = name.trim();
  if (!folderName) return null;

  const existingFolder = await findRootAssetFolderByName(userId, folderName);
  if (existingFolder) return existingFolder.id;

  const reservedId = getReservedRootAssetFolderId(userId, folderName);
  const [createdFolder] = await db
    .insert(assetFolders)
    .values({
      ...(reservedId ? { id: reservedId } : {}),
      userId,
      name: folderName,
      parentFolderId: null,
    })
    .onConflictDoNothing()
    .returning();

  if (createdFolder) return createdFolder.id;

  const concurrentFolder = await findRootAssetFolderByName(userId, folderName);
  return concurrentFolder?.id ?? reservedId;
}

async function resolveAssetFolderId(userId: string, folderId?: string | null, folderName?: string) {
  if (folderId === null) return null;

  if (folderId) {
    const rows = await db
      .select({ id: assetFolders.id })
      .from(assetFolders)
      .where(and(eq(assetFolders.id, folderId), eq(assetFolders.userId, userId)))
      .limit(1);

    if (rows.length === 0) {
      throw new Error("Folder not found");
    }

    return folderId;
  }

  if (folderName?.trim()) {
    return ensureRootAssetFolder(userId, folderName);
  }

  return null;
}

async function backfillOutputChatAssetsForUser(userId: string) {
  const existingFolder = await findRootAssetFolderByName(userId, OUTPUT_CHAT_FOLDER_NAME);
  const needsBackfillCondition = existingFolder
    ? sql`(${userAssets.folderId} IS DISTINCT FROM ${existingFolder.id} OR ${userAssets.type} = 'other' OR ${userAssets.filename} ~ ${SESSION_TEXT_FILENAME_PATTERN})`
    : sql`true`;

  const [existingSessionAsset] = await db
    .select({ id: userAssets.id })
    .from(userAssets)
    .where(
      and(
        eq(userAssets.userId, userId),
        sql`${userAssets.type} in ('other', 'txt')`,
        sql`${userAssets.filename} ~ ${SESSION_TEXT_FILENAME_PATTERN}`,
        needsBackfillCondition,
      ),
    )
    .limit(1);

  if (!existingSessionAsset) return;

  const folderId = existingFolder?.id ?? await ensureRootAssetFolder(userId, OUTPUT_CHAT_FOLDER_NAME);
  if (!folderId) return;

  await db
    .update(userAssets)
    .set({
      folderId,
      type: "txt",
      filename: sql<string>`regexp_replace(${userAssets.filename}, ${SESSION_TEXT_RENAME_PATTERN}, ${SESSION_TEXT_REPLACEMENT})`,
    })
    .where(
      and(
        eq(userAssets.userId, userId),
        sql`${userAssets.type} in ('other', 'txt')`,
        sql`${userAssets.filename} ~ ${SESSION_TEXT_FILENAME_PATTERN}`,
      ),
    );
}

// ─── Folder Routes ──────────────────────────────────────────────────

// GET /api/user-assets/folders — list user's folders with asset counts
userAssetRoutes.get("/folders", async (c) => {
  const currentUser = c.get("user");
  await backfillOutputChatAssetsForUser(currentUser.id);

  // Subquery for per-folder asset counts
  const folderCounts = db
    .select({
      folderId: userAssets.folderId,
      count: sql<number>`count(*)`.mapWith(Number).as("asset_count"),
    })
    .from(userAssets)
    .where(eq(userAssets.userId, currentUser.id))
    .groupBy(userAssets.folderId)
    .as("fc");

  const rows = await db
    .select({
      id: assetFolders.id,
      userId: assetFolders.userId,
      name: assetFolders.name,
      parentFolderId: assetFolders.parentFolderId,
      createdAt: assetFolders.createdAt,
      assetCount: sql<number>`coalesce(${folderCounts.count}, 0)`.mapWith(Number),
    })
    .from(assetFolders)
    .leftJoin(folderCounts, eq(assetFolders.id, folderCounts.folderId))
    .where(eq(assetFolders.userId, currentUser.id))
    .orderBy(assetFolders.name);

  // Which of the user's worlds each folder is bound to (organizational only).
  const bindingRows = await db
    .select({
      folderId: worldFolderBindings.folderId,
      worldId: worldFolderBindings.worldId,
      worldName: worlds.name,
    })
    .from(worldFolderBindings)
    .innerJoin(worlds, eq(worldFolderBindings.worldId, worlds.id))
    .where(eq(worlds.creatorId, currentUser.id));

  const boundByFolder = new Map<string, { worldId: string; worldName: string }[]>();
  for (const b of bindingRows) {
    const list = boundByFolder.get(b.folderId) ?? [];
    list.push({ worldId: b.worldId, worldName: b.worldName });
    boundByFolder.set(b.folderId, list);
  }

  const data = rows.map((r) => ({
    ...r,
    boundWorlds: boundByFolder.get(r.id) ?? [],
  }));

  return c.json({ data });
});

// POST /api/user-assets/folders — create folder
userAssetRoutes.post("/folders", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json<{ name: string; parentFolderId?: string; requestId?: string }>();

  if (!validUploadRequestId(body.requestId)) return c.json({ error: "Invalid request ID" }, 400);

  if (!body.name?.trim()) {
    return c.json({ error: "Folder name is required" }, 400);
  }

  const id = body.requestId ? uploadOperationId(currentUser.id, "folder", body.requestId) : crypto.randomUUID();
  if (body.parentFolderId) {
    const [parent] = await db.select({ id: assetFolders.id }).from(assetFolders)
      .where(and(eq(assetFolders.id, body.parentFolderId), eq(assetFolders.userId, currentUser.id))).limit(1);
    if (!parent) return c.json({ error: "Folder not found" }, 404);
  }
  const [inserted] = await db
    .insert(assetFolders)
    .values({
      id,
      userId: currentUser.id,
      name: body.name.trim(),
      parentFolderId: body.parentFolderId ?? null,
    })
    .onConflictDoNothing({ target: assetFolders.id })
    .returning();
  const result = inserted ?? (await db.select().from(assetFolders).where(and(eq(assetFolders.id, id), eq(assetFolders.userId, currentUser.id))).limit(1))[0];
  if (!result) return c.json({ error: "Failed to create folder" }, 500);
  return c.json({ data: result }, 201);
});

// PATCH /api/user-assets/folders/:id — rename folder
userAssetRoutes.patch("/folders/:id", async (c) => {
  const currentUser = c.get("user");
  const folderId = c.req.param("id");
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Folder name is required" }, 400);
  }

  const result = await db
    .update(assetFolders)
    .set({ name: body.name.trim() })
    .where(and(eq(assetFolders.id, folderId), eq(assetFolders.userId, currentUser.id)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Folder not found" }, 404);
  }

  return c.json({ data: result[0] });
});

// DELETE /api/user-assets/folders/:id — delete folder (assets move to root)
userAssetRoutes.delete("/folders/:id", async (c) => {
  const currentUser = c.get("user");
  const folderId = c.req.param("id");

  // Move assets in this folder to root
  await db
    .update(userAssets)
    .set({ folderId: null })
    .where(and(eq(userAssets.folderId, folderId), eq(userAssets.userId, currentUser.id)));

  // Move child folders to root
  await db
    .update(assetFolders)
    .set({ parentFolderId: null })
    .where(and(eq(assetFolders.parentFolderId, folderId), eq(assetFolders.userId, currentUser.id)));

  const result = await db
    .delete(assetFolders)
    .where(and(eq(assetFolders.id, folderId), eq(assetFolders.userId, currentUser.id)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Folder not found" }, 404);
  }

  return c.json({ data: { deleted: true } });
});

// ─── Asset Routes ───────────────────────────────────────────────────

// POST /api/user-assets/upload-url — get presigned upload URL
userAssetRoutes.post("/upload-url", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const body = await c.req.json<{
    filename: string;
    contentType?: string;
    type: string;
    requestId?: string;
    sizeBytes?: number;
  }>();

  if (!validUploadRequestId(body.requestId)) return c.json({ error: "Invalid request ID" }, 400);

  if (!body.filename || !body.type) {
    return c.json({ error: "filename and type are required" }, 400);
  }

  if (!isAssetType(body.type)) {
    return c.json({ error: "Invalid asset type" }, 400);
  }
  const assetType = body.type;

  const contentType = normalizeAssetMimeType(body.filename, body.contentType);

  // Active content is refused for EVERY asset type. Previously `other` had an
  // empty allowlist and the `allowed.length > 0` guard short-circuited it away,
  // so `other` accepted any content-type at all — and /cdn is public and
  // unauthenticated, which made it an arbitrary file host on our own origin.
  if (ACTIVE_CONTENT_TYPES.has(contentType.toLowerCase())) {
    return c.json({ error: "This file type cannot be uploaded" }, 400);
  }

  const allowed = ALLOWED_MIME_TYPES[assetType];
  if (allowed && allowed.length > 0 && !allowed.includes(contentType)) {
    return c.json({ error: `Invalid content type for ${assetType}` }, 400);
  }

  const operationId = body.requestId ? uploadOperationId(currentUser.id, "file", body.requestId) : undefined;
  if (operationId) {
    const [existing] = await db.select().from(userAssets)
      .where(and(eq(userAssets.id, operationId), eq(userAssets.userId, currentUser.id))).limit(1);
    if (existing) return c.json({ data: { asset: { ...existing, url: `${getCdnOrigin()}/cdn/${existing.id}`, key: existing.url } } });
  }

  // Check total user storage against plan limit
  const { storageLimit, concurrency } = await getUserUploadPolicy(currentUser.id);
  if (body.sizeBytes !== undefined && (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 0)) {
    return c.json({ error: "Invalid file size" }, 400);
  }
  if (storageKind() === "s3" && await sessionMedia.isReady()) {
    if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes! < 1 || body.sizeBytes! > Math.min(storageLimit, 2_147_483_647)) {
      return c.json({ error: "A valid file size is required. Refresh the app and try again." }, 400);
    }
    const prepared = await db.transaction(async (tx) => {
      await sessionMedia.lockOwner(tx, currentUser.id);
      // Recheck after locking: another registration can settle while prepare waits.
      if (operationId) {
        const [asset] = await tx.select().from(userAssets)
          .where(and(eq(userAssets.id, operationId), eq(userAssets.userId, currentUser.id))).limit(1);
        if (asset) return { asset };
        const [pending] = await mediaRows<{temp_key:string;filename:string;content_type:string;input_bytes:string;metadata:{type:string;slotReleased?:boolean};expires_at:string}>(tx, sql`
          SELECT * FROM session_media_uploads WHERE user_id=${currentUser.id}
          AND metadata->>'purpose'='creative-asset' AND metadata->>'operationId'=${operationId}
          AND status='pending' AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`);
        if (pending) {
          if (pending.filename !== body.filename || pending.content_type !== contentType || pending.metadata.type !== assetType || Number(pending.input_bytes) !== body.sizeBytes) {
            return { error: "Upload request conflicts with an earlier attempt", status: 409 as const };
          }
          if (pending.metadata.slotReleased && await activeCreativeUploads(tx, currentUser.id) >= concurrency) return { error: "Upload limit reached", status: 429 as const, busy: true };
          const admission = await admitCreativeUpload(tx, currentUser.id, "file", operationId, body.sizeBytes!, storageLimit);
          if (admission !== "admitted") return { error: "Upload limit reached", status: admission === "limit" ? 429 as const : 409 as const };
          if (pending.metadata.slotReleased) {
            await tx.execute(sql`UPDATE session_media_uploads SET metadata=metadata-'slotReleased' WHERE user_id=${currentUser.id} AND temp_key=${pending.temp_key}`);
          }
          return { key: pending.temp_key, expiresAt: pending.expires_at };
        }
      }
      const usage = await sessionMedia.usage(currentUser.id, tx);
      if (usage.used + usage.reserved + body.sizeBytes! > storageLimit) {
        return { error: "Storage limit reached", status: 413 as const };
      }
      // Folder imports can contain thousands of small files. Bound their byte
      // turnover and outstanding transfers, with a high count ceiling only to
      // prevent tiny-file spam. Chat attachments have a separate rate budget.
      if (await activeCreativeUploads(tx, currentUser.id) >= concurrency) {
        return { error: "Upload limit reached", status: 429 as const, busy: true };
      }
      const id = crypto.randomUUID();
      const admission = await admitCreativeUpload(tx, currentUser.id, "file", operationId ?? id, body.sizeBytes!, storageLimit);
      if (admission !== "admitted") return { error: "Upload limit reached", status: admission === "limit" ? 429 as const : 409 as const };
      const key = `${mediaPrefix(currentUser.id)}pending/${id}`;
      const [reservation] = await mediaRows<{expires_at:string}>(tx, sql`INSERT INTO session_media_uploads(id,user_id,entry_id,filename,content_type,input_bytes,reserved_bytes,metadata,temp_key,expires_at)
        VALUES(${id},${currentUser.id},${id},${body.filename},${contentType},${body.sizeBytes},${body.sizeBytes},${JSON.stringify({purpose:"creative-asset",type:assetType,operationId})}::jsonb,${key},now()+interval '10 minutes') RETURNING expires_at`);
      return { key, expiresAt: reservation!.expires_at };
    });
    if ("asset" in prepared && prepared.asset) {
      return c.json({ data: { asset: { ...prepared.asset, url: `${getCdnOrigin()}/cdn/${prepared.asset.id}`, key: prepared.asset.url } } });
    }
    if ("error" in prepared && prepared.error) {
      if ("busy" in prepared) c.header("Retry-After", "2");
      return c.json({ error: prepared.error, ...("busy" in prepared ? { code: "UPLOAD_BUSY" } : {}) }, prepared.status!);
    }
    const expiresIn = Math.max(1, Math.min(600, Math.floor((Date.parse(prepared.expiresAt!) - Date.now()) / 1000)));
    return c.json({ data: { key: prepared.key!, uploadUrl: await generateUploadUrl(prepared.key!, contentType, {contentLength: body.sizeBytes!, expiresIn}) } });
  }

  const usage = await sessionMedia.usage(currentUser.id);
  const totalUsed = usage.used + usage.reserved;
  if (totalUsed + (body.sizeBytes ?? 0) > storageLimit || totalUsed >= storageLimit) {
    const limitLabel = storageLimit >= 1024 * 1024 * 1024
      ? `${(storageLimit / (1024 * 1024 * 1024)).toFixed(0)} GB`
      : `${(storageLimit / (1024 * 1024)).toFixed(0)} MB`;
    return c.json({ error: `Storage limit reached (${limitLabel}). Upgrade your plan for more space.` }, 400);
  }

  const safeName = sanitizeFilename(body.filename);
  const key = `users/${currentUser.id}/${assetType}/${operationId ?? crypto.randomUUID()}-${safeName}`;

  const uploadUrl = await generateUploadUrl(key, contentType);

  return c.json({
    data: {
      uploadUrl,
      key,
    },
  });
});

// Release an abandoned transfer's concurrency slot. Keep its storage reservation
// until the signed PUT expires and cleanup removes the object; the URL may live
// longer than the client request. Hourly admission history is never refunded.
userAssetRoutes.post("/release-upload", async (c) => {
  const body = await c.req.json<{ requestId?: string; key?: string }>();
  if (!body.requestId || !validUploadRequestId(body.requestId) || typeof body.key !== "string") return c.json({ error: "Invalid request ID" }, 400);
  const userId = c.get("user").id;
  if (await sessionMedia.isReady()) await db.transaction(async tx => {
    await sessionMedia.lockOwner(tx, userId);
    await tx.execute(sql`UPDATE session_media_uploads SET metadata=metadata || '{"slotReleased":true}'::jsonb
      WHERE user_id=${userId} AND session_id IS NULL AND metadata->>'purpose'='creative-asset'
        AND metadata->>'operationId'=${uploadOperationId(userId, "file", body.requestId!)} AND temp_key=${body.key!} AND status='pending'`);
  });
  return c.json({ data: { released: true } });
});

// POST /api/user-assets — register asset after upload
userAssetRoutes.post("/", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json<{
    key: string;
    filename: string;
    type: string;
    mimeType?: string;
    sizeBytes: number;
    folderId?: string | null;
    folderName?: string;
    requestId?: string;
  }>();

  if (!validUploadRequestId(body.requestId)) return c.json({ error: "Invalid request ID" }, 400);

  if (!body.key || !body.filename || !body.type) {
    return c.json({ error: "key, filename, and type are required" }, 400);
  }

  if (!isAssetType(body.type)) {
    return c.json({ error: "Invalid asset type" }, 400);
  }

  const privatePipeline = storageKind() === "s3" && await sessionMedia.isReady();
  if (!(privatePipeline ? body.key.startsWith(`${mediaPrefix(currentUser.id)}pending/`) : body.key.startsWith(`users/${currentUser.id}/`))) {
    return c.json({ error: "Invalid asset key" }, 400);
  }

  const mimeType = normalizeAssetMimeType(body.filename, body.mimeType);
  const allowed = ALLOWED_MIME_TYPES[body.type];
  if (ACTIVE_CONTENT_TYPES.has(mimeType.toLowerCase()) || (allowed.length > 0 && !allowed.includes(mimeType))) {
    return c.json({ error: "This file type cannot be uploaded" }, 400);
  }
  const requestedFolderName = body.folderName?.trim();
  let folderName: string | undefined;
  if (requestedFolderName) {
    if (requestedFolderName.toLowerCase() !== OUTPUT_CHAT_FOLDER_NAME) {
      return c.json({ error: "Unsupported folder name" }, 400);
    }
    folderName = OUTPUT_CHAT_FOLDER_NAME;
  }
  let folderId: string | null;
  try {
    folderId = await resolveAssetFolderId(currentUser.id, body.folderId, folderName);
  } catch {
    return c.json({ error: "Folder not found" }, 404);
  }
  if (folderName && !folderId) {
    return c.json({ error: "Failed to create asset folder" }, 500);
  }

  const id = body.requestId ? uploadOperationId(currentUser.id, "file", body.requestId) : crypto.randomUUID();
  if (!privatePipeline && body.requestId && body.key !== `users/${currentUser.id}/${body.type}/${id}-${sanitizeFilename(body.filename)}`) {
    return c.json({ error: "Invalid asset key for request" }, 400);
  }
  const registeredKey = privatePipeline ? `users/${currentUser.id}/registered/${createHash("sha256").update(body.key).digest("hex")}` : body.key;
  const existingCondition = and(eq(userAssets.userId, currentUser.id), body.requestId ? eq(userAssets.id, id) : eq(userAssets.url, registeredKey));
  // A committed upload remains retryable after its temporary object is cleaned.
  const [reconciled] = await db.select().from(userAssets).where(existingCondition).limit(1);
  if (reconciled) {
    return c.json({ data: { ...reconciled, url: `${getCdnOrigin()}/cdn/${reconciled.id}`, key: reconciled.url } }, 201);
  }

  const inspected = await headObject(body.key);
  if ((privatePipeline && !inspected.etag) || inspected.contentLength < 1 || inspected.contentLength > 2_147_483_647) {
    return c.json({ error: "Invalid uploaded object" }, 400);
  }
  if (normalizeAssetMimeType(body.filename, inspected.contentType) !== mimeType) {
    return c.json({ error: "Uploaded content type does not match" }, 400);
  }
  const storageLimit = await getUserStorageLimit(currentUser.id);
  const settled = await db.transaction(async (tx) => {
    await sessionMedia.lockOwner(tx, currentUser.id);
    const [existing] = await tx.select().from(userAssets).where(existingCondition).limit(1);
    if (existing) return { asset: existing, inserted: false };
    const [reservation] = privatePipeline ? await mediaRows<{id:string;input_bytes:string;metadata:{purpose?:string;type?:string;operationId?:string};status:string;content_type:string;filename:string}>(tx,sql`SELECT * FROM session_media_uploads WHERE user_id=${currentUser.id} AND temp_key=${body.key} AND expires_at>now() FOR UPDATE`) : [];
    if (privatePipeline && (!reservation || reservation.status !== 'pending' || reservation.metadata.purpose !== 'creative-asset' || reservation.metadata.type !== body.type || reservation.metadata.operationId !== (body.requestId ? id : undefined) || reservation.filename !== body.filename || reservation.content_type !== mimeType || Number(reservation.input_bytes) !== inspected.contentLength)) {
      return { error: "Upload reservation expired or does not match", status: 409 as const };
    }
    const usage = await sessionMedia.usage(currentUser.id, tx);
    if (usage.used + usage.reserved - Number(reservation?.input_bytes ?? 0) + inspected.contentLength > storageLimit) {
      return { error: "Storage limit reached", status: 413 as const };
    }
    if (!privatePipeline) {
      // Local/legacy uploads settle actual HEAD bytes. They do not depend on
      // private S3 staging, but still share the creative admission budget.
      const admission = await admitCreativeUpload(tx, currentUser.id, "file", body.requestId ? id : body.key, inspected.contentLength, storageLimit);
      if (admission !== "admitted") return { error: "Upload limit reached", status: admission === "limit" ? 429 as const : 409 as const };
    }
    // The verified copy is immutable to callers holding the original PUT URL.
    if (privatePipeline) {
      await copyObject(body.key, registeredKey, inspected.etag!, inspected);
    }
    const [inserted] = await tx.insert(userAssets).values({
      id, userId: currentUser.id, type: body.type as AssetType, filename: body.filename,
      url: registeredKey, sizeBytes: inspected.contentLength, mimeType, folderId,
    }).returning();
    if (reservation) await tx.execute(sql`UPDATE session_media_uploads SET status='complete',reserved_bytes=0 WHERE id=${reservation.id}`);
    await tx.execute(sql`UPDATE creative_upload_admissions SET completed_at=clock_timestamp()
      WHERE user_id=${currentUser.id} AND source_kind='file' AND operation_id=${body.requestId ? id : reservation?.id ?? body.key}`);
    return { asset: inserted!, inserted: true };
  });
  if ("error" in settled) return c.json({ error: settled.error }, settled.status);
  const result = settled.asset;

  // Cap oversized image masters in place — new uploads only, same URL + format,
  // transparency preserved. Fire-and-forget: never blocks the upload response.
  if (settled.inserted && body.type === "image") {
    resizeUploadedImageInBackground(result!.url, mimeType, result!.id);
  }

  const origin = getCdnOrigin();

  return c.json(
    {
      data: {
        ...result!,
        url: `${origin}/cdn/${result!.id}`,
        key: result!.url, // raw S3 key for persistent storage references
      },
    },
    201
  );
});

// GET /api/user-assets — list user's assets
userAssetRoutes.get("/", async (c) => {
  const currentUser = c.get("user");
  await backfillOutputChatAssetsForUser(currentUser.id);

  const typeFilter = c.req.query("type");
  const folderId = c.req.query("folderId");
  const search = c.req.query("search");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "100") || 100, 1), 500);
  const offset = Math.max(parseInt(c.req.query("offset") || "0") || 0, 0);

  const conditions = userAssetFilters(currentUser.id, {
    type: isAssetType(typeFilter) ? typeFilter : undefined, folderId, search, recursive: c.req.query("recursive") === "true",
  });

  const rows = await db
    .select()
    .from(userAssets)
    .where(and(...conditions))
    .orderBy(c.req.query("sort") === "newest" ? desc(userAssets.createdAt) : userAssets.createdAt, userAssets.id)
    .limit(limit)
    .offset(offset);

  // Use CDN URLs instead of presigned S3 URLs — eliminates N signing calls
  const origin = getCdnOrigin();
  const withUrls = rows.map((row) => ({
    ...row,
    url: `${origin}/cdn/${row.id}`,
  }));

  // Private session images and creative assets share the account storage cap.
  const totalUsed = (await sessionMedia.usage(currentUser.id)).used;
  const [matchingCount] = await db.select({ total: sql<number>`count(*)::int` })
    .from(userAssets).where(and(...conditions));
  const total = matchingCount?.total ?? 0;

  return c.json({
    data: withUrls,
    storage: { used: totalUsed, limit: await getUserStorageLimit(currentUser.id) },
    total,
    limit,
    offset,
  });
});

// GET /api/user-assets/:id — get a single asset owned by the user
userAssetRoutes.get("/:id", async (c) => {
  const currentUser = c.get("user");
  const assetId = c.req.param("id");
  await backfillOutputChatAssetsForUser(currentUser.id);

  const rows = await db
    .select()
    .from(userAssets)
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, currentUser.id)))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Asset not found" }, 404);
  }

  const origin = getCdnOrigin();

  return c.json({
    data: {
      ...rows[0]!,
      url: `${origin}/cdn/${rows[0]!.id}`,
    },
  });
});

// GET /api/user-assets/:id/url — presigned download URL for a single asset
userAssetRoutes.get("/:id/url", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const assetId = c.req.param("id");

  const rows = await db
    .select()
    .from(userAssets)
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Asset not found" }, 404);
  }

  return c.json({ data: { url: `/cdn/${assetId}` } });
});

// PATCH /api/user-assets/:id/rename — rename asset
userAssetRoutes.patch("/:id/rename", async (c) => {
  const currentUser = c.get("user");
  const assetId = c.req.param("id");
  const body = await c.req.json<{ filename: string }>();

  const filename = body.filename?.trim();
  if (!filename) {
    return c.json({ error: "filename is required" }, 400);
  }

  const result = await db
    .update(userAssets)
    .set({ filename })
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, currentUser.id)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Asset not found" }, 404);
  }

  return c.json({ data: result[0] });
});

// PATCH /api/user-assets/:id/move — move asset to folder
userAssetRoutes.patch("/:id/move", async (c) => {
  const currentUser = c.get("user");
  const assetId = c.req.param("id");
  const body = await c.req.json<{ folderId: string | null }>();
  let folderId: string | null;
  try {
    folderId = await resolveAssetFolderId(currentUser.id, body.folderId);
  } catch {
    return c.json({ error: "Folder not found" }, 404);
  }

  const result = await db
    .update(userAssets)
    .set({ folderId })
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, currentUser.id)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Asset not found" }, 404);
  }

  return c.json({ data: result[0] });
});

// POST /api/user-assets/:id/publish — toggle isPublic
userAssetRoutes.post("/:id/publish", async (c) => {
  const currentUser = c.get("user");
  const assetId = c.req.param("id");

  const rows = await db
    .select()
    .from(userAssets)
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Asset not found or not authorized" }, 404);
  }

  const asset = rows[0]!;

  const [updated] = await db
    .update(userAssets)
    .set({ isPublic: !asset.isPublic })
    .where(eq(userAssets.id, assetId))
    .returning();

  return c.json({ data: updated });
});

// DELETE /api/user-assets/:id — delete asset from DB + S3
userAssetRoutes.delete("/:id", async (c) => {
  const currentUser = c.get("user");
  const assetId = c.req.param("id");

  const rows = await db
    .select()
    .from(userAssets)
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Asset not found" }, 404);
  }

  // Delete from S3
  if (isS3Configured()) {
    try {
      await deleteObject(rows[0]!.url);
    } catch { /* S3 delete failed — still remove DB record */ }
  }

  // assetReferences cascade on userAssets delete
  await db.transaction(async tx => {
    await detachGenerationAsset(tx, currentUser.id, assetId);
    await tx.delete(userAssets).where(eq(userAssets.id, assetId));
  });

  return c.json({ data: { deleted: true } });
});

export { userAssetRoutes };
