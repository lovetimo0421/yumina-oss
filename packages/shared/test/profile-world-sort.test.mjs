import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeProfileWorldSort } from "../dist/index.js";

describe("profile world sort", () => {
  it("defaults missing and invalid preferences to newest", () => {
    assert.equal(normalizeProfileWorldSort(undefined), "newest");
    assert.equal(normalizeProfileWorldSort(null), "newest");
    assert.equal(normalizeProfileWorldSort("hottest"), "newest");
  });

  it("preserves each supported preference", () => {
    assert.equal(normalizeProfileWorldSort("newest"), "newest");
    assert.equal(normalizeProfileWorldSort("popular"), "popular");
  });
});
