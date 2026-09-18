import assert from "node:assert/strict";
import test from "node:test";
import { durationFor, validateFeedbackText, toPillText, FEEDBACK_MAX_CHARS } from "./feedback-policy";

test("toPillText flattens dynamic text to one acceptable line", () => {
  assert.equal(toPillText("  Saved\n  everything!  "), "Saved everything");
  const long = "First sentence is short. " + "x".repeat(120);
  assert.equal(toPillText(long), "First sentence is short.");
  const noSentence = "y".repeat(120);
  assert.equal(toPillText(noSentence).length, FEEDBACK_MAX_CHARS);
  assert.equal(validateFeedbackText(toPillText(long)), null);
  assert.equal(toPillText(null), "");
});

test("durations follow the spec table", () => {
  assert.equal(durationFor("notice"), 2500);
  assert.equal(durationFor("error"), 6000);
  assert.equal(durationFor("undo"), 5000);
  assert.equal(durationFor("progress"), Infinity);
  assert.equal(durationFor("progress", "done"), 2500);
  assert.equal(durationFor("progress", "failed"), 6000);
  assert.equal(durationFor("persistent"), Infinity);
});

test("plain single-line copy passes", () => {
  assert.equal(validateFeedbackText("Export ready"), null);
  assert.equal(validateFeedbackText("Deleted"), null);
});

test("multi-line copy is rejected", () => {
  assert.equal(validateFeedbackText("Saved\nEverything is fine"), "newline");
});

test("over-long copy is rejected", () => {
  assert.equal(validateFeedbackText("x".repeat(FEEDBACK_MAX_CHARS + 1)), "length");
  assert.equal(validateFeedbackText("x".repeat(FEEDBACK_MAX_CHARS)), null);
});

test("exclamation marks and 'successfully' are rejected", () => {
  assert.equal(validateFeedbackText("Saved!"), "exclamation");
  assert.equal(validateFeedbackText("World saved successfully"), "successfully");
});

test("empty copy is rejected", () => {
  assert.equal(validateFeedbackText("   "), "empty");
});
