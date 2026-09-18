import { bonusRewardGroup } from "@yumina/shared";
// ─── Referral Service ────────────────────────────────────────────────
// Referral code generation, milestone tracking, and reward grants.
// Pure ladder definitions + decision logic live in referral-rewards.ts.

import { db } from "../db/index.js";
import { user, referralMilestones, creditWallets, referralQualifications } from "../db/schema.js";
import { eq, sql, count, and, isNotNull, gte, lt } from "drizzle-orm";
import { legacyReferralCutoff } from "./qualified-referrals.js";
import { ensureWallet, checkBalance } from "./credit-service.js";
import { grantPlanEntitlement } from "./plan-entitlement-grants.js";
import { insertHashedTransaction, type LedgerDatabase } from "./transaction-hash.js";
import type { PlanId } from "./plan-config.js";
import { notify } from "./notify.js";
import {
  MILESTONES,
  REFERRAL_MILESTONES,
  REFERRAL_REWARD_EPOCH,
  selectEarnedMilestones,
  type MilestoneDef,
} from "./referral-rewards.js";

import { attachBonus, freeCreditRollout, policyAccount, useBonusRewards } from "./free-credit-policy.js";

export { REFERRAL_MILESTONES };

// Same safe alphabet as invite codes (no ambiguous chars)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(length: number): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/** Generate a unique 8-char referral code. Retries on collision. */
export async function generateReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode(8);
    const [existing] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.referralCode, code))
      .limit(1);
    if (!existing) return code;
  }
  // Extremely unlikely fallback — add timestamp suffix
  return generateCode(6) + String(Date.now() % 100).padStart(2, "0");
}

/** Get or create a referral code for the user. */
export async function ensureReferralCode(userId: string): Promise<string> {
  const [row] = await db
    .select({ referralCode: user.referralCode })
    .from(user)
    .where(eq(user.id, userId));

  if (row?.referralCode) return row.referralCode;

  const code = await generateReferralCode();
  await db
    .update(user)
    .set({ referralCode: code, updatedAt: new Date() })
    .where(eq(user.id, userId));

  return code;
}

/**
 * All-time count of users this person has referred. Drives the 引路人
 * achievement/title and the "friends invited" headline — never resets.
 */
export async function getReferralCount(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(user)
    .where(eq(user.referredBy, userId));
  return Number(result?.count ?? 0);
}

/**
 * RESETTABLE raw reward count: referrals redeemed at/after the reward epoch.
 * Legacy referrals (referred_at IS NULL) are excluded, so the reward ladder
 * starts fresh without touching the all-time achievement count above.
 */
export async function getRewardRawReferralCount(userId: string): Promise<number> {
  const cutoff = await legacyReferralCutoff();
  const [result] = await db
    .select({ count: count() })
    .from(user)
    .where(
      and(
        eq(user.referredBy, userId),
        isNotNull(user.referredAt),
        gte(user.referredAt, REFERRAL_REWARD_EPOCH),
        cutoff ? lt(user.referredAt, cutoff) : undefined,
      ),
    );
  return Number(result?.count ?? 0);
}

/**
 * ACTIVE friends: invitees whose referral qualification settled as rewarded
 * (they played and came back — see qualified-referrals.ts). Since 2026-09-16
 * this is the only count that unlocks wallet rewards and Wayfinder tiers.
 */
export async function getConfirmedReferralCount(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(referralQualifications)
    .where(and(eq(referralQualifications.referrerId, userId), eq(referralQualifications.status, "rewarded")));
  return Number(result?.count ?? 0);
}

/** Get list of users referred by this person. */
export async function getReferrals(userId: string) {
  return db
    .select({
      id: user.id,
      name: user.name,
      username: user.username,
      image: user.image,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.referredBy, userId))
    .orderBy(user.createdAt);
}

/** Get milestones already claimed by this user. */
export async function getClaimedMilestones(userId: string) {
  return db
    .select()
    .from(referralMilestones)
    .where(eq(referralMilestones.userId, userId));
}

