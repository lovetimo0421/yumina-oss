// ─── Referral reward ladder (pure) ───────────────────────────────────
// DB-free so it can be unit-tested directly (mirrors plan-state.ts).
// referral-service.ts owns the DB writes that consume these definitions.

import type { PlanId } from "./plan-config.js";
import type { TierLevel } from "./achievements/definitions.js";

// ─── Reward reset epoch ──────────────────────────────────────────────
// The wallet reward ladder (mushies + Gold grants) is RESETTABLE and is
// decoupled from the all-time 引路人 achievement/title. Only referrals whose
// `user.referred_at >= REFERRAL_REWARD_EPOCH` count toward the ladder; the
// achievement engine keeps counting ALL referrals for badges/titles.
//
// To reset the reward ladder again in the future:
//   1. bump this constant to the new reset moment, and
//   2. archive + clear the `referral_milestones` table (see
//      scripts/reset-referral-rewards.sql), so the ladder becomes re-earnable.
// Legacy referrals (referred_at IS NULL, i.e. redeemed before this column
// existed) are always treated as pre-epoch, so the first reset zeroes everyone
// without touching their achievements/titles.
export const REFERRAL_REWARD_EPOCH = new Date("2026-07-16T00:00:00Z");

/** Pure: does a referral (by its referred_at) count toward the reward ladder? */
export function isRewardEligibleReferral(
  referredAt: Date | null | undefined,
  epoch: Date = REFERRAL_REWARD_EPOCH,
): boolean {
  return referredAt != null && referredAt.getTime() >= epoch.getTime();
}

export type CountBasis = "raw" | "confirmed";

export type MilestoneReward =
  | { type: "credit_grant"; credits: number }
  | { type: "plan_grant"; plan: PlanId; durationDays: number };

export interface MilestoneDef {
  threshold: number;
  countBasis: CountBasis;     // which count gates the WALLET reward
  reward?: MilestoneReward;   // omitted for badge-only tiers
  badge?: TierLevel;          // cosmetic 引路人 tier (granted by the achievement engine)
  detail: string;             // i18n key (referral.<detail>)
}

// Owner decision 2026-09-16. Two things changed at once:
//
//   1. Every step counts ACTIVE friends ("confirmed"): invitees whose referral
//      qualification settled as rewarded — 3 AI turns or 10 played minutes, plus
//      a return visit 24 h+ later, within 14 days of joining. Registrations
//      ("raw") no longer unlock anything: 24–30 sign-ups with zero friends who
//      ever played twice were collecting Gold.
//   2. The shape: 1 is small so 5 reads as the first real reward; 10 and 20 are
//      memberships so inviting also means trying the better models — a Platinum
//      week at the top is 3,430 Mushies plus Sonnet/Opus access.
//
// Payouts in Mushies (memberships via planDaysToCredits): 300 / 1,500 / 933 / 2,000 / 3,430.
export const MILESTONES: MilestoneDef[] = [
  { threshold: 1,  countBasis: "confirmed", reward: { type: "credit_grant", credits: 300 },                    detail: "milestone1"  },
  { threshold: 5,  countBasis: "confirmed", reward: { type: "credit_grant", credits: 1500 }, badge: "bronze",   detail: "milestone5"  },
  { threshold: 10, countBasis: "confirmed", reward: { type: "plan_grant", plan: "go", durationDays: 7 },       detail: "milestone10" },
  { threshold: 15, countBasis: "confirmed", reward: { type: "credit_grant", credits: 2000 }, badge: "silver",   detail: "milestone15" },
  { threshold: 20, countBasis: "confirmed", reward: { type: "plan_grant", plan: "plus", durationDays: 7 }, badge: "gold", detail: "milestone20" },
];

/** Frontend/admin-facing milestone definitions (no internal credit/plan amounts). */
export const REFERRAL_MILESTONES = MILESTONES.map((m) => ({
  threshold: m.threshold,
  rewardType: m.reward?.type ?? "badge",
  countBasis: m.countBasis,
  badge: m.badge ?? null,
  detail: m.detail,
}));

export interface ReferralCounts {
  raw: number;
  confirmed: number;
}

/** Pure: reward-bearing milestones the user has newly earned (not yet claimed). `confirmed` = active friends. */
export function selectEarnedMilestones(
  milestones: MilestoneDef[],
  counts: ReferralCounts,
  claimed: Set<number>,
): MilestoneDef[] {
  return milestones.filter((m) => {
    if (!m.reward) return false;                 // badge-only tiers carry no wallet reward
    if (claimed.has(m.threshold)) return false;
    const n = m.countBasis === "raw" ? counts.raw : counts.confirmed;
    return n >= m.threshold;
  });
}

// decidePlanRewardMode (credits-OR-days fork) was removed 2026-07-26 — every
// recipient of a plan tier now gets the same package. See
// referral-service.ts#grantStackingPlanReward. The duration-scaled mushie
// amount now lives with the rest of the allowance policy.
export { planDaysToCredits } from "./entitlement-allowance.js";
