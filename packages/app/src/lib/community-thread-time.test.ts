import assert from "node:assert/strict";
import test from "node:test";
import { getCommunityThreadDisplayTime } from "./community-thread-time.js";

const thread = {
  createdAt: "2026-07-02T12:00:00.000Z",
  lastReplyAt: "2026-08-22T08:00:00.000Z",
};

test("activity sorting displays the activity timestamp", () => {
  assert.equal(getCommunityThreadDisplayTime(thread, "activity"), thread.lastReplyAt);
});

test("newest sorting displays creation time and activity falls back safely", () => {
  assert.equal(getCommunityThreadDisplayTime(thread, "created"), thread.createdAt);
  assert.equal(
    getCommunityThreadDisplayTime({ ...thread, lastReplyAt: null }, "activity"),
    thread.createdAt,
  );
});
