import assert from "node:assert/strict";
import test from "node:test";
import { getModelContextWindow, clampMaxContextToModel } from "./context-window.js";
import { effectiveMaxTokens } from "./openrouter.js";
import { registerContextWindows, getCatalogContextWindow } from "./model-catalog.js";

// Fallback values verified against OpenRouter /api/v1/models on 2026-06-05.
test("getModelContextWindow: known families return their fallback window", () => {
  assert.equal(getModelContextWindow("deepseek/deepseek-v3.2"), 131_072);
  assert.equal(getModelContextWindow("deepseek/deepseek-v4-flash"), 1_000_000); // V4 = 1M (the default model)
  assert.equal(getModelContextWindow("google/gemini-3-flash-preview"), 1_000_000);
  assert.equal(getModelContextWindow("anthropic/claude-3-haiku"), 200_000);
  assert.equal(getModelContextWindow("anthropic/claude-haiku-4.5"), 200_000);
  assert.equal(getModelContextWindow("anthropic/claude-sonnet-4.6"), 1_000_000);
  assert.equal(getModelContextWindow("moonshotai/kimi-k2-0905"), 262_144);
});

// The literal "sonnet-4"/"opus-4" match demoted the 5.x line to 200K the day it
// shipped, halving every Claude 5 player's memory on a cold catalog.
test("getModelContextWindow: the Claude 5.x line gets the 1M fallback, not 200K", () => {
  assert.equal(getModelContextWindow("anthropic/claude-sonnet-5"), 1_000_000);
  assert.equal(getModelContextWindow("anthropic/claude-opus-5"), 1_000_000);
  assert.equal(getModelContextWindow("anthropic/claude-opus-5-fast"), 1_000_000);
  assert.equal(getModelContextWindow("anthropic/claude-fable-5"), 1_000_000);
  // …while the genuinely-200K SKUs stay 200K.
  assert.equal(getModelContextWindow("anthropic/claude-haiku-4.5"), 200_000);
  assert.equal(getModelContextWindow("anthropic/claude-haiku-5"), 200_000);
  assert.equal(getModelContextWindow("anthropic/claude-3-opus"), 200_000);
  assert.equal(getModelContextWindow("anthropic/claude-opus-3"), 200_000);
});

test("getModelContextWindow: unknown/custom returns Infinity (clamp no-op)", () => {
  assert.equal(getModelContextWindow("custom/some-local-model"), Number.POSITIVE_INFINITY);
  assert.equal(getModelContextWindow("acme/unreleased-9000"), Number.POSITIVE_INFINITY);
});

// THE REGRESSION: a 200K maxContext on DeepSeek V3.2 (131,072 window) used to be
// sent verbatim, producing OpenRouter's "maximum context length … requested
// 236054" 400. The clamp must shrink it so input + output fits the window.
test("clampMaxContextToModel: DeepSeek 200K request is clamped to fit the 131,072 window", () => {
  const requested = 200_000;
  const maxTokens = 4096;
  const result = clampMaxContextToModel(requested, "deepseek/deepseek-v3.2", maxTokens, undefined);

  assert.ok(result < requested, "should reduce the over-large request");
  // The whole point: input budget + output reserve must fit inside the window.
  const fits = result + effectiveMaxTokens(maxTokens, undefined);
  assert.ok(fits <= 131_072, `input+output (${fits}) must fit the 131,072 window`);
});

test("clampMaxContextToModel: DeepSeek with high reasoning reserves more for output", () => {
  const requested = 200_000;
  const maxTokens = 4096;
  const low = clampMaxContextToModel(requested, "deepseek/deepseek-v3.2", maxTokens, undefined);
  const high = clampMaxContextToModel(requested, "deepseek/deepseek-v3.2", maxTokens, "high");
  // More output headroom (reasoning) → smaller input budget, still fits.
  assert.ok(high < low, "high reasoning effort must leave less room for input");
  assert.ok(high + effectiveMaxTokens(maxTokens, "high") <= 131_072);
});

test("clampMaxContextToModel: GLM 4.6 fits its smallest endpoint before the catalog warms", () => {
  const model = "z-ai/glm-4.6";
  const maxTokens = 4096;
  assert.equal(getModelContextWindow(model), 198_000);
  for (const reasoning of [undefined, "high"]) {
    const result = clampMaxContextToModel(200_000, model, maxTokens, reasoning);
    assert.ok(result < 200_000);
    assert.ok(result + effectiveMaxTokens(maxTokens, reasoning) <= 198_000);
  }
});

test("clampMaxContextToModel: Gemini 200K request is left untouched (1M window)", () => {
  const requested = 200_000;
  const result = clampMaxContextToModel(requested, "google/gemini-3-flash-preview", 4096, undefined);
  assert.equal(result, requested);
});

test("clampMaxContextToModel: unknown/custom model is never clamped", () => {
  const requested = 1_500_000;
  const result = clampMaxContextToModel(requested, "custom/my-1m-proxy", 4096, "high");
  assert.equal(result, requested);
});

test("getModelContextWindow: prefers the live OpenRouter catalog over the hardcoded fallback", () => {
  // Catalog is authoritative. A model the catalog knows wins over any hardcoded guess.
  registerContextWindows([{ id: "vendor/some-future-model", contextLength: 524_288 }]);
  assert.equal(getCatalogContextWindow("vendor/some-future-model"), 524_288);
  assert.equal(getModelContextWindow("vendor/some-future-model"), 524_288);
  // And a live value also overrides a family we hardcode (simulate OpenRouter
  // reporting a different DeepSeek endpoint window).
  registerContextWindows([{ id: "deepseek/deepseek-special", contextLength: 131_072 }]);
  assert.equal(getModelContextWindow("deepseek/deepseek-special"), 131_072);
});

test("getModelContextWindow: falls back to the hardcoded map when catalog is cold for that id", () => {
  // Not registered → hardcoded family value.
  assert.equal(getModelContextWindow("deepseek/deepseek-v3.2"), 131_072);
  assert.equal(getModelContextWindow("totally/unknown-model"), Number.POSITIVE_INFINITY);
});

test("clampMaxContextToModel: a request already under the cap passes through", () => {
  // We only ever shrink an over-large request, never inflate a small one.
  const result = clampMaxContextToModel(8000, "deepseek/deepseek-v3.2", 4096, undefined);
  assert.equal(result, 8000);
});
