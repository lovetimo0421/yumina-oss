import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeProfileWorldOrder, normalizeProfileWorldSort, PROFILE_WORLD_ORDER_MAX } from "../dist/index.js";

describe("profile world sort", () => {
  it("defaults missing and invalid preferences to newest", () => {
    assert.equal(normalizeProfileWorldSort(undefined), "newest");
    assert.equal(normalizeProfileWorldSort(null), "newest");
    assert.equal(normalizeProfileWorldSort("hottest"), "newest");
  });

  it("preserves each supported preference", () => {
    assert.equal(normalizeProfileWorldSort("newest"), "newest");
    assert.equal(normalizeProfileWorldSort("popular"), "popular");
    assert.equal(normalizeProfileWorldSort("alphabetical"), "alphabetical");
    assert.equal(normalizeProfileWorldSort("custom"), "custom");
  });
});

describe("profile world order", () => {
  it("keeps a list of distinct ids in order", () => {
    assert.deepEqual(normalizeProfileWorldOrder(["b", "a", "b", "c"]), ["b", "a", "c"]);
  });

  it("drops anything that is not a short id", () => {
    assert.deepEqual(normalizeProfileWorldOrder(["a", 3, null, "", "x".repeat(65), "b"]), ["a", "b"]);
    assert.deepEqual(normalizeProfileWorldOrder("a,b"), []);
    assert.deepEqual(normalizeProfileWorldOrder(undefined), []);
  });

  it("is bounded", () => {
    const many = Array.from({ length: PROFILE_WORLD_ORDER_MAX + 50 }, (_, i) => `w${i}`);
    assert.equal(normalizeProfileWorldOrder(many).length, PROFILE_WORLD_ORDER_MAX);
  });
});
