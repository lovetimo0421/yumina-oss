// Admin plan-change grant policy: delta-only minting (owner decision
// 2026-07-19). The admin panel used to mint the FULL new-plan monthly credits
// additively on EVERY plan set — repeated flips or corrections kept minting
// (the ~237k over-mint incident). Policy now: a plan change mints only the
// credit DIFFERENCE between tiers, and only when the tier increases. Admins
// who want to gift extra mushies use the explicit credit-grant tool.
//
// Scope: the admin panel functions (adminSetPermanentPlan,
// adminSetTimeLimitedPlan). Earned rewards (referral milestones, event
// prizes via adminGrantStackedTimeLimitedPlan) keep full grants — those are
// one-shot rewards with their own stacking anti-farm rules.

import { PLANS, type PlanId } from "./plan-config.js";

/**
 * Fraction of the NEW plan's monthly credits to grant for an admin plan
 * change, such that the granted amount equals the tier delta:
 *   grant = max(0, newMonthly - currentMonthly)
 * Same-tier re-grants, downgrades, and demotions grant 0. Feed the result to
 * syncPlan's `grantFraction` (additive), which computes
 * round(newMonthly * fraction).
 */
export function adminUpgradeGrantFraction(currentPlan: PlanId, newPlan: PlanId): number {
  const newMonthly = PLANS[newPlan].monthlyCredits;
  if (newMonthly <= 0) return 0;
  const delta = Math.max(0, newMonthly - PLANS[currentPlan].monthlyCredits);
  return delta / newMonthly;
}
