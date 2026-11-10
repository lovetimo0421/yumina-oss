import assert from "node:assert/strict";
import test, { before } from "node:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { apiKeys, messages, modelPrices, playSessions, usageLogs, user, worlds } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { env } from "../lib/env.js";
import { markPlayerKeyDenied, resetPlayerKeyDenials } from "../lib/side-call-key.js";
import type { AppEnv } from "../lib/types.js";
import { USAGE_ENDPOINT_BILLING_POLICY } from "../lib/usage-log.js";
import { acquireConcurrency, releaseConcurrency, SIDE_CALL_MAX_CONCURRENT } from "../middleware/rate-limit.js";
import { completionRoutes } from "./completions.js";

before(async () => {
  await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href);
  await db.insert(modelPrices).values({ modelId: "google/gemini-2.5-flash", inputPricePerM: 1, outputPricePerM: 1, minPlan: "free" });
});

const requestBody = { state: { scene: "A waiting actor", version: 4 }, questions: { action: { type: "choice", instructions: "Pick the supported performance", criteria: { wait: "Wait quietly", bow: "Bow" } } }, narrativeModel: "google/gemini-2.5-flash" };
const answers = { action: { type: "choice", choice: "wait", probabilities: { wait: 0.9, bow: 0.1 }, confidence: 0.9 } };

