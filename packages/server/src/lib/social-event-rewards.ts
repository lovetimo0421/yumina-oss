import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  communityEventRewardGrants,
  communityEventSocialSettlements,
  creditTransactions,
  creditWallets,
  planEntitlements,
} from "../db/schema.js";
import { ensureWallet } from "./credit-service.js";
import { insertHashedTransaction } from "./transaction-hash.js";
import type { PlanId } from "./plan-config.js";
import { resolveEffectivePlanWithEventEntitlements } from "./event-plan-entitlements.js";
import { invalidateRequestCachePrefix } from "./request-cache.js";

export type SocialRewardGrantResult = {
  grantId: string;
  status: "applied" | "failed";
  alreadyApplied?: boolean;
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
}

async function maybeCompleteSettlement(eventId: string, userId: string) {
  const [settlement] = await db
    .select({
      id: communityEventSocialSettlements.id,
      status: communityEventSocialSettlements.status,
    })
    .from(communityEventSocialSettlements)
    .where(and(
      eq(communityEventSocialSettlements.eventId, eventId),
      eq(communityEventSocialSettlements.userId, userId),
    ))
    .limit(1);
  if (!settlement || settlement.status === "completed") return;
  const [remaining] = await db
    .select({ id: communityEventRewardGrants.id })
    .from(communityEventRewardGrants)
    .where(and(
      eq(communityEventRewardGrants.eventId, eventId),
      eq(communityEventRewardGrants.userId, userId),
      inArray(communityEventRewardGrants.status, ["pending", "processing", "failed"]),
    ))
    .limit(1);
  if (!remaining) {
    await db
      .update(communityEventSocialSettlements)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(communityEventSocialSettlements.id, settlement.id),
        inArray(communityEventSocialSettlements.status, ["pending", "processing", "failed"]),
      ));
  }
}

