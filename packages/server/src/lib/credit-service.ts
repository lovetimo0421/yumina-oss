// ─── Credit Service ──────────────────────────────────────────────────
// Central service for all credit operations: balance checks, deductions,
// cost calculations, and monthly renewals. All write operations use atomic
// SQL to prevent race conditions.

import { db } from "../db/index.js";
import { creditWallets, creditTransactions, studioCreditReservations, user } from "../db/schema.js";
import { eq, sql, and } from "drizzle-orm";
import { getModelPrice } from "./model-price-cache.js";
import type { PlanId } from "./plan-config.js";
import { PLANS, planMeetsMinimum, normalizePlan, STRIPE_PRICE_TO_PLAN } from "./plan-config.js";
import { insertHashedTransaction, type LedgerDatabase } from "./transaction-hash.js";
import { env } from "./env.js";
import { withTimeout } from "./with-timeout.js";
import { paidRenewalPeriod } from "./paid-renewal.js";
import { adminUpgradeGrantFraction } from "./admin-grant.js";
import { initialGrokTrial } from "./trial-config.js";
import { resolveEffectivePlanWithEventEntitlements } from "./event-plan-entitlements.js";
import { isLegacyReRegistrationFreezeWallet } from "./wallet-initialization.js";
import {
  normalizeProviderCostUsd,
  providerCostUsdToCredits,
} from "./provider-cost.js";

import { bonusCompatibilityEnabled, cyclePlanConfig, expireWalletBonus, prepareWalletSpend, recordSpendAllocation, recordCyclePolicy } from "./free-credit-policy.js";
import { isV2Signup, shouldMigrateToV2 } from "./plan-config-v2.js";
import { hasDropWork, initialDropAmount, releaseDueDrops, settleUndeliveredDrops, startDropCycle } from "./plan-drops.js";
import { getAvailableCredits, heldCreditsForWallet, studioCreditReservationsEnabled } from "./credit-reservations.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface CreditWallet {
  id: string;
  userId: string;
  balance: number;
  addonBalance: number;
  plan: PlanId;
  monthlyCredits: number;
  memoryCap: number | null;
  pendingPlan: PlanId | null;
  pendingPlanEffective: Date | null;
  planExpiresAt: Date | null;
  planBaseline: PlanId | null;
  planGrantQueue: PlanGrantQueueItem[];
  subscriptionSource: "stripe" | "wechat" | "comp" | null;
  subscriptionCancelAt: Date | null; // Stripe sub set to cancel at this time (null = renews)
  lastDailyRecovery: Date | null;
  grokTrialRemaining: number;
  /** 1 = legacy lineup, 2 = 2026-09 lineup (plan-config-v2.ts). */
  planVersion: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface PlanGrantQueueItem {
  plan: PlanId;
  durationMs: number;
}

async function withEffectiveEventPlan(wallet: CreditWallet): Promise<CreditWallet> {
  const effectivePlan = await resolveEffectivePlanWithEventEntitlements(wallet.userId, wallet.plan);
  if (effectivePlan === wallet.plan) return wallet;
  return {
    ...wallet,
    plan: effectivePlan,
    monthlyCredits: PLANS[effectivePlan].monthlyCredits,
    memoryCap: PLANS[effectivePlan].memoryCap,
  };
}

export interface DeductionResult {
  creditsDeducted: number;
  newBalance: number;
  /** Purchased (non-expiring) mushies left after the debit — generation
   * records how much of a charge came from that pile so a refund can put it back. */
  newAddonBalance: number;
  transactionId: string;
}

function normalizePlanGrantQueue(value: unknown): PlanGrantQueueItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { plan?: unknown; durationMs?: unknown };
    const plan = normalizePlan(typeof candidate.plan === "string" ? candidate.plan : null);
    const durationMs = Number(candidate.durationMs);
    if (plan === "free" || !Number.isFinite(durationMs) || durationMs <= 0) return [];
    return [{ plan, durationMs }];
  });
}

type CreditWalletRow = typeof creditWallets.$inferSelect;

function toCreditWallet(row: CreditWalletRow): CreditWallet {
  return {
    id: row.id,
    userId: row.userId,
    balance: row.balance,
    addonBalance: row.addonBalance,
    plan: normalizePlan(row.plan),
    monthlyCredits: row.monthlyCredits,
    memoryCap: row.memoryCap,
    pendingPlan: row.pendingPlan as PlanId | null,
    pendingPlanEffective: row.pendingPlanEffective,
    planExpiresAt: row.planExpiresAt,
    planBaseline: row.planBaseline as PlanId | null,
    planGrantQueue: normalizePlanGrantQueue(row.planGrantQueue),
    subscriptionSource: row.subscriptionSource as "stripe" | "wechat" | "comp" | null,
    subscriptionCancelAt: row.subscriptionCancelAt,
    lastDailyRecovery: row.lastDailyRecovery,
    grokTrialRemaining: row.grokTrialRemaining ?? 0,
    planVersion: row.planVersion ?? 1,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  };
}

async function restoreLegacyReRegistrationFreeze(
  existing: CreditWalletRow,
): Promise<CreditWalletRow> {
  const now = new Date();
  if (!isLegacyReRegistrationFreezeWallet(existing)) return existing;

  const config = await cyclePlanConfig(existing.userId, "free", now, now);
  const oldDeadline = existing.lastDailyRecovery!;
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(creditWallets)
      .set({
        balance: config.monthlyCredits,
        monthlyCredits: config.monthlyCredits,
        memoryCap: config.memoryCap,
        grokTrialRemaining: initialGrokTrial(now),
        lastDailyRecovery: null,
        periodStart: now,
        periodEnd,
        updatedAt: now,
      })
      .where(and(
        eq(creditWallets.id, existing.id),
        eq(creditWallets.userId, existing.userId),
        eq(creditWallets.plan, "free"),
        eq(creditWallets.balance, 0),
        eq(creditWallets.addonBalance, 0),
        eq(creditWallets.lastDailyRecovery, oldDeadline),
        eq(creditWallets.periodEnd, existing.periodEnd),
      ))
      .returning();

    if (!updated) {
      const [current] = await tx
        .select()
        .from(creditWallets)
        .where(eq(creditWallets.id, existing.id))
        .limit(1);
      if (!current) throw new Error("Credit wallet disappeared during default-state restoration");
      return current;
    }

    await recordCyclePolicy(tx, updated.id, now, config.monthlyCredits);
    await insertHashedTransaction({
      walletId: updated.id,
      amount: config.monthlyCredits,
      type: "plan_grant",
      referenceId: `recreated-account-default:${updated.userId}`,
      balanceAfter: updated.balance,
      description: "Restored default Free plan grant after account recreation",
    }, tx);
    return updated;
  });
}

// ─── Ensure Wallet Exists ───────────────────────────────────────────

