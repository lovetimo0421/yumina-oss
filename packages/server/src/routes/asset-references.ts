import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { assetReferences, userAssets } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import type { AppEnv } from "../lib/types.js";
import { canEdit, getWorldAccess } from "../lib/world-collaborators.js";

const assetRefRoutes = new Hono<AppEnv>();

assetRefRoutes.use("/*", authMiddleware);

// ─── Helper ─────────────────────────────────────────────────────────

/** "edit": the creator or an editor collaborator. "read": viewers too. */
async function verifyWorldAccess(worldId: string, userId: string, need: "edit" | "read" = "edit") {
  const access = await getWorldAccess(userId, worldId);
  return need === "read" ? access !== null : canEdit(access);
}

// ─── Routes ─────────────────────────────────────────────────────────

// POST /api/worlds/:worldId/asset-refs — link a user asset to a world
assetRefRoutes.post("/worlds/:worldId/asset-refs", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ assetId: string }>();

  if (!body.assetId) {
    return c.json({ error: "assetId is required" }, 400);
  }

  if (!(await verifyWorldAccess(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // The linked asset must still be the caller's own library item.
  const assetRows = await db
    .select()
    .from(userAssets)
    .where(and(eq(userAssets.id, body.assetId), eq(userAssets.userId, currentUser.id)));

  if (assetRows.length === 0) {
    return c.json({ error: "Asset not found" }, 404);
  }

  // Check if reference already exists
  const existing = await db
    .select()
    .from(assetReferences)
    .where(and(eq(assetReferences.worldId, worldId), eq(assetReferences.assetId, body.assetId)));

  if (existing.length > 0) {
    return c.json({ data: existing[0] });
  }

  const [result] = await db
    .insert(assetReferences)
    .values({ worldId, assetId: body.assetId })
    .returning();

  return c.json({ data: result }, 201);
});

// DELETE /api/worlds/:worldId/asset-refs/:assetId — unlink
assetRefRoutes.delete("/worlds/:worldId/asset-refs/:assetId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const assetId = c.req.param("assetId");

  if (!(await verifyWorldAccess(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  await db
    .delete(assetReferences)
    .where(and(eq(assetReferences.worldId, worldId), eq(assetReferences.assetId, assetId)));

  return c.json({ data: { deleted: true } });
});

// GET /api/worlds/:worldId/asset-refs — list world's referenced assets with presigned URLs
assetRefRoutes.get("/worlds/:worldId/asset-refs", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");

  if (!(await verifyWorldAccess(worldId, currentUser.id, "read"))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const rows = await db
    .select({
      refId: assetReferences.id,
      assetId: userAssets.id,
      type: userAssets.type,
      filename: userAssets.filename,
      url: userAssets.url,
      sizeBytes: userAssets.sizeBytes,
      mimeType: userAssets.mimeType,
      createdAt: userAssets.createdAt,
    })
    .from(assetReferences)
    .innerJoin(userAssets, eq(assetReferences.assetId, userAssets.id))
    .where(eq(assetReferences.worldId, worldId))
    .orderBy(userAssets.createdAt);

  const withUrls = rows.map((row) => ({
    ...row,
    url: resolveImageCdn(row.url) ?? row.url,
  }));

  return c.json({ data: withUrls });
});

export { assetRefRoutes };
