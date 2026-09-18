import assert from "node:assert/strict";
import test from "node:test";
import { hasStripeCleanupArtifacts } from "./account-deletion-policy.js";

test("Stripe cleanup policy treats every captured processor identifier as required", () => {
  for (const context of [
    { stripeCustomerId: "cus_test" },
    { stripeSubscriptionId: "sub_test" },
    { stripeConnectId: "acct_test" },
    { stripePaymentIntentIds: ["pi_test"] },
    { stripeCheckoutSessionIds: ["cs_test"] },
  ]) {
    assert.equal(hasStripeCleanupArtifacts(context), true, JSON.stringify(context));
  }
});

test("Stripe cleanup policy ignores absent and empty identifiers", () => {
  assert.equal(hasStripeCleanupArtifacts({}), false);
  assert.equal(
    hasStripeCleanupArtifacts({
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeConnectId: null,
      stripePaymentIntentIds: [],
      stripeCheckoutSessionIds: [],
    }),
    false,
  );
});
