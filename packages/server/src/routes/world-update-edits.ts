import { Hono, type MiddlewareHandler } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { worldUpdates, worlds } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";
import { parseWorldUpdateNoteBody } from "../lib/world-update-note.js";

export function createWorldUpdateEditRoutes(
  database: Database,
  auth: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  const routes = new Hono<AppEnv>();

  routes.patch("/:id/updates/:updateId", auth, rateLimit, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const input = body as Record<string, unknown> | null;
    const parsed = parseWorldUpdateNoteBody(
      input && typeof input === "object" && !Array.isArray(input)
        ? { title: input.title, content: input.content }
        : input,
    );
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const currentUser = c.get("user");
    const worldId = c.req.param("id");
    const updateId = c.req.param("updateId");
    const { title, content } = parsed.data;
    const [update] = await database
      .update(worldUpdates)
      .set({ title, content })
      .where(and(
        eq(worldUpdates.id, updateId),
        eq(worldUpdates.worldId, worldId),
        sql`EXISTS (
          SELECT 1 FROM ${worlds}
          WHERE ${worlds.id} = ${worldUpdates.worldId}
            AND ${worlds.creatorId} = ${currentUser.id}
        )`,
      ))
      .returning();
    if (!update) return c.json({ error: "Update not found" }, 404);

    // A correction keeps the original publication time and importance. It
    // must not publish another update, bump the world, or notify readers.
    return c.json({ data: { ...update, creatorName: currentUser.name } });
  });

  return routes;
}