/** Get or create a credit wallet for the user. */
export async function ensureWallet(userId: string, plan?: PlanId): Promise<CreditWallet> {
  await expireWalletBonus(userId);
  const [existing] = await db
    .select()
    .from(creditWallets)
    .where(eq(creditWallets.userId, userId));

  if (existing) {
    return toCreditWallet(await restoreLegacyReRegistrationFreeze(existing));
  }

  // Account deletion removes the old wallet. If the same person later creates
  // a new account, the new wallet starts from the same defaults as every other
  // new account; ban, referral and same-day check-in controls remain separate.
  const effectivePlan = plan ?? "free";
  const now = new Date();
  // Lineup is fixed at wallet creation: signups at/after BILLING_V2_LAUNCH_AT
  // get the 2026-09 rules; every existing wallet keeps its purchased terms.
  const planVersion = isV2Signup(now) ? 2 : 1;
  const config = await cyclePlanConfig(userId, effectivePlan, now, now, db, planVersion);
  // v2 pays the cycle pile in drops: only drop 0 lands at signup (plan-drops.ts).
  const initialBalance = planVersion === 2 ? initialDropAmount(effectivePlan) : config.monthlyCredits;
  const initialTrialRemaining = initialGrokTrial(now);
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const wallet = await db.transaction(async (tx) => {
  const [wallet] = await tx
    .insert(creditWallets)
    .values({
      userId,
      balance: initialBalance,
      addonBalance: 0,
      plan: effectivePlan,
      monthlyCredits: config.monthlyCredits,
      memoryCap: config.memoryCap,
      grokTrialRemaining: initialTrialRemaining,
      planVersion,
      lastDailyRecovery: null,
      periodStart: now,
      periodEnd,
    })
    .onConflictDoNothing({ target: creditWallets.userId })
    .returning();

  if (wallet) {
    if (effectivePlan === "free" && planVersion === 1) await recordCyclePolicy(tx, wallet.id, now, config.monthlyCredits);
    if (planVersion === 2) await startDropCycle(tx, wallet.id, now);
    if (initialBalance > 0) await insertHashedTransaction({ walletId: wallet.id, amount: initialBalance, type: "plan_grant", balanceAfter: initialBalance, description: planVersion === 2 ? `Initial ${effectivePlan} plan grant (drop 1)` : `Initial ${effectivePlan} plan grant` }, tx);
  }
  return wallet;
  });

  // Handle race: if another request created the wallet between our SELECT and INSERT
  if (!wallet) {
    const [retry] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, userId));
    if (!retry) throw new Error("Failed to create or find credit wallet");
    return toCreditWallet(await restoreLegacyReRegistrationFreeze(retry));
  }


  return {
    id: wallet.id,
    userId,
    balance: initialBalance,
    addonBalance: 0,
    plan: effectivePlan,
    monthlyCredits: config.monthlyCredits,
    memoryCap: config.memoryCap,
    pendingPlan: null,
    pendingPlanEffective: null,
    planExpiresAt: null,
    planBaseline: null,
    planGrantQueue: [],
    subscriptionSource: null,
    subscriptionCancelAt: null,
    lastDailyRecovery: null,
    grokTrialRemaining: initialTrialRemaining,
    planVersion,
    periodStart: now,
    periodEnd,
  };
}

// ─── Balance Check ──────────────────────────────────────────────────

/**
 * Safety check: verify the user has an active paid Stripe subscription before
 * any lazy downgrade. If they do, the downgrade is stale metadata — clear it
 * and skip. Prevents premature revocation when planExpiresAt/pendingPlan/
 * subscriptionSource drift from the true Stripe state.
 */
async function hasActiveStripeSubscription(userId: string): Promise<boolean> {
  if (!env.STRIPE_SECRET_KEY) return false;
  const [row] = await db
    .select({ subId: user.stripeSubscriptionId })
    .from(user)
    .where(eq(user.id, userId));
  if (!row?.subId) return false;
  const stripeKey = env.STRIPE_SECRET_KEY;
  const subId = row.subId;
  // Bound the Stripe call so it can't block the hot balance path (restored from
  // 8fcc6e04, lost in the b49f657a revert). On timeout, fail SAFE: assume the
  // subscription is active so we never wrongly downgrade a paying user.
  const check = (async () => {
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(stripeKey);
      const sub = await stripe.subscriptions.retrieve(subId);
      return sub.status === "active" || sub.status === "past_due" || sub.status === "trialing";
    } catch {
      return false;
    }
  })();
  return withTimeout(check, 3000, () => true);
}

/**
 * For a stripe-source wallet whose period lapsed: the billing period + plan to
 * mint for, or null if the renewal isn't PAID yet (past_due, open invoice,
 * canceled, lookup failure, timeout) or the paid price maps to no known plan.
 * Unlike hasActiveStripeSubscription this fails CLOSED — skipping a mint
 * self-heals on the next message or via the invoice.paid webhook, but credits
 * minted against an unpaid invoice are gone.
 */
async function paidStripeRenewalPeriod(
  userId: string,
): Promise<{ periodStart: Date; periodEnd: Date; plan: PlanId } | null> {
  if (!env.STRIPE_SECRET_KEY) return null;
  const [row] = await db
    .select({ subId: user.stripeSubscriptionId })
    .from(user)
    .where(eq(user.id, userId));
  if (!row?.subId) return null;
  const stripeKey = env.STRIPE_SECRET_KEY;
  const subId = row.subId;
  const check = (async () => {
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(stripeKey);
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
      const paid = paidRenewalPeriod(sub, new Date());
      if (!paid) return null;
      const plan = STRIPE_PRICE_TO_PLAN[paid.priceId];
      if (!plan) return null;
      return { periodStart: paid.periodStart, periodEnd: paid.periodEnd, plan };
    } catch {
      return null;
    }
  })();
  return withTimeout(check, 3000, () => null);
}

