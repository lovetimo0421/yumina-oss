import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import { deepEqual, migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { checkpoints, messages, playSessions, worlds } from "../db/schema.js";
import { normalizeGameState } from "./game-state.js";
import { resolveSessionWorldSchema } from "./pending-edit.js";
import { chunkRowsForInsert } from "./insert-chunks.js";
import { rebuildRunMemories } from "./run-scopes.js";

// Server-created holders are hidden by the existing ephemeral filter. The
// cleanup function excludes this prefix; ordinary session creation never lets
// clients choose an id. A holder is never the active playtest session.
export const STUDIO_TEST_HOLDER_PREFIX = "studio-test:";
export const MAX_TEST_START_NAME = 80;
export const MAX_TEST_STARTS = 30;
export class TestStartError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400, public code?: string) { super(message); }
}
export interface TestStartSummary { id: string; name: string; messageCount: number; createdAt: Date | null }
const ownedHolder = (userId: string, worldId: string) => and(
  eq(playSessions.userId, userId), eq(playSessions.worldId, worldId), eq(worlds.creatorId, userId),
  eq(playSessions.ephemeral, true), like(playSessions.id, `${STUDIO_TEST_HOLDER_PREFIX}%`),
);
async function ownedWorld(userId: string, worldId: string) {
  const [world] = await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)));
  if (!world) throw new TestStartError("World not found", 404);
  return world;
}
export async function listTestStarts(userId: string, worldId: string): Promise<TestStartSummary[]> {
  await ownedWorld(userId, worldId);
  return db.select({ id: checkpoints.id, name: checkpoints.name,
    messageCount: sql<number>`jsonb_array_length(${checkpoints.messages})`.mapWith(Number), createdAt: checkpoints.createdAt })
    .from(checkpoints).innerJoin(playSessions, eq(checkpoints.sessionId, playSessions.id))
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id)).where(ownedHolder(userId, worldId))
    .orderBy(desc(checkpoints.createdAt));
}
export async function saveTestStart(userId: string, worldId: string, sourceId: string, rawName: unknown, expectedState?: unknown): Promise<TestStartSummary> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > MAX_TEST_START_NAME) throw new TestStartError(`Name must be 1–${MAX_TEST_START_NAME} characters`);
  const world = await ownedWorld(userId, worldId);
  const definition = migrateWorldDefinition(await resolveSessionWorldSchema(world, userId) as unknown as WorldDefinition);
  return db.transaction(async (tx) => {
    // Serialize naming/saving against other saves for this card, and snapshot
    // state plus transcript under the same lock used by message/action writes.
    await tx.execute(sql`SELECT id FROM worlds WHERE id = ${worldId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM play_sessions WHERE id = ${sourceId} FOR UPDATE`);
    const [source] = await tx.select().from(playSessions).where(and(eq(playSessions.id, sourceId),
      eq(playSessions.userId, userId), eq(playSessions.worldId, worldId), eq(playSessions.ephemeral, true)));
    if (!source || source.id.startsWith(STUDIO_TEST_HOLDER_PREFIX)) throw new TestStartError("Playtest not found", 404);
    if (expectedState !== undefined && !deepEqual(normalizeGameState(definition, source.state), normalizeGameState(definition, expectedState))) {
      throw new TestStartError("Playtest state is still changing. Wait for updates to finish, then save the start again.", 409, "TEST_START_STATE_CHANGED");
    }
    const existing = await tx.select({ id: playSessions.id }).from(playSessions)
      .where(and(eq(playSessions.userId, userId), eq(playSessions.worldId, worldId),
        eq(playSessions.ephemeral, true), like(playSessions.id, `${STUDIO_TEST_HOLDER_PREFIX}%`)));
    if (existing.length >= MAX_TEST_STARTS) throw new TestStartError(`A card can keep up to ${MAX_TEST_STARTS} test starts`, 409, "TEST_START_LIMIT");
    const transcript = await tx.select().from(messages).where(eq(messages.sessionId, sourceId)).orderBy(asc(messages.createdAt));
    const holderId = `${STUDIO_TEST_HOLDER_PREFIX}${randomUUID()}`;
    await tx.insert(playSessions).values({ id: holderId, userId, worldId, ephemeral: true, name, state: {} });
    const [saved] = await tx.insert(checkpoints).values({ sessionId: holderId, name,
      messages: transcript as unknown as Array<Record<string, unknown>>, state: source.state, summary: source.summary }).returning();
    if (!saved) throw new Error("Test start insert returned no row");
    return { id: saved.id, name: saved.name, messageCount: transcript.length, createdAt: saved.createdAt };
  });
}
async function getTestStart(userId: string, worldId: string, checkpointId: string) {
  const [result] = await db.select({ checkpoint: checkpoints, holderId: playSessions.id }).from(checkpoints)
    .innerJoin(playSessions, eq(checkpoints.sessionId, playSessions.id))
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(checkpoints.id, checkpointId), ownedHolder(userId, worldId)));
  if (!result) throw new TestStartError("Test start not found", 404);
  return result;
}
export async function deleteTestStart(userId: string, worldId: string, checkpointId: string) {
  const { holderId } = await getTestStart(userId, worldId, checkpointId);
  // The holder owns exactly this immutable checkpoint; cascade deletes it.
  await db.delete(playSessions).where(and(eq(playSessions.id, holderId), eq(playSessions.userId, userId)));
}

