import assert from "node:assert/strict";
import test from "node:test";
import { dmDeliveryAllowed } from "./dm-gate.js";

test("a user who disabled DMs can still receive replies in a thread they messaged in", () => {
  // The bug: A turns DMs off, A messages B, B's reply was rejected because
  // the gate only looked at A's setting. A has messaged in the thread, so
  // B's reply must go through.
  assert.equal(
    dmDeliveryAllowed({ recipientAllowsDMs: false, recipientHasMessaged: true }),
    true,
  );
});

test("a stranger still cannot message someone who disabled DMs", () => {
  assert.equal(
    dmDeliveryAllowed({ recipientAllowsDMs: false, recipientHasMessaged: false }),
    false,
  );
});

test("recipients who allow DMs are reachable regardless of thread history", () => {
  assert.equal(
    dmDeliveryAllowed({ recipientAllowsDMs: true, recipientHasMessaged: false }),
    true,
  );
  assert.equal(
    dmDeliveryAllowed({ recipientAllowsDMs: true, recipientHasMessaged: true }),
    true,
  );
});
