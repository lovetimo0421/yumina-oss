import assert from "node:assert/strict";
import test from "node:test";
import {
  isLowRating,
  isLowRatingReason,
  isLowRatingExplanationLongEnough,
  lowRatingExplanationLength,
} from "../dist/index.js";

test("only 1 and 2 stars count as low", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(isLowRating), [true, true, false, false, false]);
});

test("reasons are a closed list", () => {
  assert.equal(isLowRatingReason("bug"), true);
  assert.equal(isLowRatingReason("BUG"), false);
  assert.equal(isLowRatingReason(undefined), false);
});

test("a one-word complaint is too short in any script", () => {
  assert.equal(isLowRatingExplanationLongEnough("Bug"), false);
  assert.equal(isLowRatingExplanationLongEnough("卡死了"), false);
  assert.equal(isLowRatingExplanationLongEnough("   it    crashes   "), false);
});

test("ten Chinese characters or twenty latin characters is enough", () => {
  assert.equal(lowRatingExplanationLength("第三章选完选项就卡住"), 20);
  assert.equal(isLowRatingExplanationLongEnough("第三章选完选项就卡住"), true);
  assert.equal(isLowRatingExplanationLongEnough("Freezes after ch. 3!"), true);
  assert.equal(isLowRatingExplanationLongEnough("ゲームが途中で止まる"), true);
});

test("reasons round-trip in display order, unknowns dropped", async () => {
  const { serializeLowRatingReasons, parseLowRatingReasons } = await import("../dist/index.js");
  assert.equal(serializeLowRatingReasons(["too_thin", "bug", "too_thin"]), "bug,too_thin");
  assert.deepEqual(parseLowRatingReasons("too_thin,nope,bug"), ["bug", "too_thin"]);
  assert.equal(serializeLowRatingReasons([]), null);
  assert.deepEqual(parseLowRatingReasons(null), []);
});

test("only bug and other need the player's details", async () => {
  const { lowRatingNeedsExplanation } = await import("../dist/index.js");
  assert.equal(lowRatingNeedsExplanation(["too_thin", "not_as_described"]), false);
  assert.equal(lowRatingNeedsExplanation(["too_thin", "bug"]), true);
  assert.equal(lowRatingNeedsExplanation(["other"]), true);
});
