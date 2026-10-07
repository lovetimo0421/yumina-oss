import assert from "node:assert/strict";
import test from "node:test";
import { isTokenizerReady, preloadTokenizer, type WorldDefinition } from "@yumina/engine";
import { computeContextBudget } from "./context-budget";

// A blank card is five Chinese presets. Counted before the tokenizer loads,
// they came out 225 (chars/3) and that number stuck until the entries were
// replaced — a trip to the canvas and back "changed" it to the real 619.
test("a count taken before the tokenizer loads is not kept once it has", async () => {
  const world = {
    entries: [{ id: "e1", name: "设定", content: "这是一段很长的中文设定，用来检查分词器加载前后的计数。".repeat(20), alwaysSend: true }],
    variables: [],
  } as unknown as WorldDefinition;
  assert.equal(isTokenizerReady(), false, "this test needs a process where the tokenizer has not loaded yet");
  const before = computeContextBudget(world).tokensByTrigger.always;
  await preloadTokenizer();
  assert.equal(isTokenizerReady(), true);
  const after = computeContextBudget(world).tokensByTrigger.always;
  assert.ok(after > before, `expected the exact count (${after}) to replace the pre-load estimate (${before})`);
});
