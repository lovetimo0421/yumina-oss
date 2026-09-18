import assert from "node:assert/strict";
import test from "node:test";
import { hasLockedEventRuleChanges } from "./social-event-rules-lock.js";

const existing = {
  submissionType: "social_post",
  rulesVersion: 1,
  rulesConfig: { allowedPlatforms: ["x", "reddit"], initialMushiesPerPlatform: 1_000 },
  registrationOpensAt: new Date("2026-07-16T00:00:00.000Z"),
  registrationClosesAt: new Date("2026-08-19T00:00:00.000Z"),
  finalDataOpensAt: new Date("2026-08-19T00:00:00.000Z"),
  finalDataClosesAt: new Date("2026-08-22T00:00:00.000Z"),
  settlementDeadlineAt: new Date("2026-08-29T00:00:00.000Z"),
};

test("allows full-form saves when locked rule values are unchanged", () => {
  assert.equal(hasLockedEventRuleChanges({
    submissionType: "social_post",
    rulesVersion: 1,
    rulesConfig: { allowedPlatforms: ["x", "reddit"], initialMushiesPerPlatform: 1_000 },
    registrationOpensAt: "2026-07-16T00:00:00.000Z",
    registrationClosesAt: "2026-08-19T00:00:00.000Z",
    finalDataOpensAt: "2026-08-19T00:00:00.000Z",
    finalDataClosesAt: "2026-08-22T00:00:00.000Z",
    settlementDeadlineAt: "2026-08-29T00:00:00.000Z",
  }, existing), false);
});

test("detects actual locked timeline and rules changes", () => {
  assert.equal(hasLockedEventRuleChanges({
    registrationClosesAt: "2026-08-20T00:00:00.000Z",
  }, existing), true);
  assert.equal(hasLockedEventRuleChanges({
    rulesConfig: { allowedPlatforms: ["x"], initialMushiesPerPlatform: 1_000 },
  }, existing), true);
  assert.equal(hasLockedEventRuleChanges({ submissionType: "world" }, existing), true);
});
