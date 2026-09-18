import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateAccountDeletionAccess } from "./account-deletion-access.js";

test("account deletion permits every non-admin role", () => {
  for (const role of [undefined, null, "", "user", "moderator"]) {
    assert.deepEqual(evaluateAccountDeletionAccess(role, 5), { allowed: true });
  }
  assert.deepEqual(evaluateAccountDeletionAccess("user", 0), { allowed: true });
  assert.deepEqual(evaluateAccountDeletionAccess("user", Number.NaN), { allowed: true });
});

test("account deletion rollout protects the final active administrator", () => {
  assert.deepEqual(evaluateAccountDeletionAccess("admin", 1), {
    allowed: false,
    code: "LAST_ADMIN_ACCOUNT",
    message: "The final administrator account cannot be deleted.",
  });
  assert.equal(evaluateAccountDeletionAccess("admin", 0).allowed, false);
  assert.equal(evaluateAccountDeletionAccess("admin", Number.NaN).allowed, false);
});

test("account deletion rollout permits an administrator when another active administrator remains", () => {
  assert.deepEqual(evaluateAccountDeletionAccess("admin", 2), { allowed: true });
});

test("content, submission and audit history are not deletion eligibility gates", () => {
  const source = readFileSync(new URL("./account-deletion.ts", import.meta.url), "utf8");
  assert.equal(source.includes("hasRewardOrModerationHistory"), false);
  assert.equal(source.includes("REWARD_OR_MODERATION_HISTORY_REQUIRES_SUPPORT"), false);
  assert.match(source, /anonymizeDeletedAccountAudit/);
});

test("a creator payout account is durable cleanup work, not a deletion eligibility gate", () => {
  const source = readFileSync(new URL("./account-deletion.ts", import.meta.url), "utf8");
  assert.equal(source.includes("CREATOR_ACCOUNT_CLOSURE_FAILED"), false);
  assert.match(source, /stripeConnectId: lockedContext\.stripeConnectId/);
  assert.match(source, /stripeConnectId: job\.stripeConnectId/);
});
