import { test } from "node:test";
import assert from "node:assert/strict";
import { CustomProvider } from "./custom.js";
import type { StreamChunk } from "./types.js";

/** Build an OpenAI-compatible SSE response body from raw `data:` payloads. */
function sseResponse(payloads: unknown[]): Response {
  const body = payloads
    .map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n`)
    .join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

function withMockedFetch(responses: Array<() => Response>): {
  calls: () => number;
  bodies: () => Array<Record<string, unknown>>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let count = 0;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) return new Response("{}", { status: 200 });
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const make = responses[Math.min(count, responses.length - 1)]!;
    count++;
    return make();
  }) as typeof fetch;
  return { calls: () => count, bodies: () => bodies, restore: () => { globalThis.fetch = original; } };
}

const PARAMS = {
  model: "custom/some-thinking-model",
  messages: [{ role: "user" as const, content: "hi" }],
};

for (const payloads of [[], [{ choices: [{ delta: { reasoning_content: "Still processing" } }] }]]) {
  test("CustomProvider does not resend an incomplete stream without a completion marker", async () => {
    const mock = withMockedFetch([() => sseResponse(payloads)]);
    try {
      const chunks = await collect(new CustomProvider("key", "https://api.example.com/v1").generateStream(PARAMS));
      assert.equal(mock.calls(), 1);
      assert.equal(chunks.at(-1)?.type, "error");
      assert.match(chunks.at(-1)!.content, /not automatically resent/);
      assert.equal(chunks.some(chunk => chunk.type === "done"), false);
    } finally {
      mock.restore();
    }
  });
}

test("CustomProvider accepts a finish reason without a separate DONE marker", async () => {
  const mock = withMockedFetch([() => sseResponse([
    { choices: [{ delta: { content: "Finished reply" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ])]);
  try {
    const chunks = await collect(new CustomProvider("key", "https://api.example.com/v1").generateStream(PARAMS));
    assert.equal(mock.calls(), 1);
    assert.equal(chunks.at(-1)?.type, "done");
  } finally {
    mock.restore();
  }
});

test("CustomProvider retries an all-reasoning empty completion and yields the retry's text", async () => {
  const emptyAttempt = () => sseResponse([
    { choices: [{ delta: { reasoning_content: "thinking hard..." } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 } },
  ]);
  const goodAttempt = () => sseResponse([
    { choices: [{ delta: { content: "Actual reply" } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
  ]);
  const mock = withMockedFetch([emptyAttempt, goodAttempt]);
  try {
    const provider = new CustomProvider("test-key", "https://api.example.com/v1");
    const chunks = await collect(provider.generateStream(PARAMS));
    assert.equal(mock.calls(), 2, "should retry exactly once after the empty completion");
    const text = chunks.filter((c) => c.type === "text").map((c) => c.content).join("");
    assert.equal(text, "Actual reply");
    assert.equal(chunks.at(-1)?.type, "done");
  } finally {
    mock.restore();
  }
});

test("CustomProvider does not retry once visible text was yielded", async () => {
  const attempt = () => sseResponse([
    { choices: [{ delta: { content: "Partial " } }] },
    { choices: [{ delta: { content: "reply" } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } },
  ]);
  const mock = withMockedFetch([attempt]);
  try {
    const provider = new CustomProvider("test-key", "https://api.example.com/v1");
    const chunks = await collect(provider.generateStream(PARAMS));
    assert.equal(mock.calls(), 1);
    const text = chunks.filter((c) => c.type === "text").map((c) => c.content).join("");
    assert.equal(text, "Partial reply");
  } finally {
    mock.restore();
  }
});

test("CustomProvider surfaces a non-retryable auth error immediately", async () => {
  const unauthorized = () => new Response("Invalid key", { status: 401 });
  const mock = withMockedFetch([unauthorized]);
  try {
    const provider = new CustomProvider("bad-key", "https://api.example.com/v1");
    const chunks = await collect(provider.generateStream(PARAMS));
    assert.equal(mock.calls(), 1, "401 must not be retried");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.type, "error");
    assert.match(chunks[0]!.content, /401/);
  } finally {
    mock.restore();
  }
});

test("CustomProvider gives up after retries and emits the empty done for the server-side guard", async () => {
  const emptyAttempt = () => sseResponse([
    { choices: [{ delta: { reasoning_content: "..." } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 } },
  ]);
  const mock = withMockedFetch([emptyAttempt]);
  try {
    const provider = new CustomProvider("test-key", "https://api.example.com/v1");
    const chunks = await collect(provider.generateStream(PARAMS));
    assert.equal(mock.calls(), 3, "2 retries = 3 attempts");
    assert.equal(chunks.filter((c) => c.type === "text").length, 0);
    assert.equal(chunks.at(-1)?.type, "done", "must still terminate so the empty-reply guard can fire");
  } finally {
    mock.restore();
  }
});

test("CustomProvider single-attempt mode never retries an empty completion", async () => {
  const emptyAttempt = () => sseResponse([
    { choices: [{ delta: { reasoning_content: "..." } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 } },
  ]);
  const mock = withMockedFetch([emptyAttempt]);
  try {
    const provider = new CustomProvider("test-key", "https://api.example.com/v1");
    const chunks = await collect(provider.generateStream({ ...PARAMS, singleAttempt: true }));
    assert.equal(mock.calls(), 1);
    assert.equal(chunks.at(-1)?.type, "done");
  } finally {
    mock.restore();
  }
});

test("CustomProvider disables DeepSeek thinking when explicitly requested", async () => {
  const goodAttempt = () => sseResponse([
    { choices: [{ delta: { content: "summary" }, finish_reason: "stop" }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
  ]);
  const mock = withMockedFetch([goodAttempt]);
  try {
    const provider = new CustomProvider(
      "test-key",
      "https://api.deepseek.com",
      { includeBody: { thinking: { type: "enabled" } } },
    );
    await collect(provider.generateStream({ ...PARAMS, disableReasoning: true, singleAttempt: true }));
    assert.deepEqual(mock.bodies()[0]?.thinking, { type: "disabled" });
  } finally {
    mock.restore();
  }
});

test("CustomProvider does not send DeepSeek's thinking field to generic endpoints", async () => {
  const goodAttempt = () => sseResponse([
    { choices: [{ delta: { content: "summary" }, finish_reason: "stop" }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
  ]);
  const mock = withMockedFetch([goodAttempt]);
  try {
    const provider = new CustomProvider("test-key", "https://api.example.com/v1");
    await collect(provider.generateStream({ ...PARAMS, disableReasoning: true, singleAttempt: true }));
    assert.equal("thinking" in mock.bodies()[0]!, false);
  } finally {
    mock.restore();
  }
});

test("CustomProvider preserves max-token and reasoning-token diagnostics", async () => {
  const emptyAttempt = () => sseResponse([
    { choices: [{ delta: { reasoning_content: "thinking" } }] },
    {
      choices: [{ delta: {}, finish_reason: "length" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 1200,
        total_tokens: 1210,
        completion_tokens_details: { reasoning_tokens: 1200 },
      },
    },
  ]);
  const mock = withMockedFetch([emptyAttempt]);
  try {
    const provider = new CustomProvider("test-key", "https://api.deepseek.com");
    const chunks = await collect(provider.generateStream({ ...PARAMS, disableReasoning: true, singleAttempt: true }));
    const done = chunks.at(-1);
    assert.equal(done?.type, "done");
    assert.equal(done?.stopReason, "max_tokens");
    assert.equal(done?.usage?.reasoningTokens, 1200);
  } finally {
    mock.restore();
  }
});

test("CustomProvider preserves finish reason through DONE and natural EOF without usage", async () => {
  const doneMock = withMockedFetch([() => sseResponse([
    { choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: "length" }] },
    "[DONE]",
  ])]);
  try {
    const provider = new CustomProvider("test-key", "https://api.deepseek.com");
    const chunks = await collect(provider.generateStream({ ...PARAMS, singleAttempt: true }));
    assert.equal(chunks.at(-1)?.stopReason, "max_tokens");
  } finally {
    doneMock.restore();
  }

  const eofMock = withMockedFetch([() => sseResponse([
    { choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: "length" }] },
  ])]);
  try {
    const provider = new CustomProvider("test-key", "https://api.deepseek.com");
    const chunks = await collect(provider.generateStream({ ...PARAMS, singleAttempt: true }));
    assert.equal(chunks.at(-1)?.stopReason, "max_tokens");
  } finally {
    eofMock.restore();
  }
});

test("CustomProvider non-streaming DeepSeek requests disable thinking and keep diagnostics", async () => {
  const mock = withMockedFetch([() => Response.json({
    choices: [{ message: { reasoning_content: "thinking", content: "" }, finish_reason: "length" }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 1_200,
      total_tokens: 1_210,
      completion_tokens_details: { reasoning_tokens: 1_200 },
    },
  })]);
  try {
    const provider = new CustomProvider("test-key", "https://api.deepseek.com");
    const chunks = await collect(provider.generateStream({
      ...PARAMS,
      disableReasoning: true,
      singleAttempt: true,
      stream: false,
    }));
    assert.deepEqual(mock.bodies()[0]?.thinking, { type: "disabled" });
    assert.equal(chunks.at(-1)?.stopReason, "max_tokens");
    assert.equal(chunks.at(-1)?.usage?.reasoningTokens, 1_200);
  } finally {
    mock.restore();
  }
});

test("ordinary DeepSeek chat keeps the account's configured thinking mode", async () => {
  const goodAttempt = () => sseResponse([
    { choices: [{ delta: { content: "reply" }, finish_reason: "stop" }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
  ]);
  const mock = withMockedFetch([goodAttempt]);
  try {
    const provider = new CustomProvider(
      "test-key",
      "https://api.deepseek.com",
      { includeBody: { thinking: { type: "enabled" } } },
    );
    await collect(provider.generateStream({ ...PARAMS, singleAttempt: true }));
    assert.deepEqual(mock.bodies()[0]?.thinking, { type: "enabled" });
  } finally {
    mock.restore();
  }
});
