import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { MAX_AUTO_VERSIONS_PER_WORLD, MAX_VERSIONS_PER_WORLD, MAX_VERSION_NAME_LENGTH, MAX_VERSION_NOTE_LENGTH } from "@yumina/shared";
import { db, flagWrite } from "../db/index.js";
import { worlds, worldVersions, worldPendingEdits } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import type { AppEnv } from "../lib/types.js";
import { embedAndStoreWorld } from "../lib/embeddings.js";
import {
  lockVersionWorld, lockVersionDraft, restoreVersionDraft, makeVersionLive,
  VersionActionError, versionMatchesLiveSql,
} from "../lib/world-version-history.js";

export const worldVersionRoutes = new Hono<AppEnv>();

worldVersionRoutes.get("/:id/versions", authMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const creatorId = c.get("user").id;
  const [world] = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, creatorId)));
  if (!world) return c.json({ error: "World not found" }, 404);
  const items = await db.select({
    id: worldVersions.id, worldId: worldVersions.worldId, createdBy: worldVersions.createdBy,
    publishedAt: worldVersions.publishedAt,
    name: worldVersions.name, note: worldVersions.note, createdAt: worldVersions.createdAt, source: worldVersions.source,
    isLive: versionMatchesLiveSql(),
    canMakeLive: sql<boolean>`(${worldVersions.source} = 'live' AND ${worlds.status} = 'published'
      AND ${worlds.isPublished} = true AND COALESCE(${worldPendingEdits.status}, '') <> 'pending'
      AND (${worlds.reviewedAt} IS NULL OR COALESCE(${worldVersions.publishedAt}, ${worldVersions.createdAt}) >= ${worlds.reviewedAt}))`,
  }).from(worldVersions).innerJoin(worlds, eq(worlds.id, worldVersions.worldId))
    .leftJoin(worldPendingEdits, eq(worldPendingEdits.worldId, worlds.id))
    .where(eq(worldVersions.worldId, worldId)).orderBy(desc(worldVersions.createdAt), desc(worldVersions.id));
  c.header("Cache-Control", "no-store");
  return c.json({ data: items, cap: MAX_VERSIONS_PER_WORLD, automaticCap: MAX_AUTO_VERSIONS_PER_WORLD });
});

worldVersionRoutes.get("/:id/versions/:versionId", authMiddleware, async (c) => {
  const [result] = await db.select({ version: worldVersions }).from(worldVersions)
    .innerJoin(worlds, eq(worlds.id, worldVersions.worldId))
    .where(and(eq(worlds.id, c.req.param("id")), eq(worlds.creatorId, c.get("user").id), eq(worldVersions.id, c.req.param("versionId"))));
  if (!result) return c.json({ error: "Version not found" }, 404);
  return c.json({ data: result.version });
});

worldVersionRoutes.post("/:id/versions", authMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const creatorId = c.get("user").id;
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_VERSION_NAME_LENGTH) : "";
  if (!name) return c.json({ error: "Name required" }, 400);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_VERSION_NOTE_LENGTH) || null : null;
  const result = await db.transaction(async (tx) => {
    const world = await lockVersionWorld(tx, worldId, creatorId);
    if (!world) return { kind: "notFound" as const };
    const existing = await tx.select({ id: worldVersions.id, name: worldVersions.name, createdAt: worldVersions.createdAt })
      .from(worldVersions).where(and(eq(worldVersions.worldId, worldId), eq(worldVersions.source, "manual")))
      .orderBy(desc(worldVersions.createdAt), desc(worldVersions.id));
    if (existing.length >= MAX_VERSIONS_PER_WORLD) {
      if (body.evictOldest !== true) return { kind: "atCap" as const, oldest: existing[existing.length - 1]! };
      for (const row of existing.slice(MAX_VERSIONS_PER_WORLD - 1)) {
        await tx.delete(worldVersions).where(eq(worldVersions.id, row.id));
      }
    }
    const draft = world.status === "published" ? await lockVersionDraft(tx, worldId) : null;
    const material = draft ?? world;
    const [inserted] = await tx.insert(worldVersions).values({
      worldId, createdBy: creatorId, name, note, source: "manual",
      schema: { ...material.schema, name: world.name }, thumbnailUrl: material.thumbnailUrl, ageRating: material.ageRating ?? "all",
    }).returning();
    if (!inserted) throw new Error("Version could not be saved");
    const { schema: _schema, ...metadata } = inserted;
    return { kind: "ok" as const, version: metadata };
  });
  if (result.kind === "notFound") return c.json({ error: "World not found" }, 404);
  if (result.kind === "atCap") return c.json({ error: "Version cap reached", cap: MAX_VERSIONS_PER_WORLD, oldest: result.oldest }, 409);
  flagWrite(creatorId);
  return c.json({ data: result.version }, 201);
});

worldVersionRoutes.post("/:id/versions/:versionId/restore", authMiddleware, async (c) => {
  const creatorId = c.get("user").id;
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  try {
    const result = await db.transaction((tx) => restoreVersionDraft(tx, {
      worldId: c.req.param("id"), versionId: c.req.param("versionId"), creatorId,
      skipSafetySnapshot: body.skipSafetySnapshot === true,
    }));
    flagWrite(creatorId);
    return c.json({ data: result });
  } catch (error) {
    if (error instanceof VersionActionError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

worldVersionRoutes.post("/:id/versions/:versionId/make-live", authMiddleware, rateLimitMiddleware("publishing"), async (c) => {
  const creatorId = c.get("user").id;
  try {
    const result = await db.transaction((tx) => makeVersionLive(tx, {
      worldId: c.req.param("id"), versionId: c.req.param("versionId"), creatorId,
    }));
    flagWrite(creatorId);
    if (result.changed) {
      const w = result.world;
      void embedAndStoreWorld({ worldId: w.id, name: w.name, description: w.description, tags: w.tags,
        announcement: w.announcement, firstMessage: typeof w.schema.firstMessage === "string" ? w.schema.firstMessage : null }).catch(() => {});
    }
    return c.json({ data: { live: true, changed: result.changed } });
  } catch (error) {
    if (error instanceof VersionActionError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

worldVersionRoutes.delete("/:id/versions/:versionId", authMiddleware, async (c) => {
  const creatorId = c.get("user").id;
  const result = await db.transaction(async (tx) => {
    const world = await lockVersionWorld(tx, c.req.param("id"), creatorId);
    if (!world) return [];
    // Automatic history is managed by its own retention policy. Named saves are
    // the only user-deletable records, so a live revision cannot be erased here.
    return tx.delete(worldVersions).where(and(eq(worldVersions.worldId, world.id), eq(worldVersions.id, c.req.param("versionId")), eq(worldVersions.source, "manual"))).returning();
  });
  if (!result.length) return c.json({ error: "Named version not found" }, 404);
  flagWrite(creatorId);
  return c.json({ data: { deleted: true } });
});
