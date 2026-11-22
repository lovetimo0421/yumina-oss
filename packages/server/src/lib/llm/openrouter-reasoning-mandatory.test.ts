import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterProvider } from "./openrouter.js";
import type { StreamChunk } from "./types.js";

/** The real body OpenRouter returns when an always-thinking endpoint is asked for effort "none". */
const MANDATORY_400 = JSON.stringify({
  error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled.", code: 400 },
});

function sseReply(text: string): Response {
  const body = [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ].map((p) => `data: ${JSON.stringify(p)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function jsonReply(text: string): Response {
  return Response.json({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function withMockedFetch(responses: Array<() => Response>) {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!String(input).includes("/chat/completions")) return new Response("{}", { status: 200 });
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return responses[Math.min(bodies.length - 1, responses.length - 1)]!();
  }) as typeof fetch;
  return { bodies: () => bodies, restore: () => { globalThis.fetch = original; } };
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const params = {
  model: "z-ai/glm-5.3-flash",
  messages: [{ role: "user" as const, content: "summarize" }],
  maxTokens: 1000,
  disableReasoning: true,
};

for (const stream of [true, false]) {
  test(`a mandatory-reasoning endpoint is re-sent at low effort (${stream ? "stream" : "non-stream"})`, async () => {
    const mock = withMockedFetch([
      () => new Response(MANDATORY_400, { status: 400, headers: { "Content-Type": "application/json" } }),
      () => (stream ? sseReply("the memory") : jsonReply("the memory")),
    ]);
    try {
      const chunks = await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...params, stream }));
      const [first, second] = mock.bodies();
      assert.deepEqual(first!.reasoning, { effort: "none" });
      assert.deepEqual(second!.reasoning, { effort: "low" });
      assert.equal(second!.model, "z-ai/glm-5.3-flash", "same model, not a fallback");
      assert.ok(Number(second!.max_tokens) > 1000, "low effort gets reasoning headroom");
      assert.equal(mock.bodies().length, 2);
      assert.equal(chunks.filter((c) => c.type === "text").map((c) => c.content).join(""), "the memory");
      assert.equal(chunks.some((c) => c.type === "error"), false);
    } finally {
      mock.restore();
    }
  });
}

test("a turn that never asked to disable reasoning surfaces the 400 unchanged", async () => {
  const mock = withMockedFetch([
    () => new Response(MANDATORY_400, { status: 400, headers: { "Content-Type": "application/json" } }),
  ]);
  try {
    const chunks = await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...params, disableReasoning: false }));
    assert.match(chunks.find((c) => c.type === "error")?.content ?? "", /Reasoning is mandatory/);
  } finally {
    mock.restore();
  }
});

test("singleAttempt callers keep their one request and see the 400", async () => {
  const mock = withMockedFetch([
    () => new Response(MANDATORY_400, { status: 400, headers: { "Content-Type": "application/json" } }),
  ]);
  try {
    const chunks = await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...params, singleAttempt: true }));
    assert.equal(mock.bodies().length, 1);
    assert.match(chunks.find((c) => c.type === "error")?.content ?? "", /Reasoning is mandatory/);
  } finally {
    mock.restore();
  }
});

for (const stream of [true, false]) {
  test(`Doubao Seed runs with reasoning off unless the turn asks for an effort (${stream ? "stream" : "non-stream"})`, async () => {
    const mock = withMockedFetch([() => (stream ? sseReply("ok") : jsonReply("ok"))]);
    try {
      const seed = { model: "bytedance-seed/seed-2-1-turbo", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 300, stream };
      await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream(seed));
      await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...seed, reasoningEffort: "none" }));
      await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...seed, reasoningEffort: "medium" }));
      await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...seed, model: "z-ai/glm-5.3-flash" }));
      const [plain, none, medium, other] = mock.bodies();
      assert.deepEqual(plain!.reasoning, { effort: "none" });
      assert.equal(plain!.max_tokens, 300, "no reasoning headroom");
      assert.deepEqual(none!.reasoning, { effort: "none" });
      assert.deepEqual(medium!.reasoning, { effort: "medium" });
      assert.equal(other!.reasoning, undefined, "other models keep the provider default");
    } finally {
      mock.restore();
    }
  });
}

test("Doubao Seed that refuses to switch reasoning off is re-sent at low effort", async () => {
  const mock = withMockedFetch([
    () => new Response(MANDATORY_400, { status: 400, headers: { "Content-Type": "application/json" } }),
    () => sseReply("ok"),
  ]);
  try {
    await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ model: "bytedance-seed/seed-2-1-turbo", messages: [{ role: "user", content: "hi" }], maxTokens: 300 }));
    const [first, second] = mock.bodies();
    assert.deepEqual(first!.reasoning, { effort: "none" });
    assert.deepEqual(second!.reasoning, { effort: "low" });
  } finally {
    mock.restore();
  }
});

for (const stream of [true, false]) {
  test(`a player's 「关闭」 switches thinking off, except on a model that must think (${stream ? "stream" : "non-stream"})`, async () => {
    const mock = withMockedFetch([() => (stream ? sseReply("ok") : jsonReply("ok")), () => (stream ? sseReply("ok") : jsonReply("ok")), () => (stream ? sseReply("ok") : jsonReply("ok"))]);
    try {
      const turn = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 300, stream, reasoningEffort: "none" };
      await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...turn, model: "x-ai/grok-4.3" }));
      await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...turn, model: "google/gemini-3.7-flash" }));
      await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({ ...turn, model: "x-ai/grok-4.3", reasoningEffort: "low" }));
      const [off, mustThink, low] = mock.bodies();
      assert.deepEqual(off!.reasoning, { effort: "none" });
      assert.equal(mustThink!.reasoning, undefined, "a model that must think keeps its default instead of a 400");
      assert.deepEqual(low!.reasoning, { effort: "low" });
    } finally {
      mock.restore();
    }
  });
}

test("Gemini 4 Neon plays at low effort when the turn names none or asks for 「关闭」", async () => {
  for (const reasoningEffort of [undefined, "none", "high"] as const) {
    const mock = withMockedFetch([() => sseReply("ok")]);
    try {
      await collect(new OpenRouterProvider("fixture:" + crypto.randomUUID()).generateStream({
        model: "google/gemini-4-neon", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 1000, stream: true, reasoningEffort,
      }));
      const [body] = mock.bodies();
      assert.deepEqual(body!.reasoning, { effort: reasoningEffort === "high" ? "high" : "low" });
      assert.ok(Number(body!.max_tokens) > 1000, "the default effort gets reasoning headroom");
    } finally {
      mock.restore();
    }
  }
});
