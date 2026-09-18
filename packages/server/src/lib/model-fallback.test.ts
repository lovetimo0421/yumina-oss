import assert from "node:assert/strict";
import test from "node:test";
import { canReuseFallbackMessage, modelFallbackError, parseModelFallbackRecord } from "./model-fallback.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import { getOfficialProviderFallbackModels } from "./llm/fallback-models.js";
import type { StreamChunk } from "./llm/types.js";

test("confirmed retries reuse the exact unanswered row, without a two-minute expiry", () => {
  const row = { id: "user1", role: "user", content: "hello" };
  assert.equal(canReuseFallbackMessage(row, "user1", "hello"), true);
  assert.equal(canReuseFallbackMessage(row, "user2", "hello"), false);
  assert.equal(canReuseFallbackMessage({ ...row, role: "assistant" }, "user1", "hello"), false);
  assert.equal(canReuseFallbackMessage(row, "user1", "edited"), false);
  assert.equal(canReuseFallbackMessage(undefined, "user1", "hello"), false);
});

test("consent errors contain a safe reason and retry identity, not raw upstream details", () => {
  const error = modelFallbackError({ type: "error", content: "private upstream details", fallbackReason: "unavailable" }, "hermes", "", false, "user1");
  assert.equal(error?.code, "MODEL_FALLBACK_REQUIRED");
  assert.equal(error?.userMessageId, "user1");
  assert.deepEqual(error?.fallback, { requestedModel: "hermes", reason: "unavailable", provider: "official" });
  assert.ok(!JSON.stringify(error).includes("private upstream"));
  assert.equal(modelFallbackError({ type: "error", content: "lost connection" }, "hermes", "", false), null);
  assert.equal(modelFallbackError({ type: "error", content: "failed", fallbackReason: "capacity" }, "hermes", "partial reply", false), null);
});

test("only valid cross-model metadata is retained on the resulting swipe", () => {
  const record = { requestedModel: "hermes", reason: "unavailable", automatic: false };
  assert.deepEqual(parseModelFallbackRecord(record, "gemini"), record);
  assert.equal(parseModelFallbackRecord(record, "hermes"), undefined);
  assert.equal(parseModelFallbackRecord({ ...record, automatic: "yes" }, "gemini"), undefined);
  assert.equal(parseModelFallbackRecord({ ...record, requestedModel: "x".repeat(201) }, "gemini"), undefined);
});

for (const stream of [true, false]) {
  for (const status of [404, 403]) {
    test(`Hermes ${status} (stream=${stream}) never spends on Gemini before consent`, async () => {
      const originalFetch = globalThis.fetch;
      const models: string[] = [];
      const hermes = "nousresearch/hermes-4-70b";
      globalThis.fetch = (async (_input, init) => {
        models.push(JSON.parse(String(init?.body)).model);
        return Response.json({ error: { code: status, message: status === 403 ? "Provider Terms of Service rejected this request" : "No endpoints found" } }, { status });
      }) as typeof fetch;
      try {
        const chunks: StreamChunk[] = [];
        for await (const chunk of new OpenRouterProvider("test-key").generateStream({
          model: hermes, stream, messages: [{ role: "user", content: "test" }],
          fallbackModels: getOfficialProviderFallbackModels(hermes, false),
        })) chunks.push(chunk);
        assert.ok(models.length > 0);
        assert.ok(models.every((model) => model === hermes));
        assert.equal(chunks.at(-1)?.fallbackReason, status === 403 ? "policy" : "unavailable");
        assert.equal(chunks.some((chunk) => chunk.type === "done"), false);
      } finally { globalThis.fetch = originalFetch; }
    });
  }
}
