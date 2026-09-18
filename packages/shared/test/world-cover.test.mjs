import assert from "node:assert/strict";
import test from "node:test";
import { hasPublishableCover } from "../dist/index.js";

// Publishing gate (2026-09-05): every card entering review must carry a cover.
// The predicate is shared by the server's COVER_REQUIRED check and the publish
// modal's pre-submit guard so the two can never disagree.

test("a stored cover key or URL counts as a cover", () => {
  assert.equal(hasPublishableCover("worlds/abc/thumbnail/1.webp"), true);
  assert.equal(hasPublishableCover("https://cdn.yumina.io/cdn/asset-1"), true);
});

test("null, undefined and empty strings are not covers", () => {
  assert.equal(hasPublishableCover(null), false);
  assert.equal(hasPublishableCover(undefined), false);
  assert.equal(hasPublishableCover(""), false);
});

test("whitespace-only values are not covers", () => {
  assert.equal(hasPublishableCover("   "), false);
  assert.equal(hasPublishableCover("\n\t"), false);
});
