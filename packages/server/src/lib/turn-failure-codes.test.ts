import assert from "node:assert/strict";
import test from "node:test";
import { classifyGenerationFailure, FAILURE_CODE } from "./turn-failure-codes.js";

test("unaffordable Guard correction cannot trigger mixed-model automatic retries", () => {
  const raw = "Not enough mushies for the state update correction. Switch to the free model.";
  assert.deepEqual(classifyGenerationFailure(raw), { code: FAILURE_CODE.STATE_VALIDATION, message: raw });
});

// Every raw string below was copied from a real production log line on
// 2026-07-30. If a provider changes its wording these tests are the tripwire.

test("free-model daily cap is its own code, not a generic rate limit", () => {
  const raw = "OpenRouter error (429): Rate limit exceeded: free-models-per-day-high-balance.";
  const result = classifyGenerationFailure(raw);
  assert.equal(result.code, FAILURE_CODE.FREE_POOL_EXHAUSTED);
  // The whole point: waiting does not fix this, so we must not say "try again
  // in a moment" — the only recovery is switching models.
  assert.match(result.message, /Switch to another model/);
  assert.doesNotMatch(result.message, /in a moment/);
});

test("free-model cap wins over the generic rate-limit branch", () => {
  // The raw text contains BOTH "Rate limit" and "free-models-per-day". Branch
  // order decides which advice the player gets; lock it down.
  const result = classifyGenerationFailure(
    "OpenRouter error (429): Rate limit exceeded: free-models-per-day-high-balance.",
  );
  assert.notEqual(result.code, FAILURE_CODE.UPSTREAM_UNAVAILABLE);
});

test("content-filter blocks are recognized across providers", () => {
  const raws = [
    "Response blocked by safety/content filter. Try regenerating — the filter is non-deterministic and may pass on retry.",
    "OpenRouter error (400): Gemini blocked the request: PROHIBITED_CONTENT",
    "OpenRouter error (502): Upstream error from Alibaba: Output data may contain inappropriate content.",
  ];
  for (const raw of raws) {
    assert.equal(
      classifyGenerationFailure(raw).code,
      FAILURE_CODE.CONTENT_FILTER,
      `expected CONTENT_FILTER for: ${raw}`,
    );
  }
});

test("transient upstream failures map to UPSTREAM_UNAVAILABLE", () => {
  const raws = [
    "OpenRouter error (429): Google AI Studio: google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly",
    "Generation stopped unexpectedly (reason: error) — qwen/qwen3-vl-235b-a22b-instruct's provider failed upstream. Try regenerating",
    "OpenRouter error (502): JSON error injected into SSE stream",
  ];
  for (const raw of raws) {
    assert.equal(
      classifyGenerationFailure(raw).code,
      FAILURE_CODE.UPSTREAM_UNAVAILABLE,
      `expected UPSTREAM_UNAVAILABLE for: ${raw}`,
    );
  }
});

test("unrecognized errors keep their original text instead of a friendly lie", () => {
  const raw = "TypeError: Cannot read properties of undefined (reading 'foo')";
  const result = classifyGenerationFailure(raw);
  assert.equal(result.code, null);
  assert.equal(result.message, raw);
});

test("empty input still yields a usable message", () => {
  assert.equal(classifyGenerationFailure("").message, "Generation failed");
});
