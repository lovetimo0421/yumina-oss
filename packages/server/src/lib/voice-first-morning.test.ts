import assert from "node:assert/strict";
import test from "node:test";
import { firstMorningKey, firstMorningEnabled, memoryFirstMorningStore, FIRST_MORNING_WINDOW_MS } from "./voice-first-morning.js";

const env = { UNPERSON_FIRST_MORNING_FREE: "true", OPENAI_API_KEY: "sk-test" };
const unperson = async (session: string) => session.startsWith("unperson");

test("off unless explicitly enabled with a key", () => {
  assert.equal(firstMorningEnabled({}), false);
  assert.equal(firstMorningEnabled({ UNPERSON_FIRST_MORNING_FREE: "true" }), false);
  assert.equal(firstMorningEnabled({ OPENAI_API_KEY: "sk" }), false);
  assert.equal(firstMorningEnabled(env), true);
});

test("one morning per account, reconnects allowed in that session and window", async () => {
  const store = memoryFirstMorningStore();
  const base = { userId: "u1", store, isUnpersonSession: unperson, env };
  assert.equal(await firstMorningKey({ ...base, sessionId: "unperson-a", consume: false, now: 0 }), "sk-test", "peeking does not claim");
  assert.equal(await firstMorningKey({ ...base, sessionId: "unperson-a", consume: true, now: 1000 }), "sk-test");
  assert.equal(await firstMorningKey({ ...base, sessionId: "unperson-a", consume: true, now: 5 * 60_000 }), "sk-test", "reconnect in the same morning");
  assert.equal(await firstMorningKey({ ...base, sessionId: "unperson-b", consume: true, now: 6 * 60_000 }), null, "a second session is not free");
  assert.equal(await firstMorningKey({ ...base, sessionId: "unperson-a", consume: true, now: 1000 + FIRST_MORNING_WINDOW_MS }), null, "the window closes");
  assert.equal(await firstMorningKey({ ...base, userId: "u2", sessionId: "unperson-c", consume: true, now: 0 }), "sk-test", "another account has its own morning");
});

test("other worlds and disabled installs never get the sponsored key", async () => {
  const store = memoryFirstMorningStore();
  assert.equal(await firstMorningKey({ userId: "u1", sessionId: "other-world", consume: true, store, isUnpersonSession: unperson, env }), null);
  assert.equal(await firstMorningKey({ userId: "u1", sessionId: "unperson-a", consume: true, store, isUnpersonSession: unperson, env: {} }), null);
});
