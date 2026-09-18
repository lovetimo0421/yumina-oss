// Prorated upgrade grants.
//
// Card upgrades via the Stripe Customer Portal charge the PRORATED price
// difference for the remaining days of the billing cycle, so the credit
// grant must be prorated the same way. Granting the full monthlyCredits
// for a prorated payment lets a user ladder Gold→Platinum→Diamond→Ascendant
// on day 29 and collect ~142k mushies for pennies, every cycle.
//
// This applies ONLY to card (charge_automatically) upgrades. WeChat
// purchases and send_invoice subs pay full price per purchase and keep
// full grants. The fraction is computed from Stripe's own subscription
// period — the same clock Stripe used to prorate the money.

export interface BillingPeriod {
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Fraction of the billing cycle remaining at `now`, clamped to [0, 1].
 *
 * Returns 1 (full grant, legacy behavior) when the period is missing or
 * degenerate — an unverifiable proration must never shortchange a paying
 * upgrader.
 */
export function upgradeGrantFraction(period: BillingPeriod | undefined, now: Date = new Date()): number {
  if (!period) return 1;
  const total = period.periodEnd.getTime() - period.periodStart.getTime();
  if (!Number.isFinite(total) || total <= 0) return 1;
  const remaining = period.periodEnd.getTime() - now.getTime();
  if (remaining <= 0) return 0;
  return Math.min(remaining / total, 1);
}
