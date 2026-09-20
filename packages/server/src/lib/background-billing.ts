import { PLANS, type PlanId } from "./plan-config.js";
import { calculateCost, deductCredits, ensureWallet } from "./credit-service.js";
import { resolveEffectivePlanWithEventEntitlements } from "./event-plan-entitlements.js";
import type { LedgerDatabase } from "./transaction-hash.js";

/**
 * Mushie billing for background LLM work (story compaction, session memory,
 * summaryception). Mirrors the send path's rules exactly:
 *   - BYOK calls are never charged (the caller checks `resolved.isByok` and
 *     skips this entirely — the user already pays their own upstream bill).
 *   - `unlimited` plans skip deduction.
 *   - Every deduction goes through deductCredits → the hash-chained
 *     credit_transactions ledger, one visible row per LLM call, with the
 *     usage_log id as referenceId.
 */

/** Player-facing ledger label per background endpoint. */
const BACKGROUND_BILLING_LABELS: Record<string, string> = {
  "story-compaction": "Story summary compaction",
  "session-memory": "Session memory update",
  "summaryception": "Layered summary",
  "state-update-guard": "State update correction",
};

export function backgroundBillingLabel(endpoint: string): string {
  return BACKGROUND_BILLING_LABELS[endpoint] ?? endpoint;
}

/** Player-facing message when the wallet can't cover a background update.
 *  Lands in summaryError / sessionMemoryError, so the memory panel shows the
 *  real reason instead of a cryptic INSUFFICIENT_CREDITS. */
export function notEnoughMushiesMessage(endpoint: string): string {
  if (endpoint === "state-update-guard") return "Not enough mushies for the state update correction. Choose Use free model in State Update Guard or top up, then retry. Your previous state is saved and this reply was not charged.";
  return `Not enough mushies to run the ${backgroundBillingLabel(endpoint).toLowerCase()}. It is paused until you top up or check in — then run it again from the memory panel.`;
}

/** Minimum balance required to START a multi-call background run. Cheap
 *  pre-gate so we don't burn half a compaction run and fail on the last call. */
export const BACKGROUND_RUN_MIN_BALANCE = 5;

async function effectivePlanFor(userId: string): Promise<{ plan: PlanId; balance: number }> {
  const wallet = await ensureWallet(userId);
  const plan = await resolveEffectivePlanWithEventEntitlements(userId, wallet.plan as PlanId);
  return { plan, balance: wallet.balance };
}

/** True when this user's background work should be charged at all
 *  (official-key users on non-unlimited plans). BYOK is decided per-call by
 *  the caller since the resolved key can differ per model. */
export async function backgroundBillingApplies(userId: string): Promise<boolean> {
  const { plan } = await effectivePlanFor(userId);
  return !PLANS[plan]?.unlimited;
}

/** Prepare outside a caller's state transaction; debit can then join its commit. */
export async function backgroundUsageCost(args: {
  userId: string; model: string; promptTokens: number; completionTokens: number; providerCostUsd?: number;
}): Promise<number> {
  if (!await backgroundBillingApplies(args.userId)) return 0;
  return calculateCost(args.model, args.promptTokens, args.completionTokens, { providerCostUsd: args.providerCostUsd });
}

/** Pre-gate for a multi-call run: false when the wallet clearly can't cover
 *  it. Unlimited plans always pass. */
export async function hasBackgroundRunBudget(userId: string): Promise<boolean> {
  const { plan, balance } = await effectivePlanFor(userId);
  if (PLANS[plan]?.unlimited) return true;
  return balance >= BACKGROUND_RUN_MIN_BALANCE;
}

/**
 * Charge mushies for one background LLM call made on an official key.
 * Throws a player-readable Error when the balance can't cover the cost, so
 * job-failure paths surface the real reason in the memory panel.
 */
export async function billBackgroundUsage(args: {
  userId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  usageLogId: string;
  endpoint: string;
}, database?: LedgerDatabase): Promise<void> {
  const charge = await prepareBackgroundUsageBill(args);
  await charge?.(database);
}

/** Resolve plan/pricing before opening a session transaction. The returned
 * debit uses that transaction, including its hashed ledger append. */
export async function prepareBackgroundUsageBill(args: Parameters<typeof billBackgroundUsage>[0]): Promise<
  ((database?: LedgerDatabase) => Promise<void>) | null
> {
  const { plan } = await effectivePlanFor(args.userId);
  if (PLANS[plan]?.unlimited) return null;

  const cost = await calculateCost(args.model, args.promptTokens, args.completionTokens);
  if (cost <= 0) return null;

  return async (database) => {
    try {
      await deductCredits(
        args.userId,
        cost,
        args.usageLogId,
        `${backgroundBillingLabel(args.endpoint)} — ${args.model} — ${args.promptTokens + args.completionTokens} tokens`,
        database,
      );
    } catch (err) {
      if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
        throw new Error(notEnoughMushiesMessage(args.endpoint));
      }
      throw err;
    }
  };
}
