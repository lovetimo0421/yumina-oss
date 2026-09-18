import { test } from "node:test";
import assert from "node:assert/strict";
import { activationAllowance, allowanceDescription } from "./entitlement-allowance.js";
import { PLANS } from "./plan-config.js";

test("event entitlements grant the full monthly, gated by the event flag", () => {
  assert.equal(activationAllowance("event", "plus", "free", true), PLANS.plus.monthlyCredits);
  assert.equal(activationAllowance("event", "plus", "go", true), PLANS.plus.monthlyCredits);
  assert.equal(activationAllowance("event", "plus", "free", false), 0);
});

test("admin entitlements grant the tier delta vs the base plan (delta-only policy)", () => {
  assert.equal(
    activationAllowance("admin", "ultra", "go", true),
    PLANS.ultra.monthlyCredits - PLANS.go.monthlyCredits,
  );
  assert.equal(
    activationAllowance("admin", "plus", "free", true),
    PLANS.plus.monthlyCredits - PLANS.free.monthlyCredits,
  );
  // Entitlements only activate above the base, but the guard holds anyway.
  assert.equal(activationAllowance("admin", "go", "ultra", true), 0);
  assert.equal(activationAllowance("admin", "go", "go", true), 0);
});

test("referral entitlements grant the duration-scaled equivalent", () => {
  assert.equal(activationAllowance("referral", "go", "free", true, 30), PLANS.go.monthlyCredits);
  assert.equal(activationAllowance("referral", "go", "free", true, 7), 933);
  // The event flag has no effect on non-event sources.
  assert.equal(activationAllowance("referral", "go", "free", false, 7), 933);
  // Omitted duration falls back to a full month (legacy call sites).
  assert.equal(activationAllowance("referral", "go", "free", true), PLANS.go.monthlyCredits);
});

test("referral allowance ignores the recipient's base plan", () => {
  // The base plan decides whether the DAYS activate or queue; it must never
  // change the mushie payout, or one milestone pays three different amounts.
  const amounts = (["free", "go", "plus", "ultra"] as const).map((base) =>
    activationAllowance("referral", "go", base, true, 30),
  );
  assert.deepEqual(amounts, [4000, 4000, 4000, 4000]);
});

test("descriptions name the source", () => {
  assert.match(allowanceDescription("admin", "plus"), /^Admin /);
  assert.match(allowanceDescription("referral", "go"), /^Referral /);
  assert.match(allowanceDescription("event", "ultra"), /^Event /);
});
