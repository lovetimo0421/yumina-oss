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
