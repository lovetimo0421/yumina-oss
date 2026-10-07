import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewDiffTokens, type ReviewDiffToken } from "./review-diff";

const text = (tokens: ReviewDiffToken[], type: ReviewDiffToken["type"]) =>
  tokens.filter((t) => t.type === type).map((t) => t.text).join("");

test("a small edit is diffed word by word", () => {
  const tokens = buildReviewDiffTokens("The cat sat on the mat.", "The dog sat on the mat.");
  assert.equal(text(tokens, "removed"), "cat");
  assert.equal(text(tokens, "added"), "dog");
});

test("a 2000-line fully rewritten input diffs in under 500ms", () => {
  const original = Array.from({ length: 2000 }, (_, i) => `line ${i}: the old wording of this rule, value ${i * 3}`).join("\n");
  const changed = Array.from({ length: 2000 }, (_, i) => `row ${i}: a new phrasing for that behaviour, amount ${i * 7}`).join("\n");
  const started = performance.now();
  const tokens = buildReviewDiffTokens(original, changed);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `took ${Math.round(elapsed)}ms`);
  // Nothing is lost: each side reads back in full.
  assert.equal(tokens.filter((t) => t.type !== "added").map((t) => t.text).join(""), original);
  assert.equal(tokens.filter((t) => t.type !== "removed").map((t) => t.text).join(""), changed);
});

test("a few hundred changed lines still align by sentence, quickly", () => {
  const original = Array.from({ length: 450 }, (_, i) => `Guard ${i} watches the east gate at night.`).join("\n");
  const changed = Array.from({ length: 450 }, (_, i) => `Guard ${i} watches the west gate at dawn.`).join("\n");
  const started = performance.now();
  const tokens = buildReviewDiffTokens(original, changed);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `took ${Math.round(elapsed)}ms`);
  assert.match(text(tokens, "removed"), /east/);
  assert.match(text(tokens, "added"), /west/);
  assert.match(text(tokens, "unchanged"), /Guard 12 watches the/);
});
