import test from "node:test";
import assert from "node:assert/strict";
import { extractKeywords, toStringArray } from "./context-resolver.js";

// ── toStringArray ──
// Regression: a lorebook entry whose `keywords`/`tags` were persisted as a
// string (LLM tool call emitted "a, b" instead of ["a","b"]) used to crash the
// Studio AI with `e.keywords.slice(...).join is not a function`.

test("toStringArray passes a string array through unchanged", () => {
  assert.deepEqual(toStringArray(["idol", "kpop"]), ["idol", "kpop"]);
});

test("toStringArray splits a comma-separated string into a trimmed array", () => {
  assert.deepEqual(toStringArray("idol, kpop ,stay"), ["idol", "kpop", "stay"]);
});

test("toStringArray wraps a single bare string", () => {
  assert.deepEqual(toStringArray("idol"), ["idol"]);
});

test("toStringArray returns [] for null/undefined/object/number", () => {
  assert.deepEqual(toStringArray(undefined), []);
  assert.deepEqual(toStringArray(null), []);
  assert.deepEqual(toStringArray(42), []);
  assert.deepEqual(toStringArray({ a: 1 }), []);
});

test("toStringArray drops non-string array members and empty fragments", () => {
  assert.deepEqual(toStringArray(["ok", 3, null, "two"]), ["ok", "two"]);
  assert.deepEqual(toStringArray("a,, ,b"), ["a", "b"]);
});

// ── extractKeywords ──

test("extractKeywords extracts meaningful words and filters stop words", () => {
  const keywords = extractKeywords("Create a tavern entry with a mysterious bartender");
  assert.ok(keywords.includes("tavern"));
  assert.ok(keywords.includes("mysterious"));
  assert.ok(keywords.includes("bartender"));
  assert.ok(keywords.includes("entry"));
  // Stop words filtered
  assert.ok(!keywords.includes("a"));
  assert.ok(!keywords.includes("with"));
  assert.ok(!keywords.includes("create"));
});

test("extractKeywords handles empty input", () => {
  const keywords = extractKeywords("");
  assert.equal(keywords.length, 0);
});

test("extractKeywords handles whitespace-only input", () => {
  const keywords = extractKeywords("   ");
  assert.equal(keywords.length, 0);
});

test("extractKeywords strips punctuation", () => {
  const keywords = extractKeywords("What's the bartender's name?");
  assert.ok(keywords.includes("bartender"));
  assert.ok(!keywords.includes("?"));
});

test("extractKeywords filters single-character words", () => {
  const keywords = extractKeywords("I want a b c variable");
  assert.ok(!keywords.includes("b"));
  assert.ok(!keywords.includes("c"));
  assert.ok(keywords.includes("variable"));
});

test("extractKeywords handles kebab-case entity names", () => {
  const keywords = extractKeywords("update the combat-system entry");
  assert.ok(keywords.includes("combat-system"));
});

test("extractKeywords normalizes to lowercase", () => {
  const keywords = extractKeywords("Make the BARTENDER more MYSTERIOUS");
  assert.ok(keywords.includes("bartender"));
  assert.ok(keywords.includes("mysterious"));
});