/** Check if user has credits remaining. Also triggers lazy period refresh + pending plan enforcement. */
export async function checkBalance(userId: string): Promise<{
  ok: boolean;
  balance: number;
  wallet: CreditWallet;
}> {
  let wallet = await ensureWallet(userId);
  // Billing lineup v2: pay any scheduled drop whose day has arrived before
  // judging the balance (no-op for v1 wallets). hasDropWork keeps the common
  // case lock-free — releaseDueDrops locks the wallet row and this runs on
  // every generation.
  if (await hasDropWork(wallet) && (await releaseDueDrops(userId)).length > 0) wallet = await ensureWallet(userId);

  // Lazy time-limited plan expiration. Event/admin plan grants may have a
  // queued lower tier behind the current higher tier, so activate the next
  // segment before falling back to the baseline plan.
  const now = new Date();
  if (wallet.planExpiresAt && now >= wallet.planExpiresAt) {
    const queue = normalizePlanGrantQueue(wallet.planGrantQueue);
    let elapsedMs = Math.max(now.getTime() - wallet.planExpiresAt.getTime(), 0);
    while (queue[0] && elapsedMs >= queue[0].durationMs) {
      elapsedMs -= queue.shift()!.durationMs;
    }
    const [nextSegment, ...remainingQueue] = queue;

    if (nextSegment) {
      const expiresAt = new Date(now.getTime() + Math.max(nextSegment.durationMs - elapsedMs, 1));
      const baseline = wallet.planBaseline ?? "free";
      console.log(`[Credit] Time-limited plan segment expired for ${userId}, activating queued ${nextSegment.plan}`);
      wallet = await syncPlan(userId, nextSegment.plan, { additive: true });
      await db
        .update(creditWallets)
        .set({
          planExpiresAt: expiresAt,
          planBaseline: baseline,
          planGrantQueue: remainingQueue,
          updatedAt: new Date(),
        })
        .where(eq(creditWallets.userId, userId));
      wallet = await ensureWallet(userId);
    } else {
      const baseline = wallet.planBaseline ?? "free";
      // Guard: don't revert a paying subscriber to free because of stale planExpiresAt
      if (baseline === "free" && wallet.subscriptionSource === "stripe" && await hasActiveStripeSubscription(userId)) {
        console.log(`[Credit] Time-limited plan expired for ${userId} but active Stripe sub exists — clearing stale expiry, keeping ${wallet.plan}`);
        await db
          .update(creditWallets)
          .set({ planExpiresAt: null, planBaseline: null, planGrantQueue: [], updatedAt: new Date() })
          .where(eq(creditWallets.userId, userId));
        wallet = await ensureWallet(userId);
      } else {
        console.log(`[Credit] Time-limited plan expired for ${userId}, reverting to ${baseline}`);
        await db
          .update(creditWallets)
          .set({ planExpiresAt: null, planBaseline: null, planGrantQueue: [], updatedAt: new Date() })
          .where(eq(creditWallets.userId, userId));
        wallet = await syncPlan(userId, baseline as PlanId);
      }
    }
  }

  const accessWallet = await withEffectiveEventPlan(wallet);
  const planConfig = PLANS[accessWallet.plan];

  // Lazy pending plan enforcement: if period expired and a downgrade is pending, apply it now.
  // This catches cases where the Stripe webhook was missed or delayed.
  if (wallet.pendingPlan && wallet.pendingPlanEffective && new Date() >= wallet.pendingPlanEffective) {
    // Guard: don't apply a pending downgrade to free if the user still has an active sub
    if (wallet.pendingPlan === "free" && await hasActiveStripeSubscription(userId)) {
      console.log(`[Credit] Pending free downgrade for ${userId} but active Stripe sub exists — clearing stale pendingPlan`);
      await clearPendingPlan(userId);
      wallet = await ensureWallet(userId);
    } else {
      console.log(`[Credit] Lazy enforcement: applying pending ${wallet.pendingPlan} for ${userId}`);
      wallet = await applyPendingPlan(userId, wallet.pendingPlan);
    }
  }

  // Lazy WeChat subscription expiry: if period ended and no renewal payment came in, downgrade.
  // Stripe subscriptions auto-renew via webhook, but WeChat requires user-initiated re-payment.
  // A still-running time-limited grant defers this: the planExpiresAt machinery
  // above reverts to the baseline first, and the next check applies WeChat
  // expiry to the baseline plan — downgrading mid-grant would erase the grant.
  if (
    wallet.subscriptionSource === "wechat" && wallet.plan !== "free" && new Date() >= wallet.periodEnd
    && !(wallet.planExpiresAt && wallet.planExpiresAt > new Date())
  ) {
    // Guard: if the user switched from WeChat to card, subscriptionSource may be stale
    if (await hasActiveStripeSubscription(userId)) {
      console.log(`[Credit] WeChat period expired for ${userId} but active Stripe sub exists — switching source to stripe`);
      await db
        .update(creditWallets)
        .set({ subscriptionSource: "stripe", updatedAt: new Date() })
        .where(eq(creditWallets.userId, userId));
      wallet = await ensureWallet(userId);
    } else {
      console.log(`[Credit] WeChat subscription expired for ${userId}, downgrading to free`);
      await db
        .update(creditWallets)
        .set({ subscriptionSource: null, updatedAt: new Date() })
        .where(eq(creditWallets.userId, userId));
      wallet = await syncPlan(userId, "free");
      const effectiveWallet = await withEffectiveEventPlan(wallet);
      const balance = studioCreditReservationsEnabled() ? (await getAvailableCredits(userId)).availableCredits : effectiveWallet.balance;
      return { ok: balance > 0, balance, wallet: effectiveWallet };
    }
  }

  // Unlimited plans (internal) always pass
  if (planConfig.unlimited) {
    return { ok: true, balance: accessWallet.balance, wallet: accessWallet };
  }

  // Lazy monthly refresh for credit-based plans (skip for WeChat — they don't
  // auto-renew). Card (stripe-source) renewals are billing-driven: mint ONLY
  // once Stripe confirms the cycle invoice is PAID, anchored to the real
  // billing period. A past_due renewal keeps its remaining balance but mints
  // nothing — invoice.paid grants when the retry succeeds and
  // customer.subscription.deleted downgrades when Stripe gives up. Before this
  // gate, a failed renewal charge still minted a full month for $0
  // (2026-07-19 @dekadesoummer8 report).
  //
  // The PAID plan must also match wallet.plan: a time-limited admin/comp/event
  // tier layered over a cheaper sub (wallet.plan=ultra, paying for go) must
  // not have ultra credits minted against a $5 invoice — and passing options
  // here clears planExpiresAt, which would make the comp permanent. On
  // mismatch, mint nothing: the planExpiresAt machinery reverts to the
  // baseline plan and the next lazy pass mints the paid tier.
  if (wallet.subscriptionSource === "stripe") {
    if (new Date() >= wallet.periodEnd) {
      const paid = await paidStripeRenewalPeriod(userId);
      if (paid && paid.plan === wallet.plan) {
        await refreshMonthlyCredits(userId, { periodStart: paid.periodStart, periodEnd: paid.periodEnd });
      }
    }
  } else if (wallet.subscriptionSource !== "wechat") {
    await refreshMonthlyCredits(userId);
  }

  const refreshed = await ensureWallet(userId);
  const effectiveWallet = await withEffectiveEventPlan(refreshed);
  const balance = studioCreditReservationsEnabled() ? (await getAvailableCredits(userId)).availableCredits : effectiveWallet.balance;
  return { ok: balance > 0, balance, wallet: effectiveWallet };
}

// ─── Model Access Validation ────────────────────────────────────────

/** Check if the user's plan allows access to the requested model. */
export async function validateModelAccess(
  plan: PlanId,
  modelId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const price = await getModelPrice(modelId);
  if (!price) {
    return {
      allowed: false,
      reason: `Model "${modelId}" is not available on the official API.`,
    };
  }
  if (!planMeetsMinimum(plan, price.minPlan as PlanId)) {
    const planNames: Record<string, string> = {
      free: "Free", go: "Gold", plus: "Platinum", pro: "Diamond", ultra: "Ascendant",
    };
    return {
      allowed: false,
      reason: `${modelId} requires the ${planNames[price.minPlan] ?? price.minPlan} plan or higher. Upgrade to unlock this model.`,
    };
  }
  return { allowed: true };
}

// ─── Cost Estimation (for mid-stream tracking) ─────────────────────

export interface ModelCostRates {
  inputPricePerM: number;
  outputPricePerM: number;
}

/**
 * Pre-load model pricing for use during streaming. Call ONCE before the stream
 * starts, then use the returned rates for local cost estimation (zero DB queries).
 */
