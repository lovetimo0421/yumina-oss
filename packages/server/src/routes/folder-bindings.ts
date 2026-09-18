import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { worldFolderBindings, assetFolders, userAssets, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";

const folderBindingRoutes = new Hono<AppEnv>();

folderBindingRoutes.use("/*", authMiddleware);

// ─── Helpers ────────────────────────────────────────────────────────

async function verifyWorldOwnership(worldId: string, userId: string) {
  const rows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)));
  return rows.length > 0;
}

async function verifyFolderOwnership(folderId: string, userId: string) {
  const rows = await db
    .select({ id: assetFolders.id })
    .from(assetFolders)
    .where(and(eq(assetFolders.id, folderId), eq(assetFolders.userId, userId)));
  return rows.length > 0;
}

// ─── Routes ─────────────────────────────────────────────────────────

// GET /api/worlds/:worldId/folder-bindings — folders bound to this world,
// each with an asset count and up to 4 image preview asset ids.
folderBindingRoutes.get("/worlds/:worldId/folder-bindings", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const bound = await db
    .select({
      id: assetFolders.id,
      name: assetFolders.name,
      parentFolderId: assetFolders.parentFolderId,
      createdAt: assetFolders.createdAt,
    })
    .from(worldFolderBindings)
    .innerJoin(assetFolders, eq(worldFolderBindings.folderId, assetFolders.id))
    .where(eq(worldFolderBindings.worldId, worldId))
    .orderBy(assetFolders.name);

  const folderIds = bound.map((f) => f.id);

  // Per-folder counts + a few image previews, only for the bound folders.
  const counts = folderIds.length
    ? await db
        .select({
          folderId: userAssets.folderId,
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(userAssets)
        .where(
          and(eq(userAssets.userId, currentUser.id), inArray(userAssets.folderId, folderIds)),
        )
        .groupBy(userAssets.folderId)
    : [];

  // Up to 4 image previews per folder, capped in SQL via a window function so we
  // never pull a whole (potentially huge) folder back just to slice off 4.
  const previewResult = folderIds.length
    ? await db.execute(sql`
        SELECT id, folder_id FROM (
          SELECT id, folder_id,
                 row_number() OVER (PARTITION BY folder_id ORDER BY created_at) AS rn
          FROM user_assets
          WHERE user_id = ${currentUser.id}
            AND type = 'image'
            AND folder_id IN (${sql.join(folderIds.map((id) => sql`${id}`), sql`, `)})
        ) ranked
        WHERE rn <= 4
      `)
    : { rows: [] as Record<string, unknown>[] };
  const previewRows = previewResult.rows as { id: string; folder_id: string }[];

  const countByFolder = new Map(counts.map((r) => [r.folderId, r.count]));
  const previewsByFolder = new Map<string, string[]>();
  for (const row of previewRows) {
    if (!row.folder_id) continue;
    const list = previewsByFolder.get(row.folder_id) ?? [];
    list.push(row.id);
    previewsByFolder.set(row.folder_id, list);
  }

  const data = bound.map((f) => ({
    ...f,
    assetCount: countByFolder.get(f.id) ?? 0,
    previewAssetIds: previewsByFolder.get(f.id) ?? [],
  }));

  return c.json({ data });
});

// POST /api/worlds/:worldId/folder-bindings — bind a folder { folderId }
folderBindingRoutes.post("/worlds/:worldId/folder-bindings", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ folderId: string }>().catch(() => ({ folderId: "" }));

  if (!body.folderId) {
    return c.json({ error: "folderId is required" }, 400);
  }

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  if (!(await verifyFolderOwnership(body.folderId, currentUser.id))) {
    return c.json({ error: "Folder not found or not authorized" }, 404);
  }

  const existing = await db
    .select({ id: worldFolderBindings.id })
    .from(worldFolderBindings)
    .where(
      and(
        eq(worldFolderBindings.worldId, worldId),
        eq(worldFolderBindings.folderId, body.folderId),
      ),
    );

  if (existing.length > 0) {
    return c.json({ data: existing[0] });
  }

  const [result] = await db
    .insert(worldFolderBindings)
    .values({ worldId, folderId: body.folderId })
    .onConflictDoNothing()
    .returning();

  return c.json({ data: result ?? { worldId, folderId: body.folderId } }, 201);
});

// DELETE /api/worlds/:worldId/folder-bindings/:folderId — unbind
folderBindingRoutes.delete("/worlds/:worldId/folder-bindings/:folderId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const folderId = c.req.param("folderId");

  if (!(await verifyWorldOwnership(worldId, currentUser.id))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  await db
    .delete(worldFolderBindings)
    .where(
      and(
        eq(worldFolderBindings.worldId, worldId),
        eq(worldFolderBindings.folderId, folderId),
      ),
    );

  return c.json({ data: { deleted: true } });
});

export { folderBindingRoutes };