/** Snapshot replay is a fresh temporary session using TODAY's creator schema.
 * No writes go to the source, the checkpoint, or either published/draft card. */
export async function runTestStart(userId: string, worldId: string, checkpointId: string) {
  const { checkpoint } = await getTestStart(userId, worldId, checkpointId);
  const world = await ownedWorld(userId, worldId);
  const schema = await resolveSessionWorldSchema(world, userId);
  const definition = migrateWorldDefinition(schema as unknown as WorldDefinition);
  const state = normalizeGameState(definition, checkpoint.state);
  const transcript = checkpoint.messages;
  const memoryRows = transcript.map((message) => ({
    createdAt: message.createdAt ? new Date(message.createdAt as string) : null,
    role: message.role as string,
    stateSnapshot: message.stateSnapshot ? normalizeGameState(definition, message.stateSnapshot) : null,
  }));
  const runMemories = rebuildRunMemories(definition.worldbooks, memoryRows,
    normalizeGameState(definition, {}), state, randomUUID(),
    new Date(memoryRows.at(-1)?.createdAt ?? Date.now()).toISOString());
  const created = await db.transaction(async (tx) => {
    const [session] = await tx.insert(playSessions).values({ userId, worldId, ephemeral: true,
      name: checkpoint.name, state: state as unknown as Record<string, unknown>,
      runMemories: runMemories as unknown as Record<string, unknown>,
      summary: checkpoint.summary, summaryUpdatedAt: checkpoint.summary ? new Date() : null }).returning();
    if (!session) throw new Error("Test run insert returned no row");
    const rows = transcript.map((message) => ({
      id: randomUUID(), sessionId: session.id, role: message.role as "user" | "assistant" | "system",
      content: String(message.content ?? ""),
      stateChanges: (message.stateChanges ?? null) as Record<string, unknown> | null,
      stateSnapshot: message.stateSnapshot ? normalizeGameState(definition, message.stateSnapshot) as unknown as Record<string, unknown> : null,
      swipes: (Array.isArray(message.swipes) ? message.swipes : []).map((swipe) => ({ ...swipe,
        ...(swipe.stateSnapshot ? { stateSnapshot: normalizeGameState(definition, swipe.stateSnapshot) } : {}),
      })),
      activeSwipeIndex: (message.activeSwipeIndex as number) ?? 0,
      model: (message.model as string) ?? null, tokenCount: (message.tokenCount as number) ?? null,
      generationTimeMs: (message.generationTimeMs as number) ?? null,
      // A checkpoint captures a summary, but not summaryception snippets or
      // derived session memory. Uncaptured tiers must not hide raw messages.
      compacted: Boolean(checkpoint.summary) && message.compacted === true,
      summaryceptionCompacted: false,
      attachments: (message.attachments ?? null) as Array<{ type: string; mimeType: string; name: string; url: string }> | null,
      createdAt: message.createdAt ? new Date(message.createdAt as string) : new Date(),
    }));
    for (const chunk of chunkRowsForInsert(rows)) await tx.insert(messages).values(chunk);
    return session;
  });
  return { id: created.id, name: checkpoint.name, sourceId: checkpoint.id };
}
