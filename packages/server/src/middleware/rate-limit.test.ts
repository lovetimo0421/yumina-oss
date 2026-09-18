import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RATE_LIMITS, TRUSTED_PUBLISHING_RATE_LIMIT, type RateLimitTier } from "@yumina/shared";
import { effectiveRateLimit } from "./rate-limit.js";

// Regression for the 2026-08-25 report: a whitelisted (skip_review) creator
// bulk-updating her catalog hit the 5/hour publishing cap on submit #6 and the
// client showed a generic "failed to submit" toast — looked like the old
// multilang-variant submit bug, was actually the rate limiter.

test("trusted (skip_review) creators get the wider publishing window", () => {
  assert.deepEqual(effectiveRateLimit("publishing", true), TRUSTED_PUBLISHING_RATE_LIMIT);
  assert.ok(TRUSTED_PUBLISHING_RATE_LIMIT.max > RATE_LIMITS.publishing.max);
  assert.equal(TRUSTED_PUBLISHING_RATE_LIMIT.windowSeconds, RATE_LIMITS.publishing.windowSeconds);
});

test("non-trusted users keep the standard publishing limit", () => {
  assert.deepEqual(effectiveRateLimit("publishing", false), RATE_LIMITS.publishing);
  assert.deepEqual(effectiveRateLimit("publishing", undefined), RATE_LIMITS.publishing);
});

test("skip_review does not widen any other tier", () => {
  for (const tier of Object.keys(RATE_LIMITS) as RateLimitTier[]) {
    if (tier === "publishing") continue;
    assert.deepEqual(effectiveRateLimit(tier, true), RATE_LIMITS[tier]);
  }
});

test("auth middleware keeps skipReview in the fresh user load", () => {
  // The trusted bypass reads user.skipReview off the request context; if the
  // narrow SessionUser select in loadUserFresh drops the column, the bypass
  // silently turns off for everyone.
  const authSource = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  assert.match(authSource, /skipReview: userTable\.skipReview/);
});
