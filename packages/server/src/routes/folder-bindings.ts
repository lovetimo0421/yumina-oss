import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { worldFolderBindings, assetFolders } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import { summarizeAssetFolderTrees } from "../lib/asset-folder-tree.js";
import { canEdit, getWorldAccess } from "../lib/world-collaborators.js";

const folderBindingRoutes = new Hono<AppEnv>();

folderBindingRoutes.use("/*", authMiddleware);

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * The world side: "edit" is the creator or an editor collaborator, "read" also
 * lets viewers in. The folder side (verifyFolderOwnership) stays the caller's
 * own: a collaborator binds folders from their own library.
 */
async function verifyWorldAccess(worldId: string, userId: string, need: "edit" | "read" = "edit") {
  const access = await getWorldAccess(userId, worldId);
  return need === "read" ? access !== null : canEdit(access);
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

  // Reading the bindings is part of opening the card in Studio, and admins
  // open cards they did not create (moderation, hand-offs to other accounts).
  // Binding and unbinding below need edit access (creator or editor).
  if (currentUser.role !== "admin" && !(await verifyWorldAccess(worldId, currentUser.id, "read"))) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  const bound = await db
    .select({
      id: assetFolders.id,
      userId: assetFolders.userId,
      name: assetFolders.name,
      parentFolderId: assetFolders.parentFolderId,
      createdAt: assetFolders.createdAt,
    })
    .from(worldFolderBindings)
    .innerJoin(assetFolders, eq(worldFolderBindings.folderId, assetFolders.id))
    .where(eq(worldFolderBindings.worldId, worldId))
    .orderBy(assetFolders.name);

  // A bound folder includes its descendants (also how Studio's asset catalog
  // scopes it). Archive imports may put every file below a child folder.
  // Collaborators bind folders from their own libraries, so the tree is
  // summarized per folder owner.
  const foldersByOwner = new Map<string, string[]>();
  for (const f of bound) foldersByOwner.set(f.userId, [...(foldersByOwner.get(f.userId) ?? []), f.id]);
  const summaries = await Promise.all([...foldersByOwner].map(([ownerId, ids]) => summarizeAssetFolderTrees(db, ownerId, ids)));
  const counts = summaries.flatMap((s) => s.counts);
  const previewRows = summaries.flatMap((s) => s.previews);

  const countByFolder = new Map(counts.map((r) => [r.folderId, r.count]));
  const previewsByFolder = new Map<string, string[]>();
  for (const row of previewRows) {
    if (!row.folder_id) continue;
    const list = previewsByFolder.get(row.folder_id) ?? [];
    list.push(row.id);
    previewsByFolder.set(row.folder_id, list);
  }

  const data = bound.map(({ userId: _owner, ...f }) => ({
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

  if (!(await verifyWorldAccess(worldId, currentUser.id))) {
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

  // Unbinding takes the folder away from everyone on the card: the card's
  // creator may, and so may whoever's folder it is (anyone still on the card).
  const access = await getWorldAccess(currentUser.id, worldId);
  if (!access) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }
  if (access.role !== "owner" && !(await verifyFolderOwnership(folderId, currentUser.id))) {
    return c.json({ error: "Only the card's creator or the folder's owner can unbind it", code: "NOT_FOLDER_OWNER" }, 403);
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
