import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { creditWallets, messages, modelPrices, playSessions, user, userExtensions, userPersonas, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { applyPersonaMetadataToState } from "./persona-metadata.js";
import { setSessionPersonaLock } from "./resolve-persona.js";
import { regenerateStorySummaryForSession } from "./session-compaction.js";
import { regenerateSessionMemoryForSession, retrySessionMemoryForSession, scheduleSessionMemoryIncrementalUpdate } from "./session-memory.js";

const model = "google/gemini-3.1-flash-lite";
const output = "## Story So Far\nThe cafe is open.\n## Major Open Threads\n- A visitor is waiting for tea.\n## Important Past Events\n- The door was unlocked.";

// Exercise real database selection, persona switching, job queues and persistence.
// Only the model boundary is stubbed; no customer data or external services.
test("persona snapshots are not narrative evidence for memory or story summaries", async (t) => {
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PGLITE_DATA_DIR, "memory://");
  const client = (db as unknown as { $client: PGlite }).$client;
  const migration = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  for (const statement of migration) await client.exec(statement);
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 2 });
  await invalidateModelPriceCache();
  const previousKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "test-only-never-sent-key";
  try {
    for (const mode of ["automatic", "retry", "rebuild", "story"] as const) {
      await t.test(mode, async (st) => {
        const userId = `persona-summary-${randomUUID()}`;
        const sessionId = randomUUID();
        const greetingId = randomUUID();
        const newestId = randomUUID();
        const calls: GenerateParams[] = [];
        st.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (params: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(params);
          yield { type: "text", content: output };
          yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 100, completionTokens: 60, totalTokens: 160 } };
        });
        await db.insert(user).values({ id: userId, name: "Fixture", email: `${userId}@example.com` });
        try {
          await db.insert(creditWallets).values({ userId, balance: 100, addonBalance: 100 });
          await db.insert(userExtensions).values({ userId, extensionKey: SESSION_MEMORY_EXTENSION_KEY, status: "installed" });
          const [world] = await db.insert(worlds).values({ creatorId: userId, name: "Cafe", schema: { name: "Cafe", entries: [], variables: [] } }).returning();
          const [oldPersona, newPersona] = await db.insert(userPersonas).values([
            { userId, name: "OldPersonaMarker", isActive: true, appearance: "OldAppearanceMarker", personality: "OldPersonalityMarker", backstory: "OldBackstoryMarker ".repeat(700), avatarUrl: "OldImageMarker", entries: [{ title: "OldEntryMarker", content: "OldEntryContentMarker" }] },
            { userId, name: "NewPersonaMarker", backstory: "NewBackstoryMarker" },
          ]).returning();
          // This is how session creation captures the account persona in the greeting.
          // Metadata goes first to catch filtering after the 8k truncation boundary.
          const greetingState = { metadata: { location: "CafeStateMarker" }, variables: { coins: 3 }, turnCount: 0 };
          applyPersonaMetadataToState(greetingState, oldPersona!, { name: "Fixture" });
          const originalSnapshot = structuredClone(greetingState);
          await db.insert(playSessions).values({ id: sessionId, userId, worldId: world!.id, state: greetingState, sessionMemoryIncluded: true, sessionMemoryModel: model, summaryModel: model, summaryLanguage: "en" });
          await db.insert(messages).values({ id: greetingId, sessionId, role: "assistant", content: ".", stateSnapshot: greetingState, createdAt: new Date("2026-10-01T00:00:00Z") });
          // Switch before the first user message, as in the reported incident.
          const selected = await setSessionPersonaLock(userId, sessionId, true, newPersona!.id);
          assert.equal(selected.error, undefined);
          const currentState = { metadata: {}, variables: { coins: 99, secret: "NewestStateMarker" }, turnCount: 1 };
          applyPersonaMetadataToState(currentState, newPersona!, { name: "Fixture" });
          await db.update(playSessions).set({ state: mode === "story" ? greetingState : currentState }).where(eq(playSessions.id, sessionId));
          await db.insert(messages).values([
            { sessionId, role: "user", content: "FirstUserMarker: Hello.", createdAt: new Date("2026-10-01T00:00:01Z") },
            { id: newestId, sessionId, role: "assistant", content: "NewestReplyMarker: Welcome.", stateSnapshot: mode === "story" ? greetingState : currentState, createdAt: new Date("2026-10-01T00:00:02Z") },
          ]);
          const session = async () => (await db.select().from(playSessions).where(eq(playSessions.id, sessionId)))[0]!;
          if (mode === "automatic") {
            scheduleSessionMemoryIncrementalUpdate({ sessionId, userId, userMessage: "FirstUserMarker: Hello.", assistantMessage: "NewestReplyMarker: Welcome.", assistantMessageId: newestId, state: currentState, fallbackModel: model });
            const deadline = Date.now() + 10_000;
            while (!(await session()).sessionMemoryProcessedMessageId && Date.now() < deadline) await delay(20);
          } else if (mode === "retry") {
            await db.update(playSessions).set({ sessionMemoryStatus: "failed", sessionMemorySourceHash: "v2:fixture-failed-job" }).where(eq(playSessions.id, sessionId));
            await retrySessionMemoryForSession({ sessionId, userId });
          } else if (mode === "rebuild") {
            await regenerateSessionMemoryForSession({ sessionId, userId });
          } else {
            await regenerateStorySummaryForSession({ sessionId, userId });
          }
          const saved = await session();
          assert.equal(saved.sessionPersona?.persona?.id, newPersona!.id);
          assert.equal(saved.personaLocked, true);
          assert.equal(saved[mode === "story" ? "summaryStatus" : "sessionMemoryStatus"], "idle");
          if (mode === "story") assert.ok(saved.summary?.includes("The cafe is open."));
          else {
            assert.equal(saved.sessionMemoryProcessedMessageId, greetingId);
            assert.ok(saved.sessionMemory?.text.includes("The cafe is open."));
          }
          assert.ok(calls.length > 0, "must exercise the actual provider boundary");
          const prompt = JSON.stringify(calls.map(call => call.messages));
          assert.doesNotMatch(prompt, /Old(?:Persona|Appearance|Personality|Backstory|Image|Entry|EntryContent)Marker|New(?:Persona|Backstory)Marker/);
          assert.ok(prompt.includes("CafeStateMarker"), "keep narrative metadata even after a large persona block");
          assert.ok(prompt.includes('\\"coins\\": 3'), "keep gameplay variables from the selected state");
          if (mode !== "story") assert.doesNotMatch(prompt, /FirstUserMarker|NewestReplyMarker|NewestStateMarker/, "memory must still lag one reply");
          const [greeting] = await db.select().from(messages).where(eq(messages.id, greetingId));
          assert.deepEqual(greeting!.stateSnapshot, originalSnapshot, "historical snapshots must remain intact for rewind");
        } finally { await db.delete(user).where(eq(user.id, userId)); }
      });
    }
  } finally {
    env.YUMINA_OPENROUTER_KEY = previousKey;
    await client.close();
  }
});
