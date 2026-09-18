import { test } from "node:test";
import assert from "node:assert/strict";
import { initialGrokTrial, GROK_TRIAL_GRANT } from "./trial-config.js";

// Regression guard for the Sonnet trial seeding that b49f657a silently reverted
// (new signups got 0 instead of 3). See investigation 2026-05-28.

test("signups on/after the cutoff get the full Sonnet trial", () => {
  assert.equal(initialGrokTrial(new Date("2026-05-27T00:00:00Z")), GROK_TRIAL_GRANT);
  assert.equal(initialGrokTrial(new Date("2026-05-28T12:00:00Z")), GROK_TRIAL_GRANT);
  assert.equal(initialGrokTrial(new Date("2099-01-01T00:00:00Z")), GROK_TRIAL_GRANT);
});

test("signups before the cutoff get no trial", () => {
  assert.equal(initialGrokTrial(new Date("2026-05-26T23:59:59Z")), 0);
  assert.equal(initialGrokTrial(new Date("2020-01-01T00:00:00Z")), 0);
});

test("the grant is 3 (the advertised number of free messages)", () => {
  assert.equal(GROK_TRIAL_GRANT, 3);
});