export async function getModelCostRates(
  modelId: string,
  estimatedPromptTokens: number,
): Promise<ModelCostRates> {
  const price = await getModelPrice(modelId);
  if (!price) {
    // Fallback: Sonnet-level pricing (conservative)
    return { inputPricePerM: 3.0, outputPricePerM: 15.0 };
  }
  let inputPrice = price.inputPricePerM;
  let outputPrice = price.outputPricePerM;
  if (price.contextThreshold && estimatedPromptTokens > price.contextThreshold) {
    inputPrice = price.inputPriceAboveThreshold ?? inputPrice;
    outputPrice = price.outputPriceAboveThreshold ?? outputPrice;
  }
  // Apply markup multiplier (premium models charge above raw upstream)
  const m = price.markupMultiplier ?? 1.0;
  return { inputPricePerM: inputPrice * m, outputPricePerM: outputPrice * m };
}

/**
 * Conservative token-per-character ratio for cost estimation.
 * Used only when the done chunk is unavailable (abort, cancel, error).
 * Normal completions always use exact token counts from the provider.
 *
 * 2.0 chars/token is deliberately conservative:
 * - CJK text: ~1.5-2 chars/token → estimation is roughly accurate
 * - English text: ~4 chars/token → we over-estimate by ~2x
 *
 * Over-estimating is intentional: we'd rather charge slightly more on
 * rare aborts than under-charge and lose money. The 2.5x margin on
 * credit purchases means even a 2x over-estimate on aborts still
 * leaves positive margin.
 */
const CONSERVATIVE_CHARS_PER_TOKEN = 2.0;

/** Estimate token count from character count (conservative — never under-counts). */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CONSERVATIVE_CHARS_PER_TOKEN);
}

/** Estimate credits from character counts. Used for mid-stream tracking and abort fallback. */
export function estimateCreditsFromChars(
  rates: ModelCostRates,
  promptChars: number,
  outputChars: number,
): number {
  const estimatedPromptTokens = estimateTokensFromChars(promptChars);
  const estimatedOutputTokens = estimateTokensFromChars(outputChars);
  const costDollars = (estimatedPromptTokens * rates.inputPricePerM + estimatedOutputTokens * rates.outputPricePerM) / 1_000_000;
  return Math.ceil(costDollars * 1000 * 10) / 10;
}

// ─── Cost Calculation ───────────────────────────────────────────────

/**
 * Calculate the credit cost for a generation based on actual token counts.
 * When OpenRouter reports the amount actually charged for the generation, that
 * amount is authoritative for every official model. Token-rate calculation is
 * retained as a fallback for historical records and providers that omit it.
 * Handles tiered pricing (e.g., Grok models charge 2x above context threshold).
 * Returns credits rounded up to 1 decimal place.
 */
export async function calculateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  opts?: {
    skipMarkup?: boolean;
    /** Actual USD-denominated account charge returned as OpenRouter `usage.cost`. */
    providerCostUsd?: number;
  },
): Promise<number> {
  const price = await getModelPrice(modelId);
  const providerCostUsd = normalizeProviderCostUsd(opts?.providerCostUsd);
  if (providerCostUsd !== undefined) {
    const markup = opts?.skipMarkup ? 1.0 : (price?.markupMultiplier ?? 1.0);
    return providerCostUsdToCredits(providerCostUsd, markup);
  }

  if (!price) {
    // Unknown model — estimate conservatively using Sonnet-level pricing
    console.warn(`[Credit] No pricing found for model: ${modelId}, using fallback`);
    const fallbackCost = (promptTokens * 3.0 + completionTokens * 15.0) / 1_000_000;
    return Math.ceil(fallbackCost * 1000 * 10) / 10;
  }

  let inputPrice = price.inputPricePerM;
  let outputPrice = price.outputPricePerM;

  if (price.contextThreshold && promptTokens > price.contextThreshold) {
    inputPrice = price.inputPriceAboveThreshold ?? inputPrice;
    outputPrice = price.outputPriceAboveThreshold ?? outputPrice;
  }

  const rawCostDollars = (promptTokens * inputPrice + completionTokens * outputPrice) / 1_000_000;
  const markup = opts?.skipMarkup ? 1.0 : (price.markupMultiplier ?? 1.0);
  return providerCostUsdToCredits(rawCostDollars, markup);
}

// ─── Credit Deduction ───────────────────────────────────────────────

/**
 * Atomically deduct credits from the user's wallet.
 *
 * A wallet row lock serializes the available-balance check, funding allocation,
 * guarded debit and ledger append, including active Studio reservations.
 *
 * @throws Error with message "INSUFFICIENT_CREDITS" if unreserved funds are insufficient.
 */
