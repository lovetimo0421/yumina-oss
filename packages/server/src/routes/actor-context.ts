import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { assembleActorContext, ActorContextLimitError, migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { DEFAULT_MODEL } from "@yumina/shared";
import { db } from "../db/index.js";
import { playSessions, worlds } from "../db/schema.js";
import { normalizeGameState } from "../lib/game-state.js";
import { isForkOrphaned } from "../lib/fork-orphan.js";
import { resolveSessionWorldSchema } from "../lib/pending-edit.js";
import { loadUserPrompts } from "../lib/user-prompts.js";
import type { AppEnv } from "../lib/types.js";

const requestSchema = z.object({
  actor: z.enum(["voice", "director"]),
  model: z.string().trim().min(1).max(200).optional(),
  recentMessages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4_000) }).strict()).max(24).optional(),
}).strict().refine(body => (body.recentMessages ?? []).reduce((sum, message) => sum + message.content.length, 0) <= 12_000);

/** Mounted under completionRoutes' existing auth middleware. No LLM, writes,
 * persona lookup, history read, summary or session-memory hooks run here.
 * Returning protected prompts to the sandbox would defeat official-key-only
 * enforcement, so protected non-creators are refused before prompt assembly.
 */
export const actorContextRoutes = new Hono<AppEnv>().post("/sessions/:sessionId/actor-context", bodyLimit({ maxSize: 96 * 1024 }), async c => {
  c.header("Cache-Control", "no-store");
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "Actor context requires JSON.", code: "INVALID_ACTOR_CONTEXT_REQUEST" }, 415);
  }
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid actor context request. Supply voice or director, an optional model, and at most 24 public messages (4000 characters each; 12000 total).", code: "INVALID_ACTOR_CONTEXT_REQUEST" }, 400);
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const [row] = await db.select({ state: playSessions.state, world: { id: worlds.id, creatorId: worlds.creatorId, status: worlds.status, schema: worlds.schema, allowCustomApi: worlds.allowCustomApi, sourceWorldId: worlds.sourceWorldId } })
    .from(playSessions).innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id))).limit(1);
  if (!row) return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
  const { world } = row;
  if (world.status === "unpublished" && world.creatorId !== currentUser.id) return c.json({ error: "This world is no longer available.", code: "WORLD_UNAVAILABLE" }, 403);
  if (world.allowCustomApi === false && world.creatorId !== currentUser.id) return c.json({ error: "This world's instructions cannot be exposed to custom actors.", code: "ACTOR_CONTEXT_PROTECTED" }, 403);
  if (world.sourceWorldId) {
    const [source] = await db.select({ status: worlds.status, isPublished: worlds.isPublished, publishedAt: worlds.publishedAt, creatorId: worlds.creatorId }).from(worlds).where(eq(worlds.id, world.sourceWorldId)).limit(1);
    if (isForkOrphaned({ sourceWorldId: world.sourceWorldId, sourceStatus: source?.status ?? null, sourceIsPublished: source?.isPublished ?? null, sourcePublishedAt: source?.publishedAt ?? null, sourceCreatorId: source?.creatorId ?? null, worldCreatorId: world.creatorId })) return c.json({ error: "The original world is no longer available.", code: "WORLD_UNAVAILABLE" }, 403);
  }
  // No schema cache: creator playtests see their current pending working copy;
  // other players see the current approved schema, exactly as session play does.
  const definition = migrateWorldDefinition(await resolveSessionWorldSchema(world, currentUser.id) as WorldDefinition);
  const state = normalizeGameState(definition, row.state);
  const model = parsed.data.model ?? DEFAULT_MODEL;
  const userPrompts = await loadUserPrompts(currentUser.id, { modelId: model });
  try {
    return c.json(assembleActorContext({ ...parsed.data, model, world: definition, state, userPrompts }));
  } catch (error) {
    if (error instanceof ActorContextLimitError) return c.json({ error: error.message, code: error.code, instructionChars: error.instructionChars, maxInstructionChars: 9000 }, 422);
    throw error;
  }
});
