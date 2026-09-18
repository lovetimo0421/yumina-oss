import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isNotificationSubjectMuted,
  mutedNotificationSubjectKeys,
  notificationSubjectFor,
  notificationSubjectKey,
} from "./notification-subject.js";

describe("notification subject mutes", () => {
  it("resolves routine community and work activity to a stable subject", () => {
    assert.deepEqual(
      notificationSubjectFor("thread_reply", { threadId: "thread-1" }),
      { type: "thread", id: "thread-1" },
    );
    assert.deepEqual(
      notificationSubjectFor("new_review", { worldId: "world-1" }),
      { type: "world", id: "world-1" },
    );
    assert.deepEqual(
      notificationSubjectFor("bundle_like", { bundleId: "bundle-1" }),
      { type: "bundle", id: "bundle-1" },
    );
    assert.deepEqual(
      notificationSubjectFor("post_reply", {
        threadId: "thread-1",
        postId: "reply-2",
        parentPostId: "comment-1",
      }),
      { type: "post", id: "comment-1" },
    );
    assert.deepEqual(
      notificationSubjectFor("post_like", { threadId: "thread-1", postId: "comment-1" }),
      { type: "post", id: "comment-1" },
    );
  });

  it("never exposes moderation, safety, or transaction activity as mutable", () => {
    assert.equal(
      notificationSubjectFor("world_review_rejected", { worldId: "world-1" }),
      null,
    );
    assert.equal(
      notificationSubjectFor("thread_deleted_by_admin", { threadId: "thread-1" }),
      null,
    );
    assert.equal(
      notificationSubjectFor("tip_received", { worldId: "world-1" }),
      null,
    );
  });

  it("reads only valid stored subject keys and matches the full type/id pair", () => {
    const preferences = {
      mutedNotificationSubjects: ["thread:thread-1", 123, "world:world-1"],
    };

    assert.deepEqual(
      [...mutedNotificationSubjectKeys(preferences)],
      ["thread:thread-1", "world:world-1"],
    );
    assert.equal(
      isNotificationSubjectMuted(preferences, { type: "thread", id: "thread-1" }),
      true,
    );
    assert.equal(
      isNotificationSubjectMuted(preferences, { type: "world", id: "thread-1" }),
      false,
    );
    assert.equal(
      notificationSubjectKey({ type: "bundle", id: "bundle-1" }),
      "bundle:bundle-1",
    );
    assert.equal(
      notificationSubjectKey({ type: "post", id: "comment-1" }),
      "post:comment-1",
    );
  });
});
