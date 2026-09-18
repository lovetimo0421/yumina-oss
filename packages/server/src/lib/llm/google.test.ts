import assert from "node:assert/strict";
import test from "node:test";
import { parseGoogleModels, toGoogleModelId } from "./google.js";

test("parseGoogleModels: strips Google's models/ prefix and keeps gemini chat models", () => {
  // Google's OpenAI-compat /models returns ids like "models/gemini-2.5-flash".
  // The original filter matched on startsWith("gemini-") and so dropped them all.
  const models = parseGoogleModels([
    { id: "models/gemini-2.5-flash" },
    { id: "models/gemini-2.5-pro" },
  ]);
  assert.deepEqual(
    models.map((m) => m.id),
    ["google/gemini-2.5-flash", "google/gemini-2.5-pro"],
  );
  assert.equal(models[0]?.name, "Gemini 2.5 Flash");
  assert.equal(models[0]?.contextLength, 1_048_576);
});

test("parseGoogleModels: also handles already-bare ids (no models/ prefix)", () => {
  const models = parseGoogleModels([{ id: "gemini-3-flash-preview" }]);
  assert.equal(models[0]?.id, "google/gemini-3-flash-preview");
});

test("parseGoogleModels: drops non-chat (embedding/image/live) and non-gemini models", () => {
  const models = parseGoogleModels([
    { id: "models/gemini-embedding-001" },
    { id: "models/gemini-2.0-flash-live-001" },
    { id: "models/gemini-2.5-flash-image-preview" },
    { id: "models/imagen-3.0-generate-002" },
    { id: "models/text-embedding-004" },
    { id: "models/gemini-2.5-flash" },
  ]);
  assert.deepEqual(
    models.map((m) => m.id),
    ["google/gemini-2.5-flash"],
  );
});

test("parseGoogleModels: tolerates a missing data array", () => {
  assert.deepEqual(parseGoogleModels(undefined), []);
  assert.deepEqual(parseGoogleModels([]), []);
});

test("toGoogleModelId: strips google/ and models/ prefixes for the chat endpoint", () => {
  assert.equal(toGoogleModelId("google/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(toGoogleModelId("google/models/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(toGoogleModelId("gemini-2.5-flash"), "gemini-2.5-flash");
});

import { GoogleProvider } from "./google.js";
import type { GenerateParams, StreamChunk, ToolCall } from "./types.js";

const params: GenerateParams = {
  model: "google/gemini-3.7-flash", messages: [{ role: "user", content: "Hello" }],
  maxTokens: 12000, temperature: 1, topP: 1, frequencyPenalty: 0, presencePenalty: 0, topK: 0,
};
const answer = {
  candidates: [{ content: { parts: [{ text: "Hello back" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 15 },
};
async function collect(overrides: Partial<GenerateParams> = {}): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of new GoogleProvider("test-google-key").generateStream({ ...params, ...overrides })) chunks.push(chunk);
  return chunks;
}
function sse(chunks: unknown[], fragment = 7): Response {
  const bytes = new TextEncoder().encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment));
    controller.close();
  } }));
}

for (const stream of [true, false]) {
  test(`Google native request preserves zero penalties and translates the response (stream=${stream})`, async (t) => {
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
      assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "test-google-key");
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.generationConfig, { maxOutputTokens: 12000, temperature: 1, topP: 1, frequencyPenalty: 0, presencePenalty: 0 });
      assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "Hello" }] }]);
      assert.equal(body.safetySettings.length, 5);
      for (const key of ["frequency_penalty", "presence_penalty", "safety_settings", "messages", "stream", "model", "top_k"]) assert.equal(key in body, false, key);
      return stream ? sse([answer]) : Response.json(answer);
    });
    const chunks = await collect({ stream });
    assert.deepEqual(chunks, [
      { type: "text", content: "Hello back" },
      { type: "done", content: "", stopReason: "end_turn", usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 2, totalTokens: 15 } },
    ]);
  });
}

