import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MILESTONES,
  selectEarnedMilestones,
  planDaysToCredits,
  isRewardEligibleReferral,
} from "./referral-rewards.js";
import { activationAllowance } from "./entitlement-allowance.js";

const EPOCH = new Date("2026-07-16T00:00:00Z");

test("isRewardEligibleReferral: legacy (null referred_at) never counts toward rewards", () => {
  assert.equal(isRewardEligibleReferral(null, EPOCH), false);
  assert.equal(isRewardEligibleReferral(undefined, EPOCH), false);
});

test("isRewardEligibleReferral: pre-epoch referrals excluded, post-epoch included", () => {
  assert.equal(isRewardEligibleReferral(new Date("2026-07-15T23:59:59Z"), EPOCH), false);
  assert.equal(isRewardEligibleReferral(EPOCH, EPOCH), true);
  assert.equal(isRewardEligibleReferral(new Date("2026-08-01T00:00:00Z"), EPOCH), true);
});

test("MILESTONES ladder (owner 2026-09-16): 1 / 5 / 10 / 15 / 20, every step counts active friends", () => {
  assert.deepEqual(MILESTONES.map((m) => m.threshold), [1, 5, 10, 15, 20]);
  for (const m of MILESTONES) assert.equal(m.countBasis, "confirmed", `tier ${m.threshold} must count active friends`);
  const t1 = MILESTONES.find((m) => m.threshold === 1)!;
  assert.deepEqual(t1.reward, { type: "credit_grant", credits: 300 });
  assert.equal(t1.badge, undefined);
  const t5 = MILESTONES.find((m) => m.threshold === 5)!;
  assert.deepEqual(t5.reward, { type: "credit_grant", credits: 1500 });
  assert.equal(t5.badge, "bronze");
  const t10 = MILESTONES.find((m) => m.threshold === 10)!;
  assert.deepEqual(t10.reward, { type: "plan_grant", plan: "go", durationDays: 7 });
  const t15 = MILESTONES.find((m) => m.threshold === 15)!;
  assert.deepEqual(t15.reward, { type: "credit_grant", credits: 2000 });
  assert.equal(t15.badge, "silver");
  const t20 = MILESTONES.find((m) => m.threshold === 20)!;
  assert.deepEqual(t20.reward, { type: "plan_grant", plan: "plus", durationDays: 7 });
  assert.equal(t20.badge, "gold");
  // Every tier carries a wallet reward now; the badge-only tier 30 is gone.
  assert.ok(MILESTONES.every((m) => m.reward));
});

test("selectEarnedMilestones: active friends unlock, registrations alone do not", () => {
  const registrationsOnly = selectEarnedMilestones(MILESTONES, { raw: 25, confirmed: 0 }, new Set());
  assert.deepEqual(registrationsOnly, []);
  const sixActive = selectEarnedMilestones(MILESTONES, { raw: 6, confirmed: 6 }, new Set());
  assert.deepEqual(sixActive.map((m) => m.threshold), [1, 5]);
  const fifteenActive = selectEarnedMilestones(MILESTONES, { raw: 40, confirmed: 15 }, new Set());
  assert.deepEqual(fifteenActive.map((m) => m.threshold), [1, 5, 10, 15]);
});

test("selectEarnedMilestones: already-claimed thresholds are skipped", () => {
  const earned = selectEarnedMilestones(MILESTONES, { raw: 22, confirmed: 22 }, new Set([1, 5, 10]));
  assert.deepEqual(earned.map((m) => m.threshold), [15, 20]);
});

test("planDaysToCredits: memberships scale linearly off the monthly allowance", () => {
  assert.equal(planDaysToCredits("go", 30), 4000);
  assert.equal(planDaysToCredits("go", 7), 933);
  assert.equal(planDaysToCredits("plus", 7), 3430);
});

test("referral allowance is duration-scaled and independent of the recipient's plan", () => {
  for (const basePlan of ["free", "go", "ultra"] as const) {
    assert.equal(activationAllowance("referral", "go", basePlan, true, 7), 933);
    assert.equal(activationAllowance("referral", "plus", basePlan, true, 7), 3430);
  }
});

test("referral ladder payouts: 300 / 1,500 / Gold week / 2,000 / Platinum week", () => {
  const payout = (threshold: number) => {
    const m = MILESTONES.find((x) => x.threshold === threshold)!;
    if (m.reward?.type === "credit_grant") return m.reward.credits;
    if (m.reward?.type === "plan_grant") {
      return activationAllowance("referral", m.reward.plan, "free", true, m.reward.durationDays);
    }
    return 0;
  };
  assert.deepEqual([1, 5, 10, 15, 20].map(payout), [300, 1500, 933, 2000, 3430]);
  // Step 1 is deliberately small so step 5 reads as the first real reward.
  assert.ok(payout(1) < payout(5) / 4);
  // The top step (Platinum week) is the richest, so it doubles as the hook to try better models.
  assert.ok(payout(20) > payout(15));
});

test("event and admin allowances are untouched by the referral change", () => {
  assert.equal(activationAllowance("event", "go", "free", true, 7), 4000);
  assert.equal(activationAllowance("event", "go", "free", false, 7), 0);
  assert.equal(activationAllowance("admin", "go", "go", true, 30), 0);
  assert.equal(activationAllowance("admin", "go", "free", true, 7), 2000);
});
