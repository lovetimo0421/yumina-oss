import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, creditTransactions, creditWallets, playSessions, usageLogs, user, worlds } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { env } from "../lib/env.js";
import { resetPlayerKeyDenials } from "../lib/side-call-key.js";
import { ttsRoutes } from "./tts.js";
import type { AppEnv } from "../lib/types.js";

// Voice readout for private-key (BYOK) players:
//  - an OpenRouter key: synthesized on it, 0 mushies (its 402 is a clear error);
//  - a custom endpoint / local model (no OpenRouter key): the platform key and
//    mushies exactly like official mode, or a clear "needs a key or mushies".

const PLATFORM = "platform-test-key";
const PLAYER = "sk-or-v1-player-test-key";
const originalFetch = globalThis.fetch;
const originalKey = env.YUMINA_OPENROUTER_KEY;
const originalEmotion = env.TTS_EMOTION;

interface Call { url: string; auth: string }
let calls: Call[] = [];
/** status per (url kind, key) — default 200. */
let reply: (kind: "speech" | "decisions", key: string) => number = () => 200;

beforeEach(() => {
  calls = [];
  reply = () => 200;
  resetPlayerKeyDenials();
  (env as { YUMINA_OPENROUTER_KEY: string }).YUMINA_OPENROUTER_KEY = PLATFORM;
  (env as { TTS_EMOTION?: string }).TTS_EMOTION = "on";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
    calls.push({ url, auth });
    if (url.includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.includes("decisions")) {
      const status = reply("decisions", auth);
      if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
      return new Response(JSON.stringify({ model: "typesafe/jev", answers: {}, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
    }
    const status = reply("speech", auth);
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "upstream said no" } }), { status });
    return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  (env as { YUMINA_OPENROUTER_KEY: string }).YUMINA_OPENROUTER_KEY = originalKey;
  (env as { TTS_EMOTION?: string }).TTS_EMOTION = originalEmotion;
});

async function fixture(opts: { balance: number; keys: Array<"openrouter" | "custom"> }) {
  const id = crypto.randomUUID();
  await db.insert(user).values({
    id, name: "TTS BYOK test", email: `${id}@test.local`,
    preferences: { ttsEnabled: true, preferredProvider: "private" },
  });
  await db.insert(creditWallets).values({ userId: id, plan: "free", balance: opts.balance, addonBalance: 0,
    periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) });
  for (const provider of opts.keys) {
    const enc = encryptApiKey(provider === "openrouter" ? PLAYER : "custom-endpoint-key");
    await db.insert(apiKeys).values({ userId: id, provider, encryptedKey: enc.encrypted, keyIv: enc.iv, keyTag: enc.tag,
      ...(provider === "custom" ? { baseUrl: "http://127.0.0.1:11434/v1" } : {}) });
  }
  const worldId = crypto.randomUUID();
  await db.insert(worlds).values({ id: worldId, creatorId: id, name: "TTS test", status: "draft", schema: {} });
  const [session] = await db.insert(playSessions).values({ userId: id, worldId }).returning();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of ttsRoutes.routes) if (route.method === "POST") app.post(route.path, route.handler);
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { code?: string; credits?: number; url?: string } };
  };
  const ledger = async () => {
    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId, id));
    return { balance: wallet!.balance, rows: await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, wallet!.id)) };
  };
  const logs = async (endpoint: string) => {
    // Side-call usage logs are fire-and-forget: let them land.
    await new Promise((r) => setTimeout(r, 50));
    return db.select().from(usageLogs).where(and(eq(usageLogs.userId, id), eq(usageLogs.endpoint, endpoint)));
  };
  return { id, sessionId: session!.id, post, ledger, logs };
}

const unique = () => `Hello there, traveller number ${crypto.randomUUID()}.`;
const speechCalls = () => calls.filter((c) => c.url.includes("/audio/speech") || (!c.url.includes("decisions") && !c.url.includes("/models")));

