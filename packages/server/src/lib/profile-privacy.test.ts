import assert from "node:assert/strict";
import test from "node:test";
import {
  canViewRestrictedProfile,
  profileFollowDirections,
  readProfilePrivacy,
} from "./profile-privacy.js";

test("People I follow grants access only for the owner-to-viewer follow edge", () => {
  const ownerFollowsViewer = canViewRestrictedProfile({
    profileVisibility: "followers",
    isSelf: false,
    ownerFollowsViewer: true,
  });
  const viewerOnlyFollowsOwner = canViewRestrictedProfile({
    profileVisibility: "followers",
    isSelf: false,
    ownerFollowsViewer: false,
  });

  assert.equal(ownerFollowsViewer, true);
  assert.equal(viewerOnlyFollowsOwner, false);
});

test("public, private, and self profile access retain their expected behavior", () => {
  assert.equal(
    canViewRestrictedProfile({
      profileVisibility: "public",
      isSelf: false,
      ownerFollowsViewer: false,
    }),
    true,
  );
  assert.equal(
    canViewRestrictedProfile({
      profileVisibility: "private",
      isSelf: false,
      ownerFollowsViewer: true,
    }),
    false,
  );
  assert.equal(
    canViewRestrictedProfile({
      profileVisibility: "private",
      isSelf: true,
      ownerFollowsViewer: false,
    }),
    true,
  );
});

test("follow directions cannot invert the privacy edge", () => {
  assert.deepEqual(profileFollowDirections("owner", "viewer"), {
    ownerFollowsViewer: { followerId: "owner", followingId: "viewer" },
    viewerFollowsOwner: { followerId: "viewer", followingId: "owner" },
  });
});

test("privacy preferences normalize current and legacy settings consistently", () => {
  assert.equal(
    readProfilePrivacy({ privacy: { profileVisibility: "followers" } }).profileVisibility,
    "followers",
  );
  assert.equal(
    readProfilePrivacy({ privacy: { isPrivateAccount: true } }).profileVisibility,
    "followers",
  );
  assert.equal(readProfilePrivacy({}).profileVisibility, "public");
  assert.equal(
    readProfilePrivacy({ privacy: { showStats: false } }).showFollowLists,
    false,
  );
});
