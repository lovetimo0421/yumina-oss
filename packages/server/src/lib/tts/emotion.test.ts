import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEmotionCues, splitLines } from "./emotion.js";

test("splitLines reassembles the text exactly", () => {
  for (const text of ["一句话", "第一句\n第二句", "a\n\nb\n", "\n开头空行"]) {
    assert.equal(splitLines(text).map((p) => p.line + p.sep).join(""), text);
  }
});

test("confident lines get their cue; calm, unsure and pre-tagged lines don't", () => {
  const parts = splitLines("我们赢了！\n少爷，这是信。\n别回头。\n[whispering] 已经有了\nStay with me.");
  const { text, tagged } = applyEmotionCues(parts, {
    l0: { choice: "excited", confidence: 0.93 },
    l1: { choice: "calm", confidence: 0.9 },
    l2: { choice: "tender", confidence: 0.4 },
    l3: { choice: "sad", confidence: 0.99 },
    l4: { choice: "sad", probabilities: { sad: 0.8 } },
  });
  assert.equal(tagged, 2);
  assert.equal(
    text,
    "[excited, loud and energetic]我们赢了！\n少爷，这是信。\n别回头。\n[whispering] 已经有了\n[sad, voice trembling, holding back tears] Stay with me.",
  );
});

test("missing answers leave the text untouched", () => {
  const parts = splitLines("你走吧……");
  assert.deepEqual(applyEmotionCues(parts, {}), { text: "你走吧……", tagged: 0 });
});
