import { test } from "node:test";
import assert from "node:assert/strict";
import { adminUpgradeGrantFraction } from "./admin-grant.js";
import { PLANS, type PlanId } from "./plan-config.js";

function grant(current: PlanId, next: PlanId): number {
  return Math.round(PLANS[next].monthlyCredits * adminUpgradeGrantFraction(current, next));
}

test("upgrade mints exactly the tier delta", () => {
  assert.equal(grant("free", "go"), PLANS.go.monthlyCredits - PLANS.free.monthlyCredits);
  assert.equal(grant("go", "plus"), PLANS.plus.monthlyCredits - PLANS.go.monthlyCredits);
  assert.equal(grant("plus", "ultra"), PLANS.ultra.monthlyCredits - PLANS.plus.monthlyCredits);
});

test("same-tier re-grant mints nothing (the flip footgun)", () => {
  for (const p of ["free", "go", "plus", "pro", "ultra"] as PlanId[]) {
    assert.equal(grant(p, p), 0);
  }
});

test("downgrade/demotion mints nothing", () => {
  assert.equal(grant("ultra", "go"), 0);
  assert.equal(grant("plus", "free"), 0);
});

test("repeated flips cannot compound: up-down-up mints the delta once per real upgrade", () => {
  // ultra→go→ultra: the down-flip mints 0; the re-up mints go→ultra delta.
  // Total minted = (go→ultra delta), NOT 2× ultra monthly like the old policy.
  const minted = grant("ultra", "go") + grant("go", "ultra");
  assert.equal(minted, PLANS.ultra.monthlyCredits - PLANS.go.monthlyCredits);
});

test("fraction stays within [0,1] for syncPlan's clamp", () => {
  for (const a of ["free", "go", "plus", "pro", "ultra"] as PlanId[]) {
    for (const b of ["free", "go", "plus", "pro", "ultra"] as PlanId[]) {
      const f = adminUpgradeGrantFraction(a, b);
      assert.ok(f >= 0 && f <= 1, `${a}→${b} fraction ${f} out of range`);
    }
  }
});