export async function deductCredits(
  userId: string,
  credits: number,
  referenceId: string,
  description: string,
  database: LedgerDatabase = db,
  transactionType: "usage" | "admin" = "usage",
): Promise<DeductionResult> {
  if (!Number.isFinite(credits)) throw new Error("INVALID_CREDIT_AMOUNT");
  if (credits <= 0) {
    // No-op deduction (e.g. free model). Return the current balance, NOT 0
    // — callers thread newBalance into the SSE done event, and a fake 0 here
    // makes the UI think the user is out of credits until they refresh.
    // A resumed zero-cost step may already hold the wallet/world transaction.
    // Do not escape to the global client (which can deadlock PGlite and bypass
    // the caller's snapshot). The outer flow already ensured this wallet.
    const wallet = database === db ? await ensureWallet(userId)
      : (await database.select().from(creditWallets).where(eq(creditWallets.userId, userId)))[0];
    if (!wallet) throw new Error("INSUFFICIENT_CREDITS");
    return { creditsDeducted: 0, newBalance: wallet.balance, newAddonBalance: wallet.addonBalance, transactionId: "" };
  }

  // Atomic deduction: single UPDATE statement prevents race conditions.
  // Deducts from subscription mushies first, then addon mushies.
  // addonBalance = LEAST(addonBalance, GREATEST(balance - cost, 0))
  //   → if balance dips below addonBalance, addon is consumed too
  // The wallet row lock serializes deductions, and the ledger append belongs
  // to the SAME transaction. A failed audit write must roll back the debit.
  return database.transaction(async (tx) => {
    if (bonusCompatibilityEnabled()) await expireWalletBonus(userId, tx);
    const [locked] = await tx.select().from(creditWallets).where(eq(creditWallets.userId,userId)).for("update");
    if (!locked) throw new Error("INSUFFICIENT_CREDITS");
    const [prior] = await tx.select().from(creditTransactions).where(and(eq(creditTransactions.walletId,locked.id),eq(creditTransactions.referenceId,referenceId),eq(creditTransactions.type,transactionType))).limit(1);
    if (prior) return { creditsDeducted: -prior.amount, newBalance: locked.balance, newAddonBalance: locked.addonBalance, transactionId: prior.id };
    const held = studioCreditReservationsEnabled() ? await heldCreditsForWallet(locked.id, tx) : 0;
    if (locked.balance - held < credits) throw Object.assign(new Error("INSUFFICIENT_CREDITS"), {
      userId, credits, referenceId, balance: Math.max(0, locked.balance - held),
    });
    const allocation = bonusCompatibilityEnabled() ? await prepareWalletSpend(tx, userId, credits, new Date(), held) : null;
    const [updated] = await tx
      .update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} - ${credits}`,
        addonBalance: allocation ? sql`GREATEST(0, ${creditWallets.addonBalance} - ${allocation.addonSpent})` : sql`LEAST(${creditWallets.addonBalance}, GREATEST(${creditWallets.balance} - ${credits}, 0))`,
        updatedAt: new Date(),
      })
      .where(
        sql`${creditWallets.userId} = ${userId} AND ${creditWallets.balance} >= ${credits + held}`
      )
      .returning();

    if (!updated) {
      const [wallet] = await tx.select({ balance: creditWallets.balance })
        .from(creditWallets).where(eq(creditWallets.userId, userId));
      throw Object.assign(new Error("INSUFFICIENT_CREDITS"), {
        userId,
        credits,
        referenceId,
        balance: wallet?.balance ?? 0,
      });
    }

    // Append to ledger (hash-chained). This is the audit trail — not fire-and-forget.
    const txn = await insertHashedTransaction({
      walletId: updated.id,
      amount: -credits,
      type: transactionType,
      referenceId,
      balanceAfter: updated.balance,
      description,
    }, tx);

    if (allocation) await recordSpendAllocation(tx, txn.id, updated.id, allocation.allocations);
    return {
      creditsDeducted: credits,
      newBalance: updated.balance,
      newAddonBalance: updated.addonBalance,
      transactionId: txn.id,
    };
  });
}

export async function refundCredits(
  userId: string,
  credits: number,
  referenceId: string,
  description: string,
  /**
   * Join a caller's transaction instead of opening one. Callers that flip an
   * at-most-once guard (e.g. generation's `refunded` flag) must pass their tx
   * so the guard and the payout commit or roll back together.
   */
  database: LedgerDatabase = db,
  addonCredits = 0,
): Promise<void> {
  if (credits <= 0) return;
  // A drizzle transaction carries rollback(); a database handle does not.
  const isTransaction = (handle: LedgerDatabase): handle is Exclude<LedgerDatabase, typeof db> =>
    typeof (handle as { rollback?: unknown }).rollback === "function";
  // Credit and ledger append in one transaction, for the same reason as
  // deductCredits: a half-applied refund is invisible to every audit path.
  const run = async (tx: LedgerDatabase) => {
    const [updated] = await tx
      .update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} + ${credits}`,
        addonBalance: sql`${creditWallets.addonBalance} + ${Math.min(credits, Math.max(0, addonCredits))}`,
        updatedAt: new Date(),
      })
      .where(sql`${creditWallets.userId} = ${userId}`)
      .returning();
    if (!updated) return; // wallet gone (account deletion) — nothing to refund

    await insertHashedTransaction({
      walletId: updated.id,
      amount: credits,
      type: "refund",
      referenceId,
      balanceAfter: updated.balance,
      description,
    }, tx);
  };
  // Already inside a caller's transaction — reuse it rather than nesting.
  if (isTransaction(database)) return run(database);
  await database.transaction(run);
}

/** Settle once by the usage reference fixed before generation. Removing this
 * hold and debiting actual cost share the wallet lock and transaction. Failure
 * rolls everything back so the generated turn can be retained and resumed. */
export async function settleStudioCreditReservation(
  userId: string,
  reservationId: string,
  actualCredits: number,
  referenceId: string,
  description: string,
  database: LedgerDatabase = db,
): Promise<DeductionResult> {
  if (!Number.isFinite(actualCredits) || actualCredits < 0) throw new Error("INVALID_CREDIT_AMOUNT");
  return database.transaction(async (tx) => {
    await expireWalletBonus(userId, tx);
    const [wallet] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, userId)).for("update");
    if (!wallet) throw new Error("INSUFFICIENT_CREDITS");
    const [reservation] = await tx.select().from(studioCreditReservations).where(and(
      eq(studioCreditReservations.id, reservationId), eq(studioCreditReservations.walletId, wallet.id),
    ));
    if (!reservation || reservation.referenceId !== referenceId) throw new Error("CREDIT_RESERVATION_MISMATCH");
    if (reservation.status === "settled") return {
      creditsDeducted: reservation.settledCredits ?? 0,
      newBalance: wallet.balance,
      newAddonBalance: wallet.addonBalance,
      transactionId: reservation.transactionId ?? "",
    };
    // Resume can settle an expired/released hold if funds are now available;
    // other active holds still belong to their original requests.
    await tx.update(studioCreditReservations).set({ status: "settled", updatedAt: new Date() })
      .where(eq(studioCreditReservations.id, reservationId));
    const [prior] = await tx.select().from(creditTransactions).where(and(
      eq(creditTransactions.walletId, wallet.id), eq(creditTransactions.referenceId, referenceId), eq(creditTransactions.type, "usage"),
    )).limit(1);
    const held = await heldCreditsForWallet(wallet.id, tx);
    if (!prior && actualCredits > 0 && wallet.balance - held < actualCredits) throw Object.assign(new Error("INSUFFICIENT_CREDITS"), {
      balance: Math.max(0, wallet.balance - held), credits: actualCredits, referenceId,
    });
    const result = prior
      ? { creditsDeducted: -prior.amount, newBalance: wallet.balance, newAddonBalance: wallet.addonBalance, transactionId: prior.id }
      : actualCredits === 0
        ? { creditsDeducted: 0, newBalance: wallet.balance, newAddonBalance: wallet.addonBalance, transactionId: "" }
        : await deductCredits(userId, actualCredits, referenceId, description, tx);
    await tx.update(studioCreditReservations).set({
      settledCredits: result.creditsDeducted, transactionId: result.transactionId || null, updatedAt: new Date(),
    }).where(eq(studioCreditReservations.id, reservationId));
    return result;
  });
}

// ─── Monthly Credit Refresh ─────────────────────────────────────────

/**
 * Ledger row for the unused MONTHLY mushies a reset discards: everything above
 * the addon bucket (saved + bonus, which a reset keeps). Call inside the reset
 * transaction, under the wallet lock, BEFORE the grant row, with the balances
 * read off the locked row. No-op when nothing is left to expire.
 */
async function recordMonthlyExpiry(
  tx: LedgerDatabase,
  walletId: string,
  balanceBefore: number,
  addonBalance: number,
  description: string,
  referenceId: string | null,
): Promise<number> {
  const expired = Math.max(0, balanceBefore - Math.max(0, addonBalance));
  if (expired <= 0.005) return 0;
  await insertHashedTransaction({
    walletId,
    amount: -expired,
    type: "monthly_expiry",
    referenceId,
    balanceAfter: balanceBefore - expired,
    description,
  }, tx);
  return expired;
}

/**
 * Lazy monthly credit renewal. Called before each balance check.
 * If the current period has expired, resets balance to monthly grant.
 * Credits do NOT roll over — expired balance is replaced, not added to.
 */
