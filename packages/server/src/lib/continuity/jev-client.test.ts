import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decide, DecisionError, DEFAULT_DECISION_MODEL, DEFAULT_DECISION_URL } from "./jev-client.js";
import { env } from "../env.js";
import { resetPlayerKeyDenials } from "../side-call-key.js";

const originalFetch = globalThis.fetch;
const originalKey = env.YUMINA_OPENROUTER_KEY;

beforeEach(() => { (env as { YUMINA_OPENROUTER_KEY: string }).YUMINA_OPENROUTER_KEY = "test-key"; });
afterEach(() => { globalThis.fetch = originalFetch; (env as { YUMINA_OPENROUTER_KEY: string }).YUMINA_OPENROUTER_KEY = originalKey; });

const questions = { var__hp: { type: "choice" as const, instructions: "how much", criteria: { "-1": "down", "0": "same" } } };

test("sends state + questions to the decisions endpoint with the platform key and reads answers back", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({
      model: "typesafe/jev-1.13-20260917",
      answers: { var__hp: { type: "choice", choice: "-1", probabilities: { "-1": 0.9, "0": 0.1 }, confidence: 0.9 } },
      usage: { input_tokens: 321, output_tokens: 8 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const res = await decide({ state: { reply: "he bleeds" }, questions });
  assert.equal(seen?.url, DEFAULT_DECISION_URL);
  assert.equal((seen?.init.headers as Record<string, string>).Authorization, "Bearer test-key");
  const body = JSON.parse(String(seen?.init.body));
  assert.equal(body.model, DEFAULT_DECISION_MODEL);
  assert.deepEqual(body.state, { reply: "he bleeds" });
  assert.deepEqual(Object.keys(body.questions), ["var__hp"]);
  assert.equal(res.answers.var__hp?.choice, "-1");
  assert.deepEqual(res.usage, { inputTokens: 321, outputTokens: 8 });
  assert.equal(res.model, "typesafe/jev-1.13-20260917");
});

test("a slow endpoint is a timeout, never a hang", async () => {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as typeof fetch;
  await assert.rejects(decide({ state: {}, questions, timeoutMs: 20 }), (err: unknown) => err instanceof DecisionError && err.code === "timeout");
});

test("an already cancelled request never starts a provider call", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('{"answers":{}}'); }) as typeof fetch;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decide({ state: {}, questions, signal: controller.signal }), (error: unknown) => error instanceof DecisionError && error.code === "cancelled");
  assert.equal(calls, 0);
});

test("upstream errors carry a category, not the body", async () => {
  globalThis.fetch = (async () => new Response("{\"error\":{\"message\":\"boom\"}}", { status: 503 })) as typeof fetch;
  await assert.rejects(decide({ state: {}, questions }), (err: unknown) => err instanceof DecisionError && err.code === "upstream");
  globalThis.fetch = (async () => new Response("nope", { status: 429 })) as typeof fetch;
  await assert.rejects(decide({ state: {}, questions }), (err: unknown) => err instanceof DecisionError && err.code === "rate_limited");
});

test("no key configured is a clean refusal", async () => {
  (env as { YUMINA_OPENROUTER_KEY: string }).YUMINA_OPENROUTER_KEY = "";
  await assert.rejects(decide({ state: {}, questions }), (err: unknown) => err instanceof DecisionError && err.code === "no_key");
});

// ── Player's own OpenRouter key (BYOK) ──────────────────────────────

function recordingFetch(statusFor: (key: string) => number | "hang") {
  const keys: string[] = [];
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string>).Authorization).replace(/^Bearer /, "");
    keys.push(key);
    const status = statusFor(key);
    if (status === "hang") {
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); });
    }
    if (status !== 200) return Promise.resolve(new Response("{\"error\":{\"message\":\"no\"}}", { status }));
    return Promise.resolve(new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 }));
  }) as typeof fetch;
  return keys;
}

const player = { userId: "u1", apiKey: "sk-or-v1-player" };

test("a BYOK player's decision runs on their own key", async () => {
  resetPlayerKeyDenials();
  const keys = recordingFetch(() => 200);
  const res = await decide({ state: {}, questions, playerKey: player });
  assert.deepEqual(keys, ["sk-or-v1-player"]);
  assert.equal(res.keySource, "byok");
  assert.equal(res.byokFallback, undefined);
});

test("any fast failure on the player's key retries on the platform key; key refusals are remembered", async () => {
  for (const status of [401, 402, 403, 404]) {
    resetPlayerKeyDenials();
    const keys = recordingFetch((k) => (k === player.apiKey ? status : 200));
    const res = await decide({ state: {}, questions, playerKey: player });
    assert.deepEqual(keys, ["sk-or-v1-player", "test-key"], `status ${status}`);
    assert.equal(res.keySource, "platform");
    assert.ok(res.byokFallback);
    // Remembered: the next call goes straight to the platform key.
    const again = recordingFetch(() => 200);
    await decide({ state: {}, questions, playerKey: player });
    assert.deepEqual(again, ["test-key"], `status ${status} remembered`);
    // A different key for the same player is tried afresh.
    const fresh = recordingFetch(() => 200);
    await decide({ state: {}, questions, playerKey: { ...player, apiKey: "sk-or-v1-new" } });
    assert.deepEqual(fresh, ["sk-or-v1-new"]);
  }
  // Transient upstream trouble falls back too, but isn't remembered.
  resetPlayerKeyDenials();
  const keys = recordingFetch((k) => (k === player.apiKey ? 503 : 200));
  assert.equal((await decide({ state: {}, questions, playerKey: player })).keySource, "platform");
  assert.deepEqual(keys, ["sk-or-v1-player", "test-key"]);
  const again = recordingFetch(() => 200);
  await decide({ state: {}, questions, playerKey: player });
  assert.deepEqual(again, ["sk-or-v1-player"]);
});

test("a timeout on the player's key is a timeout: no platform retry, no longer wait", async () => {
  resetPlayerKeyDenials();
  const keys = recordingFetch((k) => (k === player.apiKey ? "hang" : 200));
  const t0 = Date.now();
  await assert.rejects(decide({ state: {}, questions, playerKey: player, timeoutMs: 30 }), (err: unknown) => err instanceof DecisionError && err.code === "timeout");
  assert.deepEqual(keys, ["sk-or-v1-player"]);
  assert.ok(Date.now() - t0 < 500);
});

test("the player's key never goes to a non-OpenRouter decision endpoint", async () => {
  resetPlayerKeyDenials();
  const saved = env.CONTINUITY_JEV_URL;
  (env as { CONTINUITY_JEV_URL?: string }).CONTINUITY_JEV_URL = "https://api.typesafe.example/v1/decisions";
  try {
    const keys = recordingFetch(() => 200);
    const res = await decide({ state: {}, questions, playerKey: player });
    assert.deepEqual(keys, ["test-key"]);
    assert.equal(res.keySource, "platform");
  } finally {
    (env as { CONTINUITY_JEV_URL?: string }).CONTINUITY_JEV_URL = saved;
  }
});
