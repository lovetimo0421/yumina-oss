// ─── Plan definitions, version 2 (new signups from BILLING_V2_LAUNCH_AT) ──
//
// Owner decisions 2026-09-14, derived from the replay of real per-user usage
// (docs/billing/2026-09-14-billing-plan-final.md):
//   - Prices unchanged. The month's pile is sized so the average subscriber
//     costs about half the price and a maxed-out one under 80%; value per
//     dollar rises with the tier (full-use price/AI 1.5x → 1.25x).
//   - The pile is DELIVERED IN DROPS, not as one lump: half at purchase or
//     renewal, a quarter on day 10, a quarter on day 20 (free: 700 at
//     signup/renewal, then 100 on days 7, 14, 21). Unused credits carry inside
//     the cycle and reset at renewal. Roleplay is a binge (36% of a month in
//     one day) so daily allowances refuse most play; a single lump strands a
//     third of subscribers for a week or more. Drops were the only cadence
//     that fixed both.
//   - NO daily refill. It funded 6-12% of paid play, predicted nothing about
//     retention, and its floor equalled a Gold user's typical day.
//   - Check-ins become QUESTS: a daily action pays into the expiring Bonus
//     bucket, capped per tier per month, scaled by one global multiplier.
//
// Ladder rework, owner decisions 2026-09-16 (docs/billing/2026-09-16-quest-ladder-v2.md):
//   - The board's caps were regressive (Free's cap was 160% of its pile,
//     Ascendant's 14%) and Gold had become the best mushies-per-dollar on the
//     site. Caps are now 1,000 / 2,000 / 2,800 / 5,000 / 7,000 and every
//     per-quest amount is set PER TIER, not as a multiplier of Free, so a paid
//     board is visibly richer on every card.
//   - CYCLE QUESTS (the "forge"): rebates that unlock on mushies actually
//     burned this cycle. Platinum and up; Gold sees them locked. They are
//     fixed amounts outside the monthly cap.
//   - INVITE QUESTS: one daily (a signup with your code) and one weekly (three
//     friends who qualified as active). Fixed, the same at every tier, outside
//     the cap — a referral is good for us whatever the tier.
//   - Measured against real completion rates (28 days, 9/16) the board's
//     expected payout is 6–33% of the cap; the cap is what a daily player can
//     reach, the expected cost is what the ledger will actually show.
//
// Version-1 wallets (everyone who signed up before launch) keep plan-config.ts.

import type { PlanId } from "./plan-config.js";

export interface PlanDrop {
  /** Days after the cycle start when this drop becomes available (0 = at grant). */
  day: number;
  amount: number;
}

/** What one quest of each kind pays at a tier, before the global dial. */
export interface QuestPayoutTable {
  /** A daily quest finished in passing. Two of these are on the board each day. */
  dailyLight: number;
  /** The one daily quest a day that asks for a real session. */
  dailyHeavy: number;
  /** A weekly goal that is a single moment (claim twelve dailies). */
  weekly: number;
  /** A weekly goal that takes the whole week. */
  weeklyHeavy: number;
}

export interface PlanConfigV2 {
  id: PlanId;
  /** Full pile per 30-day cycle (sum of drops). Stored in credit_wallets.monthly_credits. */
  monthlyCredits: number;
  drops: PlanDrop[];
  /**
   * Most Bonus the daily + weekly board can pay per 30-day cycle. Solved so a
   * perfect month lands ON the cap (quest-budget.test.ts holds the invariant);
   * a cap a player cannot reach is decorative, one they hit by day 17 kills the
   * board for the rest of the cycle.
   */
  questMonthlyCap: number;
  /** Per-quest amounts at this tier. The visible difference between tiers. */
  questPayout: QuestPayoutTable;
  /**
   * Most the cycle quests (forge rungs) can pay per cycle at this tier — the
   * sum of the rungs this tier can reach. Outside questMonthlyCap. Shown on
   * the plans page as part of "up to N a month" and on the board's dial.
   */
  forgeCap: number;
  /**
   * Weekly goals this tier does not get. Free's board keeps three of the four
   * counted weeklies; the fourth shows locked with Gold's amount on it.
   */
  weeklyLocked: readonly string[];
  /** Mushie-pack member bonus for this tier, as a percentage (v2 wallets only). */
  packBonusPct: number;
}

