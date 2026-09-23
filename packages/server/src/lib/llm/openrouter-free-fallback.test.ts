import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterProvider } from "./openrouter.js";
import { getOfficialProviderFallbackModels, FREE_ROUTER_MODEL } from "./fallback-models.js";
import type { StreamChunk } from "./types.js";

/**
 * End-to-end cover for the free-pool fallback: the pure helpers are tested in
 * fallback-models.test.ts, but only this proves the provider actually re-runs
 * the turn on the next model instead of surfacing the error.
 */

/** The real body OpenRouter returns when the account-wide free pool is spent. */
const FREE_POOL_429 = JSON.stringify({
  error: {
    message: "Rate limit exceeded: free-models-per-day-high-balance.",
    code: 429,
  },
});

const THROTTLE_429 = JSON.stringify({
  error: {
    message: "Provider returned error",
    code: 429,
    metadata: {
      raw: "qwen/qwen3-30b-a3b-instruct-2507 is temporarily rate-limited upstream. Please retry shortly.",
      provider_name: "SiliconFlow",
    },
  },
});

function sseResponse(payloads: unknown[]): Response {
  const body =
    payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function reply(text: string): Response {
  return sseResponse([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
}

function jsonReply(text: string): Response {
  return Response.json({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

/** Records the `model` of each upstream call so we can assert the chain order. */
function withMockedFetch(responses: Array<() => Response>) {
  const original = globalThis.fetch;
  const models: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    models.push(String(body.model));
    return responses[Math.min(models.length - 1, responses.length - 1)]!();
  }) as typeof fetch;
  return { models: () => models, bodies: () => bodies, restore: () => { globalThis.fetch = original; } };
}

function freeParams(overrides: Record<string, unknown> = {}) {
  return {
    model: FREE_ROUTER_MODEL,
    messages: [{ role: "user" as const, content: "hi" }],
    fallbackModels: getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false),
    fallbackOnTransientErrors: true,
    ...overrides,
  };
}

test("an exhausted free pool re-runs the turn on the paid fallback", async () => {
  const mock = withMockedFetch([
    () => errorResponse(429, FREE_POOL_429),
    () => reply("the story continues"),
  ]);
  try {
    const chunks = await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream(freeParams()));
    const [first, second] = mock.models();
    assert.equal(first, FREE_ROUTER_MODEL);
    assert.equal(second, "qwen/qwen3-30b-a3b-instruct-2507", "should descend to the primary fallback");

    const text = chunks.filter((c) => c.type === "text").map((c) => c.content).join("");
    assert.equal(text, "the story continues");
    assert.equal(chunks.every((c) => c.type !== "error"), true, "player must not see an error");
    // The caller keys billing/labelling off this — it has to name the model that
    // actually served the turn.
    assert.equal(
      chunks.find((c) => c.model)?.model,
      "qwen/qwen3-30b-a3b-instruct-2507",
    );
  } finally {
    mock.restore();
  }
});

test("a throttled primary keeps descending to the last rung", async () => {
  // The scenario the last rung exists for: free pool empty AND the primary
  // throttled by the whole free tier piling onto it at once.
  const mock = withMockedFetch([
    () => errorResponse(429, FREE_POOL_429),
    () => errorResponse(429, THROTTLE_429),
    () => reply("still playing"),
  ]);
  try {
    const chunks = await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream(freeParams()));
    assert.deepEqual(mock.models(), [
      FREE_ROUTER_MODEL,
      "qwen/qwen3-30b-a3b-instruct-2507",
      "qwen/qwen3-235b-a22b-2507",
    ]);
    const text = chunks.filter((c) => c.type === "text").map((c) => c.content).join("");
    assert.equal(text, "still playing");
  } finally {
    mock.restore();
  }
});

test("a rung whose model id was retired upstream is stepped over, not fatal", async () => {
  // The 2026-08-25 outage, replayed: OpenRouter dropped every provider endpoint
  // from the first rung's id, so it started 404ing. The chain used to stop dead
  // there and hand the player OpenRouter's raw "no longer available as a free
  // model" text while a healthy rung sat unused underneath.
  const RETIRED_404 = JSON.stringify({
    error: {
      message:
        "Ling-2.6-flash is no longer available as a free model. It has transitioned to a paid model. Continue using it here: https://openrouter.ai/inclusionai/ling-2.6-flash",
      code: 404,
    },
  });
  const mock = withMockedFetch([
    () => errorResponse(429, FREE_POOL_429),
    () => errorResponse(404, RETIRED_404),
    () => reply("the story continues"),
  ]);
  try {
    const chunks = await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream(freeParams()));
    assert.deepEqual(mock.models(), [
      FREE_ROUTER_MODEL,
      "qwen/qwen3-30b-a3b-instruct-2507",
      "qwen/qwen3-235b-a22b-2507",
    ]);
    const text = chunks.filter((c) => c.type === "text").map((c) => c.content).join("");
    assert.equal(text, "the story continues");
    assert.equal(chunks.every((c) => c.type !== "error"), true, "player must not see the 404");
  } finally {
    mock.restore();
  }
});

