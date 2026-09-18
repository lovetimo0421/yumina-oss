import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSessionPickerCache,
  getCachedSessions,
  sessionPickerCacheKey,
  setCachedSessions,
} from "./session-picker-cache";

/**
 * Regression for the 2026-09-03 @kgwn report: signing out of account A and
 * into account B on the same tab must never paint A's saves in the picker.
 * A save that belongs to A 404s ("Session not found") for B, and the chat
 * shows that 404 full-screen with nothing but a retry button.
 */

const WORLD = "world:7ca1121e-1de3-4fd3-9862-c9e191b22040";
const A = "user-a";
const B = "user-b";

test.beforeEach(() => clearSessionPickerCache());

test("a cached save list is never visible to a different account", () => {
  setCachedSessions(A, WORLD, [{ id: "a-session-2" }]);

  assert.deepEqual(getCachedSessions(A, WORLD), [{ id: "a-session-2" }]);
  assert.equal(getCachedSessions(B, WORLD), undefined);
});

test("sign-out clears every cached list", () => {
  setCachedSessions(A, WORLD, [{ id: "a-session-1" }]);
  setCachedSessions(A, "group:g1", [{ id: "a-session-9" }]);

  clearSessionPickerCache();

  assert.equal(getCachedSessions(A, WORLD), undefined);
  assert.equal(getCachedSessions(A, "group:g1"), undefined);
});

test("with no signed-in user the cache neither serves nor stores", () => {
  setCachedSessions(null, WORLD, [{ id: "orphan" }]);
  setCachedSessions(undefined, WORLD, [{ id: "orphan" }]);

  assert.equal(getCachedSessions(null, WORLD), undefined);
  assert.equal(getCachedSessions(undefined, WORLD), undefined);
  // and nothing leaked in under an empty-user key that a later user could hit
  assert.equal(getCachedSessions(A, WORLD), undefined);
  assert.equal(sessionPickerCacheKey("", WORLD), null);
});

test("the same account still gets its own instant list back", () => {
  setCachedSessions(B, WORLD, [{ id: "b-session-1" }, { id: "b-session-2" }]);

  assert.deepEqual(getCachedSessions(B, WORLD), [
    { id: "b-session-1" },
    { id: "b-session-2" },
  ]);
  // scope keys stay separate within one account
  assert.equal(getCachedSessions(B, "group:g1"), undefined);
});
