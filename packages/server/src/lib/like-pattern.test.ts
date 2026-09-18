import test from "node:test";
import assert from "node:assert/strict";
import { escapeLikePattern } from "./like-pattern.js";

test("escapes percent so it matches literally", () => {
  assert.equal(escapeLikePattern("100%"), "100\\%");
});

test("escapes underscore so it matches literally", () => {
  assert.equal(escapeLikePattern("a_b"), "a\\_b");
});

test("escapes backslash itself", () => {
  assert.equal(escapeLikePattern("a\\b"), "a\\\\b");
});

test("leaves plain and CJK input untouched", () => {
  assert.equal(escapeLikePattern("水墨潇潇"), "水墨潇潇");
  assert.equal(escapeLikePattern("a872281748"), "a872281748");
  assert.equal(escapeLikePattern(""), "");
});
