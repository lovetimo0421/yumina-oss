import { setTimeout as delay } from "node:timers/promises";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { refreshSessionGreeting } from "./refresh-session-greeting.js";
// Regression tests for the production persona/memory lifecycle investigation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { PromptBuilder } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { creditWallets, messages, modelPrices, playSessions, summaryceptionSnippets, user, userPersonas, userExtensions, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { applyPersonaMetadataToState } from "./persona-metadata.js";
import { setSessionPersonaLock } from "./resolve-persona.js";
import { regenerateSessionMemoryForSession, retrySessionMemoryForSession, scheduleSessionMemoryRepair, formatSessionMemoryForPrompt } from "./session-memory.js";
import { compactSummaryceptionForSession, SummaryceptionInvalidatedError } from "./summaryception.js";
import { runExtensionInvalidation } from "./extension-hooks.js";
import { registerSessionMemoryExtension } from "../extensions/session-memory/hooks.js";
import { regenerateStorySummaryForSession } from "./session-compaction.js";
import { branchSession } from "../routes/sessions.js";

const model = "google/gemini-3.1-flash-lite";
const output = "Core facts:\n- OldTimelineMarker: the player left a red umbrella in the cafe.\nActive goals and open threads:\n- Return for the umbrella tomorrow.";

