import test from "node:test";
import assert from "node:assert/strict";
import { textPrefix } from "./text-prefix.js";

test("textPrefix backs off a split surrogate pair and otherwise matches slice", () => {
  assert.equal(textPrefix("ab😀c", 3), "ab");
  assert.equal(textPrefix("ab😀c", 4), "ab😀");
  assert.equal(textPrefix("abc", 2), "ab");
  assert.equal(textPrefix("abc", 10), "abc");
  assert.equal(textPrefix("😀", 1), "");
});
