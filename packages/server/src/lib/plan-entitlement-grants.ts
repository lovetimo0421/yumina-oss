// Overlay-based time-limited plan grants (structural follow-up 2026-07-19).
//
// Admin panel grants and referral/invite/community plan rewards write
// plan_entitlements rows instead of mutating wallet.plan — the wallet keeps
// strictly the PAID tier (stripe/wechat sub, permanent comp, or free), so a
// grant can never fight the Stripe billing state machine again:
//  - a sub ending doesn't destroy the grant (the resolver just re-activates it)
//  - a grant never flips subscriptionSource or extends the billing period
//  - stacking/preemption/pause-resume come from the entitlement resolver.
//
// The legacy wallet-based machinery (planExpiresAt/planBaseline/planGrantQueue)
// stays read-only for in-flight grants until they drain; adminSetTimeLimitedPlan
// remains only for demotions and `internal` grants, which the overlay cannot
// express (entitlements only ELEVATE above the base plan).

import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { creditTransactions, creditWallets, planEntitlements } from "../db/schema.js";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { normalizePlan, planMeetsMinimum, type PlanId } from "./plan-config.js";
import { ensureWallet } from "./credit-service.js";
import { settleEntitlementsForUser } from "./event-plan-entitlements.js";
import { activationAllowance, allowanceDescription } from "./entitlement-allowance.js";
import { insertHashedTransaction } from "./transaction-hash.js";

export type EntitlementSource = "event" | "admin" | "referral";

export const ENTITLEMENT_PLANS: readonly PlanId[] = ["go", "plus", "pro", "ultra"];

export interface GrantPlanEntitlementResult {
  entitlementId: string;
  /** queued | active — after immediate settlement. */
  status: string;
  /** Set when the entitlement activated immediately. */
  endsAt: Date | null;
  /** The user's effective plan after settlement. */
  effectivePlan: PlanId;
  /** False when the idempotencyKey had already been used (replay). */
  created: boolean;
  /** Older admin grants cancelled because this was an explicit replacement. */
  replacedEntitlementIds: string[];
}

/**
 * Cancel active/queued admin grants without touching earned event or referral
 * rewards. The admin plan controls are imperative ("change this user to X"),
 * unlike reward grants, which intentionally stack.
 */
export async function cancelAdminPlanEntitlements(
  userId: string,
  exceptEntitlementId?: string,
): Promise<string[]> {
  const baseCondition = and(
    eq(planEntitlements.userId, userId),
    eq(planEntitlements.source, "admin"),
    inArray(planEntitlements.status, ["active", "queued"]),
  );
  const rows = await db
    .update(planEntitlements)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      exceptEntitlementId
        ? and(baseCondition, ne(planEntitlements.id, exceptEntitlementId))
        : baseCondition,
    )
    .returning();
  return rows.map((row) => row.id);
}

/**
 * Pay a referral entitlement's one-time mushie allowance NOW, at grant time.
 *
 * A same-tier entitlement never outranks the base plan, so the resolver leaves
 * it `queued` — for a user already holding Gold that can be weeks (2026-07-26:
 * a Gold-30d milestone queued behind a comp Gold running to 08-12). Under the
 * old activation-only rule those users got literally nothing in their ledger
 * and reported it as a missing reward. Paying on grant makes every recipient
 * of a tier see the same entry the same day.
 *
 * Shares the activation path's referenceId, so whichever fires first wins and
 * the other is a no-op — the reward can never be paid twice.
 *
 * Exported for the backfill script, which settles the users the old rule
 * skipped. Idempotent: safe to re-run.
 */
export async function grantReferralEntitlementAllowance(
  userId: string,
  entitlementId: string,
  plan: PlanId,
  durationDays: number,
): Promise<number> {
  const amount = activationAllowance("referral", plan, "free", true, durationDays);
  if (amount <= 0) return 0;

  // Ensure the wallet row exists BEFORE the transaction so there is always a
  // row to lock below.
  await ensureWallet(userId);

  const referenceId = `event_entitlement_activation:${entitlementId}`;
  // One transaction, taking the SAME lock in the SAME order as the activation
  // path (event-plan-entitlements.ts: wallet FOR UPDATE first, then the
  // referenceId check). A concurrent settle serializes behind the wallet lock
  // instead of racing the check-then-insert into a double payment, and a
  // failure between the wallet bump and the ledger insert rolls both back
  // together instead of leaving an unledgered balance change.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM credit_wallets WHERE user_id = ${userId} FOR UPDATE`);

    const [already] = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.referenceId, referenceId))
      .limit(1);
    if (already) return 0;

    // Referral mushies are ADDON mushies — the monthly refresh recomputes
    // `balance = monthlyCredits + addonBalance`, so bumping balance alone would
    // let the next period boundary erase the reward.
    const [wallet] = await tx
      .update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} + ${amount}`,
        addonBalance: sql`${creditWallets.addonBalance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(creditWallets.userId, userId))
      .returning();
    if (!wallet) return 0;

    await insertHashedTransaction({
      walletId: wallet.id,
      amount,
      type: "plan_grant",
      referenceId,
      balanceAfter: wallet.balance,
      description: allowanceDescription("referral", plan),
    }, tx);
    return amount;
  });
}

