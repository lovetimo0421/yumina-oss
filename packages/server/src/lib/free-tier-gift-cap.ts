/**
 * Sender-side mushie-gift cap for accounts that have never paid.
 *
 * The 2026-08-18 farming audit found every farm sender was a free-tier
 * account funnelling free credits (signup grants, daily check-ins, referral
 * bonuses) to a main account. Gifting is zero-sum since the printing fix,
 * but free credits regenerate, so unrestricted free-tier gifting is still an
 * extraction pump: N alts × free credits per month, laundered into one
 * wallet as addon balance that never expires.
 *
 * The rule: a wallet on a paid tier, or one that has ever bought a mushie
 * pack, gifts freely — it can only give away what someone paid for. A
 * never-paid free wallet may gift at most FREE_TIER_MONTHLY_GIFT_CAP per
 * calendar month (UTC): enough for a couple of goodwill gifts (the minimum
 * gift is 50), worthless to farm.
 */

export const FREE_TIER_MONTHLY_GIFT_CAP = 200;

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A sender is capped unless they hold a paid plan or ever bought a pack. */
export function isCappedGifter(
  isFreePlan: boolean,
  hasPurchasedPack: boolean
): boolean {
  return isFreePlan && !hasPurchasedPack;
}

/**
 * Mushies a capped sender may still gift this month. `sentThisMonth` is the
 * sum of their gifts since the start of the current UTC month.
 */
export function remainingFreeTierGiftAllowance(sentThisMonth: number): number {
  return Math.max(0, FREE_TIER_MONTHLY_GIFT_CAP - nonNegative(sentThisMonth));
}
