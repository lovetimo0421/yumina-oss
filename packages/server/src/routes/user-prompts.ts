import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { userPrompts, promptFolders } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";

const userPromptsRoutes = new Hono<AppEnv>();

userPromptsRoutes.use("/*", authMiddleware);

// GET /api/user-prompts — list all prompts + folders
userPromptsRoutes.get("/", async (c) => {
  const userId = c.get("user").id;

  const [prompts, folders] = await Promise.all([
    db.select().from(userPrompts).where(eq(userPrompts.userId, userId)),
    db.select().from(promptFolders).where(eq(promptFolders.userId, userId)),
  ]);

  // These are edited from multiple devices; no cache layer (browser, CF, an
  // in-between proxy) may ever answer for the origin.
  c.header("Cache-Control", "no-store");
  return c.json({ data: { prompts, folders } });
});

// POST /api/user-prompts — create prompt
userPromptsRoutes.post("/", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json<{
    name: string;
    content?: string;
    section?: string;
    depth?: number;
    position?: number | null;
    folderId?: string | null;
  }>();

  const [prompt] = await db
    .insert(userPrompts)
    .values({
      userId,
      name: body.name,
      content: body.content ?? "",
      section: (body.section ?? "system-presets") as typeof userPrompts.$inferInsert.section,
      depth: body.depth ?? null,
      position: body.position ?? null,
      folderId: body.folderId ?? null,
    })
    .returning();

  return c.json({ data: prompt }, 201);
});

// PATCH /api/user-prompts/:id — update prompt
userPromptsRoutes.patch("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>();

  // Optimistic concurrency for content edits across devices: the client sends
  // the updatedAt it loaded, and a mismatch means ANOTHER device edited this
  // prompt since — saving anyway would silently clobber the newer version
  // (the reported "syncs the modified version back to the old one"). 409
  // returns the current row so the client can show it. Compared in JS at
  // millisecond precision: node-postgres already truncates the column's
  // microseconds, and defaultNow() rows would otherwise never match their
  // JSON-serialized (ms) echo.
  if (typeof body.expectedUpdatedAt === "string") {
    const [current] = await db
      .select()
      .from(userPrompts)
      .where(and(eq(userPrompts.id, id), eq(userPrompts.userId, userId)))
      .limit(1);
    if (!current) return c.json({ error: "Not found" }, 404);
    const expected = new Date(body.expectedUpdatedAt).getTime();
    const actual = current.updatedAt ? current.updatedAt.getTime() : null;
    if (!Number.isNaN(expected) && actual !== null && expected !== actual) {
      return c.json({ error: "conflict", data: current }, 409);
    }
  }

  // Build update object from allowed fields
  const updates: Record<string, unknown> = {};
  if ("name" in body) updates.name = body.name;
  if ("content" in body) updates.content = body.content;
  if ("section" in body) updates.section = body.section;
  if ("enabled" in body) updates.enabled = body.enabled;
  if ("depth" in body) updates.depth = body.depth;
  if ("position" in body) updates.position = body.position;
  if ("folderId" in body) updates.folderId = body.folderId;
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(userPrompts)
    .set(updates)
    .where(and(eq(userPrompts.id, id), eq(userPrompts.userId, userId)))
    .returning();

  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ data: updated });
});

// DELETE /api/user-prompts/:id — delete prompt
userPromptsRoutes.delete("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");

  const [deleted] = await db
    .delete(userPrompts)
    .where(and(eq(userPrompts.id, id), eq(userPrompts.userId, userId)))
    .returning();

  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ data: { ok: true } });
});

// POST /api/user-prompts/folders — create folder
userPromptsRoutes.post("/folders", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json<{ name: string }>();

  const [folder] = await db
    .insert(promptFolders)
    .values({ userId, name: body.name })
    .returning();

  return c.json({ data: folder }, 201);
});

// PATCH /api/user-prompts/folders/:id — update folder
userPromptsRoutes.patch("/folders/:id", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; enabled?: boolean }>();

  const updates: Record<string, unknown> = {};
  if ("name" in body) updates.name = body.name;
  if ("enabled" in body) updates.enabled = body.enabled;

  const [updated] = await db
    .update(promptFolders)
    .set(updates)
    .where(and(eq(promptFolders.id, id), eq(promptFolders.userId, userId)))
    .returning();

  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ data: updated });
});

// DELETE /api/user-prompts/folders/:id — delete folder (prompts become folderless)
userPromptsRoutes.delete("/folders/:id", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");

  // Unlink prompts from this folder
  await db
    .update(userPrompts)
    .set({ folderId: null })
    .where(and(eq(userPrompts.folderId, id), eq(userPrompts.userId, userId)));

  const [deleted] = await db
    .delete(promptFolders)
    .where(and(eq(promptFolders.id, id), eq(promptFolders.userId, userId)))
    .returning();

  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ data: { ok: true } });
});

// GET /api/user-prompts/export — export all as JSON
userPromptsRoutes.get("/export", async (c) => {
  const userId = c.get("user").id;

  const [prompts, folders] = await Promise.all([
    db.select().from(userPrompts).where(eq(userPrompts.userId, userId)),
    db.select().from(promptFolders).where(eq(promptFolders.userId, userId)),
  ]);

  c.header("Cache-Control", "no-store");
  return c.json({
    version: "2.0.0",
    type: "yumina-user-prompts",
    folders: folders.map((f) => ({ name: f.name, enabled: f.enabled, id: f.id })),
    prompts: prompts.map((p) => ({
      name: p.name,
      content: p.content,
      section: p.section,
      enabled: p.enabled,
      depth: p.depth,
      position: p.position,
      folderId: p.folderId,
    })),
  });
});

// POST /api/user-prompts/import — import from JSON
userPromptsRoutes.post("/import", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json<{
    folders?: Array<{ name: string; enabled?: boolean; id?: string }>;
    prompts?: Array<{
      name: string;
      content: string;
      section?: string;
      position?: string | number;  // string = legacy section alias; number = ordering position
      enabled?: boolean;
      priority?: number;
      folderId?: string | null;
    }>;
  }>();

  // Create folder ID mapping (old ID → new ID)
  const folderMap = new Map<string, string>();

  if (body.folders) {
    for (const f of body.folders) {
      const [created] = await db
        .insert(promptFolders)
        .values({ userId, name: f.name, enabled: f.enabled !== false })
        .returning();
      if (created && f.id) folderMap.set(f.id, created.id);
    }
  }

  let imported = 0;
  if (body.prompts) {
    for (const p of body.prompts) {
      const mappedFolderId = p.folderId ? folderMap.get(p.folderId) ?? null : null;
      // Support both new `section` and legacy `position` fields
      let section: "system-presets" | "chat-history" | "post-history" = "system-presets";
      let numericPosition: number | null = null;
      if (p.section === "chat-history" || p.section === "post-history") {
        section = p.section;
      } else if (typeof p.position === "string") {
        // Legacy string aliases for section
        if (p.position === "depth") section = "chat-history";
        else if (p.position === "post_history") section = "post-history";
      }
      if (typeof p.position === "number") {
        numericPosition = p.position;
      }
      await db.insert(userPrompts).values({
        userId,
        name: p.name,
        content: p.content,
        section,
        enabled: p.enabled !== false,
        position: numericPosition,
        folderId: mappedFolderId,
      });
      imported++;
    }
  }

  return c.json({ data: { imported, folders: folderMap.size } });
});

export { userPromptsRoutes };
