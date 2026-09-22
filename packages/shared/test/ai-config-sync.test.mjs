import assert from "node:assert/strict";
import test from "node:test";
import { aiConfigSchema, aiGenerationConfigSchema } from "../dist/index.js";

// What the app's first sync actually sends: every key the account does not
// have yet, with "never chose a story-memory size" as null.
const firstSyncSeed = {
  maxTokens: 12000, maxContext: 200000, storyMemory: null, temperature: 1, topP: 1,
  frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1.08, topK: 0, minP: 0,
  reasoningEffort: "low", streaming: true, selectedModel: "anthropic/claude-sonnet-4.6",
  modelFallback: { mode: "ask", officialModel: "", privateModel: "", privateKeyId: null },
};

test("the account accepts the first-sync seed, story memory unset included", () => {
  assert.equal(aiConfigSchema.safeParse(firstSyncSeed).success, true);
});

test("the account still bounds a chosen story-memory size", () => {
  assert.equal(aiConfigSchema.safeParse({ storyMemory: 16000 }).success, true);
  assert.equal(aiConfigSchema.safeParse({ storyMemory: 100 }).success, false);
  assert.equal(aiConfigSchema.safeParse({ storyMemory: "16000" }).success, false);
});

test("per-turn generation settings still take a number or nothing", () => {
  assert.equal(aiGenerationConfigSchema.safeParse({ storyMemory: null }).success, false);
});
