import assert from "node:assert/strict";
import test, { before } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { apiKeys, creditTransactions, creditWallets, messages, modelPrices, playSessions, usageLogs, user, worlds } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { env } from "../lib/env.js";
import { normalizeGameState } from "../lib/game-state.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "../lib/llm/types.js";
import { invalidateModelPriceCache } from "../lib/model-price-cache.js";
import type { AppEnv } from "../lib/types.js";
import { completionRoutes } from "./completions.js";

const BUDGET_MODEL = "google/gemini-2.5-flash-lite";
const PREMIUM_MODEL = "anthropic/claude-sonnet-4.6";
const FREE_MODEL = "openrouter/free";

before(async () => {
  // The supported wrapper provisions memory-only PGlite and refuses external fetches.
  assert.equal(process.env.YUMINA_LOCAL_TEST, "1");
  assert.equal(process.env.DATABASE_URL, "");
  await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href);
  await db.insert(modelPrices).values([
    { modelId: BUDGET_MODEL, inputPricePerM: 1, outputPricePerM: 1, minPlan: "free" },
    { modelId: PREMIUM_MODEL, inputPricePerM: 3, outputPricePerM: 15, minPlan: "plus" },
    { modelId: FREE_MODEL, inputPricePerM: 0, outputPricePerM: 0, minPlan: "free" },
  ]);
  invalidateModelPriceCache();
});