export async function refreshMonthlyCredits(
  userId: string,
  options?: { periodStart?: Date; periodEnd?: Date },
): Promise<boolean> {
  const wallet = await ensureWallet(userId);
  const now = new Date();

  // When called from invoice.paid webhook, always refresh (Stripe says it's time).
  // When called lazily (no options), only refresh if period expired.
  if (!options && now < wallet.periodEnd) return false;

  const anchoredStart = new Date(wallet.periodEnd.getTime() + Math.floor((now.getTime()-wallet.periodEnd.getTime())/(30*86400000))*30*86400000);
  const newPeriodStart = options?.periodStart ?? (bonusCompatibilityEnabled() ? anchoredStart : now);
  const newPeriodEnd = options?.periodEnd ?? new Date(newPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Every wallet not on a real Stripe subscription joins the version-2 lineup at
  // this boundary once BILLING_V2_EXISTING_AT has passed (owner 2026-09-16).
  const planVersion = shouldMigrateToV2(wallet, now) ? 2 : wallet.planVersion;
  const config = await cyclePlanConfig(userId, wallet.plan, newPeriodStart, now, db, planVersion);
  // v2 renewals pay drop 0 now; the later drops (days 7/14/21 on the current
  // schedule) follow via releaseDueDrops.
  const renewalGrant = planVersion === 2 ? initialDropAmount(wallet.plan) : config.monthlyCredits;
  return db.transaction(async (tx) => {
  const [locked] = await tx.select().from(creditWallets).where(eq(creditWallets.id,wallet.id)).for("update");
  if (!locked || locked.plan !== wallet.plan || (!options && locked.periodEnd.getTime() !== wallet.periodEnd.getTime())) return false;
  // Reset subscription mushies + preserve addon mushies.
  // balance = monthlyCredits + addonBalance (addon never expires)
  // When called from a webhook (with options), also clear stale planExpiresAt/
  // planBaseline — an active subscription renewal supersedes any prior
  // time-limited grant. Without this, a stale planExpiresAt can fire in
  // checkBalance and revert a paying subscriber to free.
  // Lazy calls (no options) repeat the period-expiry check in the WHERE so two
  // concurrent requests at the period boundary can't both reset — the JS check
  // above races; only the UPDATE is atomic.
  const [updated] = await tx
    .update(creditWallets)
    .set({
      balance: sql`${renewalGrant} + ${creditWallets.addonBalance}`,
      monthlyCredits: config.monthlyCredits,
      planVersion,
      periodStart: newPeriodStart,
      periodEnd: newPeriodEnd,
      ...(options && { planExpiresAt: null, planBaseline: null, planGrantQueue: [] }),
      updatedAt: now,
    })
    .where(
      options
        ? eq(creditWallets.userId, userId)
        : sql`${creditWallets.userId} = ${userId} AND ${creditWallets.periodEnd} <= ${now}`,
    )
    .returning();

  // Lost the boundary race — another request already renewed. No-op: don't log
  // a second plan_grant for the same period.
  if (!updated) return false;

  // Every mushie movement is a ledger row (owner mandate 2026-09-19). The unused
  // monthly mushies this reset discards are written down BEFORE the grant, so
  // the chain reads old → −expired → addon → +grant → new and a user can see
  // where the leftover went. Addon (saved/bonus) mushies are never touched here.
  // Before this row existed, renewals were the one place the ledger broke:
  // ~194k mushies a week vanished between "+2,000" rows.
  await recordMonthlyExpiry(tx, wallet.id, locked.balance, locked.addonBalance, "Unused monthly mushies expired at renewal", null);

  // Log the grant (hash-chained). balanceAfter must be the REAL post-reset
  // balance (monthly + addon) — logging bare monthlyCredits made the ledger
  // disagree with the wallet whenever the user held addon mushies.
  if (wallet.plan === "free" && planVersion === 1) await recordCyclePolicy(tx, wallet.id, newPeriodStart, config.monthlyCredits);
  if (planVersion === 2) await startDropCycle(tx, wallet.id, newPeriodStart);
  await insertHashedTransaction({
    walletId: wallet.id,
    amount: renewalGrant,
    type: "plan_grant",
    balanceAfter: updated.balance,
    description: planVersion === 2
      ? `Monthly ${wallet.plan} plan renewal (drop 1)${wallet.planVersion === 1 ? " — moved to the 2026-09 lineup" : ""}`
      : `Monthly ${wallet.plan} plan renewal`,
  }, tx);

  return true;
  });
}

// ─── Plan Sync ──────────────────────────────────────────────────────

/**
 * Single function for all plan changes.
 *
 * - additive: false (default) → RESET balance to new plan's monthly + addon.
 *   Used for: first subscribe, renewal, cancellation to free.
 *
 * - additive: true → ADD new plan's monthly credits to existing balance.
 *   Used for: mid-cycle upgrades (user keeps what they had + the new grant).
 *
 * - grantFraction (additive only, default 1): scales the granted amount.
 *   Card upgrades via the Stripe portal pay a PRORATED price, so they pass
 *   the remaining-cycle fraction here; full-price paths (WeChat, checkout,
 *   admin/comp, event grants) omit it and grant the full monthly amount.
 *   The wallet's monthlyCredits column always stores the full plan value.
 */
export async function syncPlan(
  userId: string,
  newPlan: PlanId,
  options?: { additive?: boolean; grantFraction?: number; periodStart?: Date; periodEnd?: Date; referenceId?: string;
    /** The billing source the caller is about to record (the WeChat path sets it after this call). */
    source?: "wechat" | "stripe" | "comp";
    /**
     * A paid upgrade that RESTARTS the billing cycle (in-app plan change, owner
     * 2026-09-17): the user paid a full month of `newPlan` today, keeps every
     * mushie held, and the wallet period becomes the new Stripe period passed
     * in periodStart/periodEnd. Additive only; the grant is never prorated. On a
     * version-2 wallet the drops of the plan being left that have not landed
     * yet are paid out first (settleUndeliveredDrops) — they were bought with
     * the previous month's price and the cycle restart would otherwise drop them.
     */
    cycleReset?: boolean },
): Promise<CreditWallet> {
  const wallet = await ensureWallet(userId);
  const now = new Date();
  const additive = options?.additive ?? false;
  const cycleReset = additive && options?.cycleReset === true;
  if (cycleReset && (!options?.periodStart || !options?.periodEnd)) {
    throw new Error("syncPlan: cycleReset requires the new billing period");
  }
  // Wallets not on a real Stripe subscription join the version-2 lineup when a new
  // cycle starts for them here: a downgrade or expiry to free, or a WeChat purchase
  // (that path grants additively but passes source: "wechat"). Prorated Stripe
  // upgrades, admin flips and entitlement segments never migrate (owner 2026-09-16).
  const migrate = (!additive || options?.source === "wechat")
    && shouldMigrateToV2({ planVersion: wallet.planVersion, plan: newPlan, subscriptionSource: options?.source ?? wallet.subscriptionSource }, now);
  const planVersion = migrate ? 2 : wallet.planVersion;
  const config = await cyclePlanConfig(userId, newPlan, options?.periodStart ?? now, now, db, planVersion);
  const isV2 = planVersion === 2;
  // v2: the grant at purchase/renewal/upgrade is drop 0 of the new plan; later
  // drops of the new cycle follow through releaseDueDrops.
  const cycleGrant = isV2 ? initialDropAmount(newPlan) : config.monthlyCredits;
  // Clamp to [0,1]; a non-finite fraction (NaN/Infinity from a future caller)
  // falls back to a full grant so a paying upgrader is never shortchanged. A
  // cycle-reset upgrade paid a full month, so it is never prorated.
  const rawFraction = options?.grantFraction ?? 1;
  const grantFraction = additive && !cycleReset && Number.isFinite(rawFraction)
    ? Math.min(Math.max(rawFraction, 0), 1)
    : 1;
  const grantAmount = Math.round(cycleGrant * grantFraction);
  const periodStart = options?.periodStart ?? now;
  const periodEnd = options?.periodEnd ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
  const [locked] = await tx.select().from(creditWallets).where(eq(creditWallets.id, wallet.id)).for("update");
  if (!locked) throw new Error(`syncPlan: wallet ${wallet.id} disappeared`);
  // Idempotency: if a referenceId is given (typically session.id from a webhook)
  // and we already booked a plan_grant against it for this wallet, skip.
  if (options?.referenceId) {
    const [existing] = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.walletId, wallet.id),
          eq(creditTransactions.referenceId, options.referenceId),
        ),
      )
      .limit(1);
    if (existing) {
      return wallet; // Already processed
    }
  }

  if (cycleReset) {
    // The grant was sized from the pre-lock snapshot; a wallet that changed
    // plan or lineup in between (a concurrent renewal or migration) must not
    // be settled against stale numbers — the caller retries.
    if ((locked.planVersion ?? 1) !== wallet.planVersion || normalizePlan(locked.plan) !== wallet.plan) {
      throw new Error("syncPlan: wallet changed during the upgrade; retry");
    }
    await settleUndeliveredDrops(tx, {
      id: locked.id,
      plan: locked.plan,
      planVersion: locked.planVersion ?? 1,
      periodStart: locked.periodStart,
      balance: locked.balance,
    }, now);
  }

  // A reset discards the unused monthly mushies; write them down before the
  // grant so the ledger explains the whole move (see refreshMonthlyCredits).
  if (!additive) {
    await recordMonthlyExpiry(
      tx,
      wallet.id,
      locked.balance,
      locked.addonBalance,
      newPlan === "free" ? "Unused monthly mushies expired when the plan ended" : "Unused monthly mushies expired at plan change",
      options?.referenceId ? `${options.referenceId}:expiry` : null,
    );
  }

  const balanceExpr = additive
    ? sql`${creditWallets.balance} + ${grantAmount}`
    : sql`${cycleGrant} + ${creditWallets.addonBalance}`;

  const [updated] = await tx
    .update(creditWallets)
    .set({
      plan: newPlan,
      monthlyCredits: config.monthlyCredits,
      planVersion,
      memoryCap: config.memoryCap,
      balance: balanceExpr,
      pendingPlan: null,
      pendingPlanEffective: null,
      planExpiresAt: null,
      planBaseline: null,
      planGrantQueue: [],
      periodStart,
      periodEnd,
      updatedAt: now,
    })
    .where(eq(creditWallets.userId, userId))
    .returning();

  if (newPlan === "free" && !isV2) await recordCyclePolicy(tx, wallet.id, periodStart, config.monthlyCredits);
  // Drop ledger: a fresh cycle (purchase, renewal, cycle-reset upgrade, WeChat
  // re-buy) starts at drop 0. A legacy additive change that keeps the period
  // (a price change made in the Stripe dashboard) leaves the released count
  // alone, so the cycle's remaining drops are not re-armed at the new plan's
  // size — that re-arm paid a day-25 upgrader half the new pile for pennies.
  const periodChanged = locked.periodStart.getTime() !== periodStart.getTime();
  if (isV2 && (!additive || cycleReset || periodChanged)) await startDropCycle(tx, wallet.id, periodStart);
  const description = additive
    ? `Upgrade to ${newPlan} — +${grantAmount} mushies${cycleReset ? " (new billing cycle)" : grantFraction < 1 ? " (prorated for remaining cycle)" : ""}${isV2 ? " (drop 1)" : ""}`
    : isV2 ? `${newPlan} plan — ${cycleGrant} of ${config.monthlyCredits} monthly mushies (drop 1)${migrate ? " — moved to the 2026-09 lineup" : ""}` : `${newPlan} plan — ${config.monthlyCredits} monthly mushies`;

  // A zero-amount additive grant (delta-only admin flip to the same or a lower
  // tier) changes no balance — skip the ledger row rather than logging "+0".
  if (!additive || grantAmount !== 0) {
    await insertHashedTransaction({
      walletId: wallet.id,
      amount: additive ? grantAmount : cycleGrant,
      type: "plan_grant",
      balanceAfter: updated!.balance,
      description,
      referenceId: options?.referenceId ?? null,
    }, tx);
  }

  return {
    id: updated!.id,
    userId,
    balance: updated!.balance,
    addonBalance: updated!.addonBalance,
    plan: newPlan,
    monthlyCredits: config.monthlyCredits,
    memoryCap: config.memoryCap,
    pendingPlan: null,
    pendingPlanEffective: null,
    planExpiresAt: null,
    planBaseline: null,
    planGrantQueue: [],
    subscriptionSource: updated!.subscriptionSource as "stripe" | "wechat" | "comp" | null,
    subscriptionCancelAt: updated!.subscriptionCancelAt,
    lastDailyRecovery: updated!.lastDailyRecovery,
    grokTrialRemaining: updated!.grokTrialRemaining,
    planVersion: updated!.planVersion ?? 1,
    periodStart,
    periodEnd,
  };
  });
}