test("choice-only side decisions validate and isolate each authenticated request", async t => {
  const oldEnv = { key: env.YUMINA_OPENROUTER_KEY, disabled: env.CONTINUITY_DISABLED, timeout: env.CONTINUITY_TIMEOUT_MS };
  env.YUMINA_OPENROUTER_KEY = "synthetic-platform-key"; env.CONTINUITY_DISABLED = ""; env.CONTINUITY_TIMEOUT_MS = 40;
  t.after(() => { env.YUMINA_OPENROUTER_KEY = oldEnv.key; env.CONTINUITY_DISABLED = oldEnv.disabled; env.CONTINUITY_TIMEOUT_MS = oldEnv.timeout; });
  const seen: { body: Record<string, unknown>; key: string; signal?: AbortSignal | null }[] = [];
  let result: unknown = { answers, usage: { input_tokens: 12, output_tokens: 3 } };
  let responseStatus = 200;
  let hang = false;
  let onFetch: (() => void) | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    seen.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("Authorization") ?? "", signal: init?.signal });
    onFetch?.();
    if (hang) return new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) reject(new Error("aborted"));
      else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return new Response(JSON.stringify(result), { status: responseStatus });
  });
  async function fixture(preferredProvider = "official", protectedWorld = false) {
    const userId = crypto.randomUUID(), worldId = crypto.randomUUID();
    const account = { id: userId, name: "Decision test", email: `${userId}@test.local` };
    await db.insert(user).values({ ...account, preferences: { preferredProvider } });
    const key = encryptApiKey("synthetic-player-key");
    await db.insert(apiKeys).values({ userId, provider: "openrouter", encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
    let creatorId = userId;
    if (protectedWorld) { creatorId = crypto.randomUUID(); await db.insert(user).values({ id: creatorId, name: "Creator", email: `${creatorId}@test.local` }); }
    await db.insert(worlds).values({ id: worldId, creatorId, name: "Stage", status: "draft", allowCustomApi: !protectedWorld, schema: {} });
    const state = { variables: { scene: "unchanged" }, turnCount: 4 };
    const [session] = await db.insert(playSessions).values({ userId, worldId, state }).returning();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", account as AppEnv["Variables"]["user"]);
      c.set("session", { id: "authenticated", userId, expiresAt: new Date(Date.now() + 60000), token: "test" });
      await next();
    });
    app.route("/api", completionRoutes);
    const request = (body: unknown = requestBody, options: { id?: string; signal?: AbortSignal; raw?: string } = {}) => app.request(`/api/sessions/${options.id ?? session!.id}/decisions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: options.raw ?? JSON.stringify(body), signal: options.signal,
    });
    return { request, session: session!, state, userId };
  }

  await t.test("returns only validated answers and logs platform funding without changing scene or chat", async () => {
    const f = await fixture();
    const res = await f.request();
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { answers });
    assert.deepEqual(seen.at(-1)!.body.state, requestBody.state);
    assert.deepEqual(seen.at(-1)!.body.questions, requestBody.questions);
    assert.equal(seen.at(-1)!.body.model, "typesafe/jev-1.13");
    assert.equal(seen.at(-1)!.body.narrativeModel, undefined);
    assert.equal(seen.at(-1)!.key, "Bearer synthetic-platform-key");
    const [log] = await db.select().from(usageLogs).where(and(eq(usageLogs.sessionId, f.session.id), eq(usageLogs.endpoint, "side-decision")));
    assert.equal(log?.apiKeyTier, "regular"); assert.equal(log?.promptTokens, 12);
    assert.equal(log?.analyticsWorldId, f.session.worldId);
    const [world] = await db.select({ count: worlds.messageCount }).from(worlds).where(eq(worlds.id, f.session.worldId));
    assert.equal(world?.count, 0, "internal choice checks do not count as extra narrative interactions");
    assert.equal(USAGE_ENDPOINT_BILLING_POLICY["side-decision"], "free-by-design");
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, f.session.id));
    assert.deepEqual(saved!.state, f.state);
    assert.equal((await db.select().from(messages).where(eq(messages.sessionId, f.session.id))).length, 0);
  });
  await t.test("authenticates and hides sessions belonging to another user before inference", async () => {
    const a = await fixture(), b = await fixture();
    const count = seen.length;
    const publicApp = new Hono<AppEnv>(); publicApp.route("/api", completionRoutes);
    assert.equal((await publicApp.request(`/api/sessions/${a.session.id}/decisions`, { method: "POST", body: JSON.stringify(requestBody) })).status, 401);
    assert.equal((await a.request(requestBody, { id: b.session.id })).status, 404);
    assert.equal(seen.length, count);
  });
  await t.test("rejects invalid JSON, non-choice types, excessive counts, strings, state depth and total budgets", async () => {
    const f = await fixture(), count = seen.length;
    const q = requestBody.questions.action;
    let deep: unknown = {}; for (let i = 0; i < 20; i++) deep = { x: deep };
    const cases = [null, [], {}, { ...requestBody, model: "evil/model" }, { ...requestBody, apiKey: "evil" },
      { ...requestBody, questions: {} }, { ...requestBody, state: [] }, { ...requestBody, state: { deep } },
      { ...requestBody, questions: { action: { ...q, type: "number" } } },
      { ...requestBody, questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), q])) },
      { ...requestBody, questions: { action: { ...q, criteria: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), "criterion"])) } } },
      { ...requestBody, questions: { action: { ...q, instructions: "x".repeat(4097) } } },
      { ...requestBody, questions: { action: { ...q, criteria: { wait: "x".repeat(2049) } } } },
      { ...requestBody, state: { a: "x".repeat(16001) } }, { ...requestBody, state: { a: "x".repeat(15999), b: "x".repeat(15999) } },
    ];
    for (const value of cases) assert.equal((await f.request(value)).status, 400);
    assert.equal((await f.request({}, { raw: "{" })).status, 400);
    assert.equal((await f.request({}, { raw: "x".repeat(128001) })).status, 413);
    assert.equal(seen.length, count);
  });
  await t.test("uses BYOK only when eligible and blocks private keys on protected worlds", async () => {
    resetPlayerKeyDenials();
    const f = await fixture("private"); assert.equal((await f.request()).status, 200);
    assert.equal(seen.at(-1)!.key, "Bearer synthetic-player-key");
    const [log] = await db.select().from(usageLogs).where(eq(usageLogs.sessionId, f.session.id)); assert.equal(log?.apiKeyTier, "byok");
    const protectedFixture = await fixture("private", true), count = seen.length;
    const blocked = await protectedFixture.request(); assert.equal(blocked.status, 403);
    assert.equal((await blocked.json() as { code: string }).code, "PROTECTED_WORLD"); assert.equal(seen.length, count);
  });
  await t.test("accepts an eligible OpenRouter BYOK key without any platform decision key", async () => {
    const saved = { platform: env.YUMINA_OPENROUTER_KEY, decision: env.CONTINUITY_JEV_KEY };
    env.YUMINA_OPENROUTER_KEY = ""; env.CONTINUITY_JEV_KEY = "";
    try {
      const f = await fixture("private");
      const response = await f.request();
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { answers });
      assert.equal(seen.at(-1)!.key, "Bearer synthetic-player-key");
      const [log] = await db.select().from(usageLogs).where(eq(usageLogs.sessionId, f.session.id));
      assert.equal(log?.apiKeyTier, "byok");
      const protectedFixture = await fixture("private", true), count = seen.length;
      assert.equal((await protectedFixture.request()).status, 403);
      env.CONTINUITY_DISABLED = "true";
      assert.equal((await f.request()).status, 503);
      assert.equal(seen.length, count);
    } finally {
      env.YUMINA_OPENROUTER_KEY = saved.platform; env.CONTINUITY_JEV_KEY = saved.decision; env.CONTINUITY_DISABLED = "";
    }
  });
  await t.test("a private key is unavailable when the decision endpoint is not OpenRouter or previously refused it", async () => {
    const saved = { platform: env.YUMINA_OPENROUTER_KEY, decision: env.CONTINUITY_JEV_KEY, url: env.CONTINUITY_JEV_URL };
    env.YUMINA_OPENROUTER_KEY = ""; env.CONTINUITY_JEV_KEY = "";
    try {
      const f = await fixture("private"), count = seen.length;
      env.CONTINUITY_JEV_URL = "https://api.typesafe.example/v1/decisions";
      assert.equal((await f.request()).status, 503);
      env.CONTINUITY_JEV_URL = "";
      markPlayerKeyDenied({ userId: f.userId, apiKey: "synthetic-player-key" }, "decisions");
      assert.equal((await f.request()).status, 503);
      assert.equal(seen.length, count);
    } finally {
      env.YUMINA_OPENROUTER_KEY = saved.platform; env.CONTINUITY_JEV_KEY = saved.decision; env.CONTINUITY_JEV_URL = saved.url;
      resetPlayerKeyDenials();
    }
  });
  await t.test("rejects missing or unknown answer metadata and never leaks provider error bodies", async () => {
    const f = await fixture();
    for (const invalid of [undefined, {}, { ...answers.action, confidence: undefined }, { ...answers.action, confidence: "0.9" }, { ...answers.action, choice: "unknown" }, { ...answers.action, probabilities: { wait: 1.1, bow: 0 } }, { ...answers.action, probabilities: { wait: 0.9 } }, { ...answers.action, probabilities: { wait: 0.9, bow: 0.1, unknown: 0 } }, { ...answers.action, type: "boolean" }]) {
      result = { answers: { action: invalid }, usage: { input_tokens: 12, output_tokens: 3 } };
      const response = await f.request(); assert.equal(response.status, 502, await response.clone().text());
      assert.equal((await response.json() as { code: string }).code, "INVALID_DECISION_RESPONSE");
    }
    result = { error: "synthetic-secret-echo" }; responseStatus = 503;
    const error = await f.request(); assert.equal(error.status, 502); assert.doesNotMatch(await error.text(), /synthetic-secret-echo/);
    // Rejected metadata and provider errors must release every acquired slot.
    for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) assert.equal(await acquireConcurrency(`side:${f.userId}`, SIDE_CALL_MAX_CONCURRENT), true);
    for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) await releaseConcurrency(`side:${f.userId}`);
    result = { answers }; responseStatus = 200;
  });
  await t.test("honors disable/configuration and rejects an already cancelled request without inference", async () => {
    const f = await fixture(), count = seen.length;
    env.CONTINUITY_DISABLED = "true";
    assert.equal((await f.request()).status, 503); env.CONTINUITY_DISABLED = "";
    // No platform key AND no stored player key is truly unconfigured.
    await db.delete(apiKeys).where(eq(apiKeys.userId, f.userId));
    env.YUMINA_OPENROUTER_KEY = "";
    assert.equal((await f.request()).status, 503); env.YUMINA_OPENROUTER_KEY = "synthetic-platform-key";
    const controller = new AbortController(); controller.abort();
    assert.equal((await f.request(requestBody, { signal: controller.signal })).status, 408);
    assert.equal(seen.length, count);
  });
  await t.test("deadlines and disconnects release concurrency; the pool is shared with completions", async () => {
    const f = await fixture(); hang = true;
    assert.equal((await f.request()).status, 504);
    const controller = new AbortController(); onFetch = () => controller.abort();
    assert.equal((await f.request(requestBody, { signal: controller.signal })).status, 408);
    onFetch = undefined; hang = false;
    for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) assert.equal(await acquireConcurrency(`side:${f.userId}`, SIDE_CALL_MAX_CONCURRENT), true);
    try { const blocked = await f.request(); assert.equal(blocked.status, 429); assert.equal((await blocked.json() as { code: string }).code, "CONCURRENT_LIMIT"); }
    finally { for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) await releaseConcurrency(`side:${f.userId}`); }
    assert.equal((await f.request()).status, 200);
  });
  await t.test("caps platform-funded decisions at twenty requests per minute per user", async () => {
    const f = await fixture();
    for (let i = 0; i < 20; i++) assert.equal((await f.request()).status, 200);
    const count = seen.length, limited = await f.request(); assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("Retry-After")) > 0); assert.equal(seen.length, count);
  });
});
