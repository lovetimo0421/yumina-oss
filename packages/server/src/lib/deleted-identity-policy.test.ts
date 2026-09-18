import assert from "node:assert/strict";
import test from "node:test";
import { isDeletedIdentityRegistrationBlocked } from "./deleted-identity-policy.js";

test("prior deletion does not block immediate registration", () => {
  assert.equal(isDeletedIdentityRegistrationBlocked(null), false);
  assert.equal(isDeletedIdentityRegistrationBlocked({ wasBanned: false }), false);
});

test("deleting an account does not erase an existing ban", () => {
  assert.equal(isDeletedIdentityRegistrationBlocked({ wasBanned: true }), true);
});
