import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  communityEvents,
  creditTransactions,
  creditWallets,
  planEntitlements,
} from "../db/schema.js";
import { insertHashedTransaction } from "./transaction-hash.js";
import { normalizePlan, PLANS, type PlanId } from "./plan-config.js";
import { activationAllowance, allowanceDescription } from "./entitlement-allowance.js";
import { getOrCreateRequestPromise } from "./request-cache.js";

const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  go: 1,
  plus: 2,
  pro: 3,
  ultra: 4,
  internal: 5,
};

function rank(plan: string | null | undefined): number {
  return PLAN_RANK[normalizePlan(plan)] ?? 0;
}

/**
 * Lazily pauses, expires, and activates event membership entitlements without
 * ever changing the paid subscription fields on credit_wallets.
 */
async function resolveEffectivePlanWithEventEntitlementsUncached(
  userId: string,
  basePlan: PlanId,
  activationAllowanceBasePlan: PlanId = basePlan,
): Promise<PlanId> {
  const [candidate] = await db
    .select({ id: planEntitlements.id })
    .from(planEntitlements)
    .where(and(
      eq(planEntitlements.userId, userId),
      inArray(planEntitlements.status, ["active", "queued"]),
    ))
    .limit(1);
  if (!candidate) return basePlan;

  const now = new Date();

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM credit_wallets WHERE user_id = ${userId} FOR UPDATE`);

    await tx
      .update(planEntitlements)
      .set({ status: "consumed", remainingDurationSeconds: 0, updatedAt: now })
      .where(and(
        eq(planEntitlements.userId, userId),
        eq(planEntitlements.status, "active"),
        lte(planEntitlements.endsAt, now),
      ));

    const activeRows = await tx
      .select()
      .from(planEntitlements)
      .where(and(eq(planEntitlements.userId, userId), eq(planEntitlements.status, "active")))
      .orderBy(asc(planEntitlements.createdAt));

    // A newly paid same/higher plan pauses the event clock. Its full remaining
    // duration is preserved until it can improve the user's effective tier.
    for (const active of activeRows) {
      if (rank(basePlan) >= rank(active.planId)) {
        const remaining = active.endsAt
          ? Math.max(Math.ceil((active.endsAt.getTime() - now.getTime()) / 1000), 0)
          : active.remainingDurationSeconds;
        await tx
          .update(planEntitlements)
          .set({
            status: remaining > 0 ? "queued" : "consumed",
            remainingDurationSeconds: remaining,
            endsAt: null,
            updatedAt: now,
          })
          .where(eq(planEntitlements.id, active.id));
      }
    }

    let [active] = await tx
      .select()
      .from(planEntitlements)
      .where(and(eq(planEntitlements.userId, userId), eq(planEntitlements.status, "active")))
      .orderBy(sql`CASE ${planEntitlements.planId}
        WHEN 'ultra' THEN 4 WHEN 'pro' THEN 3 WHEN 'plus' THEN 2 WHEN 'go' THEN 1 ELSE 0 END DESC`)
      .limit(1);

    const queued = await tx
      .select()
      .from(planEntitlements)
      .where(and(
        eq(planEntitlements.userId, userId),
        eq(planEntitlements.status, "queued"),
      ))
      .orderBy(
        sql`CASE ${planEntitlements.planId}
          WHEN 'ultra' THEN 4 WHEN 'pro' THEN 3 WHEN 'plus' THEN 2 WHEN 'go' THEN 1 ELSE 0 END DESC`,
        asc(planEntitlements.createdAt),
      );

    // A newly received higher event tier preempts a lower active event tier;
    // the lower tier keeps every unused second and resumes afterward.
    const preemptor = active
      ? queued.find((candidate) => candidate.remainingDurationSeconds > 0
          && rank(candidate.planId) > rank(active!.planId)
          && rank(candidate.planId) > rank(basePlan))
      : undefined;
    if (active && preemptor) {
      const remaining = active.endsAt
        ? Math.max(Math.ceil((active.endsAt.getTime() - now.getTime()) / 1000), 0)
        : active.remainingDurationSeconds;
      await tx
        .update(planEntitlements)
        .set({
          status: remaining > 0 ? "queued" : "consumed",
          remainingDurationSeconds: remaining,
          endsAt: null,
          updatedAt: now,
        })
        .where(eq(planEntitlements.id, active.id));
      active = undefined;
    }

    if (!active) {
      const next = preemptor ?? queued.find((candidate) =>
        candidate.remainingDurationSeconds > 0 && rank(candidate.planId) > rank(basePlan));

      if (next) {
        const endsAt = new Date(now.getTime() + next.remainingDurationSeconds * 1000);
        await tx
          .update(planEntitlements)
          .set({
            status: "active",
            activatedAt: next.activatedAt ?? now,
            resumedAt: next.activatedAt ? now : null,
            endsAt,
            updatedAt: now,
          })
          .where(eq(planEntitlements.id, next.id));
        const activatedPlan = normalizePlan(next.planId);

        const [event] = next.source === "event"
          ? await tx
              .select({ rulesConfig: communityEvents.rulesConfig })
              .from(communityEvents)
              .where(eq(communityEvents.id, next.sourceId))
              .limit(1)
          : [];
        const eventGrantsMonthly = event?.rulesConfig?.grantMonthlyCreditsOnActivation ?? true;
        // Per-source allowance policy (entitlement-allowance.ts): event = full
        // (config-gated), referral = duration-scaled, admin = tier delta vs the
        // base plan at activation (delta-only owner policy).
        //
        // Referral allowances are normally already paid at grant time, so the
        // referenceId check below turns this into a no-op for them. It still
        // runs for entitlements granted before that change shipped.
        const amount = activationAllowance(
          next.source,
          activatedPlan,
          activationAllowanceBasePlan,
          eventGrantsMonthly,
          next.durationDays,
        );
        if (amount > 0) {
          const referenceId = `event_entitlement_activation:${next.id}`;
          const [alreadyGranted] = await tx
            .select({ id: creditTransactions.id })
            .from(creditTransactions)
            .where(eq(creditTransactions.referenceId, referenceId))
            .limit(1);
          if (!alreadyGranted) {
            const [wallet] = await tx
              .update(creditWallets)
              .set({
                balance: sql`${creditWallets.balance} + ${amount}`,
                addonBalance: sql`${creditWallets.addonBalance} + ${amount}`,
                updatedAt: now,
              })
              .where(eq(creditWallets.userId, userId))
              .returning();
            if (wallet) {
              await insertHashedTransaction({
                walletId: wallet.id,
                amount,
                type: "plan_grant",
                referenceId,
                balanceAfter: wallet.balance,
                description: allowanceDescription(next.source, activatedPlan),
              }, tx);
            }
          }
        }
        active = { ...next, status: "active", endsAt };
      }
    }

    return active && rank(active.planId) > rank(basePlan)
      ? normalizePlan(active.planId)
      : basePlan;
  });
}

export function resolveEffectivePlanWithEventEntitlements(
  userId: string,
  basePlan: PlanId,
): Promise<PlanId> {
  return getOrCreateRequestPromise(
    `event-plan:${userId}:${basePlan}`,
    () => resolveEffectivePlanWithEventEntitlementsUncached(userId, basePlan),
  );
}

/**
 * Uncached settle — for grant paths (plan-entitlement-grants.ts) that must
 * activate a just-inserted row: the per-request memo above may hold a
 * pre-insert resolution for the same (user, basePlan) key.
 */
export const settleEntitlementsForUser = resolveEffectivePlanWithEventEntitlementsUncached;
