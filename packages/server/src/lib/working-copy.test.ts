import test from "node:test";
import assert from "node:assert/strict";
import { viewerSeesWorkingCopy, workingCopyViewerId } from "./working-copy.js";

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

test("viewerSeesWorkingCopy: an editor collaborator sees it like the creator, only on published worlds", () => {
  assert.equal(viewerSeesWorkingCopy("published", CREATOR, OTHER, true), true);
  assert.equal(viewerSeesWorkingCopy("published", CREATOR, OTHER, false), false);
  assert.equal(viewerSeesWorkingCopy("draft", CREATOR, OTHER, true), false);
});

test("workingCopyViewerId: an editor resolves as the creator, everyone else as themselves", () => {
  assert.equal(workingCopyViewerId({ creatorId: CREATOR }, OTHER, true), CREATOR);
  assert.equal(workingCopyViewerId({ creatorId: CREATOR }, OTHER, false), OTHER);
});
