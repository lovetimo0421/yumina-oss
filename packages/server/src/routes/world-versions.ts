import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { MAX_AUTO_VERSIONS_PER_WORLD, MAX_VERSIONS_PER_WORLD, MAX_VERSION_NAME_LENGTH, MAX_VERSION_NOTE_LENGTH } from "@yumina/shared";
import { db, flagWrite } from "../db/index.js";
import { worlds, worldVersions, worldPendingEdits } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import type { AppEnv } from "../lib/types.js";
import { embedAndStoreWorld } from "../lib/embeddings.js";
import { versionAssetRefs } from "../lib/world-version-asset-refs.js";
import { redactSchemaFor } from "../lib/sealed-entries.js";
import {
  lockEditableVersionWorld, lockVersionDraft, restoreVersionDraft, makeVersionLive,
  VersionActionError, versionMatchesLiveSql,
} from "../lib/world-version-history.js";
import { canOpenWorldSql } from "../lib/world-collaborators.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { publishWorldEvent } from "../lib/world-events.js";
import { injectServerTextWrite } from "../lib/collab-text.js";

export const worldVersionRoutes = new Hono<AppEnv>();

// Reading history is open to everyone on the card (owner, editors, viewers).
worldVersionRoutes.get("/:id/versions", authMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const userId = c.get("user").id;
  const [world] = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), canOpenWorldSql(userId)));
  if (!world) return c.json({ error: "World not found" }, 404);
  const items = await db.select({
    id: worldVersions.id, worldId: worldVersions.worldId, createdBy: worldVersions.createdBy, actorId: worldVersions.actorId,
    // A collaborator's name, when one of them (not the creator) made it.
    actorName: sql<string | null>`(SELECT u.name FROM "user" u WHERE u.id = ${worldVersions.actorId})`,
    actorImage: sql<string | null>`(SELECT u.image FROM "user" u WHERE u.id = ${worldVersions.actorId})`,
    // Everything else is the creator's: collaborators see whose it is.
    creatorName: sql<string | null>`(SELECT u.name FROM "user" u WHERE u.id = ${worlds.creatorId})`,
    creatorImage: sql<string | null>`(SELECT u.image FROM "user" u WHERE u.id = ${worlds.creatorId})`,
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
  const data = items.map((v) => ({ ...v, actorImage: resolveImageCdn(v.actorImage), creatorImage: resolveImageCdn(v.creatorImage) }));
  return c.json({ data, cap: MAX_VERSIONS_PER_WORLD, automaticCap: MAX_AUTO_VERSIONS_PER_WORLD });
});

worldVersionRoutes.get("/:id/versions/:versionId", authMiddleware, async (c) => {
  const [result] = await db.select({ version: worldVersions }).from(worldVersions)
    .innerJoin(worlds, eq(worlds.id, worldVersions.worldId))
    .where(and(eq(worlds.id, c.req.param("id")), canOpenWorldSql(c.get("user").id), eq(worldVersions.id, c.req.param("versionId"))));
  if (!result) return c.json({ error: "Version not found" }, 404);
  const viewer = c.get("user").id;
  const version = result.version as typeof result.version & { schema?: unknown };
  return c.json({ data: "schema" in version
    ? { ...version, schema: redactSchemaFor({ id: c.req.param("id"), creatorId: viewer, schema: version.schema }, version.schema, viewer, "edit") }
    : version });
});

