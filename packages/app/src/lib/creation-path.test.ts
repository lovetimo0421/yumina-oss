import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isCreationPath } from "./creation-path";

test("the blueprint, the editor and the create picker are making surfaces", () => {
  assert.equal(isCreationPath("/app/studio/abc-123"), true);
  assert.equal(isCreationPath("/app/studio"), true);
  assert.equal(isCreationPath("/app/worlds/create"), true);
  assert.equal(isCreationPath("/app/worlds/abc-123/edit"), true);
  assert.equal(isCreationPath("/app/worlds/abc-123/edit/entries"), true);
});

test("browsing and playing are not", () => {
  assert.equal(isCreationPath("/app/hub"), false);
  assert.equal(isCreationPath("/app/worlds"), false);
  assert.equal(isCreationPath("/app/worlds/abc-123"), false);
  assert.equal(isCreationPath("/app/chat/abc-123"), false);
  assert.equal(isCreationPath("/app/community"), false);
});