test("Google translates system instructions, history, images, JSON output and positive sampling settings", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: "Rules" }, { text: "More rules" }] });
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "First" }] },
      { role: "model", parts: [{ text: "Previous reply" }] },
      { role: "user", parts: [{ text: "Look" }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }, { fileData: { fileUri: "https://example.com/image.png" } }] },
    ]);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.topK, 40);
    assert.equal(body.generationConfig.frequencyPenalty, 0.4);
    return Response.json(answer);
  });
  const chunks = await collect({ stream: false, topK: 40, frequencyPenalty: 0.4, responseFormat: { type: "json_object" }, messages: [
    { role: "system", content: "Rules" }, { role: "user", content: "First" },
    { role: "assistant", content: "Previous reply" }, { role: "system", content: "More rules" },
    { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }, { type: "image_url", image_url: { url: "https://example.com/image.png" } }] },
  ] });
  assert.equal(chunks.at(-1)?.type, "done");
});

test("Google waits past early usage, decodes fragmented UTF-8, separates thoughts, and handles an unterminated final SSE event", async (t) => {
  const events = [
    { usageMetadata: { promptTokenCount: 8 } },
    { candidates: [{ content: { parts: [{ text: "Thinking", thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: "你好" }] } }] },
    { candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { candidatesTokenCount: 2, thoughtsTokenCount: 4, totalTokenCount: 14 } },
  ];
  const bytes = new TextEncoder().encode(events.map((e) => `data:${JSON.stringify(e)}`).join("\n\n"));
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(c) {
    for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
    c.close();
  } })));
  const chunks = await collect();
  assert.deepEqual(chunks.filter((c) => c.type === "text").map((c) => c.content), ["你好", "!"]);
  assert.equal(chunks[0]?.type, "reasoning");
  assert.equal(chunks.filter((c) => c.type === "done").length, 1);
  assert.equal(chunks.at(-1)?.stopReason, "max_tokens");
  assert.deepEqual(chunks.at(-1)?.usage, { promptTokens: 8, completionTokens: 6, reasoningTokens: 4, totalTokens: 14 });
});

for (const stream of [true, false]) {
  test(`Google function calls and signatures survive serialization and a fresh provider (stream=${stream})`, async (t) => {
    const parts = [
      { functionCall: { name: "lookup", args: { id: 1 } }, thoughtSignature: "signed-thought" },
      { functionCall: { id: "upstream-id", name: "lookup", args: { id: 2 } } },
    ];
    let request = 0;
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: "lookup", description: "Lookup", parametersJsonSchema: { type: "object", properties: { id: { type: "number" } } } }] }]);
      assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } });
      if (request++ === 0) {
        const reply = { candidates: [{ content: { parts }, finishReason: "STOP" }] };
        return stream ? sse([reply]) : Response.json(reply);
      }
      assert.equal(body.contents[1].parts[0].thoughtSignature, "signed-thought");
      assert.equal(body.contents[1].parts[1].thoughtSignature, undefined);
      assert.equal(body.contents[2].parts.length, 2);
      assert.deepEqual(body.contents[2].parts.map((p: any) => p.functionResponse.response), [{ found: true }, { result: "plain result" }]);
      assert.equal(body.contents[2].parts[0].functionResponse.id, body.contents[1].parts[0].functionCall.id);
      return stream ? sse([answer]) : Response.json(answer);
    });
    const overrides: Partial<GenerateParams> = { stream, tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { id: { type: "number" } } } } }], toolChoice: { type: "function", function: { name: "lookup" } } };
    const first = await collect(overrides);
    const calls: ToolCall[] = JSON.parse(JSON.stringify(first.filter((c) => c.type === "tool_call_end").map((c) => c.toolCall)));
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.id);
    assert.notEqual(calls[0]!.id, calls[1]!.id);
    assert.equal(calls[1]!.id, "upstream-id");
    const second = await collect({ ...overrides, messages: [params.messages[0]!, { role: "assistant", content: "", tool_calls: calls }, { role: "tool", tool_call_id: calls[0]!.id, content: '{"found":true}' }, { role: "tool", tool_call_id: calls[1]!.id, content: "plain result" }] });
    assert.equal(second.at(-1)?.type, "done");
  });
}

for (const [toolChoice, mode] of [["auto", "AUTO"], ["none", "NONE"], ["required", "ANY"]] as const) {
  test(`Google maps tool choice ${toolChoice}`, async (t) => {
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      assert.deepEqual(JSON.parse(init.body as string).toolConfig, { functionCallingConfig: { mode } });
      return Response.json(answer);
    });
    assert.equal((await collect({ stream: false, toolChoice, tools: [{ type: "function", function: { name: "test", description: "test", parameters: { type: "object" } } }] })).at(-1)?.type, "done");
  });
}

