import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDeletionPreflight } from "./account-deletion-preflight.js";

const ready = { schemaReady: true, role: "user", activeAdministrators: 2, restricted: false,
  unsettledEarnings: false, stripeConfigured: false, billing: {} };

test("billing records without Stripe permit only the confirmation email", () => {
  const report = evaluateDeletionPreflight({ ...ready, billing: {
    stripeCustomerId: "cus_fixture", stripeConnectId: "acct_fixture",
  } });
  assert.equal(report.canSendEmail, true);
  assert.equal(report.canDelete, false);
  assert.deepEqual(report.issues.map(i => [i.code, i.billingRecords]), [
    ["BILLING_CLEANUP_UNAVAILABLE", ["customer", "connect"]],
  ]);
  assert.ok(!JSON.stringify(report).includes("cus_fixture"), "never expose payment identifiers");
});

test("all known eligibility issues are returned together", () => {
  const now = new Date("2026-10-16T00:00:00Z");
  const report = evaluateDeletionPreflight({ ...ready, role: "admin", activeAdministrators: 1,
    latestDeletionAt: now, unsettledEarnings: true, billing: { stripeSubscriptionId: "sub_fixture",
      stripePaymentIntentIds: ["pi_fixture"], stripeCheckoutSessionIds: ["cs_fixture"] },
  }, now);
  assert.deepEqual(report.issues.map(i => i.code), ["LAST_ADMIN_ACCOUNT", "ACCOUNT_DELETION_COOLDOWN",
    "PENDING_CREATOR_EARNINGS", "BILLING_CLEANUP_UNAVAILABLE"]);
  assert.equal(report.issues[1]!.blockedUntil, "2026-10-19T00:00:00.000Z");
  assert.deepEqual(report.issues[3]!.billingRecords, ["subscription", "payment", "checkout"]);
  assert.equal(report.canSendEmail, false);
  assert.equal(report.canDelete, false);
});

test("schema readiness fails closed, clean accounts and configured billing can proceed", () => {
  assert.deepEqual(evaluateDeletionPreflight(ready), { issues: [], canSendEmail: true, canDelete: true });
  assert.equal(evaluateDeletionPreflight({ ...ready, stripeConfigured: true,
    billing: { stripeCustomerId: "cus_fixture" } }).canDelete, true);
  const unready = evaluateDeletionPreflight({ ...ready, schemaReady: false });
  assert.equal(unready.canSendEmail, false);
  assert.deepEqual(unready.issues.map(i => i.code), ["ACCOUNT_DELETION_NOT_READY"]);
});
