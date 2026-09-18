import type { CreditWallet } from "./credit-service.js";
import { planMeetsMinimum, type PlanId } from "./plan-config.js";

export type PlanSource =
  | "stripe"          // Active Stripe card subscription
  | "wechat"          // WeChat one-time-as-subscription window
  | "referral"        // Time-limited grant from referral milestone
  | "comp"            // Admin-granted with explicit subscriptionSource
  | "event"           // Event entitlement overlay currently active
  | "internal"        // Creator/internal tier
  | "free"            // No paid source
  | "ghost";          // Elevated plan with no source — needs cleanup

export type ScheduledChangeReason =
  | "stripe_downgrade_pending"
  | "stripe_cancel_pending"
  | "referral_grant_expires"
  | "wechat_no_renewal"
  | "entitlement_expires"
  | "admin_pending";

/**
 * A plan_entitlements row projected for display. Entitlements OVERLAY the
 * wallet-derived state: the base (paid) plan stays in wallet.plan and the
 * active entitlement, when it outranks the base, is the effective tier.
 */
export interface EntitlementOverlay {
  planId: PlanId;
  status: "active" | "queued";
  endsAt: Date | null;
  source: string; // 'event' | 'admin' | 'referral'
}

export interface ScheduledPlanChange {
  plan: PlanId;
  when: Date;
  reason: ScheduledChangeReason;
}

export interface EffectivePlanState {
  /** What plan the user is on RIGHT NOW (after lazy-enforcement resolution). */
  effective: PlanId;
  /** Where this plan came from. */
  source: PlanSource;
  /** Explicit upcoming change, if any. UI should display this. */
  scheduled: ScheduledPlanChange | null;
  /** Whether the stored wallet.plan disagrees with effective (lazy enforcement is overdue). */
  driftFromStored: boolean;
}

/**
 * Resolve a wallet's six-field plan state machine into a single canonical view.
 * Pure function. Does not mutate. Does not call the DB.
 *
 * Resolution order matches credit-service.ts checkBalance lazy enforcement:
 *   1. Referral grant expired → revert to planBaseline
 *   2. Pending plan effective time passed → apply pending
 *   3. WeChat period ended → revert to free
 *   4. Otherwise: stored plan
 *
 * Anything that displays or gates on plan should use the result of this function,
 * NOT wallet.plan directly.
 */
export function computeEffectivePlanState(
  wallet: CreditWallet,
  now: Date = new Date(),
  entitlements: EntitlementOverlay[] = [],
): EffectivePlanState {
  const base = computeWalletPlanState(wallet, now);

  // Overlay: an active entitlement that outranks the wallet-derived effective
  // plan IS the user's current tier. Lower/equal entitlements are paused by
  // the resolver and change nothing here. driftFromStored stays the BASE
  // verdict — an overlay outranking wallet.plan is by design, not overdue
  // lazy enforcement.
  const active = entitlements
    .filter((e) => e.status === "active" && (!e.endsAt || e.endsAt > now))
    .sort((a, b) => (outranks(a.planId, b.planId) ? -1 : 1))[0];
  if (!active || !outranks(active.planId, base.effective)) return base;

  const nextQueued = entitlements
    .filter((e) => e.status === "queued" && outranks(e.planId, base.effective))
    .sort((a, b) => (outranks(a.planId, b.planId) ? -1 : 1))[0];
  const afterExpiry = nextQueued?.planId ?? base.effective;

  return {
    effective: active.planId,
    source: entitlementSource(active.source),
    scheduled: active.endsAt
      ? { plan: afterExpiry, when: active.endsAt, reason: "entitlement_expires" }
      : base.scheduled,
    driftFromStored: base.driftFromStored,
  };
}

/** Strictly higher tier (planMeetsMinimum is >=). */
function outranks(a: PlanId, b: PlanId): boolean {
  return a !== b && planMeetsMinimum(a, b);
}

function entitlementSource(source: string): PlanSource {
  if (source === "admin") return "comp";
  if (source === "referral") return "referral";
  return "event";
}