function publishedSchema(worldId: string): WorldDefinition {
  return migrateWorldDefinition({
    id: worldId, version: "1.0.0", name: "Side-call clearing", description: "", author: "Another creator",
    entries: [{ id: "live-context", name: "Approved context", content: "APPROVED_CLEARING_CONTEXT", role: "custom", position: 0, section: "system-presets", enabled: true, alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all" }],
    // This matches Still's state contract without depending on a generated card file.
    variables: [{ id: "still_state", name: "The clearing", type: "json", defaultValue: {}, internal: true, aiAccess: "none" }],
    rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 2000, temperature: 0.85 },
  } as unknown as WorldDefinition);
}

async function ordinarySession(preferredProvider: "official" | "private", balance: number, allowCustomApi = true, withKey = true) {
  const account = { id: crypto.randomUUID(), name: "Ordinary free player", role: "user" };
  const creatorId = crypto.randomUUID(), worldId = crypto.randomUUID();
  await db.insert(user).values([
    { ...account, email: `${account.id}@test.local`, preferences: { preferredProvider } },
    { id: creatorId, name: "Other creator", role: "user", email: `${creatorId}@test.local` },
  ]);
  const [wallet] = await db.insert(creditWallets).values({
    userId: account.id, plan: "free", planVersion: 2, balance, addonBalance: 0,
    periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000),
  }).returning();
  if (preferredProvider === "private" && withKey) {
    const key = encryptApiKey("synthetic-ordinary-side-call-key");
    await db.insert(apiKeys).values({ userId: account.id, provider: "openrouter", encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
  }
  const schema = publishedSchema(worldId);
  await db.insert(worlds).values({ id: worldId, creatorId, name: schema.name, status: "published", isPublished: true, visibility: "public", allowCustomApi, schema: schema as unknown as Record<string, unknown> });
  const state = { worldId, variables: {}, turnCount: 7, metadata: { personaName: "Returning player" } };
  const [session] = await db.insert(playSessions).values({ userId: account.id, worldId, state }).returning();
  const app = new Hono<AppEnv>();
  // Synthetic authentication only; mount the actual completion route handlers,
  // retaining their ownership, provider, plan, balance and billing decisions.
  app.use("*", async (c, next) => { c.set("user", account as AppEnv["Variables"]["user"]); await next(); });
  const route = "/sessions/:sessionId/completions";
  for (const { handler } of completionRoutes.routes.filter(item => item.method === "POST" && item.path === route)) app.post(route, handler);
  const request = async (model: string) => {
    const response = await app.request(`/sessions/${session!.id}/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, context: "session", includeLorebook: "matched", maxTokens: 2400, responseFormat: { type: "json_object" }, messages: [{ role: "user", content: "Observe the clearing and answer with a valid direction." }] }),
    });
    return { status: response.status, body: await response.text() };
  };
  const currentWallet = async () => (await db.select().from(creditWallets).where(eq(creditWallets.id, wallet!.id)))[0]!;
  const transactions = () => db.select().from(creditTransactions).where(eq(creditTransactions.walletId, wallet!.id));
  const usage = () => db.select().from(usageLogs).where(eq(usageLogs.sessionId, session!.id));
  return { account, creatorId, worldId, schema, state, session: session!, request, currentWallet, transactions, usage };
}

test("ordinary noncreator side completions enforce official access and keep private billing independent", async t => {
  const originalKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-official-side-call-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = originalKey; });
  const observed: GenerateParams[] = [];
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (params: GenerateParams): AsyncGenerator<StreamChunk> {
    observed.push(params);
    yield { type: "text", content: '{"actions":[],"line":"I am here."}' };
    yield { type: "done", content: "", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
  });

  await t.test("a positive-balance free player can use an eligible official model and is charged once", async () => {
    const f = await ordinarySession("official", 100);
    assert.notEqual(f.account.id, f.creatorId);
    assert.equal(f.account.role, "user");
    const count = observed.length;
    const result = await f.request(BUDGET_MODEL);
    assert.equal(result.status, 200, result.body);
    assert.match(result.body, /event: done/);
    assert.doesNotMatch(result.body, /event: error/);
    assert.equal(observed.length, count + 1);
    assert.equal(observed.at(-1)!.model, BUDGET_MODEL);
    assert.deepEqual(observed.at(-1)!.responseFormat, { type: "json_object" });
    assert.match(JSON.stringify(observed.at(-1)!.messages), /APPROVED_CLEARING_CONTEXT/);
    const wallet = await f.currentWallet();
    assert.equal(wallet.plan, "free");
    assert.ok(wallet.balance < 100 && wallet.balance > 0);
    const transactions = await f.transactions();
    assert.equal(transactions.length, 1);
    assert.ok(transactions[0]!.amount < 0);
    const usage = await f.usage();
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.apiKeyTier, "free");
    assert.equal(usage[0]!.endpoint, "side-completion");
    assert.deepEqual((await db.select().from(playSessions).where(eq(playSessions.id, f.session.id)))[0]!.state, f.state);
    assert.equal((await db.select().from(messages).where(eq(messages.sessionId, f.session.id))).length, 0);
  });

  await t.test("premium selection is denied before inference and switching to an eligible model recovers", async () => {
    const f = await ordinarySession("official", 100);
    const count = observed.length;
    const denied = await f.request(PREMIUM_MODEL);
    assert.equal(denied.status, 403, denied.body);
    assert.equal(JSON.parse(denied.body).code, "MODEL_NOT_ALLOWED");
    assert.equal(observed.length, count);
    assert.equal((await f.currentWallet()).balance, 100);
    assert.deepEqual(await f.transactions(), []);
    assert.deepEqual(await f.usage(), []);
    const recovered = await f.request(FREE_MODEL);
    assert.equal(recovered.status, 200, recovered.body);
    assert.match(recovered.body, /event: done/);
    assert.equal(observed.length, count + 1);
    assert.equal(observed.at(-1)!.model, FREE_MODEL);
    assert.equal((await f.currentWallet()).balance, 100);
    assert.deepEqual(await f.transactions(), []);
  });

  await t.test("an empty official wallet rejects even a zero-priced model before inference", async () => {
    const f = await ordinarySession("official", 0);
    const count = observed.length;
    for (const model of [BUDGET_MODEL, FREE_MODEL]) {
      const denied = await f.request(model);
      assert.equal(denied.status, 402, denied.body);
      assert.equal(JSON.parse(denied.body).code, "INSUFFICIENT_CREDITS");
    }
    assert.equal(observed.length, count);
    assert.equal((await f.currentWallet()).balance, 0);
    assert.deepEqual(await f.transactions(), []);
    assert.deepEqual(await f.usage(), []);
  });

  await t.test("BYOK allows a noncreator free player with zero credits and never debits the wallet", async () => {
    const f = await ordinarySession("private", 0);
    const count = observed.length;
    const result = await f.request(PREMIUM_MODEL);
    assert.equal(result.status, 200, result.body);
    assert.match(result.body, /event: done/);
    assert.doesNotMatch(result.body, /event: error/);
    assert.equal(observed.length, count + 1);
    assert.equal(observed.at(-1)!.model, PREMIUM_MODEL);
    assert.deepEqual(observed.at(-1)!.responseFormat, { type: "json_object" });
    assert.equal((await f.currentWallet()).balance, 0);
    assert.deepEqual(await f.transactions(), []);
    const usage = await f.usage();
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.apiKeyTier, "byok");
  });

  await t.test("a protected world rejects noncreator private mode without spending official credits", async () => {
    const f = await ordinarySession("private", 100, false);
    const count = observed.length;
    const result = await f.request(BUDGET_MODEL);
    assert.equal(result.status, 403, result.body);
    assert.equal(JSON.parse(result.body).code, "PROTECTED_WORLD");
    assert.equal(observed.length, count);
    assert.equal((await f.currentWallet()).balance, 100);
    assert.deepEqual(await f.transactions(), []);
    assert.deepEqual(await f.usage(), []);
  });

  await t.test("private mode without a key never falls back to the available official key", async () => {
    const f = await ordinarySession("private", 100, true, false);
    const count = observed.length;
    const result = await f.request(BUDGET_MODEL);
    assert.equal(result.status, 400, result.body);
    assert.match(JSON.parse(result.body).error, /No API key available/);
    assert.equal(observed.length, count);
    assert.equal((await f.currentWallet()).balance, 100);
    assert.deepEqual(await f.transactions(), []);
    assert.deepEqual(await f.usage(), []);
  });
});

test("a variable-free saved session gains the clearing default without changing its identity or stored history", async () => {
  const f = await ordinarySession("official", 100);
  const [oldMessage] = await db.insert(messages).values({ sessionId: f.session.id, role: "assistant", content: "A previous conversation remains in the session." }).returning();
  const normalized = normalizeGameState(f.schema, f.state);
  assert.equal(normalized.worldId, f.worldId);
  assert.equal(normalized.turnCount, f.state.turnCount);
  assert.deepEqual(normalized.metadata, f.state.metadata);
  assert.deepEqual(normalized.variables.still_state, {});
  assert.deepEqual(f.state.variables, {}, "reading new defaults must not mutate the saved state");
  const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, f.session.id));
  assert.equal(saved!.id, f.session.id);
  assert.equal(saved!.worldId, f.worldId);
  assert.deepEqual(saved!.state, f.state);
  const history = await db.select().from(messages).where(eq(messages.sessionId, f.session.id));
  assert.equal(history.length, 1);
  assert.equal(history[0]!.id, oldMessage!.id);
  assert.equal(history[0]!.content, oldMessage!.content);
});
