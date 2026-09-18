import assert from "node:assert/strict";
import test from "node:test";
import { resolveSocialSubmissionTimes } from "./social-event-eligibility.js";

const registrationOpensAt = new Date("2026-07-16T00:00:00.000Z");
const receivedAt = new Date("2026-07-17T12:00:00.000Z");

test("starts the 24 hour review delay when the server receives the submission", () => {
  const result = resolveSocialSubmissionTimes({
    postPublishedAt: "2026-07-16T06:00:00.000Z",
    registrationOpensAt,
    receivedAt,
  });
  assert.equal(result.publishedAt.toISOString(), "2026-07-16T06:00:00.000Z");
  assert.equal(result.initialReviewEligibleAt.toISOString(), "2026-07-18T12:00:00.000Z");
});

test("rejects posts published before the event registration window", () => {
  assert.throws(
    () => resolveSocialSubmissionTimes({
      postPublishedAt: "2026-07-15T23:59:59.999Z",
      registrationOpensAt,
      receivedAt,
    }),
    /SOCIAL_POST_PUBLISHED_BEFORE_EVENT/,
  );
});

test("rejects future publication timestamps", () => {
  assert.throws(
    () => resolveSocialSubmissionTimes({
      postPublishedAt: "2026-07-17T12:00:00.001Z",
      registrationOpensAt,
      receivedAt,
    }),
    /SOCIAL_POST_PUBLISHED_IN_FUTURE/,
  );
});
