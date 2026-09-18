// Pure per-source policy for the one-time mushie allowance attached to a plan
// entitlement (owner decisions 2026-07-19, revised 2026-07-26). DB-free so it
// can be unit-tested directly; event-plan-entitlements.ts and
// plan-entitlement-grants.ts apply it.

import { PLANS, type PlanId } from "./plan-config.js";

/** Duration-scaled mushie-equivalent of a time-limited plan grant. */
export function planDaysToCredits(plan: PlanId, durationDays: number): number {
  return Math.round((PLANS[plan].monthlyCredits * durationDays) / 30);
}

/**
 *  - admin:    the tier DELTA vs the base plan at activation (delta-only
 *              policy — same-tier or lower mints nothing).
 *  - referral: the DURATION-SCALED equivalent of the granted tier, paid at
 *              GRANT time (see plan-entitlement-grants.ts), not activation.
 *  - event:    full monthly, gated by the event's
 *              grantMonthlyCreditsOnActivation rules flag (existing behavior).
 *
 * The referral allowance used to be a full month regardless of duration, which
 * made the 10-friend tier (Gold 7d → 4000) pay more than the 15-friend tier
 * (3000) and 4.3x what the credits-equivalent path paid the same tier's
 * subscribers (933). Scaling by duration keeps the ladder monotonic and gives
 * every recipient of a tier the identical package.
 */
export function activationAllowance(
  source: string,
  plan: PlanId,
  basePlan: PlanId,
  eventGrantsMonthly: boolean,
  durationDays?: number,
): number {
  if (source === "event") return eventGrantsMonthly ? PLANS[plan].monthlyCredits : 0;
  if (source === "admin") {
    return Math.max(0, PLANS[plan].monthlyCredits - PLANS[basePlan].monthlyCredits);
  }
  return planDaysToCredits(plan, durationDays ?? 30);
}

/** Ledger description for an entitlement allowance, per source. */
export function allowanceDescription(source: string, plan: PlanId): string {
  const label = PLANS[plan].displayName;
  if (source === "admin") return `Admin ${label} membership activation grant`;
  if (source === "referral") return `Referral ${label} membership reward`;
  return `Event ${label} membership activation grant`;
}
