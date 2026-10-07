import { Hono, type Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { LiveCanonEntryInput } from "@yumina/shared";
import { db } from "../db/index.js";
import { playSessions, sessionLoreEntries } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import {
  LIVE_CANON_MAX_CONTENT,
  LIVE_CANON_DISABLED_MESSAGE,
  LiveCanonError,
  applyLiveCanonStateUpdates,
  assertLoreCapacityForRows,
  buildLiveCanonPayload,
  canEditLiveCanonEntry,
  isSafeLiveCanonContent,
  loadLiveCanonContext,
} from "../extensions/live-canon/service.js";

export const liveCanonRoutes = new Hono<AppEnv>();
liveCanonRoutes.use("/*", authMiddleware);

const primitiveValue = z.union([
  z.number().finite(),
  z.string().max(500),
  z.boolean(),
]);
const stateBodySchema = z.object({
  updates: z.record(primitiveValue),
}).refine((body) => Object.keys(body.updates).length <= 25, "Too many state changes");
const loreFields = {
  name: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(LIVE_CANON_MAX_CONTENT).refine(
    isSafeLiveCanonContent,
    "Session lore cannot contain macros or engine control markers",
  ),
  enabled: z.boolean(),
  alwaysSend: z.boolean(),
  keywords: z.array(z.string().trim().min(1).max(80)).max(20),
  matchWholeWords: z.boolean(),
};
const loreBodySchema = z.object({
  name: loreFields.name,
  content: loreFields.content,
  enabled: loreFields.enabled.optional().default(true),
  alwaysSend: loreFields.alwaysSend.optional().default(true),
  keywords: loreFields.keywords.optional().default([]),
  matchWholeWords: loreFields.matchWholeWords.optional().default(false),
});
const lorePatchSchema = z.object(loreFields).partial().refine(
  (body) => Object.keys(body).length > 0,
  "At least one field is required",
);
const basePatchSchema = z.object({
  content: loreFields.content,
});

function cleanKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))].slice(0, 20);
}

type LiveCanonTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockAuthorGate(tx: LiveCanonTransaction, worldId: string): Promise<{ additionsAllowed: boolean }> {
  const result = await tx.execute(
    sql`SELECT allow_live_canon, allow_live_canon_additions FROM worlds WHERE id = ${worldId} FOR UPDATE`,
  );
  const row = result.rows[0] as {
    allow_live_canon?: boolean;
    allow_live_canon_additions?: boolean;
  } | undefined;
  if (!row?.allow_live_canon) {
    throw new LiveCanonError(
      "AUTHOR_DISABLED_LIVE_CANON",
      403,
      LIVE_CANON_DISABLED_MESSAGE,
    );
  }
  return { additionsAllowed: row.allow_live_canon_additions === true };
}

async function assertLoreCapacityInTransaction(
  tx: LiveCanonTransaction,
  sessionId: string,
  replacement?: { id?: string; content: string },
): Promise<void> {
  const rows = await tx
    .select({ id: sessionLoreEntries.id, content: sessionLoreEntries.content })
    .from(sessionLoreEntries)
    .where(eq(sessionLoreEntries.sessionId, sessionId));
  assertLoreCapacityForRows(rows, replacement);
}