test("once the chain is spent the real error surfaces", async () => {
  const mock = withMockedFetch([() => errorResponse(429, FREE_POOL_429), () => errorResponse(429, THROTTLE_429)]);
  try {
    const chunks = await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream(freeParams()));
    const err = chunks.find((c) => c.type === "error");
    assert.ok(err, "the player must get a real error rather than silence");
    // Three calls: free router, primary, second rung — then nothing left.
    assert.equal(mock.models().length, 3);
  } finally {
    mock.restore();
  }
});

test("a paid model is NOT swapped out when it is merely throttled", async () => {
  // The guard that keeps this feature scoped to the free tier.
  const mock = withMockedFetch([() => errorResponse(429, THROTTLE_429), () => reply("should never run")]);
  try {
    const chunks = await collect(
      new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({
        model: "deepseek/deepseek-v3.2",
        messages: [{ role: "user" as const, content: "hi" }],
        fallbackModels: getOfficialProviderFallbackModels("deepseek/deepseek-v3.2", false),
        fallbackOnTransientErrors: false,
      }),
    );
    assert.deepEqual(mock.models(), ["deepseek/deepseek-v3.2"], "no second call");
    assert.ok(chunks.find((c) => c.type === "error"));
  } finally {
    mock.restore();
  }
});

test("a free turn with an image goes straight to the vision fallback", async () => {
  const mock = withMockedFetch([() => errorResponse(429, FREE_POOL_429), () => reply("i see it")]);
  try {
    await collect(
      new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream(
        freeParams({
          fallbackModels: getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false, true),
        }),
      ),
    );
    assert.deepEqual(mock.models(), [
      FREE_ROUTER_MODEL,
      // Never a text-only rung — those 400 on the image part.
      "qwen/qwen3-vl-30b-a3b-instruct",
    ]);
  } finally {
    mock.restore();
  }
});

test("a throttled vision rung descends to the other vision model, never to text", async () => {
  // The vision path used to be one rung deep, so a throttled first choice ended
  // the turn. It now degrades — but only across models that actually take images.
  const mock = withMockedFetch([
    () => errorResponse(429, FREE_POOL_429),
    () => errorResponse(429, THROTTLE_429),
    () => reply("i still see it"),
  ]);
  try {
    const chunks = await collect(
      new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream(
        freeParams({
          fallbackModels: getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false, true),
        }),
      ),
    );
    assert.deepEqual(mock.models(), [
      FREE_ROUTER_MODEL,
      "qwen/qwen3-vl-30b-a3b-instruct",
      "mistralai/mistral-small-3.2-24b-instruct",
    ]);
    const text = chunks.filter((c) => c.type === "text").map((c) => c.content).join("");
    assert.equal(text, "i still see it");
  } finally {
    mock.restore();
  }
});

test("OpenRouter sends explicit none reasoning effort instead of using the model default", async () => {
  const mock = withMockedFetch([() => reply("summary")]);
  try {
    await collect(
      new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "summarize" }],
        maxTokens: 1_200,
        reasoningEffort: "high",
        disableReasoning: true,
        singleAttempt: true,
      }),
    );
    assert.deepEqual(mock.bodies()[0]?.reasoning, { effort: "none" });
    assert.equal(mock.bodies()[0]?.max_tokens, 1_200, "disabled reasoning must not reserve hidden headroom");
  } finally {
    mock.restore();
  }
});

test("OpenRouter keeps ordinary chat reasoning effort and headroom unchanged", async () => {
  const mock = withMockedFetch([() => reply("answer")]);
  try {
    await collect(
      new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "solve" }],
        maxTokens: 1_200,
        reasoningEffort: "high",
        singleAttempt: true,
      }),
    );
    assert.deepEqual(mock.bodies()[0]?.reasoning, { effort: "high" });
    assert.ok(Number(mock.bodies()[0]?.max_tokens) > 1_200);
  } finally {
    mock.restore();
  }
});

test("OpenRouter also disables reasoning without headroom in non-streaming mode", async () => {
  const mock = withMockedFetch([() => jsonReply("summary")]);
  try {
    await collect(
      new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "summarize" }],
        maxTokens: 1_200,
        reasoningEffort: "high",
        disableReasoning: true,
        singleAttempt: true,
        stream: false,
      }),
    );
    assert.deepEqual(mock.bodies()[0]?.reasoning, { effort: "none" });
    assert.equal(mock.bodies()[0]?.max_tokens, 1_200);
    assert.equal(mock.bodies()[0]?.stream, false);
  } finally {
    mock.restore();
  }
});
