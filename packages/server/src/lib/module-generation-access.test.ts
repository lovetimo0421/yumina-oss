import assert from "node:assert/strict";
import test, { before, afterEach, mock } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditWallets, modelPrices, playSessions, user, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { generateStorySummaryText } from "./session-compaction.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import { LocalBridgeProvider } from "./llm/local-bridge.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { acquireConcurrency, checkSideCallRateLimit, releaseConcurrency, SIDE_CALL_MAX_CONCURRENT, SIDE_CALL_MAX_PER_MINUTE } from "../middleware/rate-limit.js";

before(async () => {
  await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href);
  env.YUMINA_OPENROUTER_KEY = "isolated-test-key";
  await db.insert(modelPrices).values([
    { modelId: "test/free", inputPricePerM: 1, outputPricePerM: 1, minPlan: "free" },
    { modelId: "test/premium", inputPricePerM: 1, outputPricePerM: 1, minPlan: "pro" },
    { modelId: "deepseek/deepseek-v3.2", inputPricePerM: 1, outputPricePerM: 1, minPlan: "pro" },
  ]);
  invalidateModelPriceCache();
});
afterEach(() => mock.restoreAll());

async function fixture(options: { protected?: boolean; creator?: boolean; balance?: number; suspended?: boolean; private?: boolean } = {}) {
  const userId = crypto.randomUUID(), creatorId = options.creator ? userId : crypto.randomUUID();
  await db.insert(user).values([
    { id: userId, name: "Player", email: `${userId}@test.invalid`, isSuspended: options.suspended ?? false, preferences: { preferredProvider: options.private ? "private" : "official" } },
    ...(creatorId !== userId ? [{ id: creatorId, name: "Creator", email: `${creatorId}@test.invalid` }] : []),
  ]);
  await db.insert(creditWallets).values({ userId, plan: "free", balance: options.balance ?? 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) });
  const [world] = await db.insert(worlds).values({ creatorId, name: "Protected story", schema: {}, allowCustomApi: !options.protected }).returning();
  const [session] = await db.insert(playSessions).values({ userId, worldId: world!.id, state: {} }).returning();
  return { userId, sessionId: session!.id };
}

function providerMock(kind: "official" | "local" = "official", fail = false) {
  const requests: GenerateParams[] = [];
  mock.method(kind === "local" ? LocalBridgeProvider.prototype : OpenRouterProvider.prototype, "generateStream", async function* (params: GenerateParams): AsyncGenerator<StreamChunk> {
    requests.push(params);
    if (fail) throw new Error("content filter");
    yield { type: "text", content: "A usable answer." };
    yield { type: "done", content: "", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
  });
  return requests;
}

const call = (session: { userId: string; sessionId: string }, model: string, endpoint = "module-worker") => generateStorySummaryText({ ...session, model, endpoint, maxTokens: 100, prompt: [{ role: "system", content: "Private creator instructions" }] });

test("protected station prompts never reach a player's local provider", async () => {
  const session = await fixture({ protected: true, private: true });
  const requests = providerMock("local");
  await assert.rejects(call(session, "local/test"), /PROTECTED_WORLD/);
  assert.equal(requests.length, 0);
});

test("protected worlds in private mode do not silently spend official credits", async () => {
  const session = await fixture({ protected: true, private: true });
  const requests = providerMock();
  await assert.rejects(call(session, "test/free"), /PROTECTED_WORLD/);
  assert.equal(requests.length, 0);
});

for (const reason of ["MODEL_NOT_ALLOWED", "NO_CREDITS", "SUSPENDED"]) {
  test(`${reason} prevents all upstream module requests`, async () => {
    const session = await fixture({ balance: reason === "NO_CREDITS" ? 0 : 100, suspended: reason === "SUSPENDED" });
    const requests = providerMock();
    await assert.rejects(call(session, reason === "MODEL_NOT_ALLOWED" ? "test/premium" : "test/free"), new RegExp(reason));
    assert.equal(requests.length, 0);
  });
}

test("a refusal fallback must pass the same plan check", async () => {
  const session = await fixture();
  const requests = providerMock("official", true);
  await assert.rejects(call(session, "test/free"), /MODEL_NOT_ALLOWED/);
  assert.equal(requests.length, 1, "the disallowed fallback must not contact a provider");
});

for (const creator of [false, true]) {
  test(`${creator ? "protected creator" : "unprotected player"} retains uncharged local generation`, async () => {
    const session = await fixture({ protected: creator, creator, private: true, balance: 0 });
    const requests = providerMock("local");
    assert.equal(await call(session, "local/test"), "A usable answer.");
    assert.equal(requests.length, 1);
    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId, session.userId));
    assert.equal(wallet!.balance, 0);
  });
}