function computeWalletPlanState(
  wallet: CreditWallet,
  now: Date,
): EffectivePlanState {
  // Resolution rule 1: referral / time-limited grant has expired
  if (wallet.planExpiresAt && now >= wallet.planExpiresAt) {
    const baseline = resolveExpiredTimeLimitedPlan(wallet, now);
    return {
      effective: baseline,
      source: classifyAfterRevert(wallet, baseline),
      scheduled: null,
      driftFromStored: wallet.plan !== baseline,
    };
  }

  // Resolution rule 2: pending downgrade/admin change effective date passed
  if (wallet.pendingPlan && wallet.pendingPlanEffective && now >= wallet.pendingPlanEffective) {
    return {
      effective: wallet.pendingPlan,
      source: classifyAfterRevert(wallet, wallet.pendingPlan),
      scheduled: null,
      driftFromStored: wallet.plan !== wallet.pendingPlan,
    };
  }

  // Resolution rule 3: WeChat window ended without renewal
  if (
    wallet.subscriptionSource === "wechat" &&
    wallet.plan !== "free" &&
    now >= wallet.periodEnd
  ) {
    return {
      effective: "free",
      source: "free",
      scheduled: null,
      driftFromStored: true,
    };
  }

  // Otherwise: stored plan is current
  return {
    effective: wallet.plan,
    source: classifyCurrent(wallet),
    scheduled: detectScheduledChange(wallet),
    driftFromStored: false,
  };
}

/**
 * Classify the plan source from wallet fields when the wallet is in steady state
 * (no lazy-enforcement transition pending).
 */
function classifyCurrent(wallet: CreditWallet): PlanSource {
  if (wallet.plan === "free") return "free";
  if (wallet.plan === "internal") return "internal";

  if (wallet.subscriptionSource === "stripe") return "stripe";
  if (wallet.subscriptionSource === "wechat") return "wechat";
  if (wallet.subscriptionSource === "comp") return "comp";

  // Has plan_expires_at + plan_baseline → time-limited grant.
  // (Pre-cleanup data: no explicit comp source set yet. After cleanup, admin
  // grants always set source='comp', so this branch only fires for legacy rows
  // and referrals.)
  if (wallet.planExpiresAt) {
    return wallet.planBaseline ? "referral" : "comp";
  }

  // Elevated plan, no source, no expiry → ghost (should not exist post-cleanup).
  return "ghost";
}

/** Classify after a revert (planExpiresAt or pendingPlan triggered). */
function classifyAfterRevert(wallet: CreditWallet, _newPlan: PlanId): PlanSource {
  if (_newPlan === "free") return "free";
  if (_newPlan === "internal") return "internal";
  if (wallet.subscriptionSource === "stripe") return "stripe";
  if (wallet.subscriptionSource === "wechat") return "wechat";
  if (wallet.subscriptionSource === "comp") return "comp";
  return "ghost";
}

/** Detect upcoming plan changes from the stored fields, ordered by precedence. */
function detectScheduledChange(wallet: CreditWallet): ScheduledPlanChange | null {
  // Cancellation wins: a sub set to cancel at period end is ENDING (→ free),
  // which supersedes any scheduled downgrade. In practice the two are mutually
  // exclusive (both /cancel and the webhook clear pendingPlan on cancel); this
  // ordering is defense-in-depth so stale data can never show "downgrades to X"
  // for a subscription that is actually leaving.
  // (subscriptionCancelAt is only ever written for Stripe subs.)
  if (wallet.subscriptionCancelAt) {
    return {
      plan: "free",
      when: wallet.subscriptionCancelAt,
      reason: "stripe_cancel_pending",
    };
  }
  if (wallet.pendingPlan && wallet.pendingPlanEffective) {
    return {
      plan: wallet.pendingPlan,
      when: wallet.pendingPlanEffective,
      reason: "stripe_downgrade_pending",
    };
  }
  if (wallet.planExpiresAt) {
    const queuedPlan = wallet.planGrantQueue[0]?.plan;
    return {
      plan: (queuedPlan ?? wallet.planBaseline ?? "free") as PlanId,
      when: wallet.planExpiresAt,
      reason: "referral_grant_expires",
    };
  }
  if (wallet.subscriptionSource === "wechat" && wallet.plan !== "free") {
    return { plan: "free", when: wallet.periodEnd, reason: "wechat_no_renewal" };
  }
  return null;
}

function resolveExpiredTimeLimitedPlan(wallet: CreditWallet, now: Date): PlanId {
  const elapsedAfterActiveMs = wallet.planExpiresAt
    ? Math.max(now.getTime() - wallet.planExpiresAt.getTime(), 0)
    : 0;
  let elapsedMs = elapsedAfterActiveMs;

  for (const segment of wallet.planGrantQueue) {
    if (elapsedMs < segment.durationMs) {
      return segment.plan;
    }
    elapsedMs -= segment.durationMs;
  }

  return (wallet.planBaseline ?? "free") as PlanId;
}
