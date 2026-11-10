import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenerateParams, LLMProvider, StreamChunk } from "../llm/types.js";
import { generateStreamWithRetry } from "./generate-stream-with-retry.js";

const params: GenerateParams = { model: "test-model", messages: [] };

function mockProvider(generateStream: LLMProvider["generateStream"]): LLMProvider {
  return { generateStream, listModels: async () => [] };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const partialChunks: StreamChunk[] = [
  { type: "text", content: "I will update" },
  { type: "reasoning", content: "Checking the component" },
  { type: "tool_call_start", content: "", toolCallId: "write-1", toolCallName: "write_custom_ui", toolCallIndex: 0 },
  { type: "tool_call_delta", content: '{"id":"index.tsx"', toolCallIndex: 0 },
  { type: "tool_call_end", content: "", toolCallIndex: 0, toolCall: {
    id: "write-1", type: "function", function: { name: "write_custom_ui", arguments: '{"id":"index.tsx","code":"export default () => null"}' },
  } },
];

for (const partial of partialChunks) {
  test(`does not resend a generation after a ${partial.type} chunk and network exception`, async () => {
    let calls = 0;
    const failure = new Error("ECONNRESET network connection");
    const provider = mockProvider(async function* () {
      calls++;
      yield partial;
      if (calls === 1) throw failure;
      yield { type: "done", content: "" };
    });
    const observed: StreamChunk[] = [];
    await assert.rejects(async () => {
      for await (const chunk of generateStreamWithRetry(provider, params, 1)) observed.push(chunk);
    }, failure);
    assert.equal(calls, 1, "retrying would mix separate generations and may duplicate writes");
    assert.deepEqual(observed, [partial]);
  });
}

for (const failureMode of ["throw", "error-chunk"] as const) {
  test(`retries a transient ${failureMode} before the first chunk`, async () => {
    let calls = 0;
    const provider = mockProvider(async function* () {
      calls++;
      if (calls === 1) {
        if (failureMode === "throw") throw new Error("503 upstream unavailable");
        yield { type: "error", content: "503 upstream unavailable" };
        return;
      }
      yield { type: "text", content: "Finished" };
      yield { type: "done", content: "" };
    });
    assert.deepEqual(await collect(generateStreamWithRetry(provider, params, 1)), [
      { type: "text", content: "Finished" }, { type: "done", content: "" },
    ]);
    assert.equal(calls, 2);
  });
}

test("surfaces a mid-stream error chunk without retrying", async () => {
  let calls = 0;
  const provider = mockProvider(async function* () {
    calls++;
    yield { type: "text", content: "Partial" };
    yield { type: "error", content: "503 upstream unavailable" };
  });
  const chunks = await collect(generateStreamWithRetry(provider, params, 1));
  assert.equal(calls, 1);
  assert.equal(chunks.at(-1)?.type, "error");
});

test("does not retry a non-transient failure before any output", async () => {
  let calls = 0;
  const failure = new Error("Invalid API key (401)");
  const provider = mockProvider(async function* () {
    calls++;
    throw failure;
  });
  await assert.rejects(collect(generateStreamWithRetry(provider, params, 1)), failure);
  assert.equal(calls, 1);
});

test("does not call the provider for a cancelled run", async () => {
  let calls = 0;
  const provider = mockProvider(async function* () {
    calls++;
    yield { type: "done", content: "" };
  });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await collect(generateStreamWithRetry(provider, { ...params, signal: controller.signal })), []);
  assert.equal(calls, 0);
});

const withImage: GenerateParams = {
  model: "z-ai/glm-4.6",
  maxTokens: 64000,
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "make the screen look like this" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
  ],
};

