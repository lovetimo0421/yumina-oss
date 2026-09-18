import test from "node:test";
import assert from "node:assert/strict";
import { applyGiftDeduction, giftableMushies } from "./mushie-gift-math.js";

// ─── giftableMushies ────────────────────────────────────────────────
// Only the spendable balance above the daily floor may be gifted. addonBalance
// is a sub-portion of balance (proven by refreshMonthlyCredits: balance =
// monthlyCredits + addonBalance), so it must NOT be added on top — doing so was
// the old double-count that let players gift ~2× their balance.

test("giftable is balance minus the floor, ignoring addon entirely", () => {
  assert.equal(giftableMushies(5000, 1000), 4000);
});

test("giftable never goes negative when balance is under the floor", () => {
  assert.equal(giftableMushies(100, 1000), 0);
});

test("non-finite balance or floor collapses to a safe number", () => {
  assert.equal(giftableMushies(Number.NaN, 1000), 0);
  assert.equal(giftableMushies(5000, Number.NaN), 5000);
});

// ─── applyGiftDeduction ─────────────────────────────────────────────
// A gift must cost the sender its full amount of spendable balance. The old
// code left balance untouched whenever addon covered the gift, minting mushies.

test("a gift fully covered by addon still costs the full spendable balance", () => {
  // The printing case: balance == addon == 5000, gift 1000.
  const after = applyGiftDeduction(5000, 5000, 1000);
  assert.equal(after.balance, 4000, "balance must drop by the full gift");
  assert.equal(after.addonBalance, 4000, "addon stays a subset of balance");
});

test("gifting spends the monthly portion first, preserving purchased addon", () => {
  // balance 5000 = 3000 monthly + 2000 purchased. Gift 1000 → addon untouched.
  const after = applyGiftDeduction(5000, 2000, 1000);
  assert.equal(after.balance, 4000);
  assert.equal(after.addonBalance, 2000);
});

test("addon is only drawn down once the gift exceeds the monthly portion", () => {
  // balance 3000 = 0 monthly + 3000 addon. Gift 2500 → addon clamps to 500.
  const after = applyGiftDeduction(3000, 3000, 2500);
  assert.equal(after.balance, 500);
  assert.equal(after.addonBalance, 500);
});

test("the addon <= balance invariant holds for every split", () => {
  for (const [bal, addon, amt] of [
    [5000, 5000, 1000],
    [5000, 2000, 4000],
    [3000, 3000, 3000],
    [1000, 0, 800],
  ] as Array<[number, number, number]>) {
    const after = applyGiftDeduction(bal, addon, amt);
    assert.ok(after.addonBalance <= after.balance, `addon>${after.balance} for ${bal}/${addon}/${amt}`);
    assert.ok(after.addonBalance >= 0, "addon never negative");
  }
});
