import assert from "node:assert/strict";
import test from "node:test";
import { resolveProfileContentLevel } from "./profile-content-level.js";

test("profile content defaults to safe and guests cannot request Limitless", () => {
  assert.equal(resolveProfileContentLevel(false, "sensitive", { contentLevel: "sensitive" }), "safe");
  assert.equal(resolveProfileContentLevel(true, undefined, undefined), "safe");
  assert.equal(resolveProfileContentLevel(true, "invalid", {}), "safe");
});

test("profile content follows the viewer's mode, including legacy preferences", () => {
  for (const contentLevel of ["sensitive", "r18", "r18g"]) {
    assert.equal(resolveProfileContentLevel(true, undefined, { contentLevel }), "r18");
    assert.equal(resolveProfileContentLevel(true, "safe", { contentLevel }), "safe");
    assert.equal(resolveProfileContentLevel(true, contentLevel, { contentLevel: "safe" }), "r18");
  }
  assert.equal(resolveProfileContentLevel(true, undefined, { showNsfw: true }), "r18");
  assert.equal(resolveProfileContentLevel(true, undefined, { contentLevel: "safe", showNsfw: true }), "safe");
});
