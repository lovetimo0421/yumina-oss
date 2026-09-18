import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { OpenRouterProvider } from "./llm/openrouter.js";
import { generateWithSummaryFallback } from "./summary-fallback.js";
import { createStoryCompactionAttemptBudget, STORY_COMPACTION_ATTEMPT_BUDGET_ERROR } from "./session-compaction-core.js";

const primary = "anthropic/claude-haiku-4.5";
const fallback = "deepseek/deepseek-v3.2";
const rejection = (status = 403, message = "This request was rejected under provider terms of service") =>
  Response.json({ error: { message, code: status } }, { status });
const success = () => Response.json({
  choices: [{ message: { content: "The crew repaired the harbor gate." }, finish_reason: "stop" }],
});

// Exercise the real provider formatter: the old summary classifier recognized
// raw content_filter errors but missed the normalized Terms of Service text.
async function withProvider(
  responses: Array<() => Response>,
  run: (fixture: {
    generate: (model: string, isFallback: boolean) => Promise<string>;
    models: string[];
    errors: string[];
    budget: ReturnType<typeof createStoryCompactionAttemptBudget>;
    controller: AbortController;
  }) => Promise<void>,
  maxAttempts = 32,
  stream = false,
) {
  const original = globalThis.fetch;
  const models: string[] = [];
  const errors: string[] = [];
  const budget = createStoryCompactionAttemptBudget(maxAttempts);
  const controller = new AbortController();
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    assert.equal(body.max_tokens, 1500);
    assert.ok(models.length <= responses.length, "unexpected additional upstream attempt");
    return responses[models.length - 1]!();
  }) as typeof fetch;
  try {
    await run({
      models, errors, budget, controller,
      generate: async (model) => {
        controller.signal.throwIfAborted();
        if (!budget.tryConsume()) throw new Error(STORY_COMPACTION_ATTEMPT_BUDGET_ERROR);
        let text = "";
        for await (const chunk of new OpenRouterProvider("test-key").generateStream({
          model, messages: [{ role: "user", content: "Summarize the fictional harbor repairs within 1250 tokens." }],
          stream, singleAttempt: true, maxTokens: 1500, disableReasoning: true, signal: controller.signal,
        })) {
          if (chunk.type === "error") { errors.push(chunk.content); throw new Error(chunk.content); }
          if (chunk.type === "text") text += chunk.content;
        }
        return text;
      },
    });
  } finally { globalThis.fetch = original; }
}

test("formatted provider Terms refusal reaches exactly one successful summary fallback", async () => {
  await withProvider([rejection, success], async ({ generate, models, errors, budget }) => {
    const result = await generateWithSummaryFallback({ model: primary, fallbackModel: fallback, generate });
    assert.deepEqual(models, [primary, fallback]);
    assert.equal(result.model, fallback);
    assert.equal(result.text, "The crew repaired the harbor gate.");
    assert.equal(budget.remaining(), 30);
    assert.doesNotMatch(errors[0]!, /Yumina retried/i, "a provider cannot claim a caller has already retried");
  });
});

test("a second Terms rejection ends the summary attempt without cycling models", async () => {
  await withProvider([rejection, rejection], async ({ generate, models }) => {
    await assert.rejects(generateWithSummaryFallback({ model: primary, fallbackModel: fallback, generate }), /Terms of Service/i);
    assert.deepEqual(models, [primary, fallback]);
  });
});