function errorResponse(c: Context<AppEnv>, error: unknown) {
  if (error instanceof LiveCanonError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  throw error;
}

liveCanonRoutes.get("/:sessionId/live-canon", async (c) => {
  try {
    const ctx = await loadLiveCanonContext(c.req.param("sessionId"), c.get("user").id);
    return c.json({ data: await buildLiveCanonPayload(ctx) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

liveCanonRoutes.patch("/:sessionId/live-canon/state", async (c) => {
  try {
    const userId = c.get("user").id;
    const sessionId = c.req.param("sessionId");
    const ctx = await loadLiveCanonContext(sessionId, userId);
    const parsed = stateBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid state update", details: parsed.error.flatten() }, 400);

    const updated = await db.transaction(async (tx) => {
      // Lock the author gate before the session row. World settings writers
      // lock the same row, so closing the gate cannot cross this write.
      await lockAuthorGate(tx, ctx.worldId);
      const [locked] = await tx
        .select({ state: playSessions.state })
        .from(playSessions)
        .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
        .for("update");
      if (!locked) throw new LiveCanonError("LIVE_CANON_NOT_FOUND", 404, "Session not found");
      const state = applyLiveCanonStateUpdates(ctx, locked.state, parsed.data.updates);
      const [row] = await tx
        .update(playSessions)
        .set({ state: state as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
        .returning();
      return row;
    });
    return c.json({ data: updated });
  } catch (error) {
    return errorResponse(c, error);
  }
});

liveCanonRoutes.put("/:sessionId/live-canon/lore/base/:entryId", async (c) => {
  try {
    const userId = c.get("user").id;
    const sessionId = c.req.param("sessionId");
    const entryId = c.req.param("entryId");
    const ctx = await loadLiveCanonContext(sessionId, userId);
    const parsed = basePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid lore update", details: parsed.error.flatten() }, 400);
    const entry = ctx.worldDef.entries.find((candidate) => candidate.id === entryId);
    if (!entry || !canEditLiveCanonEntry(entry)) {
      throw new LiveCanonError("LIVE_CANON_FORBIDDEN", 403, "The author did not allow this lore entry to be edited");
    }
    const row = await db.transaction(async (tx) => {
      await lockAuthorGate(tx, ctx.worldId);
      const [existing] = await tx
        .select({ id: sessionLoreEntries.id })
        .from(sessionLoreEntries)
        .where(and(
          eq(sessionLoreEntries.sessionId, sessionId),
          eq(sessionLoreEntries.kind, "override"),
          eq(sessionLoreEntries.baseEntryId, entryId),
        ))
        .limit(1);
      await assertLoreCapacityInTransaction(tx, sessionId, { id: existing?.id, content: parsed.data.content });
      const [saved] = await tx
        .insert(sessionLoreEntries)
        .values({ sessionId, kind: "override", baseEntryId: entryId, content: parsed.data.content })
        .onConflictDoUpdate({
          target: [sessionLoreEntries.sessionId, sessionLoreEntries.kind, sessionLoreEntries.baseEntryId],
          set: { content: parsed.data.content, updatedAt: new Date() },
        })
        .returning();
      return saved;
    });
    return c.json({ data: row });
  } catch (error) {
    return errorResponse(c, error);
  }
});

liveCanonRoutes.delete("/:sessionId/live-canon/lore/base/:entryId", async (c) => {
  try {
    const userId = c.get("user").id;
    const sessionId = c.req.param("sessionId");
    const ctx = await loadLiveCanonContext(sessionId, userId);
    const entry = ctx.worldDef.entries.find((candidate) => candidate.id === c.req.param("entryId"));
    if (!entry || !canEditLiveCanonEntry(entry)) {
      throw new LiveCanonError("LIVE_CANON_FORBIDDEN", 403, "The author did not allow this lore entry to be edited");
    }
    await db.transaction(async (tx) => {
      await lockAuthorGate(tx, ctx.worldId);
      await tx.delete(sessionLoreEntries).where(and(
        eq(sessionLoreEntries.sessionId, sessionId),
        eq(sessionLoreEntries.kind, "override"),
        eq(sessionLoreEntries.baseEntryId, entry.id),
      ));
    });
    return c.json({ data: { deleted: true } });
  } catch (error) {
    return errorResponse(c, error);
  }
});

liveCanonRoutes.post("/:sessionId/live-canon/lore", async (c) => {
  try {
    const userId = c.get("user").id;
    const sessionId = c.req.param("sessionId");
    const ctx = await loadLiveCanonContext(sessionId, userId);
    const parsed = loreBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid session lore", details: parsed.error.flatten() }, 400);
    const input: LiveCanonEntryInput = parsed.data;
    const row = await db.transaction(async (tx) => {
      const gate = await lockAuthorGate(tx, ctx.worldId);
      if (!gate.additionsAllowed) {
        throw new LiveCanonError("LIVE_CANON_FORBIDDEN", 403, "The author did not allow new session lore");
      }
      await assertLoreCapacityInTransaction(tx, sessionId, { content: parsed.data.content });
      const [created] = await tx.insert(sessionLoreEntries).values({
        sessionId,
        kind: "created",
        name: input.name,
        content: input.content,
        enabled: input.enabled ?? true,
        alwaysSend: input.alwaysSend ?? true,
        keywords: cleanKeywords(input.keywords ?? []),
        matchWholeWords: input.matchWholeWords ?? false,
      }).returning();
      return created;
    });
    return c.json({ data: row }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

liveCanonRoutes.patch("/:sessionId/live-canon/lore/:entryId", async (c) => {
  try {
    const userId = c.get("user").id;
    const sessionId = c.req.param("sessionId");
    const entryId = c.req.param("entryId");
    const ctx = await loadLiveCanonContext(sessionId, userId);
    const parsed = lorePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid session lore", details: parsed.error.flatten() }, 400);
    const row = await db.transaction(async (tx) => {
      await lockAuthorGate(tx, ctx.worldId);
      if (parsed.data.content) {
        await assertLoreCapacityInTransaction(tx, sessionId, { id: entryId, content: parsed.data.content });
      }
      const [updated] = await tx.update(sessionLoreEntries).set({
        ...parsed.data,
        ...(parsed.data.keywords ? { keywords: cleanKeywords(parsed.data.keywords) } : {}),
        updatedAt: new Date(),
      }).where(and(
        eq(sessionLoreEntries.id, entryId),
        eq(sessionLoreEntries.sessionId, sessionId),
        eq(sessionLoreEntries.kind, "created"),
      )).returning();
      return updated;
    });
    if (!row) throw new LiveCanonError("LIVE_CANON_NOT_FOUND", 404, "Session lore entry not found");
    return c.json({ data: row });
  } catch (error) {
    return errorResponse(c, error);
  }
});

liveCanonRoutes.delete("/:sessionId/live-canon/lore/:entryId", async (c) => {
  try {
    const userId = c.get("user").id;
    const sessionId = c.req.param("sessionId");
    const ctx = await loadLiveCanonContext(sessionId, userId);
    const rows = await db.transaction(async (tx) => {
      await lockAuthorGate(tx, ctx.worldId);
      return tx.delete(sessionLoreEntries).where(and(
        eq(sessionLoreEntries.id, c.req.param("entryId")),
        eq(sessionLoreEntries.sessionId, sessionId),
        eq(sessionLoreEntries.kind, "created"),
      )).returning();
    });
    if (rows.length === 0) throw new LiveCanonError("LIVE_CANON_NOT_FOUND", 404, "Session lore entry not found");
    return c.json({ data: { deleted: true } });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Privacy cleanup remains available even if the author later closes editing.
// It reveals no row data or count and cannot be reached from the warning UI.
liveCanonRoutes.delete("/:sessionId/live-canon", async (c) => {
  const userId = c.get("user").id;
  const sessionId = c.req.param("sessionId");
  const [owned] = await db.select({ id: playSessions.id }).from(playSessions).where(and(
    eq(playSessions.id, sessionId),
    eq(playSessions.userId, userId),
  )).limit(1);
  if (!owned) return c.json({ error: "Session not found", code: "LIVE_CANON_NOT_FOUND" }, 404);
  await db.delete(sessionLoreEntries).where(eq(sessionLoreEntries.sessionId, sessionId));
  return c.json({ data: { deleted: true } });
});
