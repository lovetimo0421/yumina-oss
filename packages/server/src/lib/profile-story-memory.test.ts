import assert from "node:assert/strict";
import test from "node:test";
import { profileStoryMemoryDefault } from "./profile-story-memory.js";

test("profile defaults match generation's account rollout boundary", () => {
  const rollout = "2026-09-22T11:34:00Z";
  assert.equal(profileStoryMemoryDefault(new Date("2026-09-22T11:33:59Z"), rollout), null);
  assert.equal(profileStoryMemoryDefault(new Date(rollout), rollout), 16000);
  assert.equal(profileStoryMemoryDefault(new Date("2026-09-25T00:00:00Z"), rollout), 16000);
});

test("unconfigured/local editions and unknown account dates preserve inherited memory", () => {
  const created = new Date("2026-09-25T00:00:00Z");
  for (const flag of [undefined, "", "invalid"]) assert.equal(profileStoryMemoryDefault(created, flag), null);
  assert.equal(profileStoryMemoryDefault(null, "2026-09-22T11:34:00Z"), null);
});
