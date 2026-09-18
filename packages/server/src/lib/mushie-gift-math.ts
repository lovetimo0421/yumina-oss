/**
 * Mushie-gift wallet math.
 *
 * `balance` is the player's total spendable mushies; `addonBalance` is the
 * sub-portion of that total which never expires (purchases, check-ins, referral
 * grants, received gifts). The invariant `addonBalance <= balance` is proven by
 * `refreshMonthlyCredits`, which rebuilds balance as `monthlyCredits + addon`.
 *
 * The gift path used to treat addon as a SEPARATE pool: it let a player gift
 * `addon + (balance - floor)` — double-counting addon — and, when addon covered
 * the gift, deducted nothing from balance. The result was minted mushies: the
 * sender kept its full spendable balance while the recipient's balance grew.
 * These helpers make a gift cost real balance, mirroring how usage is charged.
 */

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Mushies a player may gift: spendable balance above the daily floor. */
export function giftableMushies(balance: number, floor: number): number {
  return Math.max(0, finite(balance) - finite(floor));
}

export interface WalletAfterGift {
  balance: number;
  addonBalance: number;
}

/**
 * Charge a gift to the sender's wallet. Balance drops by the full amount;
 * addon is clamped so it stays a subset of the new balance, which spends the
 * monthly portion first and preserves purchased mushies — identical to usage
 * deduction. Callers must guard `giftableMushies(balance, floor) >= amount`
 * first; this pure function does not re-check the floor.
 */
export function applyGiftDeduction(
  balance: number,
  addonBalance: number,
  amount: number
): WalletAfterGift {
  const newBalance = balance - amount;
  return {
    balance: newBalance,
    addonBalance: Math.min(addonBalance, Math.max(newBalance, 0)),
  };
}
