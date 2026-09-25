import { eq, sql } from "drizzle-orm";
import { bonusRewardGroup } from "@yumina/shared";
import { db, flagWrite } from "../db/index.js";
import { creditWallets, questClaims } from "../db/schema.js";
import { getCheckInWindow, type CheckInWindow } from "./check-ins.js";
import { ensureWallet, type CreditWallet } from "./credit-service.js";
import { resolveEffectivePlanWithEventEntitlements } from "./event-plan-entitlements.js";
import { attachBonus, bonusCompatibilityEnabled } from "./free-credit-policy.js";
import { PLANS_V2 } from "./plan-config-v2.js";
import type { PlanId } from "./plan-config.js";
import { posthog } from "./posthog.js";
import {
  countsAgainstCap, isLockedFor, isOnBoard, questBonusUsedThisCycle, questProgress, questRewardCapped, walletUsesQuests,
  type QuestDef, type QuestProgress,
} from "./quests.js";
import { insertHashedTransaction } from "./transaction-hash.js";

/**
 * Paying a finished quest, shared by the Claim button (routes/quests.ts) and
 * the automatic collector (quest-auto-collect.ts). One code path means one set
 * of rules: the board, the plan, the lock, the cycle cap, the ledger row and
 * the Bonus lot are identical however the reward is triggered.
 */

/** A cycle quest's period key: the day the wallet's cycle started. */
export const cycleKey = (periodStart: Date) => periodStart.toISOString().slice(0, 10);

export interface QuestClaimContext {
  userId: string;
  wallet: CreditWallet;
  planVersion: number;
  effectivePlan: PlanId;
  /** The reward window the claim belongs to. Pass `at` to claim for the window an event fell in. */
  window: CheckInWindow;
}

export async function questClaimContext(userId: string, at: Date = new Date()): Promise<QuestClaimContext> {
  const window = getCheckInWindow(at);
  const wallet = await ensureWallet(userId);
  const planVersion = wallet.planVersion ?? 1;
  const effectivePlan = (await resolveEffectivePlanWithEventEntitlements(userId, wallet.plan as PlanId)) as PlanId;
  return { userId, wallet, planVersion, effectivePlan, window };
}

export function questPeriod(quest: QuestDef, ctx: QuestClaimContext): { periodKey: string; from: Date; to: Date } {
  if (quest.period === "day") return { periodKey: ctx.window.dayKey, from: ctx.window.previousResetAt, to: ctx.window.nextResetAt };
  if (quest.period === "week") return { periodKey: ctx.window.weekKey, from: ctx.window.weekStartsAt, to: ctx.window.weekEndsAt };
  return { periodKey: cycleKey(ctx.wallet.periodStart), from: ctx.wallet.periodStart, to: ctx.wallet.periodEnd };
}

/** "claim" is the button; "event" and "sweep" are the collector, and mark the ledger line. */
export type QuestClaimTrigger = "claim" | "event" | "sweep";

export type QuestClaimOutcome =
  | { kind: "claimed"; reward: number; balance: number }
  | { kind: "wrong_lineup" }
  | { kind: "not_on_board" }
  | { kind: "locked" }
  | { kind: "unverified"; quest: QuestProgress }
  | { kind: "incomplete"; quest: QuestProgress }
  | { kind: "cap_reached"; cap: number; used: number }
  | { kind: "already" };

/** Everything that can refuse a claim before any reading of progress. Null means "go ahead". */
export function questClaimGate(ctx: QuestClaimContext, quest: QuestDef): QuestClaimOutcome | null {
  if (!walletUsesQuests(ctx.planVersion, ctx.window.previousResetAt) || ctx.effectivePlan === "internal") return { kind: "wrong_lineup" };
  if (!isOnBoard(quest, ctx.window.weekdayIndex)) return { kind: "not_on_board" };
  // Free has no forge; every paid tier does, on either lineup.
  if (quest.period === "cycle" && ctx.effectivePlan === "free") return { kind: "not_on_board" };
  if (isLockedFor(ctx.effectivePlan, quest)) return { kind: "locked" };
  return null;
}

