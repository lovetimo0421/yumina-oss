import { Hono, type MiddlewareHandler } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/index.js";
import { userLibrary, worlds } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";

const selectionSchema = z.object({
  worldIds: z.array(z.string().min(1).max(128)).min(1).max(1000)
    .refine((ids) => new Set(ids).size === ids.length),
});

const variantColumns = {
  id: worlds.id,
  creatorId: worlds.creatorId,
  name: worlds.name,
  language: worlds.language,
  languageGroupId: worlds.languageGroupId,
  variantLabel: worlds.variantLabel,
  status: worlds.status,
};

interface UnpublishEffects {
  flagWrite: (userId: string) => void;
  notify: (userIds: string[], payload: {
    worldId: string;
    worldName: string;
    thumbnailUrl: string | null;
    creatorUserId: string;
  }, actorUserId: string) => Promise<void>;
}

/** Explicit IDs preserve the scope the author reviewed, even if new siblings appear. */
export function createWorldUnpublishRoutes(
  database: Database,
  auth: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
  effects: UnpublishEffects,
) {
  const routes = new Hono<AppEnv>();

  routes.get("/:id/unpublish", auth, async (c) => {
    const creatorId = c.get("user").id;
    // Publication controls read primary: stale replica data must not widen the selection.
    const [anchor] = await database.select(variantColumns).from(worlds)
      .where(and(eq(worlds.id, c.req.param("id")), eq(worlds.creatorId, creatorId)));
    if (!anchor) return c.json({ error: "World not found" }, 404);
    const variants = anchor.languageGroupId
      ? await database.select(variantColumns).from(worlds)
        .where(and(eq(worlds.languageGroupId, anchor.languageGroupId), eq(worlds.creatorId, creatorId)))
        .orderBy(worlds.createdAt, worlds.id)
      : [anchor];
    return c.json({ data: variants });
  });

  routes.post("/:id/unpublish", auth, rateLimit, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const input = selectionSchema.safeParse(body);
    if (!input.success) return c.json({ error: "Select valid, distinct variants" }, 400);
    const creatorId = c.get("user").id;
    const anchorId = c.req.param("id");
    const { worldIds } = input.data;

    const result = await database.transaction(async (tx) => {
      // Lock the anchor and every selected row in a consistent order. Validation
      // and mutation share the locks, so any stale selection fails as a whole.
      const locked = await tx.select({ ...variantColumns, thumbnailUrl: worlds.thumbnailUrl }).from(worlds)
        .where(inArray(worlds.id, [...new Set([anchorId, ...worldIds])]))
        .orderBy(worlds.id).for("update");
      const anchor = locked.find((row) => row.id === anchorId && row.creatorId === creatorId);
      if (!anchor) return { error: "World not found", status: 404 } as const;
      const selected = worldIds.map((id) => locked.find((row) => row.id === id));
      if (selected.some((row) => !row || row.creatorId !== creatorId ||
        (row.id !== anchor.id && (!anchor.languageGroupId || row.languageGroupId !== anchor.languageGroupId)))) {
        return { error: "Variant not found", status: 404 } as const;
      }
      if (selected.some((row) => row!.status !== "published")) {
        return { error: "Variant status changed", status: 409 } as const;
      }
      await tx.update(worlds)
        .set({ status: "unpublished", isPublished: false, updatedAt: new Date() })
        .where(and(inArray(worlds.id, worldIds), eq(worlds.creatorId, creatorId), eq(worlds.status, "published")));
      const updated = selected.map((row) => ({ id: row!.id, name: row!.name, thumbnailUrl: row!.thumbnailUrl }));
      const readers = await tx.select({ worldId: userLibrary.worldId, userId: userLibrary.userId })
        .from(userLibrary).where(inArray(userLibrary.worldId, worldIds));
      return { updated, readers } as const;
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);

    effects.flagWrite(creatorId);
    for (const userId of new Set(result.readers.map((reader) => reader.userId))) effects.flagWrite(userId);
    // A notification outage must not report failure after the changes committed.
    await Promise.all(result.updated.map(async (world) => {
      const recipients = result.readers.filter((reader) => reader.worldId === world.id).map((reader) => reader.userId);
      if (!recipients.length) return;
      try {
        await effects.notify(recipients, {
          worldId: world.id, worldName: world.name, thumbnailUrl: world.thumbnailUrl, creatorUserId: creatorId,
        }, creatorId);
      } catch (error) {
        console.error("[world-unpublish] Notification failed", world.id, error);
      }
    }));
    return c.json({ data: { worldIds: result.updated.map((world) => world.id) } });
  });

  return routes;
}