/**
 * Cycle quests ("forge" rungs, owner 2026-09-16). Unlock on mushies BURNED in
 * the current billing cycle — not earned, not held — and pay a fixed amount
 * into the expiring Bonus bucket. Cumulative: a Diamond player who burns
 * 25,000 has cleared I, II and III.
 *
 * Every threshold sits inside the pile of the lowest tier that can see it
 * unlocked (Platinum 13,600 ≥ 12,000; Diamond 40,000 ≥ 25,000; Ascendant
 * 88,000 ≥ 55,000), so a subscriber never needs a pack to reach their rungs.
 * Free (2,500 a month all in) and Gold (5,200) cannot reach rung I: that is the
 * gate, and it needs no rule — the arithmetic is the rule.
 */
export interface ForgeRung {
  key: `cycle_${number}`;
  /** Mushies burned this cycle to unlock. */
  burn: number;
  /** Fixed Bonus paid on unlock, at every tier that can see it. */
  pay: number;
  /** Lowest plan on which this rung is claimable; lower paid tiers see it locked. */
  minPlan: PlanId;
}

export const FORGE_RUNGS: readonly ForgeRung[] = [
  { key: "cycle_6000",  burn: 6_000,  pay: 1_000, minPlan: "plus" },
  { key: "cycle_12000", burn: 12_000, pay: 1_500, minPlan: "plus" },
  { key: "cycle_25000", burn: 25_000, pay: 3_000, minPlan: "pro" },
  { key: "cycle_55000", burn: 55_000, pay: 5_000, minPlan: "ultra" },
];

/**
 * Invite quests pay the same fixed amount at every tier and sit outside the
 * monthly cap. Registrations alone carry the daily one (one slot a day, so a
 * farm of alts is worth at most 1,500 a month — less than the alt's own welcome
 * gift); the weekly one counts friends whose referral qualification settled as
 * `rewarded` (they played and came back). 28-day measurement: 698 referrer-days
 * with a signup and at most 125 referrer-weeks with three, so the whole site
 * pays under $60 a month for both.
 */
export const INVITE_QUEST_PAYOUT = { day: 50, week: 300 } as const;

/** What the invite quests can pay a month, for the plans page: 50 × 30 + 300 × 4. */
export const INVITE_QUEST_MONTHLY_MAX = INVITE_QUEST_PAYOUT.day * 30 + INVITE_QUEST_PAYOUT.week * 4;

const drops50_25_25 = (pile: number): PlanDrop[] => [
  { day: 0, amount: Math.round(pile * 0.5) },
  { day: 10, amount: Math.round(pile * 0.25) },
  { day: 20, amount: pile - Math.round(pile * 0.5) - Math.round(pile * 0.25) },
];

const LADDER: readonly PlanId[] = ["free", "go", "plus", "pro", "ultra", "internal"];

/** Sum of the forge rungs a tier can actually unlock. */
export function forgeCapFor(plan: PlanId): number {
  return FORGE_RUNGS
    .filter((r) => LADDER.indexOf(plan) >= LADDER.indexOf(r.minPlan))
    .reduce((s, r) => s + r.pay, 0);
}

/**
 * Per-tier amounts, solved so a perfect month equals the cap with the board
 * shape below (14 light + 7 heavy daily slots, 3 heavy weeklies + 1 regular,
 * the invite quests excluded because they are outside the cap):
 *
 *   month = (14·light + 7·heavy + 3·weeklyHeavy + weekly) × 30/7
 *
 *   Free      5 / 10 / 30 / 30, "100 messages" locked →  986 ≈ 1,000
 *   Gold     10 / 15 / 60 / 40                         → 1,993 ≈ 2,000
 *   Platinum 12 / 24 / 85 / 70                         → 2,833 ≈ 2,800
 *   Diamond  20 / 40 / 160 / 120                       → 4,971 ≈ 5,000
 *   Ascendant 30 / 60 / 210 / 180                      → 7,071 ≈ 7,000
 */
