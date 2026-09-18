import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CustomProvider } from "./custom.js";
import { OllamaProvider } from "./ollama.js";
import { localGenerationTimeoutMs, readLocalStream } from "./local-timeout.js";
import type { StreamChunk } from "./types.js";

const params = { model: "local-model", messages: [{ role: "user" as const, content: "hello" }] };

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function configureTimeout(value?: string) {
  const original = process.env.LOCAL_AI_TIMEOUT_MS;
  if (value === undefined) delete process.env.LOCAL_AI_TIMEOUT_MS;
  else process.env.LOCAL_AI_TIMEOUT_MS = value;
  return () => {
    if (original === undefined) delete process.env.LOCAL_AI_TIMEOUT_MS;
    else process.env.LOCAL_AI_TIMEOUT_MS = original;
  };
}

test("local timeout defaults to ten minutes and validates configuration", () => {
  for (const value of [undefined, "", "invalid", "-1", "Infinity", "2147483648", "0.5"]) {
    const restore = configureTimeout(value);
    try { assert.equal(localGenerationTimeoutMs(), 600_000); } finally { restore(); }
  }
  for (const value of ["0", "900000"]) {
    const restore = configureTimeout(value);
    try { assert.equal(localGenerationTimeoutMs(), Number(value)); } finally { restore(); }
  }
});

for (const kind of ["custom", "ollama"] as const) {
  test(`${kind} waits past two minutes without resending a silent stream`, async context => {
    const restore = configureTimeout();
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          const payload = kind === "custom"
            ? 'data: {"choices":[{"delta":{"content":"Slow reply"}}]}\n\ndata: [DONE]\n\n'
            : '{"message":{"content":"Slow reply"},"done":true}\n';
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        }, 130_000);
      },
    });
    const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(body));
    try {
      const provider = kind === "custom"
        ? new CustomProvider("key", "https://api.example.com/v1")
        : new OllamaProvider();
      const pending = collect(provider.generateStream(params));
      await setImmediate();
      context.mock.timers.tick(130_000);
      const chunks = await pending;
      assert.equal(fetchMock.mock.callCount(), 1);
      assert.equal(chunks.find(chunk => chunk.type === "text")?.content, "Slow reply");
      assert.equal(chunks.at(-1)?.type, "done");
    } finally { restore(); }
  });
}

test("Custom timeout emits one error and cancels the reader without resending", async context => {
  const restore = configureTimeout("1000");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(body));
  try {
    const pending = collect(new CustomProvider("key", "https://api.example.com/v1").generateStream(params));
    await setImmediate();
    context.mock.timers.tick(1000);
    const chunks = await pending;
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0]!.content, /not automatically resent/);
    assert.equal(cancelled, true);
  } finally { restore(); }
});

for (const status of [408, 504, 524]) {
  test(`Custom does not retry ambiguous upstream timeout ${status}`, async context => {
    const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response("timeout", { status }));
    const chunks = await collect(new CustomProvider("key", "https://api.example.com/v1").generateStream(params));
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(chunks.at(-1)?.type, "error");
  });
}

test("Custom does not retry a failed connection that may have delivered the prompt", async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => { throw new Error("fetch failed"); });
  const chunks = await collect(new CustomProvider("key", "https://api.example.com/v1").generateStream(params));
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(chunks.at(-1)?.type, "error");
});

test("zero disables stream inactivity timeout", async context => {
  const restore = configureTimeout("0");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const reader = new ReadableStream<Uint8Array>({ start(value) { controller = value; } }).getReader();
  try {
    const pending = readLocalStream(reader);
    context.mock.timers.tick(3_600_000);
    controller.enqueue(new Uint8Array([1]));
    const result = await pending;
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.value, new Uint8Array([1]));
  } finally { await reader.cancel(); restore(); }
});

for (const stream of [true, false]) {
  test(`Custom waits for delayed response headers (stream=${stream})`, async context => {
    const restore = configureTimeout();
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let signal!: AbortSignal;
    const fetchMock = context.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return new Promise<Response>(resolve => {
        setTimeout(() => resolve(new Response(stream
          ? 'data: {"choices":[{"delta":{"content":"Ready"}}]}\n\ndata: [DONE]\n\n'
          : '{"choices":[{"message":{"content":"Ready"}}]}')), 200_000);
      });
    });
    try {
      const pending = collect(new CustomProvider("key", "https://api.example.com/v1").generateStream({ ...params, stream }));
      await setImmediate();
      context.mock.timers.tick(200_000);
      const chunks = await pending;
      assert.equal(signal.aborted, false);
      assert.equal(fetchMock.mock.callCount(), 1);
      assert.equal(chunks.find(chunk => chunk.type === "text")?.content, "Ready");
      assert.equal(chunks.at(-1)?.type, "done");
    } finally { restore(); }
  });

  test(`Custom header timeout does not resend (stream=${stream})`, async context => {
    const restore = configureTimeout("1000");
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fetchMock = context.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => {
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    try {
      const pending = collect(new CustomProvider("key", "https://api.example.com/v1").generateStream({ ...params, stream }));
      await setImmediate();
      context.mock.timers.tick(1000);
      const chunks = await pending;
      assert.equal(fetchMock.mock.callCount(), 1);
      assert.equal(chunks.at(-1)?.type, "error");
      assert.match(chunks.at(-1)!.content, /timeout/);
    } finally { restore(); }
  });

  test(`zero disables Custom header timeout but preserves manual stop (stream=${stream})`, async context => {
    const restore = configureTimeout("0");
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let signal!: AbortSignal;
    const fetchMock = context.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    try {
      const controller = new AbortController();
      const pending = collect(new CustomProvider("key", "https://api.example.com/v1").generateStream({ ...params, stream, signal: controller.signal }));
      await setImmediate();
      context.mock.timers.tick(3_600_000);
      assert.equal(signal.aborted, false);
      controller.abort();
      assert.deepEqual(await pending, []);
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally { restore(); }
  });
}
