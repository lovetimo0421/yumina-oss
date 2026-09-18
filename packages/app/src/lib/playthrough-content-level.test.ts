import assert from "node:assert/strict";
import test from "node:test";
import { playthroughContentLevelQuery } from "./playthrough-content-level";

test("safe gallery requests omit the content marker", () => {
  assert.equal(playthroughContentLevelQuery("&", "safe"), "");
});

test("sensitive gallery and detail requests include the content marker", () => {
  assert.equal(playthroughContentLevelQuery("&", "sensitive"), "&contentLevel=sensitive");
  assert.equal(playthroughContentLevelQuery("?", "sensitive"), "?contentLevel=sensitive");
});