/** Process one durable grant. Safe to call repeatedly and concurrently. */
export async function processSocialEventRewardGrant(grantId: string): Promise<SocialRewardGrantResult> {
  const [before] = await db
    .select()
    .from(communityEventRewardGrants)
    .where(eq(communityEventRewardGrants.id, grantId))
    .limit(1);
  if (!before) throw new Error("SOCIAL_REWARD_GRANT_NOT_FOUND");
  if (before.status === "applied") {
    return { grantId, status: "applied", alreadyApplied: true };
  }
  if (before.status === "cancelled" || before.status === "reversed") {
    throw new Error("SOCIAL_REWARD_GRANT_NOT_PROCESSABLE");
  }

  // Wallet creation is idempotent. Doing it before the reward transaction
  // leaves the actual balance + ledger + grant application fully atomic.
  if (before.kind === "mushies") await ensureWallet(before.userId);

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM community_event_reward_grants
        WHERE id = ${grantId}
        FOR UPDATE
      `);
      const [grant] = await tx
        .select()
        .from(communityEventRewardGrants)
        .where(eq(communityEventRewardGrants.id, grantId))
        .limit(1);
      if (!grant) throw new Error("SOCIAL_REWARD_GRANT_NOT_FOUND");
      if (grant.status === "applied") return { grant, alreadyApplied: true };
      if (grant.status === "cancelled" || grant.status === "reversed") {
        throw new Error("SOCIAL_REWARD_GRANT_NOT_PROCESSABLE");
      }

      await tx
        .update(communityEventRewardGrants)
        .set({
          status: "processing",
          attemptCount: sql`${communityEventRewardGrants.attemptCount} + 1`,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(communityEventRewardGrants.id, grant.id));

      if (grant.kind === "mushies") {
        if (!grant.amount || grant.amount <= 0) throw new Error("INVALID_MUSHIES_GRANT");
        await tx.execute(sql`SELECT id FROM credit_wallets WHERE user_id = ${grant.userId} FOR UPDATE`);
        const referenceId = `event_reward:${grant.idempotencyKey}`;
        const [existingTx] = await tx
          .select({ id: creditTransactions.id })
          .from(creditTransactions)
          .where(eq(creditTransactions.referenceId, referenceId))
          .limit(1);
        let transactionId = existingTx?.id ?? null;
        if (!transactionId) {
          const [wallet] = await tx
            .update(creditWallets)
            .set({
              balance: sql`${creditWallets.balance} + ${grant.amount}`,
              addonBalance: sql`${creditWallets.addonBalance} + ${grant.amount}`,
              updatedAt: new Date(),
            })
            .where(eq(creditWallets.userId, grant.userId))
            .returning();
          if (!wallet) throw new Error("EVENT_REWARD_WALLET_NOT_FOUND");
          const inserted = await insertHashedTransaction({
            walletId: wallet.id,
            amount: grant.amount,
            type: "event_reward",
            referenceId,
            balanceAfter: wallet.balance,
            description: grant.purpose === "verified_settlement_floor"
              ? "YUMINA social event final-review completion reward"
              : `YUMINA community event reward (${grant.phase})`,
          }, tx);
          transactionId = inserted.id;
        }

        const [applied] = await tx
          .update(communityEventRewardGrants)
          .set({
            status: "applied",
            creditTransactionId: transactionId,
            appliedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(communityEventRewardGrants.id, grant.id))
          .returning();
        return { grant: applied!, alreadyApplied: Boolean(existingTx) };
      }

      if (grant.kind === "plan") {
        if (!grant.planId || !grant.durationDays || grant.durationDays <= 0) {
          throw new Error("INVALID_PLAN_GRANT");
        }
        const [created] = await tx
          .insert(planEntitlements)
          .values({
            userId: grant.userId,
            planId: grant.planId,
            source: "event",
            // Social settlements grant one highest tier per event/user. Legacy
            // world-event rewards use phase=adjustment and remain per submission.
            sourceId: grant.phase === "adjustment" ? grant.idempotencyKey : grant.eventId,
            idempotencyKey: grant.idempotencyKey,
            durationDays: grant.durationDays,
            remainingDurationSeconds: grant.durationDays * 24 * 60 * 60,
            status: "queued",
          })
          .onConflictDoNothing({ target: planEntitlements.idempotencyKey })
          .returning();
        const [entitlement] = created ? [created] : await tx
          .select()
          .from(planEntitlements)
          .where(eq(planEntitlements.idempotencyKey, grant.idempotencyKey))
          .limit(1);
        if (!entitlement) throw new Error("PLAN_ENTITLEMENT_CREATE_FAILED");

        const [applied] = await tx
          .update(communityEventRewardGrants)
          .set({
            status: "applied",
            planEntitlementId: entitlement.id,
            appliedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(communityEventRewardGrants.id, grant.id))
          .returning();
        return { grant: applied!, alreadyApplied: !created };
      }

      throw new Error("UNKNOWN_EVENT_REWARD_KIND");
    });

    if (result.grant.kind === "plan") {
      invalidateRequestCachePrefix(`event-plan:${result.grant.userId}:`);
      const wallet = await ensureWallet(result.grant.userId);
      try {
        await resolveEffectivePlanWithEventEntitlements(result.grant.userId, wallet.plan as PlanId);
      } catch (error) {
        // The entitlement and durable grant are already atomically committed.
        // Lazy access checks will retry activation without duplicating it.
        console.error("[SOCIAL EVENT] entitlement activation deferred", error);
      }
    }
    try {
      await maybeCompleteSettlement(result.grant.eventId, result.grant.userId);
    } catch (error) {
      console.error("[SOCIAL EVENT] settlement completion refresh deferred", error);
    }
    return {
      grantId,
      status: "applied",
      alreadyApplied: result.alreadyApplied,
    };
  } catch (error) {
    const message = errorMessage(error);
    await db
      .update(communityEventRewardGrants)
      .set({
        status: "failed",
        attemptCount: sql`${communityEventRewardGrants.attemptCount} + 1`,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(and(
        eq(communityEventRewardGrants.id, grantId),
        inArray(communityEventRewardGrants.status, ["pending", "processing", "failed"]),
      ));
    return { grantId, status: "failed", error: message };
  }
}

export async function processSocialEventRewardGrants(grantIds: readonly string[]) {
  const results: SocialRewardGrantResult[] = [];
  for (const grantId of grantIds) {
    results.push(await processSocialEventRewardGrant(grantId));
  }
  return results;
}
