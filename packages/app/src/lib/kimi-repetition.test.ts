import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isKimiAntiRepetitionModel,
  kimiRepetitionOverride,
} from "./kimi-repetition.js";

test("Kimi receives its repetition override", () => {
  assert.equal(isKimiAntiRepetitionModel("moonshotai/kimi-k2-0905"), true);
  assert.deepEqual(
    kimiRepetitionOverride("moonshotai/kimi-k2-0905", 1.08),
    { repetitionPenalty: 1.08 },
  );
});

test("non-Kimi models receive no repetition override", () => {
  for (const model of [
    "deepseek/deepseek-v4-pro",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3-flash-preview",
    "openai/gpt-5.2",
  ]) {
    assert.equal(isKimiAntiRepetitionModel(model), false, model);
    assert.deepEqual(kimiRepetitionOverride(model, 1.5), {}, model);
  }
});

test("all chat request paths apply the model-scoped override", () => {
  const chatStore = readFileSync(new URL("../stores/chat.ts", import.meta.url), "utf8");

  assert.equal(
    chatStore.match(/\.\.\.kimiRepetitionOverride\(/g)?.length,
    3,
    "send, regenerate, and continue must all use the Kimi-only helper",
  );
  assert.doesNotMatch(chatStore, /repetitionPenalty:\s*config\.repetitionPenalty/);
});
