import assert from "node:assert/strict";
import test from "node:test";
import {
  mergePlaythroughGalleryRows,
  playthroughGalleryVisibility,
} from "./playthrough-visibility.js";

test("safe guests only see safe playthroughs", () => {
  assert.equal(
    playthroughGalleryVisibility({ wantsSensitive: false, worldCreatorId: "creator" }),
    "safe",
  );
});

test("safe signed-in viewers can also see their own playthroughs", () => {
  assert.equal(
    playthroughGalleryVisibility({
      wantsSensitive: false,
      currentUserId: "viewer",
      worldCreatorId: "creator",
    }),
    "safe-and-own",
  );
});

test("a world creator can moderate every playthrough in safe mode", () => {
  assert.equal(
    playthroughGalleryVisibility({
      wantsSensitive: false,
      currentUserId: "creator",
      worldCreatorId: "creator",
    }),
    "all",
  );
});

test("sensitive mode is signed-in only — a guest's contentLevel param is ignored", () => {
  // Guests are hard-locked to safe: Limitless playthroughs must never be
  // reachable logged-out, no matter what params the request carries.
  assert.equal(
    playthroughGalleryVisibility({ wantsSensitive: true, worldCreatorId: "creator" }),
    "safe",
  );
});

test("sensitive mode includes sensitive playthroughs for signed-in viewers", () => {
  assert.equal(
    playthroughGalleryVisibility({
      wantsSensitive: true,
      currentUserId: "viewer",
      worldCreatorId: "creator",
    }),
    "all",
  );
});

test("primary-owned rows fill replica gaps and retain gallery ordering", () => {
  const older = { id: "older", likeCount: 10, createdAt: new Date(1) };
  const newest = { id: "newest", likeCount: 0, createdAt: new Date(3) };
  const primaryOnly = { id: "primary", likeCount: 4, createdAt: new Date(2) };

  assert.deepEqual(
    mergePlaythroughGalleryRows([older, newest], [primaryOnly], "newest").map((row) => row.id),
    ["newest", "primary", "older"],
  );
  assert.deepEqual(
    mergePlaythroughGalleryRows([older, newest], [primaryOnly], "popular").map((row) => row.id),
    ["older", "primary", "newest"],
  );
});
