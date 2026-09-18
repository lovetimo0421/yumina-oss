import assert from "node:assert/strict";
import test from "node:test";
import { coverShouldBlur } from "./cover-blur";

test("coverShouldBlur honors the explicit creator choice over age rating", () => {
  // Sensitive card whose creator turned blur OFF → clear.
  assert.equal(coverShouldBlur({ blurCover: false, ageRating: "sensitive" }), false);
  // All-ages card whose creator turned blur ON → blurred.
  assert.equal(coverShouldBlur({ blurCover: true, ageRating: "all" }), true);
});

test("coverShouldBlur falls back to age rating when blurCover is unset (null/undefined)", () => {
  assert.equal(coverShouldBlur({ blurCover: null, ageRating: "sensitive" }), true);
  assert.equal(coverShouldBlur({ blurCover: null, ageRating: "all" }), false);
  assert.equal(coverShouldBlur({ ageRating: "sensitive" }), true);
  assert.equal(coverShouldBlur({ ageRating: "all" }), false);
});

test("coverShouldBlur falls back to isNsfw when ageRating is absent", () => {
  assert.equal(coverShouldBlur({ isNsfw: true }), true);
  assert.equal(coverShouldBlur({ isNsfw: false }), false);
  assert.equal(coverShouldBlur({}), false);
});

test("coverShouldBlur: explicit blurCover overrides every fallback combination", () => {
  // blurCover=true wins over all-ages + non-nsfw
  assert.equal(coverShouldBlur({ blurCover: true, ageRating: "all", isNsfw: false }), true);
  // blurCover=false wins over sensitive + nsfw
  assert.equal(coverShouldBlur({ blurCover: false, ageRating: "sensitive", isNsfw: true }), false);
});

test("coverShouldBlur: r18 and r18g age ratings are treated as sensitive (non-all)", () => {
  assert.equal(coverShouldBlur({ blurCover: null, ageRating: "r18" }), true);
  assert.equal(coverShouldBlur({ blurCover: null, ageRating: "r18g" }), true);
});

test("coverShouldBlur: ageRating takes priority over isNsfw when both present", () => {
  // ageRating="all" but isNsfw=true — ageRating wins
  assert.equal(coverShouldBlur({ ageRating: "all", isNsfw: true }), false);
  // ageRating="sensitive" but isNsfw=false — ageRating wins
  assert.equal(coverShouldBlur({ ageRating: "sensitive", isNsfw: false }), true);
});
