import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { userPresetOverrides } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";

const routes = new Hono<AppEnv>();

routes.use("/*", authMiddleware);

// GET / — list all preset overrides for current user
routes.get("/", async (c) => {
  const userId = c.get("user").id;
  const overrides = await db
    .select()
    .from(userPresetOverrides)
    .where(eq(userPresetOverrides.userId, userId));
  return c.json({ data: overrides });
});

// PUT /:presetId — upsert override (create or update by presetId)
routes.put("/:presetId", async (c) => {
  const userId = c.get("user").id;
  const presetId = c.req.param("presetId");
  const body = await c.req.json<{
    enabled?: boolean;
    content?: string | null;
    apiRole?: string | null;
  }>();

  // Check if override already exists
  const [existing] = await db
    .select()
    .from(userPresetOverrides)
    .where(
      and(
        eq(userPresetOverrides.userId, userId),
        eq(userPresetOverrides.presetId, presetId),
      )
    );

  if (existing) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if ("enabled" in body) updates.enabled = body.enabled;
    if ("content" in body) updates.content = body.content;
    if ("apiRole" in body) updates.apiRole = body.apiRole;

    const [updated] = await db
      .update(userPresetOverrides)
      .set(updates)
      .where(eq(userPresetOverrides.id, existing.id))
      .returning();
    return c.json({ data: updated });
  }

  const [created] = await db
    .insert(userPresetOverrides)
    .values({
      userId,
      presetId,
      enabled: body.enabled ?? true,
      content: body.content ?? null,
      apiRole: (body.apiRole ?? null) as "system" | "user" | "assistant" | null,
    })
    .returning();
  return c.json({ data: created }, 201);
});

// DELETE /:presetId — remove override (reset to default)
routes.delete("/:presetId", async (c) => {
  const userId = c.get("user").id;
  const presetId = c.req.param("presetId");

  const [deleted] = await db
    .delete(userPresetOverrides)
    .where(
      and(
        eq(userPresetOverrides.userId, userId),
        eq(userPresetOverrides.presetId, presetId),
      )
    )
    .returning();

  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ data: { ok: true } });
});

export { routes as userPresetOverridesRoutes };