test("persona and memory lifecycle regressions", async (t) => {
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PGLITE_DATA_DIR, "memory://");
  const client = (db as unknown as { $client: PGlite }).$client;
  const migration = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  for (const statement of migration) await client.exec(statement);
  registerSessionMemoryExtension();
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 2 });
  await invalidateModelPriceCache();
  const previousKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "test-only-never-sent-key";
  try {
    for (const mode of ["greeting-macro", "edit-retains-memory", "auto-repair", "repair-retry-cap", "layered-restart-race", "layered-edit-race", "branch-summary-future"] as const) {
      await t.test(mode, async (st) => {
        const userId = `audit-${randomUUID()}`;
        const sessionId = randomUUID();
        const firstId = randomUUID();
        let called = false;
        let failRepair = mode === "repair-retry-cap";
        const calls: GenerateParams[] = [];
        st.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (params: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(params);
          if (failRepair) throw new Error("simulated repair outage");
          if (!called && mode.startsWith("layered-")) {
            called = true;
            assert.ok(JSON.stringify(params.messages).includes("OldTimelineMarker"));
            if (mode === "layered-restart-race") {
              // Same invalidation hook used by restart, while the provider is pending.
              await db.delete(messages).where(eq(messages.sessionId, sessionId));
              await runExtensionInvalidation({ reason: "session-restart", sessionId });
              assert.equal((await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, sessionId))).length, 0);
            } else {
              await runExtensionInvalidation({ reason: "message-edited", sessionId }, undefined, db, async (tx) => {
                const [before] = await tx.select().from(messages).where(eq(messages.id, firstId));
                await tx.update(messages).set({ content: "CorrectedTimelineMarker: no umbrella exists." }).where(eq(messages.id, firstId));
                return { messageFlags: { id: firstId, createdAt: before!.createdAt, compacted: before!.compacted, summaryceptionCompacted: before!.summaryceptionCompacted } };
              });
            }
          }
          yield { type: "text", content: mode === "branch-summary-future" ? "Core facts:\n- FutureBranchMarker: the player found a gold key after leaving the cafe." : mode === "auto-repair" || mode === "repair-retry-cap" ? "Core facts:\n- CorrectedTimelineMarker: no umbrella exists.\nActive goals and open threads:\n- Have tea in the cafe." : output };
          yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 } };
        });
        await db.insert(user).values({ id: userId, name: "Audit", email: `${userId}@example.com` });
        try {
          await db.insert(creditWallets).values({ userId, balance: 100, addonBalance: 100 });
          const worldDef = { id: randomUUID(), name: "Audit Cafe", entries: [{ id: "g", role: "greeting", enabled: true, position: 0, content: "Welcome {{user}}. {{persona_backstory}}" }], variables: [], rules: [], components: [], settings: {} } as unknown as WorldDefinition;
          const [world] = await db.insert(worlds).values({ creatorId: userId, name: "Audit Cafe", schema: worldDef as unknown as Record<string, unknown> }).returning();
          const [oldPersona, newPersona] = await db.insert(userPersonas).values([{ userId, name: "OldName", isActive: true, backstory: "OldPersonaInGreetingMarker" }, { userId, name: "NewName", backstory: "NewPersonaMarker" }]).returning();
          const state = { worldId: world!.id, variables: {}, turnCount: 0, metadata: {} };
          applyPersonaMetadataToState(state, oldPersona!, { name: "Audit" });
          const opening = new PromptBuilder().buildGreetings(worldDef, state)[0]!;
          await db.insert(playSessions).values({ id: sessionId, userId, worldId: world!.id, state, sessionMemoryModel: model, summaryModel: model, summaryceptionModel: model, summaryRecentTailTokens: 1, summaryLanguage: "en" });
          await db.insert(messages).values(Array.from({ length: mode === "greeting-macro" ? 1 : 8 }, (_, i) => ({ id: i === 0 ? firstId : randomUUID(), sessionId, role: i % 2 === 0 ? "assistant" as const : "user" as const, content: i === 0 ? (mode === "greeting-macro" ? opening : "OldTimelineMarker: the player left a red umbrella in the cafe.") : `Cafe conversation ${i}.`, stateSnapshot: state, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) })));
          if (mode.startsWith("layered-")) {
            // Use a realistic long transcript and a valid 4k context budget.
            await db.update(playSessions).set({ summaryRecentTailTokens: 1000 }).where(eq(playSessions.id, sessionId));
            for (const row of await db.select().from(messages).where(eq(messages.sessionId, sessionId))) {
              await db.update(messages).set({ content: row.content + " The visitor waits quietly while the barista prepares tea.".repeat(120) }).where(eq(messages.id, row.id));
            }
          }
          await setSessionPersonaLock(userId, sessionId, true, newPersona!.id);
          if (mode === "branch-summary-future") {
            const sourceRows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
            const later = sourceRows.find(m => m.content === "Cafe conversation 6.")!;
            await db.update(messages).set({ content: "FutureBranchMarker: the player found a gold key after leaving the cafe." }).where(eq(messages.id, later.id));
            await regenerateStorySummaryForSession({ sessionId, userId });
            assert.ok(calls.length > 0 && JSON.stringify(calls[0]!.messages).includes("FutureBranchMarker"));
            const [parent] = await db.select().from(playSessions).where(eq(playSessions.id, sessionId));
            assert.ok(parent!.summaryCoversUntilMessageId !== firstId);
            const originals = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
            assert.ok(originals.every(m => !m.compacted), "manual small-summary path preserves raw rows");
            const result = await branchSession({ sessionId, userId, messageId: firstId });
            assert.equal(result.status, 201);
            const childId = result.body.data!.sessionId;
            const [child] = await db.select().from(playSessions).where(eq(playSessions.id, childId));
            const childMessages = await db.select().from(messages).where(eq(messages.sessionId, childId));
            assert.equal(childMessages.length, 1);
            assert.ok(!childMessages[0]!.content.includes("FutureBranchMarker"));
            assert.equal(child!.summary, null, "future facts must not survive an earlier branch");
            assert.equal(child!.summaryCoversUntilMessageId, null, "discarded summary has no coverage");
          } else if (mode === "greeting-macro") {
            const refreshed = await refreshSessionGreeting(sessionId, userId, worldDef);
            assert.ok(refreshed?.content.includes("NewPersonaMarker"));
            assert.ok(!refreshed?.content.includes("OldPersonaInGreetingMarker"));
            await db.insert(messages).values(Array.from({ length: 7 }, (_, i) => ({ sessionId,
              role: i % 2 === 0 ? "user" as const : "assistant" as const, content: `Cafe conversation ${i + 1}.`,
              createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i + 1)) })));
            assert.equal(await refreshSessionGreeting(sessionId, userId, worldDef), null, "played history must not be rewritten");
            await regenerateSessionMemoryForSession({ sessionId, userId });
            assert.ok(calls.length > 0);
            assert.ok(!JSON.stringify(calls[0]!.messages).includes("OldPersonaInGreetingMarker"), "opening and summary use the selected persona");
            assert.ok(!JSON.stringify(calls[0]!.messages).includes('personaBackstory'), "metadata filtering itself still works");
          } else if (mode === "edit-retains-memory" || mode === "auto-repair" || mode === "repair-retry-cap") {
            if (mode !== "edit-retains-memory") {
              await db.insert(userExtensions).values({ userId, extensionKey: SESSION_MEMORY_EXTENSION_KEY });
              await db.update(playSessions).set({ sessionMemoryIncluded: true, sessionMemoryRetryCount: mode === "repair-retry-cap" ? 2 : 0 }).where(eq(playSessions.id, sessionId));
              // Legacy snapshots carried copies of raw messages. A rebuild must
              // never reintroduce the edited text from those hidden mirrors.
              await db.update(messages).set({ stateSnapshot: { ...state, metadata: { ...state.metadata,
                lastMessage: "OldTimelineMarker", lastUserMessage: "OldTimelineMarker", lastCharMessage: "OldTimelineMarker" } } }).where(eq(messages.sessionId, sessionId));
            }
            await db.update(playSessions).set({ sessionMemory: { text: output }, sessionMemoryProcessedMessageId: firstId, ...(mode === "auto-repair" ? { summary: "OldTimelineMarker: legacy summary without coverage" } : {}) }).where(eq(playSessions.id, sessionId));
            await runExtensionInvalidation({ reason: "message-edited", sessionId }, undefined, db, async (tx) => {
              const [before] = await tx.select().from(messages).where(eq(messages.id, firstId));
              await tx.update(messages).set({ content: "CorrectedTimelineMarker: no umbrella exists." }).where(eq(messages.id, firstId));
              return { messageFlags: { id: firstId, createdAt: before!.createdAt, compacted: false, summaryceptionCompacted: false } };
            });
            const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, sessionId));
            assert.ok(saved!.sessionMemoryStaleAt);
            assert.equal(formatSessionMemoryForPrompt(saved!.sessionMemory, { staleSinceEdit: true }), null, "stale facts must not be injected");
            if (mode !== "edit-retains-memory") {
              const session = async () => (await db.select().from(playSessions).where(eq(playSessions.id, sessionId)))[0]!;
              const deadline = Date.now() + 10_000;
              while (Date.now() < deadline) {
                const current = await session();
                if (mode === "auto-repair" ? !current.sessionMemoryStaleAt : current.sessionMemoryStatus === "failed") break;
                await delay(20);
              }
              if (mode === "repair-retry-cap") {
                assert.equal((await session()).sessionMemoryRetryCount, 3);
                const count = calls.length;
                await scheduleSessionMemoryRepair(sessionId);
                await delay(100);
                assert.equal(calls.length, count, "automatic retries stop at the existing cap");
                failRepair = false;
                await retrySessionMemoryForSession({ sessionId, userId });
              }
              const repaired = await session();
              assert.equal(repaired.sessionMemoryStaleAt, null);
              assert.equal(repaired.sessionMemoryStatus, "idle");
              assert.equal(repaired.sessionMemoryRetryCount, 0);
              assert.ok(repaired.sessionMemory?.text.includes("CorrectedTimelineMarker"));
              assert.ok(calls.length > 0, "an installed extension must actually rebuild");
              assert.doesNotMatch(JSON.stringify(calls.map(call => call.messages)), /OldTimelineMarker/, "neither previous memory nor hidden transcript mirrors enter the repair");
            }
          } else {
            await assert.rejects(compactSummaryceptionForSession({ sessionId, userId, fallbackModel: model, contextTokenLimit: 4096, force: true }), SummaryceptionInvalidatedError);
            assert.ok(called, "must reach model boundary before mutation");
            const snippets = await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, sessionId));
            assert.equal(snippets.length, 0, "late results cannot resurrect invalidated facts");
          }
        } finally { await db.delete(user).where(eq(user.id, userId)); }
      });
    }
  } finally { env.YUMINA_OPENROUTER_KEY = previousKey; await client.close(); }
});