// ─── Pending Plan Management ────────────────────────────────────────

/** Schedule a deferred plan change (downgrade). Benefits stay until periodEnd. */
export async function setPendingPlan(
  userId: string,
  pendingPlan: PlanId,
  effectiveDate: Date,
): Promise<void> {
  if (!(pendingPlan in PLANS)) {
    throw new Error(`Invalid pendingPlan: ${pendingPlan}`);
  }
  await db
    .update(creditWallets)
    .set({ pendingPlan, pendingPlanEffective: effectiveDate, updatedAt: new Date() })
    .where(eq(creditWallets.userId, userId));
}

/** Set how recurring billing is managed for this user. */
export async function setSubscriptionSource(userId: string, source: "stripe" | "wechat" | "comp" | null): Promise<void> {
  await db
    .update(creditWallets)
    .set({ subscriptionSource: source, updatedAt: new Date() })
    .where(eq(creditWallets.userId, userId));
}

/**
 * Record (or clear) a Stripe cancel-at-period-end. Pass the cancel date to mark
 * the subscription as ending; pass null when it will renew (reactivation or a
 * fresh/active subscription). Drives the "cancels on X" display in admin + UI.
 */
export async function setSubscriptionCancelAt(userId: string, cancelAt: Date | null): Promise<void> {
  await db
    .update(creditWallets)
    .set({ subscriptionCancelAt: cancelAt, updatedAt: new Date() })
    .where(eq(creditWallets.userId, userId));
}

