import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTemperatureForModel,
  clampTopKForModel,
  clampTemperature,
  isAnthropicModel,
  repetitionPenaltyForModel,
} from "./sampling-limits.js";

test("LongCat 2.0 sampling respects measured limits without changing other models", () => {
  const model = "meituan/longcat-2.0";
  assert.equal(clampTemperatureForModel(model, 1.1), 1);
  assert.equal(clampTemperatureForModel(model, 0), 0);
  assert.equal(clampTemperatureForModel(model, 0.8), 0.8);
  assert.equal(clampTemperatureForModel(model, undefined), undefined);
  assert.equal(clampTopKForModel(model, 200), 100);
  assert.equal(clampTopKForModel(model, 100), 100);
  assert.equal(clampTopKForModel(model, 50), 50);
  assert.equal(clampTopKForModel(model, 0.5), 1);
  assert.equal(clampTopKForModel(model, 0), 0);
  assert.equal(clampTopKForModel(model, undefined), undefined);
  assert.equal(clampTopKForModel(model, NaN), undefined);
  for (const other of ["google/gemini-3-flash-preview", "meituan/longcat-flash-chat", "custom/longcat-2.0"]) {
    assert.equal(clampTemperatureForModel(other, 1.1), 1.1);
    assert.equal(clampTopKForModel(other, 200), 200);
  }
});

test("isAnthropicModel: native and OpenRouter Claude ids match", () => {
  assert.equal(isAnthropicModel("anthropic/claude-opus-4.7"), true);
  assert.equal(isAnthropicModel("anthropic/claude-opus-4-7"), true);
  assert.equal(isAnthropicModel("claude-3-haiku-20240307"), true);
});

test("isAnthropicModel: other families do not match", () => {
  assert.equal(isAnthropicModel("google/gemini-3-flash-preview"), false);
  assert.equal(isAnthropicModel("openai/gpt-4o"), false);
  assert.equal(isAnthropicModel("moonshotai/kimi-k2-0905"), false);
});

test("clampTemperatureForModel: Claude models clamp above 1.0 (the ANG 400)", () => {
  assert.equal(clampTemperatureForModel("anthropic/claude-opus-4.7", 1.5), 1);
  assert.equal(clampTemperatureForModel("anthropic/claude-opus-4.7", 1.15), 1);
});

test("clampTemperatureForModel: Claude in-range values pass through untouched", () => {
  assert.equal(clampTemperatureForModel("anthropic/claude-opus-4.7", 1), 1);
  assert.equal(clampTemperatureForModel("anthropic/claude-opus-4.7", 0.7), 0.7);
  assert.equal(clampTemperatureForModel("anthropic/claude-opus-4.7", 0), 0);
});

test("clampTemperatureForModel: non-Claude families are not clamped (Gemini accepts >1)", () => {
  assert.equal(clampTemperatureForModel("google/gemini-3.5-flash", 1.15), 1.15);
  assert.equal(clampTemperatureForModel("openai/gpt-4o", 1.5), 1.5);
});

test("clampTemperatureForModel: unset/NaN omits the field", () => {
  assert.equal(clampTemperatureForModel("anthropic/claude-opus-4.7", undefined), undefined);
  assert.equal(clampTemperatureForModel("anthropic/claude-opus-4.7", Number.NaN), undefined);
});

test("clampTemperature: negative values clamp to 0", () => {
  assert.equal(clampTemperature(-0.5, 1), 0);
});

test("Kimi K2 gets a conservative repetition penalty by default", () => {
  assert.equal(repetitionPenaltyForModel("moonshotai/kimi-k2-0905", undefined), 1.08);
  assert.equal(repetitionPenaltyForModel("moonshotai/kimi-k2-0905", 1.2), 1.2);
});

test("repetition penalty is omitted for models that may reject it", () => {
  assert.equal(repetitionPenaltyForModel("google/gemini-3.5-flash", 1.08), undefined);
  assert.equal(repetitionPenaltyForModel("deepseek/deepseek-v3.2", 1.08), undefined);
});

test("Kimi repetition penalty is clamped to OpenRouter's accepted range", () => {
  assert.equal(repetitionPenaltyForModel("moonshotai/kimi-k2-0905", -1), 0);
  assert.equal(repetitionPenaltyForModel("moonshotai/kimi-k2-0905", 3), 2);
  assert.equal(repetitionPenaltyForModel("moonshotai/kimi-k2-0905", Number.NaN), 1.08);
});