/** The mushies a referred user receives. */
export const REFERRAL_GIFT_MUSHIES = 1000;
export function newFreeReferralOffer(now = new Date()) {
  const config = freeCreditRollout();
  const bonus = config.enabled && now.getTime() >= Date.parse(config.launchAt!);
  return { amount: bonus ? 500 : 1000, bonus, expiresAt: bonus ? bonusRewardGroup(now).expiresAt.toISOString() : null };
}
/**
 * Lineup v2 (owner 2026-09-16): the 1,000 welcome gift is paid in two halves —
 * 500 when the code is redeemed, 500 when the invitee's referral qualification
 * settles as `rewarded` (they played and came back; qualified-referrals.ts).
 * 28-day measurement: 2,669 referred accounts, 44% never charged a message,
 * so half of the old gift went to accounts that never played. Both halves are
 * expiring Bonus.
 */
export const REFERRAL_GIFT_V2_HALF = 500;

export async function referralWelcomePolicy(userId: string) {
  const wallet = await ensureWallet(userId);
  const effective = (await checkBalance(userId)).wallet.plan;
  if ((wallet.planVersion ?? 1) === 2) {
    return { amount: REFERRAL_GIFT_V2_HALF, bonus: true, expiresAt: bonusRewardGroup(new Date()).expiresAt.toISOString(), deferred: REFERRAL_GIFT_V2_HALF };
  }
  const config = freeCreditRollout();
  if (!config.enabled) return { amount: 1000, bonus: false, expiresAt: null };
  const account = await policyAccount(userId, effective, wallet.periodStart);
  const bonus = account.createdAt.getTime() >= Date.parse(config.launchAt!) && await useBonusRewards(userId, effective, wallet.periodStart);
  return { amount: bonus ? 500 : 1000, bonus, expiresAt: bonus ? bonusRewardGroup(new Date()).expiresAt.toISOString() : null };
}

// ─── Grant Rewards ──────────────────────────────────────────────────

/**
 * Add credits to a user's wallet (for referral / invite rewards).
 *
 * Referral & invite mushies are ADDON mushies: they land in `addonBalance` as
 * well as `balance` so the monthly refresh — which resets
 * `balance = monthlyCredits + addonBalance` — never wipes them. This mirrors the
 * mushie-pack purchase path (stripe.ts) and the addon-target admin grant. Bump
 * BOTH columns together; bumping `balance` alone would let the next period
 * boundary erase the reward.
 */