for (const failureMode of ["throw", "error-chunk"] as const) {
  test(`a text-only model's image refusal (${failureMode}) is retried once without the image`, async () => {
    const seen: GenerateParams[] = [];
    const provider = mockProvider(async function* (p) {
      seen.push(p);
      if (seen.length === 1) {
        const msg = "OpenRouter error (404): No endpoints found that support image input";
        if (failureMode === "throw") throw new Error(msg);
        yield { type: "error", content: msg };
        return;
      }
      yield { type: "text", content: "ok" };
      yield { type: "done", content: "" };
    });
    const chunks = await collect(generateStreamWithRetry(provider, withImage, 0));
    assert.deepEqual(chunks.map((c) => c.type), ["text", "done"]);
    assert.equal(seen.length, 2);
    const user = seen[1]!.messages[1]!;
    assert.ok(Array.isArray(user.content));
    assert.equal((user.content as Array<{ type: string }>).some((p) => p.type === "image_url"), false);
    assert.match(JSON.stringify(user.content), /cannot see images/);
    assert.equal(seen[1]!.messages[0], withImage.messages[0], "messages without images pass through untouched");
  });
}

test("a BYOK balance that cannot cover the ceiling retries at what it can afford", async () => {
  const seen: GenerateParams[] = [];
  const provider = mockProvider(async function* (p) {
    seen.push(p);
    if (seen.length === 1) {
      yield { type: "error", content: "OpenRouter error (402): This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 14530." };
      return;
    }
    yield { type: "done", content: "" };
  });
  await collect(generateStreamWithRetry(provider, { ...params, maxTokens: 64000 }, 0));
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.maxTokens, Math.floor(14530 * 0.9));
});

test("a balance too small for a useful reply, or a second refusal, is reported as is", async () => {
  let calls = 0;
  const tiny = mockProvider(async function* () {
    calls++;
    yield { type: "error", content: "OpenRouter error (402): You requested up to 64000 tokens, but can only afford 591." };
  });
  const chunks = await collect(generateStreamWithRetry(tiny, { ...params, maxTokens: 64000 }, 0));
  assert.equal(calls, 1);
  assert.equal(chunks[0]!.type, "error");

  let again = 0;
  const stubborn = mockProvider(async function* () {
    again++;
    yield { type: "error", content: "OpenRouter error (404): No endpoints found that support image input" };
  });
  const out = await collect(generateStreamWithRetry(stubborn, withImage, 0));
  assert.equal(again, 2, "one rewrite, then the refusal stands");
  assert.equal(out[0]!.type, "error");
});

test("a rate limit waits out Retry-After once, then surfaces a second 429", async () => {
  let calls = 0;
  const provider = mockProvider(async function* () {
    calls++;
    yield { type: "error", content: "OpenRouter error (429): Rate limit exceeded", retryAfterMs: 10 };
  });
  const chunks = await collect(generateStreamWithRetry(provider, params, 0));
  assert.equal(calls, 2);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.content, /429/);
});

test("a rate limit that clears on the retry yields only the retried generation", async () => {
  let calls = 0;
  const provider = mockProvider(async function* () {
    calls++;
    if (calls === 1) yield { type: "error", content: "error (429): slow down", retryAfterMs: 5 };
    else yield { type: "done", content: "" };
  });
  const chunks = await collect(generateStreamWithRetry(provider, params));
  assert.equal(calls, 2);
  assert.deepEqual(chunks.map((c) => c.type), ["done"]);
});

test("a daily quota or a long Retry-After is not waited on", async () => {
  for (const chunk of [
    { type: "error" as const, content: "error (429): free-models-per-day exceeded" },
    { type: "error" as const, content: "error (429): rate limited", retryAfterMs: 60_000 },
  ]) {
    let calls = 0;
    const provider = mockProvider(async function* () { calls++; yield chunk; });
    await collect(generateStreamWithRetry(provider, params));
    assert.equal(calls, 1);
  }
});

test("a model that only accepts temperature 1 is retried once with it", async () => {
  const temps: Array<number | undefined> = [];
  const provider = mockProvider(async function* (p) {
    temps.push(p.temperature);
    if (p.temperature !== 1) yield { type: "error", content: "Custom endpoint error (400): invalid temperature: only 1 is allowed for this model" };
    else yield { type: "done", content: "" };
  });
  const chunks = await collect(generateStreamWithRetry(provider, { ...params, temperature: 0.7 }));
  assert.deepEqual(temps, [0.7, 1]);
  assert.deepEqual(chunks.map((c) => c.type), ["done"]);
});