export async function claimQuest(
  ctx: QuestClaimContext,
  quest: QuestDef,
  options: { trigger: QuestClaimTrigger },
): Promise<QuestClaimOutcome> {
  const refused = questClaimGate(ctx, quest);
  if (refused) return refused;
  const { periodKey, from, to } = questPeriod(quest, ctx);
  const auto = options.trigger !== "claim";

  const result = await db.transaction(async (tx): Promise<QuestClaimOutcome> => {
    const [current] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, ctx.userId)).for("update");
    if (!current) throw new Error("QUEST_WALLET_MISSING");

    const progress = await questProgress(ctx.userId, quest, from, to, tx);
    // Verification did not run (replica lag, a table mid-migration). Ask the
    // player to try again rather than guessing in either direction.
    if (!progress.verified) return { kind: "unverified", quest: progress };
    if (!progress.done) return { kind: "incomplete", quest: progress };

    const used = countsAgainstCap(quest) ? await questBonusUsedThisCycle(ctx.userId, current.periodStart, tx) : 0;
    const reward = questRewardCapped(ctx.effectivePlan, quest, used);
    // Budget spent: refuse before writing anything. Letting a claim through to a
    // zero payout burns the quest, writes a "+0" ledger row and reads as a bug.
    if (reward <= 0) return { kind: "cap_reached", cap: PLANS_V2[ctx.effectivePlan]?.questMonthlyCap ?? 0, used };

    const inserted = await tx.insert(questClaims).values({
      userId: ctx.userId,
      dayKey: ctx.window.dayKey,
      periodKind: quest.period,
      periodKey,
      questKey: quest.key,
      rewardAmount: reward,
    }).onConflictDoNothing().returning();
    if (inserted.length === 0) return { kind: "already" };

    // Quest rewards are Bonus mushies: they sit in addonBalance so the monthly
    // refresh never wipes them, and each lot expires with its reward month.
    const [updated] = await tx.update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} + ${reward}`,
        addonBalance: sql`${creditWallets.addonBalance} + ${reward}`,
        updatedAt: new Date(),
      })
      .where(eq(creditWallets.userId, ctx.userId))
      .returning();
    if (!updated) throw new Error("QUEST_WALLET_UPDATE_FAILED");

    const reference = `quest:${ctx.userId}:${quest.period}:${periodKey}:${quest.key}`;
    if (bonusCompatibilityEnabled()) {
      await attachBonus(tx, current.id, reward, reference, "check_in", bonusRewardGroup(new Date()).expiresAt);
    }
    const kind = quest.period === "day" ? "Daily" : quest.period === "week" ? "Weekly" : "Cycle";
    await insertHashedTransaction({
      walletId: current.id,
      amount: reward,
      type: "check_in",
      referenceId: reference,
      balanceAfter: updated.balance,
      // The ledger is where a player who never opened the board learns why the
      // balance moved, so the line says it was collected for them.
      description: `${kind} quest (${quest.key})${auto ? " · collected for you" : ""}`,
    }, tx);

    return { kind: "claimed", reward, balance: Math.floor(updated.balance) };
  });

  if (result.kind !== "claimed") return result;

  await flagWrite(ctx.userId).catch(() => {});
  try {
    posthog.capture({
      distinctId: ctx.userId,
      event: "quest_claimed",
      properties: {
        quest_key: quest.key, period: quest.period, plan: ctx.effectivePlan, plan_version: ctx.planVersion,
        reward: result.reward, fixed: !countsAgainstCap(quest), auto, trigger: options.trigger, day_key: ctx.window.dayKey,
      },
    });
  } catch { /* diagnostics must never change the outcome */ }
  return result;
}