test("allowed official modules still generate and bill", async () => {
  const session = await fixture({ protected: true });
  const requests = providerMock();
  assert.equal(await call(session, "test/free"), "A usable answer.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.fallbackModels, undefined, "all fallback models must go through authorization");
  const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId, session.userId));
  assert.ok(wallet!.balance < 100);
});

test("a session cannot be billed to a different user", async () => {
  const session = await fixture(), other = await fixture();
  const requests = providerMock();
  await assert.rejects(call({ ...session, userId: other.userId }, "test/free"), /SESSION_NOT_FOUND/);
  assert.equal(requests.length, 0);
});

test("existing story compaction keeps its separate model policy", async () => {
  const session = await fixture();
  const requests = providerMock();
  assert.equal(await call(session, "test/premium", "story-compaction"), "A usable answer.");
  assert.equal(requests.length, 1);
});

test("a tiny positive balance cannot start a call it cannot afford", async () => {
  const session = await fixture({ balance: 0.001 });
  const requests = providerMock();
  await assert.rejects(call(session, "test/free"), /NO_CREDITS/);
  assert.equal(requests.length, 0);
});

test("modules share the bounded side-call pool and recover after it is released", async () => {
  const session = await fixture();
  const requests = providerMock();
  const key = `side:${session.userId}`;
  for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) assert.ok(await acquireConcurrency(key, SIDE_CALL_MAX_CONCURRENT));
  try {
    await assert.rejects(call(session, "test/free"), /CONCURRENT_LIMIT/);
    assert.equal(requests.length, 0);
  } finally { for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) await releaseConcurrency(key); }
  assert.equal(await call(session, "test/free"), "A usable answer.");
});

test("a provider failure always releases the module's concurrency slot", async () => {
  const session = await fixture();
  const provider = mock.method(OpenRouterProvider.prototype, "generateStream", async function* (): AsyncGenerator<StreamChunk> { throw new Error("provider unavailable"); });
  for (let i = 0; i <= SIDE_CALL_MAX_CONCURRENT; i++) await assert.rejects(call(session, "test/free"), /provider unavailable/);
  assert.equal(provider.mock.callCount(), SIDE_CALL_MAX_CONCURRENT + 1);
});

test("rate-limited modules make no upstream call", async () => {
  const session = await fixture();
  const requests = providerMock();
  for (let i = 0; i < SIDE_CALL_MAX_PER_MINUTE; i++) assert.equal(await checkSideCallRateLimit(session.userId), null);
  await assert.rejects(call(session, "test/free"), /RATE_LIMITED/);
  assert.equal(requests.length, 0);
});

test("abort during inference releases the module slot", async () => {
  const session = await fixture();
  const abort = new AbortController();
  mock.method(OpenRouterProvider.prototype, "generateStream", async function* (): AsyncGenerator<StreamChunk> {
    abort.abort(); throw abort.signal.reason;
  });
  await assert.rejects(generateStorySummaryText({ ...session, model: "test/free", endpoint: "module-worker", maxTokens: 100, prompt: [], signal: abort.signal }), { name: "AbortError" });
  const key = `side:${session.userId}`;
  let held = 0;
  try {
    for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) {
      assert.ok(await acquireConcurrency(key, SIDE_CALL_MAX_CONCURRENT)); held++;
    }
  } finally { for (let i = 0; i < held; i++) await releaseConcurrency(key); }
});
