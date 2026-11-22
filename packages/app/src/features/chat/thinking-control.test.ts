import assert from "node:assert/strict";
import test from "node:test";
import { aiGenerationConfigSchema } from "@yumina/shared";
import { thinkingSupport } from "../../../sandbox/chat/thinking-control";

const choices = (...models: string[]) => thinkingSupport(models).choices;

test("the composer only offers thinking choices a model actually honors", () => {
  // Can switch off, levels differ.
  assert.deepEqual(choices("x-ai/grok-4.3"), ["none", "low", "medium", "high"]);
  // Must think, levels differ: no off.
  assert.deepEqual(choices("google/gemini-3.7-flash"), ["low", "medium", "high"]);
  assert.deepEqual(choices("google/gemini-4-hydrogen"), ["low", "medium", "high"]);
  assert.deepEqual(choices("google/gemini-4-neon"), ["low", "medium", "high"]);
  // Can switch off, but every level thinks the same: on / off only.
  assert.deepEqual(choices("moonshotai/kimi-k2.6"), ["none", "low"]);
  // Must think and levels do nothing: nothing to choose.
  assert.deepEqual(choices("aion-labs/aion-3.0"), []);
  assert.equal(thinkingSupport(["aion-labs/aion-3.0"]).canThink, true);
  // Never thinks.
  assert.deepEqual(choices("mistralai/mistral-nemo"), []);
  assert.deepEqual(choices("local/llama3"), []);
  // Never measured: levels but not off.
  assert.deepEqual(choices("someone/unknown-model"), ["low", "medium", "high"]);
  // A mix pool offers a choice when any of its models honors it.
  assert.deepEqual(choices("aion-labs/aion-3.0", "moonshotai/kimi-k2.6"), ["none", "low"]);
  assert.deepEqual(choices("google/gemini-3.7-flash", "moonshotai/kimi-k2.6"), ["none", "low", "medium", "high"]);
});

test("AI settings accept 「关闭」 as a thinking level", () => {
  assert.equal(aiGenerationConfigSchema.parse({ reasoningEffort: "none" }).reasoningEffort, "none");
});
