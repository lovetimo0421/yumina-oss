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
