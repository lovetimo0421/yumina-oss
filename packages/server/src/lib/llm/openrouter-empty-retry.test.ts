import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterProvider, extractServedProviderSlug } from "./openrouter.js";
import { createByokProvider } from "./provider-factory.js";
import type { StreamChunk } from "./types.js";

/**
 * A turn can fail while looking like a success: HTTP 200, a `done` chunk, and
 * no visible text. No error chunk is ever produced, so the provider-exclusion
 * machinery built for 4xx failures never fired and all three attempts could
 * re-roll the same dead endpoint. That is how deepseek-v4-flash reached a 14%
 * empty-reply rate on the platform key (v4-pro 6%) while every other model sat
 * under 0.9% and the same model on a user's own key sat at 0.11% — prod,
 * 2026-09-02.
 *
 * These cover the wiring end to end: the empty turn has to teach the retry who
 * to skip, and — just as important — has to keep behaving exactly as before
 * when the provider can't be named.
 */

const MODEL = "deepseek/deepseek-v4-flash";

function sseResponse(payloads: unknown[]): Response {
  const body = payloads.map((p) => `data: ${JSON.stringify(p)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** HTTP 200, usage reported, not one token of visible text. */
function emptyReply(provider?: string): Response {
  return sseResponse([
    {
      ...(provider && { provider }),
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 17158, completion_tokens: 1, total_tokens: 17159 },
    },
  ]);
}

function reply(text: string, provider?: string): Response {
  return sseResponse([
    { ...(provider && { provider }), choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
}

function nonStreamReply(text: string): Response {
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

/** Records the parsed request body of each upstream call so we can assert what
 *  routing preferences the retry actually sent. */
function withMockedFetch(responses: Array<() => Response>) {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) return new Response("{}", { status: 200 });
    bodies.push(JSON.parse(String(init?.body)));
    return responses[Math.min(bodies.length - 1, responses.length - 1)]!();
  }) as typeof fetch;
  return { bodies: () => bodies, restore: () => { globalThis.fetch = original; } };
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    messages: [{ role: "user" as const, content: "hi" }],
    ...overrides,
  };
}

// ── the fix ──

test("an empty completion excludes the provider that served it on retry", async () => {
  const mock = withMockedFetch([
    () => emptyReply("DeepInfra"),
    () => reply("the story continues", "Fireworks"),
  ]);
  try {
    const chunks = await collect(new OpenRouterProvider("k").generateStream(params()));
    const [first, second] = mock.bodies();

    assert.equal(first!.provider, undefined, "deepseek carries no routing preference on the first try");
    assert.deepEqual(
      second!.provider,
      { ignore: ["deepinfra"] },
      "the retry must not re-roll the endpoint that just returned nothing",
    );

    const text = chunks.filter((c) => c.type === "text").map((c) => c.content).join("");
    assert.equal(text, "the story continues");
  } finally {
    mock.restore();
  }
});

test("a second empty completion excludes both providers", async () => {
  const mock = withMockedFetch([
    () => emptyReply("DeepInfra"),
    () => emptyReply("Novita"),
    () => reply("finally", "Fireworks"),
  ]);
  try {
    await collect(new OpenRouterProvider("k").generateStream(params()));
    const [, second, third] = mock.bodies();
    assert.deepEqual(second!.provider, { ignore: ["deepinfra"] });
    assert.deepEqual(third!.provider, { ignore: ["deepinfra", "novita"] });
  } finally {
    mock.restore();
  }
});

test("an unidentifiable provider leaves the retry exactly as it was", async () => {
  const mock = withMockedFetch([
    () => emptyReply(),
    () => reply("the story continues"),
  ]);
  try {
    const chunks = await collect(new OpenRouterProvider("k").generateStream(params()));
    const [, second] = mock.bodies();
    assert.equal(second!.provider, undefined, "no slug means a plain retry, never garbage routing");
    assert.equal(
      chunks.filter((c) => c.type === "text").map((c) => c.content).join(""),
      "the story continues",
    );
  } finally {
    mock.restore();
  }
});

test("BYOK account routing omits request-level provider rules across retries", async () => {
  const mock = withMockedFetch([
    () => emptyReply("DeepInfra"),
    () => reply("account route recovered", "DeepInfra"),
  ]);
  try {
    await collect(
      new OpenRouterProvider("k", { preserveAccountRouting: true }).generateStream(params()),
    );
    assert.deepEqual(
      mock.bodies().map((body) => body.provider),
      [undefined, undefined],
    );
  } finally {
    mock.restore();
  }
});

test("the BYOK provider factory preserves OpenRouter account routing", async () => {
  const mock = withMockedFetch([() => reply("vertex response", "Google")]);
  try {
    const provider = createByokProvider("openrouter", "k");
    await collect(provider.generateStream(params({ model: "google/gemini-3.1-pro-preview" })));
    assert.equal(mock.bodies()[0]!.provider, undefined);
  } finally {
    mock.restore();
  }
});

test("non-streaming BYOK also preserves OpenRouter account routing", async () => {
  const mock = withMockedFetch([() => nonStreamReply("vertex response")]);
  try {
    const provider = createByokProvider("openrouter", "k");
    await collect(provider.generateStream(params({
      model: "google/gemini-3.1-pro-preview",
      stream: false,
    })));
    assert.equal(mock.bodies()[0]!.provider, undefined);
  } finally {
    mock.restore();
  }
});

test("a turn that produced text never excludes its provider", async () => {
  const mock = withMockedFetch([() => reply("all good", "DeepInfra")]);
  try {
    await collect(new OpenRouterProvider("k").generateStream(params()));
    assert.equal(mock.bodies().length, 1, "a healthy turn must not retry at all");
  } finally {
    mock.restore();
  }
});

// ── extractServedProviderSlug ──

test("the top-level provider field wins", () => {
  assert.equal(extractServedProviderSlug({ provider: "DeepInfra" }), "deepinfra");
});

test("falls back to routing metadata when the top-level field is absent", () => {
  assert.equal(
    extractServedProviderSlug({
      openrouter_metadata: { attempts: [{ provider_slug: "novita" }] },
    }),
    "novita",
  );
});

test("returns undefined rather than guessing", () => {
  assert.equal(extractServedProviderSlug({ choices: [] }), undefined);
  assert.equal(extractServedProviderSlug(null), undefined);
  assert.equal(extractServedProviderSlug({ provider: 42 }), undefined);
});
