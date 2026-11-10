import assert from "node:assert/strict";
import test from "node:test";
import { CustomProvider } from "./custom.js";

const params = { model: "custom/Qwen/Qwen2.5-0.5B-Instruct", messages: [{ role: "user" as const, content: "Hi" }] };
const message = "Maximum context length allowed on your plan is 32768 tokens. Your prompt has 40034 tokens. Please reduce the length of your prompt.";
for (const wire of [
  `data: ${JSON.stringify({ object: "error", error: { code: "context_length_exceeded", message } })}\n\n`,
  `data:${JSON.stringify({ error: { code: "context_length_exceeded", message } })}`,
]) {
  test("Featherless HTTP 200 stream errors preserve the real refusal without resending", async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(wire, { headers: { "Content-Type": "text/event-stream" } }); });
    const chunks = [];
    for await (const chunk of new CustomProvider("test-key", "https://api.featherless.ai/v1").generateStream(params)) chunks.push(chunk);
    assert.equal(calls, 1);
    assert.equal(chunks.at(-1)?.type, "error");
    assert.match(chunks.at(-1)!.content, /context_length_exceeded/);
    assert.match(chunks.at(-1)!.content, /32768/);
    assert.doesNotMatch(chunks.at(-1)!.content, /closed the stream/);
    assert.equal(chunks.some(c => c.type === "done"), false);
  });
}

test("a streamed 500 error after text is reported once without duplicate generation", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: {"error":{"code":500,"message":"Worker failed"}}\n\n');
  });
  const chunks = [];
  for await (const chunk of new CustomProvider("test-key", "https://api.example.com/v1").generateStream(params)) chunks.push(chunk);
  assert.equal(calls, 1);
  assert.deepEqual(chunks.map(c => c.type), ["text", "error"]);
  assert.match(chunks[1]!.content, /Worker failed/);
});

test("a final completion event without a trailing newline is not mistaken for disconnection", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response('data:{"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}'));
  const chunks = [];
  for await (const chunk of new CustomProvider("test-key", "https://api.example.com/v1").generateStream(params)) chunks.push(chunk);
  assert.deepEqual(chunks.map(c => c.type), ["text", "done"]);
});

test("a running usage on every chunk (vLLM continuous stats, Celeris) does not end the stream before the text", async t => {
  // The wire Celeris sends: usage rides the empty role chunk and each content
  // chunk, then a usage-only chunk with no choices, then [DONE].
  const wire = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }], usage: { prompt_tokens: 3339, completion_tokens: 0, total_tokens: 3339 } },
    { choices: [{ index: 0, delta: { content: "Movement is strange." }, finish_reason: null }], usage: { prompt_tokens: 3339, completion_tokens: 5, total_tokens: 3344 } },
    { choices: [{ index: 0, delta: { content: " [form: set \"Stage 1\"]" }, finish_reason: "stop" }], usage: { prompt_tokens: 3339, completion_tokens: 12, total_tokens: 3351 } },
    { choices: [], usage: { prompt_tokens: 3339, completion_tokens: 12, total_tokens: 3351 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  t.mock.method(globalThis, "fetch", async () => new Response(wire, { headers: { "Content-Type": "text/event-stream" } }));
  const chunks = [];
  for await (const chunk of new CustomProvider("test-key", "https://inference.celeris.ai/celeris-1/v1").generateStream(params)) chunks.push(chunk);
  assert.deepEqual(chunks.map(c => c.type), ["text", "text", "done"]);
  assert.equal(chunks.filter(c => c.type === "text").map(c => c.content).join(""), "Movement is strange. [form: set \"Stage 1\"]");
  assert.equal(chunks.at(-1)!.usage?.completionTokens, 12);
});
