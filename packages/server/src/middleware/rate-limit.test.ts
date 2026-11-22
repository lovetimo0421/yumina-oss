import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RATE_LIMITS, type RateLimitTier } from "@yumina/shared";
import { effectiveRateLimit } from "./rate-limit.js";

// History: on 2026-08-25 a whitelisted (skip_review) creator bulk-updating her
// catalog hit the publishing cap. On 11/07 the trusted tier was retired (every
// submission gets the AI first look) and the base window was widened instead.

test("everyone gets the same, wider publishing window; skip_review no longer changes it", () => {
  assert.ok(RATE_LIMITS.publishing.max >= 100);
  assert.deepEqual(effectiveRateLimit("publishing", true), RATE_LIMITS.publishing);
  assert.deepEqual(effectiveRateLimit("publishing", false), RATE_LIMITS.publishing);
  assert.deepEqual(effectiveRateLimit("publishing", undefined), RATE_LIMITS.publishing);
});

test("skip_review does not widen any other tier", () => {
  for (const tier of Object.keys(RATE_LIMITS) as RateLimitTier[]) {
    assert.deepEqual(effectiveRateLimit(tier, true), RATE_LIMITS[tier]);
  }
});

test("admins skip the hourly media submit limit, and only that one", async () => {
  // 2026-11-11: recording demo footage on the official account, a retry loop against the active-job cap used up
  // the 30-an-hour media window and locked the account for an hour.
  const { rateLimitMiddleware } = await import("./rate-limit.js");
  const run = async (tier: RateLimitTier, role: string) => {
    let passed = 0, refused = 0;
    const mw = rateLimitMiddleware(tier);
    const id = `test-${tier}-${role}-${Date.now()}`;
    for (let i = 0; i < RATE_LIMITS[tier].max + 5; i++) {
      const c = { get: () => ({ id, role }), header: () => {}, json: () => { refused++; return null; } } as never;
      await mw(c, async () => { passed++; });
    }
    return { passed, refused };
  };
  assert.deepEqual(await run("media-generation", "admin"), { passed: RATE_LIMITS["media-generation"].max + 5, refused: 0 });
  assert.equal((await run("media-generation", "user")).refused > 0, true);
  assert.equal((await run("ai-generation", "admin")).refused > 0, true);
  const authSource = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  assert.match(authSource, /role: userTable\.role/);
});
