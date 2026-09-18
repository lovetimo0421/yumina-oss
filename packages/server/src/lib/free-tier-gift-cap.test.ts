import test from "node:test";
import assert from "node:assert/strict";
import {
  FREE_TIER_MONTHLY_GIFT_CAP,
  isCappedGifter,
  remainingFreeTierGiftAllowance,
} from "./free-tier-gift-cap.js";

// Never-paid free wallets may only gift a token amount per month; paid plans
// and pack buyers gift freely. This is the anti-farm control — the recipient
// traction floor is only a spam floor (see tip-eligibility.ts).

test("the cap is the agreed 200 per month", () => {
  assert.equal(FREE_TIER_MONTHLY_GIFT_CAP, 200);
});

test("free plan with no purchases is capped", () => {
  assert.equal(isCappedGifter(true, false), true);
});

test("a paid plan is never capped, purchases or not", () => {
  assert.equal(isCappedGifter(false, false), false);
  assert.equal(isCappedGifter(false, true), false);
});

test("a free plan that bought a pack is not capped", () => {
  assert.equal(isCappedGifter(true, true), false);
});

test("allowance counts down from the cap and floors at zero", () => {
  assert.equal(remainingFreeTierGiftAllowance(0), 200);
  assert.equal(remainingFreeTierGiftAllowance(150), 50);
  assert.equal(remainingFreeTierGiftAllowance(200), 0);
  assert.equal(remainingFreeTierGiftAllowance(9999), 0);
});

test("garbage sent-totals cannot inflate the allowance", () => {
  assert.equal(remainingFreeTierGiftAllowance(-500), 200);
  assert.equal(remainingFreeTierGiftAllowance(Number.NaN), 200);
  assert.equal(remainingFreeTierGiftAllowance(Number.POSITIVE_INFINITY), 200);
});
