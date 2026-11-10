import { and, asc, eq } from "drizzle-orm";
import { GameStateManager, PromptBuilder } from "@yumina/engine";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { messages, playSessions, user } from "../db/schema.js";
import { applyPersonaMetadataToState } from "./persona-metadata.js";
import { resolvePersonaForSession } from "./resolve-persona.js";
import { loadSessionWorldDef } from "./world-def-cache.js";

/** Rebind only an untouched opening before play starts. Played or manually
 * edited text is history, not a template. The session lock serializes this
 * repair with persona selection and message mutations. */
export async function refreshSessionGreeting(sessionId: string, userId: string, worldDef?: WorldDefinition) {
  const [meta] = await db.select({ worldId: playSessions.worldId, state: playSessions.state }).from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
  if (!meta || Number(meta.state?.turnCount ?? 0) > 0) return null;
  const world = worldDef ?? await loadSessionWorldDef(meta.worldId, userId);
  if (!world) return null;
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(playSessions).where(and(
      eq(playSessions.id, sessionId), eq(playSessions.userId, userId),
    )).for("update");
    if (!session || Number(session.state?.turnCount ?? 0) > 0) return null;
    const rows = await tx.select().from(messages).where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt), asc(messages.id)).limit(2).for("update");
    const greeting = rows[0];
    if (rows.length !== 1 || greeting?.role !== "assistant" || !greeting.stateSnapshot) return null;
    const [account] = await tx.select().from(user).where(eq(user.id, userId));
    if (!account) return null;
    const persona = await resolvePersonaForSession(session, tx);
    const builder = new PromptBuilder();
    const entries = builder.buildGreetingEntries(world);
    const savedSwipes = greeting.swipes?.length ? greeting.swipes : [{ content: greeting.content,
      stateSnapshot: greeting.stateSnapshot, createdAt: greeting.createdAt?.toISOString() ?? new Date(0).toISOString() }];
    const active = greeting.activeSwipeIndex ?? 0;
    // A direct text edit may not have updated its stored swipe.
    if (savedSwipes[active]?.content !== greeting.content) return null;
    const swipes = savedSwipes.map((swipe, index) => {
      const previous = structuredClone(swipe.stateSnapshot ?? greeting.stateSnapshot) as unknown as GameState;
      const entryIndex = previous.activeGreetingId
        ? entries.findIndex(entry => entry.id === previous.activeGreetingId) : index;
      if (entryIndex < 0) return swipe;
      let renderState = previous;
      if (builder.buildGreetings(world, previous)[entryIndex] !== swipe.content) {
        // Legacy openings were rendered before applying the scenario preset.
        // Require an exact template match; never replace names in edited text.
        const legacy = new GameStateManager(world, previous);
        const defaults = new GameStateManager(world);
        for (const key of Object.keys(entries[entryIndex]?.initialVariables ?? {})) {
          const value = defaults.get(key);
          if (value !== undefined) legacy.set(key, value);
        }
        renderState = legacy.getSnapshot();
        if (builder.buildGreetings(world, renderState)[entryIndex] !== swipe.content) return swipe;
      }
      const next = structuredClone(previous);
      applyPersonaMetadataToState(next, persona, account);
      const nextRender = structuredClone(renderState);
      applyPersonaMetadataToState(nextRender, persona, account);
      const content = builder.buildGreetings(world, nextRender)[entryIndex];
      return content === undefined ? swipe : { ...swipe, content, stateSnapshot: next as unknown as Record<string, unknown> };
    });
    if (JSON.stringify(swipes) === JSON.stringify(savedSwipes)) return null;
    const selected = swipes[active]!;
    const [updated] = await tx.update(messages).set({ content: selected.content, swipes,
      stateSnapshot: selected.stateSnapshot ?? greeting.stateSnapshot,
    }).where(eq(messages.id, greeting.id)).returning();
    const state = structuredClone(session.state) as { metadata?: Record<string, unknown> };
    applyPersonaMetadataToState(state, persona, account);
    await tx.update(playSessions).set({ state, updatedAt: new Date() }).where(eq(playSessions.id, sessionId));
    return updated ?? null;
  });
}