worldVersionRoutes.post("/:id/versions", authMiddleware, async (c) => {
  const worldId = c.req.param("id");
  const userId = c.get("user").id;
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_VERSION_NAME_LENGTH) : "";
  if (!name) return c.json({ error: "Name required" }, 400);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_VERSION_NOTE_LENGTH) || null : null;
  const result = await db.transaction(async (tx) => {
    const locked = await lockEditableVersionWorld(tx, worldId, userId);
    if (!locked) return { kind: "notFound" as const };
    const { world, access } = locked;
    const existing = await tx.select({ id: worldVersions.id, name: worldVersions.name, createdAt: worldVersions.createdAt, actorId: worldVersions.actorId })
      .from(worldVersions).where(and(eq(worldVersions.worldId, worldId), eq(worldVersions.source, "manual")))
      .orderBy(desc(worldVersions.createdAt), desc(worldVersions.id));
    if (existing.length >= MAX_VERSIONS_PER_WORLD) {
      const evicted = existing.slice(MAX_VERSIONS_PER_WORLD - 1);
      // A collaborator can't make room by dropping someone else's named save.
      const mayEvict = access.role === "owner" || evicted.every((row) => row.actorId === userId);
      if (body.evictOldest !== true || !mayEvict) {
        const { actorId: _actor, ...oldest } = existing[existing.length - 1]!;
        return { kind: "atCap" as const, oldest, canEvict: mayEvict };
      }
      for (const row of evicted) {
        await tx.delete(worldVersions).where(eq(worldVersions.id, row.id));
      }
    }
    const draft = world.status === "published" ? await lockVersionDraft(tx, worldId) : null;
    const material = draft ?? world;
    const schema = { ...material.schema, name: world.name };
    const [inserted] = await tx.insert(worldVersions).values({
      // The card's history stays the creator's; a collaborator is the actor.
      worldId, createdBy: world.creatorId, actorId: userId === world.creatorId ? null : userId,
      name, note, source: "manual",
      schema, thumbnailUrl: material.thumbnailUrl, ageRating: material.ageRating ?? "all", ...versionAssetRefs(schema),
    }).returning();
    if (!inserted) throw new Error("Version could not be saved");
    const { schema: _schema, assetIds: _assetIds, assetPaths: _assetPaths, ...metadata } = inserted;
    return { kind: "ok" as const, version: metadata };
  });
  if (result.kind === "notFound") return c.json({ error: "World not found" }, 404);
  if (result.kind === "atCap") return c.json({ error: "Version cap reached", cap: MAX_VERSIONS_PER_WORLD, oldest: result.oldest, canEvict: result.canEvict }, 409);
  flagWrite(userId);
  return c.json({ data: result.version }, 201);
});

worldVersionRoutes.post("/:id/versions/:versionId/restore", authMiddleware, async (c) => {
  const userId = c.get("user").id;
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  try {
    const worldId = c.req.param("id");
    const { live, ...result } = await db.transaction((tx) => restoreVersionDraft(tx, {
      worldId, versionId: c.req.param("versionId"), userId,
      skipSafetySnapshot: body.skipSafetySnapshot === true,
    }));
    flagWrite(userId);
    // Everyone else with the card open moves to the restored copy now,
    // instead of carrying on with (and saving over it from) the old one.
    publishWorldEvent(worldId, {
      kind: "saved", updatedAt: live.updatedAt.toISOString(), previousUpdatedAt: live.previousUpdatedAt?.toISOString() ?? null,
      clientId: null, actorUserId: userId,
    });
    void injectServerTextWrite(worldId, live.before, live.after, { actorUserId: userId }).catch(() => {});
    return c.json({ data: { ...result, updatedAt: live.updatedAt.toISOString(), previousUpdatedAt: live.previousUpdatedAt?.toISOString() ?? null } });
  } catch (error) {
    if (error instanceof VersionActionError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

// Owner-only: switching what players see is a public write (makeVersionLive
// locks by creatorId, so a collaborator gets 404).
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
        announcement: w.announcement, schema: w.schema }).catch(() => {});
    }
    return c.json({ data: { live: true, changed: result.changed } });
  } catch (error) {
    if (error instanceof VersionActionError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

worldVersionRoutes.delete("/:id/versions/:versionId", authMiddleware, async (c) => {
  const userId = c.get("user").id;
  const result = await db.transaction(async (tx) => {
    const locked = await lockEditableVersionWorld(tx, c.req.param("id"), userId);
    if (!locked) return [];
    const { world, access } = locked;
    // Automatic history is managed by its own retention policy. Named saves are
    // the only user-deletable records, so a live revision cannot be erased here.
    // A collaborator deletes only the named saves they made themselves.
    return tx.delete(worldVersions).where(and(
      eq(worldVersions.worldId, world.id), eq(worldVersions.id, c.req.param("versionId")), eq(worldVersions.source, "manual"),
      access.role === "owner" ? undefined : eq(worldVersions.actorId, userId),
    )).returning();
  });
  if (!result.length) return c.json({ error: "Named version not found" }, 404);
  flagWrite(userId);
  return c.json({ data: { deleted: true } });
});