for (const stream of [true, false]) {
  for (const [label, response] of [
    ["prompt block", { promptFeedback: { blockReason: "SAFETY" } }],
    ["candidate block", { candidates: [{ finishReason: "SAFETY" }] }],
    ["malformed tool call", { candidates: [{ content: { parts: [{ functionCall: { name: "x", args: [] } }] }, finishReason: "STOP" }] }],
    ["empty completion", { candidates: [{ finishReason: "STOP" }] }],
    ["upstream error", { error: { code: 500, message: "Upstream unavailable" } }],
    ["incomplete response", { candidates: [{ content: { parts: [{ text: "Partial" }] } }] }],
  ] as const) {
    test(`Google reports ${label} without a successful done (stream=${stream})`, async (t) => {
      t.mock.method(globalThis, "fetch", async () => stream ? sse([response]) : Response.json(response));
      const chunks = await collect({ stream });
      assert.equal(chunks.at(-1)?.type, "error");
      assert.equal(chunks.some((c) => c.type === "done"), false);
      if (label === "prompt block" || label === "candidate block") assert.match(chunks.at(-1)!.content, /safety\/content filter/);
    });
  }
}

test("Google surfaces HTTP failures and network failures", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("Invalid API key", { status: 403 }));
  assert.match((await collect())[0]!.content, /Google AI error \(403\)/);
  fetch.mock.mockImplementation(async () => { throw new Error("Network unavailable"); });
  assert.match((await collect())[0]!.content, /Network unavailable/);
});

test("Google rejects malformed JSON and missing response bodies", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("data: {bad\n\n"));
  assert.equal((await collect()).at(-1)?.type, "error");
  fetch.mock.mockImplementation(async () => new Response("{bad"));
  assert.equal((await collect({ stream: false })).at(-1)?.type, "error");
  fetch.mock.mockImplementation(async () => new Response(null));
  assert.equal((await collect()).at(-1)?.type, "error");
});

test("Google rejects unmatched tool results before sending and respects cancellation", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(answer));
  const invalid = await collect({ messages: [{ role: "tool", tool_call_id: "missing", content: "result" }] });
  assert.match(invalid[0]!.content, /no matching function call/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(await collect({ signal: AbortSignal.abort() }), []);
  assert.equal(fetch.mock.callCount(), 0);
});

import { LLM_CONNECTION_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MS, LLM_STREAM_INACTIVITY_TIMEOUT_SHORT_MS } from "./constants.js";
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Google aborts an idle upstream and releases the stream reader", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    return new Response(body);
  });
  const pending = collect();
  await nextTurn();
  t.mock.timers.tick(LLM_STREAM_INACTIVITY_TIMEOUT_SHORT_MS);
  const chunks = await pending;
  assert.match(chunks.at(-1)!.content, /Stream timed out/);
  assert.equal(chunks.at(-1)?.type, "error");
  assert.equal(chunks.some((c) => c.type === "done"), false);
  assert.equal(signal?.aborted, true);
  assert.equal(canceled, true);
  assert.equal(body.locked, false);
});

for (const stream of [true, false]) {
  test(`Google respects an in-flight user abort (stream=${stream})`, async (t) => {
    const abort = new AbortController();
    let body: ReadableStream<Uint8Array>;
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      body = new ReadableStream<Uint8Array>({ start(controller) {
        init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
      } });
      return new Response(body);
    });
    const pending = collect({ stream, signal: abort.signal });
    await nextTurn();
    abort.abort();
    assert.deepEqual(await pending, []);
    if (stream) assert.equal(body!.locked, false);
  });
}

test("Google connection and non-stream body deadlines are enforced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const connecting = collect();
  await nextTurn();
  t.mock.timers.tick(LLM_CONNECTION_TIMEOUT_MS);
  assert.match((await connecting).at(-1)!.content, /Request timeout/);
  fetch.mock.mockImplementation(async (_url: string, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
    init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
  } })));
  const reading = collect({ stream: false });
  await nextTurn();
  t.mock.timers.tick(LLM_REQUEST_TIMEOUT_MS);
  assert.match((await reading).at(-1)!.content, /Request timeout/);
});
