import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CustomProvider } from "./custom.js";
import type { GenerateParams, StreamChunk } from "./types.js";

const params: GenerateParams = { model: "custom/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }] };
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
const success = (stream: boolean) => stream
  ? new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
  : Response.json({ choices: [{ message: { content: "OK" } }] });

for (const stream of [true, false]) {
  test(`DeepSeek forwards selected effort in the actual body (stream=${stream})`, async t => {
    let body: Record<string, unknown> = {};
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return success(stream);
    });
    const provider = new CustomProvider("secret", "https://api.deepseek.com/v1");
    for (const [effort, mapped] of Object.entries({ minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max", none: "none" })) {
      const chunks = await collect(provider.generateStream({ ...params, stream, reasoningEffort: effort }));
      assert.equal(chunks.at(-1)?.type, "done");
      assert.equal(body.reasoning_effort, mapped);
      assert.deepEqual(body.thinking, { type: effort === "none" ? "disabled" : "enabled" });
    }
    await collect(provider.generateStream({ ...params, stream, reasoningEffort: "high", disableReasoning: true }));
    assert.equal(body.reasoning_effort, "none");
    await collect(provider.generateStream({ ...params, stream }));
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
  });

  for (const phase of ["headers", "body"] as const) {
    test(`DeepSeek bounds stalled ${phase} without resending (stream=${stream})`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let signal!: AbortSignal;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const fetchMock = t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => {
        signal = init.signal!;
        if (phase === "headers") return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(c) {
          controller = c;
          signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
        } })));
      });
      const pending = collect(new CustomProvider("secret", "https://api.deepseek.com/v1").generateStream({ ...params, stream }));
      await setImmediate();
      // Real DeepSeek may send HTTP 200 + comments/whitespace while queued.
      // Those transport bytes must not extend the model-progress deadline.
      for (let i = 0; i < (stream ? 3 : 4); i++) {
        if (phase === "body") controller.enqueue(new TextEncoder().encode(stream ? ": keepalive\n\n" : " "));
        await setImmediate();
        t.mock.timers.tick(30_000);
        await setImmediate();
      }
      const chunks = await pending;
      assert.equal(signal.aborted, true);
      assert.equal(fetchMock.mock.callCount(), 1);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0]!.type, "error");
      assert.match(chunks[0]!.content, /DeepSeek response timeout.*not automatically resent/);
    });
  }
}

test("DeepSeek actual reasoning progress extends the deadline, completion cleans it up", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal!: AbortSignal;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    signal = init.signal!;
    return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }));
  });
  const pending = collect(new CustomProvider("key", "https://api.deepseek.com/v1").generateStream(params));
  await setImmediate();
  t.mock.timers.tick(60_000);
  controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"Working"}}]}\n\n'));
  await setImmediate();
  t.mock.timers.tick(60_000);
  assert.equal(signal.aborted, false);
  controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'));
  controller.close();
  const chunks = await pending;
  assert.ok(chunks.some(c => c.type === "reasoning"));
  assert.equal(chunks.at(-1)?.type, "done");
  t.mock.timers.tick(200_000);
  assert.equal(signal.aborted, false);
});

test("DeepSeek caller stop is silent and never retried", async t => {
  const caller = new AbortController();
  const fetchMock = t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const pending = collect(new CustomProvider("key", "https://api.deepseek.com/v1").generateStream({ ...params, signal: caller.signal }));
  await setImmediate();
  caller.abort();
  assert.deepEqual(await pending, []);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("explicit DeepSeek controls override profile defaults, other hosts receive no native fields", async t => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return success(true); });
  const provider = new CustomProvider("key", "https://api.deepseek.com/v1", { includeBody: { thinking: { type: "enabled" }, reasoning_effort: "high" } });
  await collect(provider.generateStream({ ...params, disableReasoning: true }));
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, "none");
  for (const host of ["https://proxy.example.com/v1", "https://api.deepseek.com.example.com/v1"]) {
    await collect(new CustomProvider("key", host).generateStream({ ...params, reasoningEffort: "low", disableReasoning: true }));
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
  }
});

test("DeepSeek connectivity probe bounds output and disables reasoning", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(body.max_tokens, 128);
    assert.equal(body.stream, false);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.reasoning_effort, "none");
    return success(false);
  });
  assert.equal((await new CustomProvider("key", "https://api.deepseek.com/v1").sendTestMessage(params.model)).reply, "OK");
});

test("probe preserves a response-body timeout instead of blaming JSON or the model ID", async t => {
  const response = new Response("");
  t.mock.method(response, "text", async () => { throw new Error("response body timed out"); });
  t.mock.method(globalThis, "fetch", async () => response);
  const result = await new CustomProvider("key", "https://api.deepseek.com/v1").sendTestMessage(params.model);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /Network error: response body timed out/);
  assert.doesNotMatch(result.reason!, /valid chat response/);
});

test("other custom connectivity probes retain their existing unbounded request shape", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)), { model: "thinking-model", messages: [{ role: "user", content: "Hi" }], stream: false });
    return success(false);
  });
  assert.equal((await new CustomProvider("key", "https://proxy.example.com/v1").sendTestMessage("custom/thinking-model")).ok, true);
});
