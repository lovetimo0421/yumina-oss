import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../lib/types.js";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import { db, readOwn } from "../db/index.js";
import { userPersonas, userWorldPersonas } from "../db/schema.js";
import { MAX_PERSONA_NAME, MAX_PERSONA_APPEARANCE, MAX_PERSONA_PERSONALITY, MAX_PERSONA_BACKSTORY, MAX_PERSONA_NOTE } from "@yumina/shared";

import { setAccountPersona } from "../lib/resolve-persona.js";

export const personaRoutes = new Hono<AppEnv>();

// List current user's personas
personaRoutes.get("/", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const rows = await rd
    .select()
    .from(userPersonas)
    .where(eq(userPersonas.userId, currentUser.id))
    .orderBy(userPersonas.createdAt);
  return c.json({ data: rows });
});

// Compatibility for older clients: worlds now follow the profile selection.
personaRoutes.get("/binding/:worldId", authMiddleware, async (c) => {
  return c.json({ data: { personaId: null } });
});
personaRoutes.put("/binding/:worldId", authMiddleware, async (c) => {
  // A stale client must not show a successful selection that generation ignores.
  const body: unknown = await c.req.json().catch(() => null);
  const personaId = body && typeof body === "object" && "personaId" in body ? body.personaId : undefined;
  if (typeof personaId !== "string") return c.json({ error: "Invalid persona ID" }, 400);
  const result = await setAccountPersona(c.get("user").id, personaId);
  if (result.error) return c.json({ error: result.error }, 404);
  return c.json({ data: { worldId: c.req.param("worldId"), personaId } });
});
personaRoutes.delete("/binding/:worldId", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  await db.delete(userWorldPersonas).where(and(
    eq(userWorldPersonas.userId, currentUser.id), eq(userWorldPersonas.worldId, worldId),
  ));
  return c.json({ data: { worldId, personaId: null } });
});

// Get single persona
personaRoutes.get("/:id", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");
  const rd = await readOwn(currentUser.id);
  const [row] = await rd
    .select()
    .from(userPersonas)
    .where(and(eq(userPersonas.id, id), eq(userPersonas.userId, currentUser.id)));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ data: row });
});

// Create persona
personaRoutes.post("/", authMiddleware, rateLimitMiddleware("content-creation"), async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json<{
    name: string;
    avatarUrl?: string;
    appearance?: string;
    personality?: string;
    backstory?: string;
    note?: string;
  }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Name is required" }, 400);
  }
  if (body.name.length > MAX_PERSONA_NAME) {
    return c.json({ error: `Name must be ${MAX_PERSONA_NAME} characters or fewer` }, 400);
  }
  if (body.appearance && body.appearance.length > MAX_PERSONA_APPEARANCE) {
    return c.json({ error: `Appearance must be ${MAX_PERSONA_APPEARANCE} characters or fewer` }, 400);
  }
  if (body.personality && body.personality.length > MAX_PERSONA_PERSONALITY) {
    return c.json({ error: `Personality must be ${MAX_PERSONA_PERSONALITY} characters or fewer` }, 400);
  }
  if (body.backstory && body.backstory.length > MAX_PERSONA_BACKSTORY) {
    return c.json({ error: `Backstory must be ${MAX_PERSONA_BACKSTORY} characters or fewer` }, 400);
  }
  if (body.note && body.note.length > MAX_PERSONA_NOTE) {
    return c.json({ error: `Note must be ${MAX_PERSONA_NOTE} characters or fewer` }, 400);
  }

  // Check if user has any personas — if not, make this one active
  const existing = await db
    .select({ id: userPersonas.id })
    .from(userPersonas)
    .where(eq(userPersonas.userId, currentUser.id))
    .limit(1);
  const isFirst = existing.length === 0;

  const [created] = await db
    .insert(userPersonas)
    .values({
      userId: currentUser.id,
      name: body.name.trim(),
      avatarUrl: body.avatarUrl ?? null,
      appearance: body.appearance ?? null,
      personality: body.personality ?? null,
      backstory: body.backstory ?? null,
      note: body.note ?? null,
      isActive: isFirst,
    })
    .returning();

  return c.json({ data: created }, 201);
});

// Update persona
personaRoutes.patch("/:id", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    avatarUrl?: string | null;
    appearance?: string | null;
    personality?: string | null;
    backstory?: string | null;
    note?: string | null;
  }>();

  if (body.name !== undefined && !body.name.trim()) {
    return c.json({ error: "Name cannot be empty" }, 400);
  }
  if (body.name !== undefined && body.name.length > MAX_PERSONA_NAME) {
    return c.json({ error: `Name must be ${MAX_PERSONA_NAME} characters or fewer` }, 400);
  }
  if (body.appearance !== undefined && body.appearance !== null && body.appearance.length > MAX_PERSONA_APPEARANCE) {
    return c.json({ error: `Appearance must be ${MAX_PERSONA_APPEARANCE} characters or fewer` }, 400);
  }
  if (body.personality !== undefined && body.personality !== null && body.personality.length > MAX_PERSONA_PERSONALITY) {
    return c.json({ error: `Personality must be ${MAX_PERSONA_PERSONALITY} characters or fewer` }, 400);
  }
  if (body.backstory !== undefined && body.backstory !== null && body.backstory.length > MAX_PERSONA_BACKSTORY) {
    return c.json({ error: `Backstory must be ${MAX_PERSONA_BACKSTORY} characters or fewer` }, 400);
  }
  if (body.note !== undefined && body.note !== null && body.note.length > MAX_PERSONA_NOTE) {
    return c.json({ error: `Note must be ${MAX_PERSONA_NOTE} characters or fewer` }, 400);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
  if (body.appearance !== undefined) updates.appearance = body.appearance;
  if (body.personality !== undefined) updates.personality = body.personality;
  if (body.backstory !== undefined) updates.backstory = body.backstory;
  if (body.note !== undefined) updates.note = body.note;

  const [updated] = await db
    .update(userPersonas)
    .set(updates)
    .where(and(eq(userPersonas.id, id), eq(userPersonas.userId, currentUser.id)))
    .returning();

  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ data: updated });
});

// Delete persona
personaRoutes.delete("/:id", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");

  const [deleted] = await db
    .delete(userPersonas)
    .where(and(eq(userPersonas.id, id), eq(userPersonas.userId, currentUser.id)))
    .returning();

  if (!deleted) return c.json({ error: "Not found" }, 404);

  // If deleted persona was active, activate the first remaining one
  if (deleted.isActive) {
    const [first] = await db
      .select({ id: userPersonas.id })
      .from(userPersonas)
      .where(eq(userPersonas.userId, currentUser.id))
      .orderBy(userPersonas.createdAt)
      .limit(1);
    if (first) {
      await db
        .update(userPersonas)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(userPersonas.id, first.id));
    }
  }

  return c.json({ data: { id } });
});

// Both settings and in-chat choices update the same account selection.
personaRoutes.post("/deactivate", authMiddleware, async (c) => {
  await setAccountPersona(c.get("user").id, null);
  return c.json({ data: { activeId: null } });
});

personaRoutes.post("/:id/activate", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const result = await setAccountPersona(c.get("user").id, id);
  if (result.error) return c.json({ error: "Not found" }, 404);
  return c.json({ data: { id } });
});