/**
 * Whether a Stripe subscription is actively auto-charging and should be stopped
 * when we start sponsoring (comping) the user. Only card subscriptions
 * (`charge_automatically`) recur without user action; WeChat (`send_invoice`)
 * is a one-time payment per cycle and never auto-charges, so it's left alone.
 * A sub already set to cancel needs no change.
 */
export function shouldStopAutoBilling(sub: {
  status: string;
  collection_method: string;
  cancel_at_period_end: boolean;
}): boolean {
  const active = sub.status === "active" || sub.status === "past_due" || sub.status === "trialing";
  return active && sub.collection_method === "charge_automatically" && !sub.cancel_at_period_end;
}

/**
 * Stop auto-billing for a user we're now sponsoring via an admin comp. Sets any
 * active card subscription to cancel at period end — the user keeps whatever
 * they already paid for through the current period but is never charged again,
 * so a free comp never coexists with a live charge. WeChat subs are untouched
 * (they don't auto-charge). Reversible: an admin can reactivate in Stripe.
 * Non-fatal — logs and returns null on any error so it never blocks the grant.
 */
export async function stopAutoBillingForUser(
  userId: string,
): Promise<{ subId: string; cancelAt: Date } | null> {
  if (!env.STRIPE_SECRET_KEY) return null;
  const [row] = await db
    .select({ subId: user.stripeSubscriptionId })
    .from(user)
    .where(eq(user.id, userId));
  if (!row?.subId) return null;
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const sub = await stripe.subscriptions.retrieve(row.subId);
    if (!shouldStopAutoBilling(sub)) return null;
    const updated = await stripe.subscriptions.update(row.subId, { cancel_at_period_end: true });
    const item = updated.items.data[0];
    const cancelAt = item ? new Date(item.current_period_end * 1000) : new Date();
    await setSubscriptionCancelAt(userId, cancelAt);
    console.log(`[Comp] Stopped auto-billing for ${userId}: ${row.subId} cancels at ${cancelAt.toISOString()}`);
    return { subId: row.subId, cancelAt };
  } catch (err) {
    console.error(`[Comp] Failed to stop auto-billing for ${userId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Clear a pending plan change (user undid the downgrade). */
export async function clearPendingPlan(userId: string): Promise<void> {
  await db
    .update(creditWallets)
    .set({ pendingPlan: null, pendingPlanEffective: null, updatedAt: new Date() })
    .where(eq(creditWallets.userId, userId));
}

/** Apply a pending plan change. Used by lazy enforcement and invoice.paid webhook. */
export async function applyPendingPlan(userId: string, newPlan: PlanId): Promise<CreditWallet> {
  // Clear pending + apply plan in one call
  return syncPlan(userId, newPlan);
}

/**
 * LEGACY wallet-based time-limited plan set. Since 2026-07-19, admin UPGRADES
 * go through the plan_entitlements overlay (plan-entitlement-grants.ts) — the
 * admin route only calls this for what the overlay cannot express: demotions
 * ("demote a user to Go for 30 days"), same-tier extensions, and `internal`
 * grants. It UNCONDITIONALLY applies the plan change, even downward.
 *
 * The previous baseline (the plan the user reverts to when this expires) is
 * captured BEFORE the syncPlan call. For "self-extend" cases (plan === current),
 * baseline falls through to "free" so an expiry doesn't no-op.
 */
export async function adminSetTimeLimitedPlan(
  userId: string,
  plan: PlanId,
  durationDays: number,
): Promise<CreditWallet> {
  if (durationDays <= 0) throw new Error("durationDays must be positive");
  const wallet = await ensureWallet(userId);
  const baseline = wallet.plan === plan ? "free" : wallet.plan;
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

  // syncPlan additively applies the new plan and clears any prior expiry/baseline,
  // so we set the new expiry/baseline immediately after. A paying subscriber
  // KEEPS their billing source (stripe/wechat) — flipping it to 'comp' broke
  // renewal handling and cohort analytics while the grant ran (the referral
  // ladder has always preserved it — grantStackingPlanReward never touches
  // wallet.plan at all now). Only untagged users get the 'comp' source label.
  const preservedSource =
    wallet.subscriptionSource === "stripe" || wallet.subscriptionSource === "wechat"
      ? wallet.subscriptionSource
      : ("comp" as const);
  // Delta-only mint (owner policy 2026-07-19): grant the tier DIFFERENCE, and
  // only when the tier increases — repeated flips/corrections mint nothing.
  const updatedWallet = await syncPlan(userId, plan, {
    additive: true,
    grantFraction: adminUpgradeGrantFraction(wallet.plan, plan),
  });

  await db
    .update(creditWallets)
    .set({
      planExpiresAt: expiresAt,
      planBaseline: baseline,
      planGrantQueue: [],
      subscriptionSource: preservedSource,
      updatedAt: new Date(),
    })
    .where(eq(creditWallets.userId, userId));

  return {
    ...updatedWallet,
    planExpiresAt: expiresAt,
    planBaseline: baseline,
    planGrantQueue: [],
    subscriptionSource: preservedSource,
  };
}

// adminGrantStackedTimeLimitedPlan (the segment-queue reward stacker) was
// replaced 2026-07-19 by plan_entitlements overlay grants — see
// plan-entitlement-grants.ts. The queue-drain logic in checkBalance stays for
// in-flight legacy grants until they expire.

/**
 * Admin-initiated permanent plan grant.
 *
 * Sets the plan with `additive` semantics (preserves existing balance + addon)
 * and tags `subscription_source='comp'` so it's clearly distinguished from
 * Stripe / WeChat subscribers. No expiry — admin must remove explicitly.
 * Delta-only mint (owner policy 2026-07-19): grants the tier difference on
 * upgrade, nothing on same-tier/downward flips — repeated plan sets no longer
 * compound free credits (the ~237k over-mint footgun).
 */
export async function adminSetPermanentPlan(
  userId: string,
  plan: PlanId,
): Promise<CreditWallet> {
  const current = await ensureWallet(userId);
  const updatedWallet = await syncPlan(userId, plan, {
    additive: true,
    grantFraction: adminUpgradeGrantFraction(current.plan, plan),
  });

  await db
    .update(creditWallets)
    .set({
      subscriptionSource: "comp",
      updatedAt: new Date(),
    })
    .where(eq(creditWallets.userId, userId));

  return { ...updatedWallet, subscriptionSource: "comp" };
}

// Scheduled jobs (daily credit recovery, auth cleanup, playtest cleanup,
// WeChat renewal reminders) live as Postgres functions installed via
// scripts/install-daily-recovery-fn.sql and scripts/install-cleanup-fns.sql,
// invoked by GitHub Actions workflows in .github/workflows/. Keep the
// hardcoded plan floors in install-daily-recovery-fn.sql in sync with
// PLANS[*].dailyRecoveryAmount in plan-config.ts. The daily-recovery
// function uses ONE universal 04:00 boundary in the platform zone
// (Asia/Shanghai = 20:00 UTC, no DST) for every user, matching the daily
// check-in window — keep the SQL reset zone/hour in sync with
// env.YUMINA_CHECKIN_TIME_ZONE / CHECK_IN_RESET_HOUR.