export const PLANS_V2: Record<PlanId, PlanConfigV2> = {
  free: {
    id: "free",
    monthlyCredits: 1000,
    drops: [
      { day: 0, amount: 700 },
      { day: 7, amount: 100 },
      { day: 14, amount: 100 },
      { day: 21, amount: 100 },
    ],
    questMonthlyCap: 1000,
    questPayout: { dailyLight: 5, dailyHeavy: 10, weekly: 30, weeklyHeavy: 30 },
    forgeCap: 0,
    weeklyLocked: ["week_messages"],
    packBonusPct: 0,
  },
  go: {
    id: "go", monthlyCredits: 3200, drops: drops50_25_25(3200),
    questMonthlyCap: 2000, questPayout: { dailyLight: 10, dailyHeavy: 15, weekly: 40, weeklyHeavy: 60 },
    forgeCap: forgeCapFor("go"), weeklyLocked: [], packBonusPct: 10,
  },
  plus: {
    id: "plus", monthlyCredits: 13600, drops: drops50_25_25(13600),
    questMonthlyCap: 2800, questPayout: { dailyLight: 12, dailyHeavy: 24, weekly: 70, weeklyHeavy: 85 },
    forgeCap: forgeCapFor("plus"), weeklyLocked: [], packBonusPct: 15,
  },
  pro: {
    id: "pro", monthlyCredits: 40000, drops: drops50_25_25(40000),
    questMonthlyCap: 5000, questPayout: { dailyLight: 20, dailyHeavy: 40, weekly: 120, weeklyHeavy: 160 },
    forgeCap: forgeCapFor("pro"), weeklyLocked: [], packBonusPct: 20,
  },
  ultra: {
    id: "ultra", monthlyCredits: 88000, drops: drops50_25_25(88000),
    questMonthlyCap: 7000, questPayout: { dailyLight: 30, dailyHeavy: 60, weekly: 180, weeklyHeavy: 210 },
    forgeCap: forgeCapFor("ultra"), weeklyLocked: [], packBonusPct: 25,
  },
  // Internal/creator plan: unchanged allowance, no drops (single grant), no quests.
  internal: {
    id: "internal", monthlyCredits: 1_000_000, drops: [{ day: 0, amount: 1_000_000 }],
    questMonthlyCap: 0, questPayout: { dailyLight: 0, dailyHeavy: 0, weekly: 0, weeklyHeavy: 0 },
    forgeCap: 0, weeklyLocked: [], packBonusPct: 0,
  },
};

/** Version-2 wallets are created for signups at/after this instant (env BILLING_V2_LAUNCH_AT). */
export function billingV2LaunchAt(): Date | null {
  const raw = process.env.BILLING_V2_LAUNCH_AT;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Whether a wallet created at `createdAt` belongs to the version-2 lineup. */
export function isV2Signup(createdAt: Date): boolean {
  const launch = billingV2LaunchAt();
  return !!launch && createdAt.getTime() >= launch.getTime();
}

/**
 * Existing wallets join the version-2 lineup at their first cycle boundary at/after
 * this instant (env BILLING_V2_EXISTING_AT). Owner decision 2026-09-16, timed to the
 * announced free-tier cut: instead of the reduced legacy cycle (1,000 + refill),
 * existing free users go straight to 700 + 100×3 drops and quests.
 *
 * Every wallet that is NOT on a real Stripe recurring subscription migrates: free
 * wallets, WeChat-paid plans (one-time 30-day purchases, so renewal or expiry is a
 * clean boundary), comp accounts, anything without a live Stripe subscription. Only
 * Stripe MRR keeps the terms it bought (owner clarification). Not set = nobody moves.
 */
export function billingV2ExistingAt(): Date | null {
  const raw = process.env.BILLING_V2_EXISTING_AT;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Pure: should this version-1 wallet become version 2 at the cycle boundary happening `now`? */
export function shouldMigrateToV2(
  wallet: { planVersion: number; plan: string; subscriptionSource: string | null },
  now: Date = new Date(),
): boolean {
  if (wallet.planVersion !== 1) return false;
  const at = billingV2ExistingAt();
  if (!at || now.getTime() < at.getTime()) return false;
  return wallet.plan === "free" || wallet.subscriptionSource !== "stripe";
}

/** Global quest reward multiplier for version-2 wallets (env QUEST_MULTIPLIER_V2, 0..2, default 1). */
export function questMultiplierV2(): number {
  const raw = Number(process.env.QUEST_MULTIPLIER_V2 ?? "1");
  if (!Number.isFinite(raw)) return 1;
  return Math.min(2, Math.max(0, raw));
}

/** Drops whose day threshold has passed, given the cycle start and now. */
export function dueDrops(config: PlanConfigV2, periodStart: Date, now: Date): PlanDrop[] {
  const elapsedDays = Math.floor((now.getTime() - periodStart.getTime()) / 86_400_000);
  return config.drops.filter((d) => d.day <= elapsedDays);
}

/** The next drop not yet released, or null when the cycle's drops are all out. */
export function nextDrop(config: PlanConfigV2, periodStart: Date, released: number): { day: number; amount: number; at: Date } | null {
  const drop = config.drops[released];
  if (!drop) return null;
  return { ...drop, at: new Date(periodStart.getTime() + drop.day * 86_400_000) };
}
