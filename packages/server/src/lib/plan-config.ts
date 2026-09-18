// ─── Plan Definitions ────────────────────────────────────────────────
// Static configuration for all subscription plans.
// Plan hierarchy determines model access: higher index = higher tier.

export type PlanId = "free" | "go" | "plus" | "pro" | "ultra" | "internal";

export interface PlanConfig {
  id: PlanId;
  displayName: string;         // user-facing name (Gold, Platinum, etc.)
  monthlyCredits: number;
  /** Monthly cap on TOTAL daily-recovery credits per billing period. Set to
   *  50% of monthlyCredits (= the original pre-2x-promo grant), so a daily-grind
   *  user recovers at most half a month's allotment for free before hitting the
   *  wall and topping up. NOT the plan grant — that's monthlyCredits.
   *  WARNING: also hardcoded in scripts/install-daily-recovery-fn.sql
   *  (recovery_cap_plan) — keep in sync. */
  monthlyRecoveryCap: number;
  memoryCap: number | null;   // null = unlimited (model's native limit)
  storageCap: number;          // bytes — max asset storage per user
  unlimited: boolean;          // skip credit deduction entirely
  rateLimit: number;           // messages per minute
  maxConcurrent: number;
  priceCents: number;
  /** Daily floor: if balance falls below this, the daily refresh restores
   *  balance to this amount. 0 disables (internal/unlimited tier).
   *  Refresh fires once per local check-in day (04:00 in the user's
   *  time zone, matching daily check-in).
   *  WARNING: dailyRecoveryAmount (the floor) AND monthlyRecoveryCap (the cap)
   *  are hardcoded in scripts/install-daily-recovery-fn.sql — update both when
   *  changing values or adding tiers. */
  dailyRecoveryAmount: number;
}

// Plan hierarchy: higher index = higher tier. "internal" sits above all public tiers.
const PLAN_HIERARCHY: PlanId[] = ["free", "go", "plus", "pro", "ultra", "internal"];

/** Check if a user's plan meets or exceeds the required minimum plan. */
export function planMeetsMinimum(userPlan: PlanId, requiredPlan: PlanId): boolean {
  return PLAN_HIERARCHY.indexOf(userPlan) >= PLAN_HIERARCHY.indexOf(requiredPlan);
}

/**
 * Normalize a tier string from the database to a valid PlanId.
 * Handles legacy values ("regular" → "free", "invited" → "go")
 * and unknown values (fallback to "free").
 * CRITICAL: The auth middleware caches user objects in Redis.
 * Cached sessions may still contain old tier values for up to 60s
 * after a migration. This function ensures they still work.
 */
export function normalizePlan(tier: string | undefined | null): PlanId {
  if (!tier) return "free";
  // Legacy tier values from before the credit system
  if (tier === "regular") return "free";
  if (tier === "invited") return "go";
  // Valid plan IDs pass through
  if (tier in PLANS) return tier as PlanId;
  // Unknown value — safe fallback (log for investigation)
  console.error(`[Plan] Unknown tier "${tier}" normalized to "free" — possible data corruption`);
  return "free";
}

// ─── Stripe Price ↔ Plan Mapping ────────────────────────────────────
// Single source of truth (was duplicated in routes/stripe.ts and
// routes/subscription.ts). Live-mode subscription price IDs.

export const STRIPE_PRICE_TO_PLAN: Record<string, PlanId> = {
  "price_1TUwUTAqpxe2iPklt7qxNZQj": "go",
  "price_1TUwUTAqpxe2iPkl77clUCKq": "plus",
  "price_1TUwUTAqpxe2iPklWRxm2fHP": "pro",
  "price_1TUwUSAqpxe2iPkl2G5DtBZ7": "ultra",
};

export const STRIPE_PLAN_TO_PRICE: Partial<Record<PlanId, string>> = {
  go: "price_1TUwUTAqpxe2iPklt7qxNZQj",
  plus: "price_1TUwUTAqpxe2iPkl77clUCKq",
  pro: "price_1TUwUTAqpxe2iPklWRxm2fHP",
  ultra: "price_1TUwUSAqpxe2iPkl2G5DtBZ7",
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

// ─── Launch Promotion: 2× Credits ───────────────────────────────────
// All plans get 2× monthly credits during launch period.
// Original (post-promo) values: 1000 / 2000 / 7350 / 20000 / 41700.
// To fully end the promotion, set monthlyCredits to those.
export const PLANS: Record<PlanId, PlanConfig> = {
  free:     { id: "free",     displayName: "Free",      monthlyCredits: 2000,    monthlyRecoveryCap: 1000,  memoryCap: 64_000,  storageCap: 100 * MB,  unlimited: false, rateLimit: 20, maxConcurrent: 10, priceCents: 0,    dailyRecoveryAmount: 200  },
  go:       { id: "go",       displayName: "Gold",      monthlyCredits: 4000,    monthlyRecoveryCap: 2000,  memoryCap: 96_000,  storageCap: 500 * MB,  unlimited: false, rateLimit: 20, maxConcurrent: 10, priceCents: 500,  dailyRecoveryAmount: 500  },
  plus:     { id: "plus",     displayName: "Platinum",  monthlyCredits: 14700,   monthlyRecoveryCap: 7350,  memoryCap: null,    storageCap: 2 * GB,    unlimited: false, rateLimit: 20, maxConcurrent: 10, priceCents: 1800, dailyRecoveryAmount: 1600 },
  pro:      { id: "pro",      displayName: "Diamond",   monthlyCredits: 40000,   monthlyRecoveryCap: 20000, memoryCap: null,    storageCap: 5 * GB,    unlimited: false, rateLimit: 20, maxConcurrent: 10, priceCents: 4800, dailyRecoveryAmount: 4000 },
  ultra:    { id: "ultra",    displayName: "Ascendant", monthlyCredits: 83400,   monthlyRecoveryCap: 41700, memoryCap: null,    storageCap: 20 * GB,   unlimited: false, rateLimit: 20, maxConcurrent: 10, priceCents: 9800, dailyRecoveryAmount: 8000 },
  internal: { id: "internal", displayName: "Creator",   monthlyCredits: 1_000_000, monthlyRecoveryCap: 0, memoryCap: null,  storageCap: 50 * GB,   unlimited: false, rateLimit: 20, maxConcurrent: 10, priceCents: 0,    dailyRecoveryAmount: 0    },
};
