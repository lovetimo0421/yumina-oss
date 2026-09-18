import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { generateCompleteMemory, normalizeSessionMemory, MAX_MEMORY_CHARS, MAX_MEMORY_OUTPUT_TOKENS } from "./session-memory-core.js";
import { memoryPromptWithBudget } from "./session-memory-prompts.js";

const partial = "Core facts:\n- Mira holds the copper key.\nCurrent risks:\n- The bridge will close before";
test("second truncated response is saved as usable memory with a durable warning", async () => {
  const targets: number[] = [];
  const memory = await generateCompleteMemory({generate: async target => {
    targets.push(target);
    return {text: partial, stopReason: "max_tokens", completionTokens: 8192};
  }});
  assert.deepEqual(targets, [5000, 1500]);
  assert.deepEqual(memory, {text: partial, warning: "truncated"});
  assert.deepEqual(normalizeSessionMemory(memory), memory, "warning survives the read path");
  assert.equal(MAX_MEMORY_OUTPUT_TOKENS, 8192, "only the prompt target shrinks");
});

test("second oversized response keeps its prefix inside the unchanged storage ceiling", async () => {
  const text = Array.from({length: 220}, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("\n");
  const memory = await generateCompleteMemory({generate: async () => ({text, stopReason: "stop", completionTokens: 6000})});
  assert.equal(memory.text.length, MAX_MEMORY_CHARS);
  assert.equal(memory.text, text.slice(0, MAX_MEMORY_CHARS));
  assert.deepEqual(memory, normalizeSessionMemory(memory));
  assert.equal((memory as {warning?: string}).warning, "truncated");
});

test("recovery gives a small explicit character and token writing budget", () => {
  const prompt = memoryPromptWithBudget([{role: "system", content: "Keep facts in Chinese."}, {role: "user", content: "Mira holds the key."}], 1500, true);
  const instruction = String(prompt[0]!.content);
  assert.match(instruction, /1500 characters/);
  assert.match(instruction, /1500 output tokens/);
  assert.match(instruction, /supersedes/i);
  assert.match(instruction, /rewrite.*entire/i);
  assert.equal(prompt[1]!.content, "Mira holds the key.");
});
