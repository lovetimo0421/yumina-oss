import { test } from "node:test";
import assert from "node:assert/strict";
import { searchActions } from "./search-actions";

test("the words a creator uses for a feature find it", () => {
  assert.deepEqual(searchActions("theme"), ["look"]);
  assert.deepEqual(searchActions("主题"), ["look"]);
  assert.deepEqual(searchActions("代码"), ["code"]);
  assert.deepEqual(searchActions("Front End Code"), ["code"]);
  assert.deepEqual(searchActions("模板"), ["saveTemplate"]);
  assert.deepEqual(searchActions("preset"), ["saveTemplate"]);
  assert.deepEqual(searchActions("資源市場"), ["market"]);
});

test("a sentence that names the feature finds it, and the start of a word does", () => {
  assert.deepEqual(searchActions("how do I edit the theme code"), ["look", "code"]);
  assert.deepEqual(searchActions("tem"), ["look", "saveTemplate"]);
  assert.deepEqual(searchActions("主"), ["look"]);
});

test("one Latin letter, an empty box or a character's name asks for nothing", () => {
  assert.deepEqual(searchActions("t"), []);
  assert.deepEqual(searchActions("   "), []);
  assert.deepEqual(searchActions("德拉科妮娅"), []);
  assert.deepEqual(searchActions("Hermione"), []);
});
