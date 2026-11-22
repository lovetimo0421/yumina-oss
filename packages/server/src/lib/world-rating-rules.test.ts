import assert from "node:assert/strict";
import test from "node:test";
import { checkLowRating } from "./world-rating-rules.js";

const explained = "第三章选完选项就卡住，刷新也没用";

test("3–5 stars need nothing and clear any stored reason", () => {
  for (const rating of [3, 4, 5]) {
    assert.deepEqual(checkLowRating({ rating, reasons: undefined, content: null, existingLowReason: "bug" }), { ok: true, lowReason: null });
  }
});

test("a bare 1 star is refused until it says what went wrong", () => {
  for (const reasons of [undefined, null, [], "bug"]) {
    const result = checkLowRating({ rating: 1, reasons, content: null, existingLowReason: null });
    assert.equal(!result.ok && result.code, "low_rating_needs_reason");
  }
  const junk = checkLowRating({ rating: 1, reasons: ["too_thin", "meh"], content: null, existingLowReason: null });
  assert.equal(!junk.ok && junk.code, "low_rating_needs_reason");
});

test("self-explanatory reasons are one tap; the comment is optional", () => {
  assert.deepEqual(
    checkLowRating({ rating: 2, reasons: ["too_thin", "not_as_described"], content: null, existingLowReason: null }),
    { ok: true, lowReason: "not_as_described,too_thin" },
  );
  assert.deepEqual(
    checkLowRating({ rating: 1, reasons: ["boring"], content: "meh", existingLowReason: null }),
    { ok: true, lowReason: "boring" },
  );
});

test("bug and other reasons accept short or absent written details", () => {
  for (const reasons of [["bug"], ["other"], ["too_thin", "bug"]]) {
    for (const content of [null, "Bug", "卡死了"]) {
      const result = checkLowRating({ rating: 2, reasons, content, existingLowReason: null });
      assert.equal(result.ok, true);
    }
  }
  assert.deepEqual(checkLowRating({ rating: 1, reasons: ["bug"], content: explained, existingLowReason: null }), { ok: true, lowReason: "bug" });
});

test("moving between 1 and 2 stars keeps the earlier reasons without a new comment", () => {
  assert.deepEqual(checkLowRating({ rating: 2, reasons: null, content: null, existingLowReason: "ai_quality,boring" }), { ok: true, lowReason: "ai_quality,boring" });
  // A 5★ rater dropping to 1★ has no low reason on file and must pick one.
  assert.equal(checkLowRating({ rating: 1, reasons: null, content: null, existingLowReason: null }).ok, false);
});
