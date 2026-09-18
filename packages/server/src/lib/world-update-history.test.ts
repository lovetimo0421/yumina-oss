import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReadWorldUpdateHistory,
  hasMoreWorldUpdates,
  normalizeWorldUpdateOffset,
} from "./world-update-history.js";

test("world update history access respects publication and followers visibility", () => {
  assert.equal(canReadWorldUpdateHistory({
    status: "published",
    visibility: "public",
    isOwner: false,
    isAdmin: false,
    isFollower: false,
  }), true);
  assert.equal(canReadWorldUpdateHistory({
    status: "published",
    visibility: "followers",
    isOwner: false,
    isAdmin: false,
    isFollower: false,
  }), false);
  assert.equal(canReadWorldUpdateHistory({
    status: "published",
    visibility: "followers",
    isOwner: false,
    isAdmin: false,
    isFollower: true,
  }), true);
  assert.equal(canReadWorldUpdateHistory({
    status: "unpublished",
    visibility: "public",
    isOwner: true,
    isAdmin: false,
    isFollower: false,
  }), true);
  assert.equal(canReadWorldUpdateHistory({
    status: "unpublished",
    visibility: "public",
    isOwner: false,
    isAdmin: false,
    isFollower: true,
  }), false);
});

test("world update offsets stay page-aligned and terminate at the cap", () => {
  assert.equal(normalizeWorldUpdateOffset(undefined), 0);
  assert.equal(normalizeWorldUpdateOffset("invalid"), 0);
  assert.equal(normalizeWorldUpdateOffset("39"), 20);
  assert.equal(normalizeWorldUpdateOffset("9999"), 9980);
  assert.equal(normalizeWorldUpdateOffset("10020"), 10_000);
  assert.equal(hasMoreWorldUpdates(21, 9980), true);
  assert.equal(hasMoreWorldUpdates(21, 10_000), false);
});
