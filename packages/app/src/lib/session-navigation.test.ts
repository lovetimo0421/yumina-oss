import assert from "node:assert/strict";
import test from "node:test";
import { chatSessionTarget, createdSessionId } from "./session-navigation";

const validId = "123e4567-e89b-42d3-a456-426614174000";

test("a successful create response returns its UUID", () => {
  assert.equal(createdSessionId(true, { data: { id: validId } }), validId);
});

test("failed and malformed create responses cannot produce a chat id", () => {
  assert.equal(createdSessionId(false, { data: { id: validId } }), null);
  assert.equal(createdSessionId(true, { data: {} }), null);
  assert.equal(createdSessionId(true, { data: { id: "not-a-session" } }), null);
  assert.equal(createdSessionId(true, null), null);
});

test("a valid chat URL resolves to its session", () => {
  assert.deepEqual(chatSessionTarget(`/app/chat/${validId}`), {
    matchesChatRoute: true,
    sessionId: validId,
  });
});

test("invalid, missing, and malformed chat ids are rejected", () => {
  for (const url of ["/app/chat/not-a-session", "/app/chat/", "/app/chat/%E0%A4%A"]) {
    assert.deepEqual(chatSessionTarget(url), {
      matchesChatRoute: true,
      sessionId: null,
    });
  }
});

test("non-chat URLs remain available to the general navigator", () => {
  assert.deepEqual(chatSessionTarget("/app/library"), {
    matchesChatRoute: false,
    sessionId: null,
  });
});