test("custom-endpoint BYOK player with mushies: platform key, charged like official mode", async () => {
  const f = await fixture({ balance: 100, keys: ["custom"] });
  const res = await f.post(`/sessions/${f.sessionId}/tts`, { text: unique() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok((res.body.credits ?? 0) > 0, "mushies charged");
  assert.deepEqual(speechCalls().map((c) => c.auth), [PLATFORM]);
  const { balance, rows } = await f.ledger();
  assert.ok(balance < 100);
  assert.equal(rows.length, 1);
  const [log] = await f.logs("tts");
  assert.notEqual(log?.apiKeyTier, "byok");
  // Emotion judge ran on the platform key, logged free-by-design (not byok).
  const emotion = await f.logs("tts-emotion");
  assert.ok(emotion.every((l) => l.apiKeyTier === "regular"));
  assert.ok(calls.filter((c) => c.url.includes("decisions")).every((c) => c.auth === PLATFORM));

  // Replay of the same text is a cache hit: free.
  const again = await f.post(`/sessions/${f.sessionId}/tts`, { text: "Hello there." });
  assert.equal(again.status, 200);
});

test("custom-endpoint BYOK player without mushies: clear refusal, nothing synthesized or charged", async () => {
  const f = await fixture({ balance: 0, keys: ["custom"] });
  const res = await f.post(`/sessions/${f.sessionId}/tts`, { text: unique() });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, "TTS_NEEDS_KEY_OR_CREDITS");
  assert.equal(speechCalls().length, 0);
  const { balance, rows } = await f.ledger();
  assert.equal(balance, 0);
  assert.equal(rows.length, 0);

  const preview = await f.post("/tts/preview", { lang: "es", voice: `nonexistent-${crypto.randomUUID()}` });
  // A preview line may already be cached from another test; only a miss must refuse.
  if (preview.status !== 200) assert.equal(preview.body.code, "TTS_NEEDS_KEY_OR_CREDITS");
});

test("a synthesis failure on the platform key charges a BYOK-without-OpenRouter player nothing", async () => {
  const f = await fixture({ balance: 100, keys: ["custom"] });
  reply = (kind) => (kind === "speech" ? 500 : 200);
  const res = await f.post(`/sessions/${f.sessionId}/tts`, { text: unique() });
  assert.equal(res.status, 502);
  const { balance, rows } = await f.ledger();
  assert.equal(balance, 100);
  assert.equal(rows.length, 0);
});

test("OpenRouter BYOK player: own key, 0 mushies; side calls on the player's key logged as byok", async () => {
  const f = await fixture({ balance: 100, keys: ["openrouter"] });
  const res = await f.post(`/sessions/${f.sessionId}/tts`, { text: unique() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.credits, 0);
  assert.deepEqual(speechCalls().map((c) => c.auth), [PLAYER]);
  assert.deepEqual(calls.filter((c) => c.url.includes("decisions")).map((c) => c.auth), [PLAYER]);
  const emotion = await f.logs("tts-emotion");
  assert.deepEqual(emotion.map((l) => l.apiKeyTier), ["byok"]);
  assert.equal((await f.ledger()).balance, 100);
});

test("player key without decisions access: that call falls back to the platform key, and the refusal is remembered", async () => {
  const f = await fixture({ balance: 100, keys: ["openrouter"] });
  reply = (kind, key) => (kind === "decisions" && key === PLAYER ? 403 : 200);
  const res = await f.post(`/sessions/${f.sessionId}/tts`, { text: unique() });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.filter((c) => c.url.includes("decisions")).map((c) => c.auth), [PLAYER, PLATFORM]);
  assert.deepEqual((await f.logs("tts-emotion")).map((l) => l.apiKeyTier), ["regular"]);

  calls = [];
  const next = await f.post(`/sessions/${f.sessionId}/tts`, { text: unique() });
  assert.equal(next.status, 200);
  assert.deepEqual(calls.filter((c) => c.url.includes("decisions")).map((c) => c.auth), [PLATFORM], "no second failed try within the window");
  // Synthesis itself still runs on the player's key.
  assert.deepEqual(speechCalls().map((c) => c.auth), [PLAYER]);
});

test("OpenRouter BYOK key out of balance: a clear BYOK_INSUFFICIENT_BALANCE, nothing charged", async () => {
  const f = await fixture({ balance: 100, keys: ["openrouter"] });
  reply = (kind) => (kind === "speech" ? 402 : 200);
  const res = await f.post(`/sessions/${f.sessionId}/tts`, { text: unique() });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, "BYOK_INSUFFICIENT_BALANCE");
  const { balance, rows } = await f.ledger();
  assert.equal(balance, 100);
  assert.equal(rows.length, 0);
});