test("streamed summary requests also fall back after the formatted Terms rejection", async () => {
  const streamedReply = () => new Response(
    'data: {"choices":[{"delta":{"content":"Harbor repaired."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
  await withProvider([rejection, streamedReply], async ({ generate, models }) => {
    const result = await generateWithSummaryFallback({ model: primary, fallbackModel: fallback, generate });
    assert.deepEqual(models, [primary, fallback]);
    assert.deepEqual(result, { text: "Harbor repaired.", model: fallback });
  }, 32, true);
});

test("an already selected fallback is never retried on itself", async () => {
  await withProvider([rejection], async ({ generate, models }) => {
    await assert.rejects(generateWithSummaryFallback({ model: fallback, fallbackModel: fallback, generate }), /Terms of Service/i);
    assert.deepEqual(models, [fallback]);
  });
});

test("ordinary permissions, authentication, and credit errors do not switch summary models", async () => {
  for (const [status, message] of [[403, "Access denied"], [401, "Invalid API key"], [402, "Insufficient credits"]] as const) {
    await withProvider([() => rejection(status, message)], async ({ generate, models }) => {
      await assert.rejects(generateWithSummaryFallback({ model: primary, fallbackModel: fallback, generate }));
      assert.deepEqual(models, [primary]);
    });
  }
});

test("refusal fallback cannot exceed the shared attempt budget or outlive cancellation", async () => {
  await withProvider([rejection], async ({ generate, models, budget }) => {
    await assert.rejects(generateWithSummaryFallback({ model: primary, fallbackModel: fallback, generate }),
      (error: Error) => error.message === STORY_COMPACTION_ATTEMPT_BUDGET_ERROR);
    assert.deepEqual(models, [primary]);
    assert.equal(budget.remaining(), 0);
  }, 1);
  await withProvider([rejection], async ({ generate, models, controller }) => {
    await assert.rejects(generateWithSummaryFallback({
      model: primary, fallbackModel: fallback, generate,
      onFallback: () => controller.abort(new Error("summary cancelled")),
    }), /summary cancelled/);
    assert.deepEqual(models, [primary]);
  });
});

test("existing content-filter refusals still fall back and preserve the successful model", async () => {
  const calls: Array<[string, boolean]> = [];
  const result = await generateWithSummaryFallback({
    model: primary, fallbackModel: fallback,
    generate: async (model, isFallback) => {
      calls.push([model, isFallback]);
      if (!isFallback) throw new Error("content_filter");
      return "Summary";
    },
  });
  assert.deepEqual(calls, [[primary, false], [fallback, true]]);
  assert.deepEqual(result, { text: "Summary", model: fallback });
});

test("a successful primary is returned unchanged without selecting a fallback", async () => {
  await withProvider([success], async ({ generate, models, budget }) => {
    const result = await generateWithSummaryFallback({ model: primary, fallbackModel: fallback, generate });
    assert.deepEqual(models, [primary]);
    assert.equal(result.model, primary);
    assert.equal(budget.remaining(), 31);
  });
});

test("raw provider policy 403s qualify but an unrelated error mentioning terms does not", async () => {
  for (const message of ["OpenRouter error (403): Provider ToS rejected request", "OpenRouter error (403): Rejected under provider terms of service"]) {
    const calls: string[] = [];
    const result = await generateWithSummaryFallback({
      model: primary, fallbackModel: fallback,
      generate: async (model, isFallback) => {
        calls.push(model);
        if (!isFallback) throw new Error(message);
        return "Summary";
      },
    });
    assert.deepEqual(calls, [primary, fallback]);
    assert.equal(result.model, fallback);
  }
  const error = new Error("OpenRouter error (401): Invalid key; see terms of service");
  let calls = 0;
  await assert.rejects(generateWithSummaryFallback({
    model: primary, fallbackModel: fallback,
    generate: async () => { calls += 1; throw error; },
  }), (thrown) => thrown === error);
  assert.equal(calls, 1);
});

test("story generation wires the fallback through the same billed, bounded provider call", () => {
  const source = readFileSync(new URL("./session-compaction.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const wrapper = source.slice(source.indexOf("async function generateStorySummaryText"), source.indexOf("async function generateStorySummaryTextOnce"));
  assert.match(wrapper, /generateWithSummaryFallback\(/);
  assert.match(wrapper, /generateStorySummaryTextOnce\(\{\s*\.\.\.args,\s*model,[\s\S]*disableModelFallback: isFallback/);
  assert.match(wrapper, /result.model === STORY_SUMMARY_REFUSAL_FALLBACK_MODEL/);
  assert.match(wrapper, /args.fallbackTracker.refusalFallbackUsed = true/);
});

test("a free-router reasoning requirement uses one compatible summary attempt and reports its actual model", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return Response.json({ error: {
      code: 400, message: "Reasoning is mandatory for this endpoint and cannot be disabled.",
    } }, { status: 400 });
    return new Response('data: {"choices":[{"delta":{"content":"A usable summary."}}]}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const budget = createStoryCompactionAttemptBudget(2);
    const result = await generateWithSummaryFallback({
      model: "openrouter/free", fallbackModel: "deepseek/deepseek-v3.2",
      generate: async (model) => {
        assert.equal(budget.tryConsume(), true);
        let text = "";
        for await (const chunk of new OpenRouterProvider("test").generateStream({
          model, messages: [{ role: "user", content: "Summarize this test story." }],
          maxTokens: 1200, disableReasoning: true, singleAttempt: true,
        })) {
          if (chunk.type === "error") throw new Error(chunk.content);
          if (chunk.type === "text") text += chunk.content;
        }
        return text;
      },
    });
    assert.deepEqual(result, { text: "A usable summary.", model: "deepseek/deepseek-v3.2" });
    assert.deepEqual(bodies.map(body => body.model), ["openrouter/free", "deepseek/deepseek-v3.2"]);
    assert.ok(bodies.every(body => body.max_tokens === 1200));
    assert.equal(budget.remaining(), 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("summary compatibility fallback respects the existing shared provider-attempt ceiling", async () => {
  const budget = createStoryCompactionAttemptBudget(1);
  let calls = 0;
  await assert.rejects(generateWithSummaryFallback({
    model: "openrouter/free", fallbackModel: "deepseek/deepseek-v3.2",
    generate: async () => {
      if (!budget.tryConsume()) throw new Error(STORY_COMPACTION_ATTEMPT_BUDGET_ERROR);
      calls++;
      throw new Error("OpenRouter error (400): Reasoning is mandatory for this endpoint and cannot be disabled.");
    },
  }), { message: STORY_COMPACTION_ATTEMPT_BUDGET_ERROR });
  assert.equal(calls, 1);
});

test("ordinary failures are preserved and a failing fallback cannot loop", async () => {
  for (const message of ["OpenRouter error (401): Invalid key", "OpenRouter error (400): Invalid message format"]) {
    let calls = 0;
    const error = new Error(message);
    await assert.rejects(generateWithSummaryFallback({
      model: "openrouter/free", fallbackModel: "deepseek/deepseek-v3.2",
      generate: async () => { calls++; throw error; },
    }), error);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(generateWithSummaryFallback({
    model: "openrouter/free", fallbackModel: "deepseek/deepseek-v3.2",
    generate: async () => { calls++; throw new Error("content filter"); },
  }), /content filter/);
  assert.equal(calls, 2);
});