/**
 * Insert an admin/referral time-limited plan entitlement and settle activation
 * immediately (so the grantee sees the tier without waiting for their next
 * balance check). Idempotent on `idempotencyKey`.
 */
export async function grantPlanEntitlement(
  userId: string,
  opts: {
    plan: PlanId;
    durationDays: number;
    source: Exclude<EntitlementSource, "event">;
    sourceId: string;
    idempotencyKey?: string;
    /** Admin UI changes replace prior admin grants instead of stacking. */
    replaceExistingAdminGrants?: boolean;
  },
): Promise<GrantPlanEntitlementResult> {
  if (!ENTITLEMENT_PLANS.includes(opts.plan)) {
    throw new Error(`Plan ${opts.plan} cannot be granted as an entitlement`);
  }
  if (!Number.isFinite(opts.durationDays) || opts.durationDays <= 0) {
    throw new Error("durationDays must be positive");
  }

  let settlementWallet: Awaited<ReturnType<typeof ensureWallet>> | null = null;
  let replacementAllowanceBasePlan: PlanId | undefined;
  if (opts.source === "admin" && opts.replaceExistingAdminGrants) {
    settlementWallet = await ensureWallet(userId);
    const [activeAdminGrant] = await db
      .select({ planId: planEntitlements.planId })
      .from(planEntitlements)
      .where(and(
        eq(planEntitlements.userId, userId),
        eq(planEntitlements.source, "admin"),
        eq(planEntitlements.status, "active"),
      ))
      .orderBy(sql`CASE ${planEntitlements.planId}
        WHEN 'ultra' THEN 4 WHEN 'pro' THEN 3 WHEN 'plus' THEN 2 WHEN 'go' THEN 1 ELSE 0 END DESC`)
      .limit(1);
    const activeAdminPlan = activeAdminGrant
      ? normalizePlan(activeAdminGrant.planId)
      : settlementWallet.plan;
    replacementAllowanceBasePlan = planMeetsMinimum(activeAdminPlan, settlementWallet.plan)
      ? activeAdminPlan
      : settlementWallet.plan;
  }

  const idempotencyKey = opts.idempotencyKey ?? `${opts.source}:${randomUUID()}`;
  const [inserted] = await db
    .insert(planEntitlements)
    .values({
      userId,
      planId: opts.plan,
      source: opts.source,
      sourceId: opts.sourceId,
      idempotencyKey,
      durationDays: Math.ceil(opts.durationDays),
      remainingDurationSeconds: Math.round(opts.durationDays * 86400),
      status: "queued",
    })
    .onConflictDoNothing({ target: planEntitlements.idempotencyKey })
    .returning();

  let entitlementId = inserted?.id;
  const created = Boolean(inserted);
  if (!entitlementId) {
    const [existing] = await db
      .select({ id: planEntitlements.id })
      .from(planEntitlements)
      .where(eq(planEntitlements.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!existing) throw new Error("Entitlement insert conflicted but no existing row found");
    entitlementId = existing.id;
  }

  const replacedEntitlementIds =
    opts.source === "admin" && opts.replaceExistingAdminGrants
      ? await cancelAdminPlanEntitlements(userId, entitlementId)
      : [];

  // Pay the referral allowance BEFORE settling, so the settle path's
  // referenceId check sees it and never mints a second copy on activation.
  // Deliberately NOT gated on `created`: a retry that hit the idempotencyKey
  // conflict (crash between the entitlement insert and this payment) must
  // still pay, or a reward that stays `queued` would never mint at all. The
  // referenceId check inside makes the call a no-op when the allowance was
  // already paid — at grant or at activation.
  if (opts.source === "referral") {
    await grantReferralEntitlementAllowance(userId, entitlementId, opts.plan, opts.durationDays);
  }

  // Settle immediately (uncached — the per-request memo may hold a
  // pre-insert resolution) so the grant activates now when it outranks the
  // base plan, granting its activation allowance in the same call.
  const wallet = settlementWallet ?? await ensureWallet(userId);
  const effectivePlan = await settleEntitlementsForUser(
    userId,
    wallet.plan,
    replacementAllowanceBasePlan,
  );

  const [row] = await db
    .select({
      status: planEntitlements.status,
      endsAt: planEntitlements.endsAt,
    })
    .from(planEntitlements)
    .where(and(eq(planEntitlements.id, entitlementId), eq(planEntitlements.userId, userId)))
    .limit(1);

  return {
    entitlementId,
    status: row?.status ?? "queued",
    endsAt: row?.endsAt ?? null,
    effectivePlan,
    created,
    replacedEntitlementIds,
  };
}
