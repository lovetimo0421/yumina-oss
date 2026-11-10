import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { db } from "../db/index.js";
import { creditWallets, messages, modelPrices, playSessions, user, userExtensions, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { regenerateSessionMemoryForSession, scheduleSessionMemoryRepair } from "./session-memory.js";

// A rebuild re-reads the whole chat. The system may start one on its own only
// on the default model and only while it is cheap; on a long chat it waits for
// the player, who rebuilds on their own model from the memory panel.

const defaultModel = "google/gemini-3.1-flash-lite";
const playerModel = "minimax/minimax-m3";
const rebuilt = "Core facts:\n- The visitor waits for tea.";
// ~2,000 tokens a message by the character heuristic.
const filler = "The visitor waits quietly while the barista warms the tea. ".repeat(136);
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

async function fixture(count: number, long: boolean) {
  const uid = randomUUID();
  await db.insert(user).values({ id: uid, name: "Rebuild", email: `${uid}@example.test` });
  await db.insert(creditWallets).values({ userId: uid, balance: 100000, addonBalance: 0 });
  await db.insert(userExtensions).values({ userId: uid, extensionKey: SESSION_MEMORY_EXTENSION_KEY, status: "installed" });
  const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Cafe", schema: { name: "Cafe", entries: [], variables: [] } }).returning();
  const ids = Array.from({ length: count }, () => randomUUID());
  const [session] = await db.insert(playSessions).values({
    userId: uid, worldId: world!.id, state: {}, sessionMemory: { text: "Core facts:\n- Old fact." },
    sessionMemoryModel: playerModel, sessionMemoryIncluded: true, sessionMemoryStatus: "idle",
    sessionMemoryStaleAt: new Date(),
  }).returning();
  await db.insert(messages).values(ids.map((id, i) => ({
    id, sessionId: session!.id, role: i % 2 ? "user" as const : "assistant" as const,
    content: `Turn ${i}. ${long ? filler : "The visitor waits."}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
  })));
  return { uid, sid: session!.id };
}

function mockProvider(t: TestContext) {
  const models: string[] = [];
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
    models.push(p.model);
    yield { type: "text", content: rebuilt };
    yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
  });
  return models;
}

async function settled(sid: string) {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.select().from(playSessions).where(eq(playSessions.id, sid));
    if (row!.sessionMemoryStatus !== "updating" && (row!.sessionMemoryStatus === "failed" || !row!.sessionMemoryStaleAt)) return row!;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("memory job never settled");
}

test("automatic memory rebuilds run cheap or wait for the player", async t => {
  assert.equal(env.DATABASE_URL, undefined);
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "test-only-key-never-sent";
  await db.insert(modelPrices).values([
    { modelId: defaultModel, inputPricePerM: 1, outputPricePerM: 1 },
    { modelId: playerModel, inputPricePerM: 1, outputPricePerM: 1 },
  ]).onConflictDoNothing();
  await invalidateModelPriceCache();
  try {
    await t.test("a short chat rebuilds on its own, on the default model, keeping the player's pick", async st => {
      const f = await fixture(6, false);
      const models = mockProvider(st);
      await scheduleSessionMemoryRepair(f.sid);
      const row = await settled(f.sid);
      assert.equal(row.sessionMemoryStatus, "idle");
      assert.equal((row.sessionMemory as { text: string }).text, rebuilt);
      assert.ok(models.length > 0 && models.every(m => m === defaultModel), `ran on ${models.join(", ")}`);
      assert.equal(row.sessionMemoryModel, playerModel);
    });

    await t.test("a long chat does not rebuild on its own and says what it would cost", async st => {
      const f = await fixture(20, true);
      const models = mockProvider(st);
      await scheduleSessionMemoryRepair(f.sid);
      const row = await settled(f.sid);
      assert.equal(models.length, 0, "no paid call");
      assert.equal(row.sessionMemoryStatus, "failed");
      assert.match(row.sessionMemoryError ?? "", /would cost about \d+ mushies.*memory panel/);
      assert.equal(row.sessionMemoryModel, playerModel);
      assert.equal((row.sessionMemory as { text: string }).text, "Core facts:\n- Old fact.", "old memory kept");
    });

    await t.test("the player's own rebuild runs on a long chat, on their model", async st => {
      const f = await fixture(20, true);
      const models = mockProvider(st);
      await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid });
      const [row] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
      assert.equal((row!.sessionMemory as { text: string }).text, rebuilt);
      assert.ok(models.length > 0 && models.every(m => m === playerModel), `ran on ${models.join(", ")}`);
    });
  } finally {
    env.YUMINA_OPENROUTER_KEY = oldKey;
  }
});