export async function grantCredits(
  userId: string,
  amount: number,
  description: string,
  database: LedgerDatabase = db,
  bonusReference?: string,
  bonusExpiresAt?: Date,
): Promise<void> {
  // A caller-owned transaction already initialized the wallet before claiming
  // the referral. Escaping to the global connection here can wait on that same
  // transaction (and always blocks a single-connection database).
  if (database === db) await ensureWallet(userId);
  await database.transaction(async (tx) => {
  const [updated] = await tx
    .update(creditWallets)
    .set({
      balance: sql`${creditWallets.balance} + ${amount}`,
      addonBalance: sql`${creditWallets.addonBalance} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(creditWallets.userId, userId))
    .returning();

  if (!updated) throw new Error("REFERRAL_WALLET_MISSING");
  if (bonusReference) await attachBonus(tx, updated.id, amount, bonusReference, "referral_welcome", bonusExpiresAt);
  // balanceAfter must be the REAL post-increment balance from the UPDATE's
  // RETURNING — computing it from the pre-increment read let the ledger row
  // disagree with the wallet under concurrent writes.
  await insertHashedTransaction({
    walletId: updated.id,
    amount,
    type: "referral_reward",
    balanceAfter: updated.balance,
    description,
  }, tx);
  });
}

/**
 * Grant a time-limited plan as a referral / invite-code reward.
 *
 * ONE package for everyone (owner decision 2026-07-26): the duration-scaled
 * mushie allowance, paid immediately by grantPlanEntitlement, PLUS the real
 * days as an entitlement overlay.
 *
 * The old credits-OR-days fork paid three different amounts for a single
 * milestone depending on how the recipient happened to already hold Gold — a
 * free user got 4000 + 7 days, a Stripe subscriber got 933 and no days, and a
 * comp-Gold user got NOTHING because the same-tier entitlement sat `queued`
 * and only the activation path minted mushies. Splitting the reward into
 * "allowance now, days on the overlay" removes the fork entirely: wallet.plan
 * still never moves for paid subscribers, and a reward that has to queue is
 * still visible in the ledger the day it is earned.
 */
export async function grantStackingPlanReward(
  userId: string,
  plan: PlanId,
  durationDays: number,
  ctx?: { sourceId?: string; idempotencyKey?: string },
): Promise<void> {
  await checkBalance(userId); // settle lazy expiry / pending downgrades first
  await grantPlanEntitlement(userId, {
    plan,
    durationDays,
    source: "referral",
    sourceId: ctx?.sourceId ?? "referral-reward",
    ...(ctx?.idempotencyKey && { idempotencyKey: ctx.idempotencyKey }),
  });
}

// ─── Process Milestones ─────────────────────────────────────────────

/**
 * Claim + grant any newly-earned milestones for a referrer. Called from the
 * redeem path, so wallet rewards fire as soon as the invitee registers/redeems.
 * Achievement tiers use the same registration count and are granted by the
 * achievement engine. Idempotent:
 * the claim is insert-first with onConflictDoNothing, so concurrent calls and
 * re-runs never double-grant. Badge tiers (5/15/30) are owned by the achievement
 * engine, not granted here.
 *
 * Returns the milestones newly granted in this call.
 */
export async function processReferralMilestones(
  referrerId: string,
  opts?: { silent?: boolean },
): Promise<MilestoneDef[]> {
  // Every wallet step counts ACTIVE friends (`confirmed`). Registrations
  // (`raw`) are still computed for the legacy backfill script but unlock
  // nothing — see the MILESTONES note in referral-rewards.ts.
  const [raw, confirmed] = await Promise.all([
    getRewardRawReferralCount(referrerId),
    getConfirmedReferralCount(referrerId),
  ]);
  const claimed = new Set((await getClaimedMilestones(referrerId)).map((m) => m.milestone));

  const candidates = selectEarnedMilestones(MILESTONES, { raw, confirmed }, claimed);
  const newlyGranted: MilestoneDef[] = [];

  for (const m of candidates) {
    if (!m.reward) continue; // defensive; selectEarnedMilestones already excludes badge-only

    // Insert-first claim. If another request already claimed it, skip the reward.
    const inserted = await db
      .insert(referralMilestones)
      .values({
        userId: referrerId,
        milestone: m.threshold,
        rewardType: m.reward.type,
        rewardDetail: m.detail,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) continue;

    try {
      if (m.reward.type === "credit_grant") {
        await grantCredits(referrerId, m.reward.credits, `Referral milestone: ${m.detail}`);
      } else {
        await grantStackingPlanReward(referrerId, m.reward.plan, m.reward.durationDays, {
          sourceId: `milestone:${m.threshold}`,
          idempotencyKey: `referral:${referrerId}:milestone:${m.threshold}`,
        });
      }
    } catch (err) {
      // Grant failed after the claim was written — roll the claim back so a later
      // trigger retries this milestone instead of locking the user out of it.
      await db
        .delete(referralMilestones)
        .where(eq(referralMilestones.id, inserted[0]!.id))
        .catch(() => {});
      console.error(
        `[referral] milestone ${m.threshold} grant failed for ${referrerId}:`,
        (err as Error).message,
      );
      continue;
    }

    if (!opts?.silent) {
      await notify(referrerId, "referral_milestone", {
        threshold: m.threshold,
        rewardType: m.reward.type,
        detail: m.detail,
        ...(m.reward.type === "credit_grant"
          ? { amount: m.reward.credits }
          : { plan: m.reward.plan, durationDays: m.reward.durationDays }),
      }).catch(() => {});
    }

    newlyGranted.push(m);
  }

  return newlyGranted;
}
