import { test } from "node:test";
import assert from "node:assert/strict";
import { upgradeGrantFraction } from "./upgrade-grant.js";
import { PLANS } from "./plan-config.js";

// 30-day cycle matching a real Stripe subscription period.
const period = {
  periodStart: new Date("2026-06-20T00:00:00Z"),
  periodEnd: new Date("2026-07-20T00:00:00Z"),
};

function grant(plan: keyof typeof PLANS, now: Date): number {
  return Math.round(PLANS[plan].monthlyCredits * upgradeGrantFraction(period, now));
}

test("mid-cycle upgrade grants the remaining-days fraction (Yuri case)", () => {
  // Upgrade to Diamond with 12 of 30 days left → 40% of the grant,
  // mirroring the prorated Stripe charge for the same window.
  const now = new Date("2026-07-08T00:00:00Z");
  assert.equal(upgradeGrantFraction(period, now), 12 / 30);
  assert.equal(grant("pro", now), 16000);
});

test("day-29 ladder no longer yields a full-grant windfall", () => {
  // The exploit: on day 29 ladder go→plus→pro→ultra and collect every full
  // grant for ~one day of prorations. Pre-fix the three upgrade grants
  // totaled 138,100 mushies; prorated they collapse to ~3% of that.
  const now = new Date("2026-07-19T00:00:00Z"); // 1 of 30 days left
  const ladder = grant("plus", now) + grant("pro", now) + grant("ultra", now);
  const preFix = PLANS.plus.monthlyCredits + PLANS.pro.monthlyCredits + PLANS.ultra.monthlyCredits;
  assert.equal(ladder, 490 + 1333 + 2780);
  assert.ok(ladder < preFix * 0.05, `ladder ${ladder} should be under 5% of pre-fix ${preFix}`);
});

test("upgrade on day one grants effectively the full amount", () => {
  const now = new Date("2026-06-20T00:00:01Z");
  assert.ok(upgradeGrantFraction(period, now) > 0.999);
});

test("missing or degenerate period falls back to full grant", () => {
  assert.equal(upgradeGrantFraction(undefined), 1);
  assert.equal(
    upgradeGrantFraction({ periodStart: period.periodEnd, periodEnd: period.periodStart }),
    1,
  );
  assert.equal(
    upgradeGrantFraction({ periodStart: period.periodStart, periodEnd: period.periodStart }),
    1,
  );
});

test("clock skew never over- or under-grants beyond the bounds", () => {
  // now before periodStart (webhook clock ahead of Stripe) → clamp to 1
  assert.equal(upgradeGrantFraction(period, new Date("2026-06-19T00:00:00Z")), 1);
  // now after periodEnd (delayed webhook) → 0; renewal grants moments later
  assert.equal(upgradeGrantFraction(period, new Date("2026-07-21T00:00:00Z")), 0);
});

test("grant scales with plan config so promo changes apply automatically", () => {
  // The formula reads PLANS at grant time — halving the config (ending the
  // 2× promo) must halve the prorated grant with no code change.
  const now = new Date("2026-07-05T00:00:00Z"); // 15 of 30 days left
  const fraction = upgradeGrantFraction(period, now);
  assert.equal(Math.round(PLANS.pro.monthlyCredits * fraction), PLANS.pro.monthlyCredits / 2);
});
