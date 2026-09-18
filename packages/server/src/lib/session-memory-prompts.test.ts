import assert from "node:assert/strict";
import test from "node:test";
import { memoryPromptWithBudget } from "./session-memory-prompts.js";
import type { ChatMessage } from "./llm/types.js";

test("recovery replaces the writing budget without changing evidence or losing language instructions", () => {
  const prompt: ChatMessage[] = [
    { role: "system", content: "Keep headings in English and write facts in Traditional Chinese." },
    { role: "user", content: "Existing memory: Mei promised to return the compass.\nAll pending exchanges: Lin now holds it." },
  ];
  const original = structuredClone(prompt);
  const first = memoryPromptWithBudget(prompt, 5000, false);
  const repair = memoryPromptWithBudget(prompt, 1500, true);
  assert.equal(typeof first[0]!.content, "string");
  assert.equal(typeof repair[0]!.content, "string");
  const initialInstruction = String(first[0]!.content);
  const repairInstruction = String(repair[0]!.content);
  assert.deepEqual(prompt, original, "requests must not mutate the evidence or accumulate repair instructions");
  assert.deepEqual(first.slice(1), original.slice(1));
  assert.deepEqual(repair.slice(1), original.slice(1));
  assert.match(repairInstruction, /Traditional Chinese/);
  assert.match(initialInstruction, /about 5000 characters in TOTAL/);
  assert.match(repairInstruction, /1500 characters TOTAL/);
  assert.doesNotMatch(repairInstruction, /5000/);
  assert.match(repairInstruction, /1500 output tokens/);
  assert.doesNotMatch(repairInstruction, /hard storage ceiling|at most \d+ bullets/);
  assert.match(repairInstruction, /Do not drop an important fact/);
  assert.match(repairInstruction, /ORIGINAL evidence/);
  assert.equal(repair.length, original.length, "budget belongs in the system instruction, not a competing user message");
});

test("a legacy output cap gets its own smaller writing budget", () => {
  const prompt: ChatMessage[] = [{ role: "user", content: "Original evidence" }];
  const result = memoryPromptWithBudget(prompt, 1500, true);
  assert.equal(result[0]!.role, "system");
  assert.match(String(result[0]!.content), /1500 characters TOTAL/);
  assert.equal(result[1]!.content, "Original evidence");
});
