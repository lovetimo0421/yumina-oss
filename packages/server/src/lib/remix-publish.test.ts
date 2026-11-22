import { test } from "node:test";
import assert from "node:assert/strict";
import { remixPublishBlock } from "./remix-publish.js";

const live = { creatorId: "author", status: "published", isPublished: true, allowEdit: true };

test("a copy of a live card that allows edits can be published", () => {
  assert.equal(remixPublishBlock(live, "me"), null);
});
test("a copy whose original is gone can be published", () => {
  assert.equal(remixPublishBlock(null, "me"), null);
});
test("a copy of my own card can be published whatever its state", () => {
  assert.equal(remixPublishBlock({ ...live, creatorId: "me", status: "draft", isPublished: false, allowEdit: false }, "me"), null);
});
test("a copy of a DM-shared draft stays private", () => {
  assert.equal(remixPublishBlock({ ...live, status: "draft", isPublished: false }, "me"), "REMIX_SOURCE_NOT_PUBLIC");
});
test("a copy of a pulled or in-review card stays private", () => {
  assert.equal(remixPublishBlock({ ...live, status: "unpublished", isPublished: false }, "me"), "REMIX_SOURCE_NOT_PUBLIC");
  assert.equal(remixPublishBlock({ ...live, status: "pending_review", isPublished: false }, "me"), "REMIX_SOURCE_NOT_PUBLIC");
});
test("a copy of a card whose author turned edits off cannot be submitted", () => {
  assert.equal(remixPublishBlock({ ...live, allowEdit: false }, "me"), "REMIX_NOT_ALLOWED");
});
test("legacy rows without a status fall back to is_published", () => {
  assert.equal(remixPublishBlock({ ...live, status: null }, "me"), null);
  assert.equal(remixPublishBlock({ ...live, status: null, isPublished: false }, "me"), "REMIX_SOURCE_NOT_PUBLIC");
});
