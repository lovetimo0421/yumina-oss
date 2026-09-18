import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  isSafeToReload,
  isProtectedPath,
  holdReload,
  activeReloadHolds,
  __resetReloadHoldsForTests,
  type ReloadSnapshot,
} from "./reload-safety";

const quiet: ReloadSnapshot = {
  textEntryHasContent: false,
  chatStreaming: false,
  editorDirty: false,
  studioBusy: false,
  dialogOpen: false,
  holds: [],
  protectedRoute: false,
};

test("authoring and play routes are protected even when nothing is dirty", () => {
  assert.equal(isSafeToReload({ ...quiet, protectedRoute: true }), false);
  // creators
  assert.equal(isProtectedPath("/app/worlds/abc123/edit"), true);
  assert.equal(isProtectedPath("/app/worlds/create"), true);
  assert.equal(isProtectedPath("/app/studio/abc123"), true);
  assert.equal(isProtectedPath("/app/bundles/b1/edit"), true);
  // players
  assert.equal(isProtectedPath("/app/chat/s1"), true);
  assert.equal(isProtectedPath("/app/preview/w1"), true);
  // browse surfaces: safe
  assert.equal(isProtectedPath("/app/hub"), false);
  assert.equal(isProtectedPath("/app/library"), false);
  assert.equal(isProtectedPath("/app/worlds/abc123"), false);
});

beforeEach(() => __resetReloadHoldsForTests());

test("a quiet tab is safe to reload", () => {
  assert.equal(isSafeToReload(quiet), true);
});

test("any single hazard blocks the reload", () => {
  assert.equal(isSafeToReload({ ...quiet, textEntryHasContent: true }), false);
  assert.equal(isSafeToReload({ ...quiet, chatStreaming: true }), false);
  assert.equal(isSafeToReload({ ...quiet, editorDirty: true }), false);
  assert.equal(isSafeToReload({ ...quiet, studioBusy: true }), false);
  assert.equal(isSafeToReload({ ...quiet, dialogOpen: true }), false);
  assert.equal(isSafeToReload({ ...quiet, holds: ["upload"] }), false);
});

test("holds are counted per reason and released idempotently", () => {
  const releaseA = holdReload("upload");
  const releaseB = holdReload("upload");
  const releaseRoom = holdReload("game-room");
  assert.deepEqual(activeReloadHolds().sort(), ["game-room", "upload"]);
  releaseA();
  assert.deepEqual(activeReloadHolds().sort(), ["game-room", "upload"]);
  releaseA(); // second call is a no-op
  releaseB();
  assert.deepEqual(activeReloadHolds(), ["game-room"]);
  releaseRoom();
  assert.deepEqual(activeReloadHolds(), []);
});
