import test from "node:test";
import assert from "node:assert/strict";
import { viewerSeesWorkingCopy } from "./working-copy.js";

const CREATOR = "user-creator";
const OTHER = "user-other";

test("viewerSeesWorkingCopy: creator sees the working copy of their own published world", () => {
  assert.equal(viewerSeesWorkingCopy("published", CREATOR, CREATOR), true);
});

test("viewerSeesWorkingCopy: does NOT leak the working copy to other players", () => {
  // The held edit is unapproved content — non-creators must keep getting live.
  assert.equal(viewerSeesWorkingCopy("published", CREATOR, OTHER), false);
});

test("viewerSeesWorkingCopy: only applies to published worlds", () => {
  // Drafts/unpublished worlds edit the live schema directly — no held copy.
  assert.equal(viewerSeesWorkingCopy("draft", CREATOR, CREATOR), false);
  assert.equal(viewerSeesWorkingCopy("unpublished", CREATOR, CREATOR), false);
});
