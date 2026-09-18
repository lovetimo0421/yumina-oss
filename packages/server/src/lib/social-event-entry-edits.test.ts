import assert from "node:assert/strict";
import test from "node:test";
import { resolveSocialEntryEditTransition } from "./social-event-entry-edits.js";

test("keeps account and evidence corrections outside the replacement allowance", () => {
  assert.deepEqual(resolveSocialEntryEditTransition({
      status: "submitted",
      replacementCount: 0,
      currentCanonicalPostKey: "x:1",
      nextCanonicalPostKey: "x:1",
    }), {
      linkChanged: false,
      changeKind: "correction",
      nextReplacementCount: 0,
      resetInitialReviewMaturity: false,
    });
});

test("counts a voluntary new post and resets the 24-hour maturity clock", () => {
  assert.deepEqual(resolveSocialEntryEditTransition({
      status: "under_initial_review",
      replacementCount: 0,
      currentCanonicalPostKey: "x:1",
      nextCanonicalPostKey: "x:2",
    }), {
      linkChanged: true,
      changeKind: "replacement",
      nextReplacementCount: 1,
      resetInitialReviewMaturity: true,
    });
});

test("does not consume the allowance when an admin requested changes", () => {
  assert.equal(resolveSocialEntryEditTransition({
      status: "needs_changes",
      replacementCount: 1,
      currentCanonicalPostKey: "x:1",
      nextCanonicalPostKey: "x:2",
    }).nextReplacementCount, 1);
});

test("rejects a second voluntary replacement", () => {
  assert.throws(() => resolveSocialEntryEditTransition({
      status: "submitted",
      replacementCount: 1,
      currentCanonicalPostKey: "x:1",
      nextCanonicalPostKey: "x:2",
    }), /SOCIAL_ENTRY_REPLACEMENT_LIMIT_REACHED/);
});

test("locks entries once initial review has completed", () => {
  assert.throws(() => resolveSocialEntryEditTransition({
      status: "initial_approved",
      replacementCount: 0,
      currentCanonicalPostKey: "x:1",
      nextCanonicalPostKey: "x:1",
    }), /SOCIAL_ENTRY_EDIT_LOCKED/);
});
