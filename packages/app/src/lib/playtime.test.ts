import assert from "node:assert/strict";
import test from "node:test";
import { formatPlaytimeShort } from "./playtime";

test("a just-played session shows minutes, not 0.0 h", () => {
  assert.equal(formatPlaytimeShort(20, "en"), "<1 min");
  assert.equal(formatPlaytimeShort(12 * 60 + 5, "en"), "12 min");
  assert.equal(formatPlaytimeShort(90 * 60, "en"), "1.5 hr");
  assert.equal(formatPlaytimeShort(12 * 60, "zh"), "12分钟");
  assert.equal(formatPlaytimeShort(null, "en"), "--");
});
