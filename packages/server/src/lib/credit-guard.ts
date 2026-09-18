// ─── Credit Guard ───────────────────────────────────────────────────
// Centralized pre-generation validation for all AI endpoints.
// Single module replaces the copy-pasted check logic in every route.

import { recordWallHit } from "./wall-events.js";
import {
  checkBalance,
  validateModelAccess,
  ensureWallet,
  getModelCostRates,
  estimateCreditsFromChars,
  estimateTokensFromChars,
} from "./credit-service.js";
import type { CreditWallet, ModelCostRates } from "./credit-service.js";
import { PLANS } from "./plan-config.js";
import type { PlanId, PlanConfig } from "./plan-config.js";
import { checkRateLimit, acquireConcurrency, releaseConcurrency } from "../middleware/rate-limit.js";

// ─── Pre-Generation Guard ──────────────────────────────────────────

export interface GuardContext {
  wallet: CreditWallet;
  plan: PlanId;
  planConfig: PlanConfig;
  /** True when credit/model/rate protections are active (official key). */
  protected: boolean;
  /** True when a concurrency slot was acquired (caller MUST release). */
  concurrencyHeld: boolean;
}

export type GuardOutcome =
  | { ok: true; ctx: GuardContext }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Pre-generation validation. Call before ANY AI generation.
 *
 * Checks (in order): suspended → balance → model access → rate limit → concurrency.
 * BYOK users skip all checks — returns inert context.
 *
 * On failure, returns { ok: false, status, body } — caller does `c.json(body, status)`.
 */
export async function guardGeneration(
  userId: string,
  model: string,
  opts: {
    isByok: boolean;
    isSuspended?: boolean;
    /** Skip concurrency slot (e.g., agent has its own mechanism). */
    skipConcurrency?: boolean;
    /** Skip model-in-modelPrices validation (e.g., studio has its own allowlist). */
    skipModelValidation?: boolean;
  },
): Promise<GuardOutcome> {
  // BYOK: their key, their problem — skip all checks
  if (opts.isByok) {
    const wallet = await ensureWallet(userId);
    return {
      ok: true,
      ctx: { wallet, plan: wallet.plan, planConfig: PLANS[wallet.plan] ?? PLANS.free, protected: false, concurrencyHeld: false },
    };
  }

  if (opts.isSuspended) {
    return { ok: false, status: 403, body: { error: "Your account has been temporarily suspended from AI generation. If you believe this is a mistake, please contact support.", code: "SUSPENDED" } };
  }

  // Balance check (also triggers lazy monthly refresh)
  const balanceResult = await checkBalance(userId);
  const plan = balanceResult.wallet.plan;
  const planConfig = PLANS[plan] ?? PLANS.free;

  if (!opts.skipModelValidation) {
    const modelAccess = await validateModelAccess(plan, model);
    if (!modelAccess.allowed) {
      return { ok: false, status: 403, body: { error: modelAccess.reason, code: "MODEL_NOT_ALLOWED" } };
    }
  }

  if (!planConfig.unlimited && !balanceResult.ok) {
    recordWallHit({ userId, plan, planVersion: balanceResult.wallet.planVersion, balance: 0, model, endpoint: "guard", stage: "preflight" });
    return { ok: false, status: 402, body: { error: "You've used all your credits for this period. Purchase additional credits or upgrade your plan.", code: "NO_CREDITS", balance: 0 } };
  }

  const rateErr = await checkRateLimit(userId, planConfig.rateLimit);
  if (rateErr) {
    return { ok: false, status: 429, body: rateErr };
  }

  let concurrencyHeld = false;
  if (!opts.skipConcurrency) {
    if (!(await acquireConcurrency(userId, planConfig.maxConcurrent))) {
      return { ok: false, status: 429, body: { error: "You already have a response being generated. Please wait for it to finish.", code: "CONCURRENT_LIMIT", retryAfter: 5 } };
    }
    concurrencyHeld = true;
  }

  // The generation budget excludes funds held for another call. Keep the raw
  // wallet total intact for balance displays and exempt unlimited contexts.
  const wallet = planConfig.unlimited ? balanceResult.wallet
    : { ...balanceResult.wallet, balance: balanceResult.balance };
  return { ok: true, ctx: { wallet, plan, planConfig, protected: true, concurrencyHeld } };
}

/** Release concurrency slot if held. Call in finally{} after streaming. */
export async function releaseGuard(userId: string, ctx: GuardContext): Promise<void> {
  if (ctx.concurrencyHeld) await releaseConcurrency(userId);
}

// ─── Mid-Stream Cost Tracker ────────────────────────────────────────
// Tracks estimated cost during SSE streaming. Zero DB queries during
// streaming — uses pre-loaded cost rates for local estimation.

export class MidStreamTracker {
  private rates: ModelCostRates | null;
  private startBalance: number;
  private pChars: number;

  streamedChars = 0;
  creditAborted = false;

  private constructor(rates: ModelCostRates | null, startBalance: number, pChars: number) {
    this.rates = rates;
    this.startBalance = startBalance;
    this.pChars = pChars;
  }

  /**
   * Create a tracker. Loads cost rates for protected non-unlimited plans.
   * For BYOK/unlimited, returns an inert tracker that never aborts.
   */
  static async create(opts: {
    ctx: GuardContext;
    model: string;
    promptChars: number;
  }): Promise<MidStreamTracker> {
    if (!opts.ctx.protected || opts.ctx.planConfig.unlimited) {
      return new MidStreamTracker(null, Infinity, 0);
    }
    const rates = await getModelCostRates(opts.model, estimateTokensFromChars(opts.promptChars));
    return new MidStreamTracker(rates, opts.ctx.wallet.balance, opts.promptChars);
  }

  /** Track output chunk. Returns true if stream should abort (credits exhausted). */
  track(chunkLen: number): boolean {
    this.streamedChars += chunkLen;
    if (!this.rates) return false;
    // Check every ~500 output chars
    if (this.streamedChars % 500 < chunkLen) {
      if (estimateCreditsFromChars(this.rates, this.pChars, this.streamedChars) >= this.startBalance) {
        this.creditAborted = true;
        return true;
      }
    }
    return false;
  }

  /** Estimated cost for what was streamed so far. */
  get estimatedCost(): number {
    if (!this.rates || this.streamedChars === 0) return 0;
    return estimateCreditsFromChars(this.rates, this.pChars, this.streamedChars);
  }

  /** Balance at the start of this turn (mushies). */
  get balance(): number {
    return this.startBalance;
  }

  /**
   * True when the prompt alone already exceeds the start balance — the user
   * can't afford this turn before a single output token. Lets callers reject
   * pre-flight (clean "out of mushies") instead of aborting mid-stream into a
   * blank reply. Inert (false) for BYOK/unlimited.
   */
  exceedsAtStart(): boolean {
    if (!this.rates) return false;
    return estimateCreditsFromChars(this.rates, this.pChars, 0) >= this.startBalance;
  }

  /** Whether this tracker is actively monitoring (false for BYOK/unlimited). */
  get active(): boolean {
    return this.rates !== null;
  }
}
