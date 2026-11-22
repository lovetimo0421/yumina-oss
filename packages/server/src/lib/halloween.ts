import { and, eq, gt, gte, lt, sql } from "drizzle-orm";
import { db, flagWrite } from "../db/index.js";
import { creditWallets, questClaims, usageLogs, user } from "../db/schema.js";
import { getCheckInWindow } from "./check-ins.js";
import { ensureWallet } from "./credit-service.js";
import { attachBonus, bonusCompatibilityEnabled } from "./free-credit-policy.js";
import { posthog } from "./posthog.js";
import { QUEST_TURN_ENDPOINTS_SQL } from "./quest-turn-endpoints.js";
import { insertHashedTransaction, type LedgerDatabase } from "./transaction-hash.js";

/**
 * Halloween 2026: "Trick or Treat".
 *
 * Five pumpkins hide around the site (the home feed, the chat input, the Studio
 * canvas, the community feed, settings). Opening one pays a random handful of
 * Bonus mushies once; sometimes a ghost "steals" it and hands back double.
 * Finding all five pays a fixed bonus and the Pumpkin Hunter achievement. A
 * side quest pays for 13 turns played during the event.
 *
 * Claims ride on `quest_claims` with periodKind "event" — the same unique key
 * (user, period, quest) that keeps a daily quest from paying twice keeps a
 * pumpkin from opening twice, so the event needs no table of its own. The
 * quest board's cap queries skip "event" rows.
 *
 * The window runs on reward-day boundaries (04:00 Asia/Shanghai), Oct 31 to
 * Nov 3, which covers Halloween night in the Americas. HALLOWEEN_STARTS_AT /
 * HALLOWEEN_ENDS_AT move it for testing.
 */
export const HALLOWEEN_ID = "halloween-2026";
export const HALLOWEEN_PERIOD_KIND = "event";

export function halloweenWindow(): { startsAt: Date; endsAt: Date } {
  const parse = (value: string | undefined, fallback: string) => {
    const d = new Date(value || fallback);
    return Number.isFinite(d.getTime()) ? d : new Date(fallback);
  };
  return {
    startsAt: parse(process.env.HALLOWEEN_STARTS_AT, "2026-10-30T20:00:00Z"),
    endsAt: parse(process.env.HALLOWEEN_ENDS_AT, "2026-11-02T20:00:00Z"),
  };
}

export function halloweenActive(now: Date = new Date()): boolean {
  const { startsAt, endsAt } = halloweenWindow();
  return now >= startsAt && now < endsAt;
}

export const PUMPKIN_SPOTS = ["home", "play", "studio", "community", "settings"] as const;
export type PumpkinSpot = (typeof PUMPKIN_SPOTS)[number];

export const ALL_FOUND_KEY = "pumpkin_all";
export const ALL_FOUND_BONUS = 500;
export const TURNS_KEY = "turns_13";
export const TURNS_GOAL = 13;
export const TURNS_REWARD = 300;

const pumpkinKey = (spot: PumpkinSpot) => `pumpkin_${spot}`;

/**
 * One pumpkin's candy: 30–200 in steps of 5. One in five is a trick — the
 * ghost takes it and gives back double, so the draw is 30–100 before doubling
 * and every pumpkin stays inside 30–200.
 */
export function drawCandy(random: () => number = Math.random): { amount: number; trick: boolean } {
  const trick = random() < 0.2;
  const steps = (lo: number, hi: number) => lo + 5 * Math.floor(random() * ((hi - lo) / 5 + 1));
  return trick ? { amount: steps(30, 100) * 2, trick } : { amount: steps(30, 200), trick };
}

/**
 * Accounts made for the event can't farm it: an account must predate the event
 * or have played at least one real turn.
 */
export async function halloweenEligible(userId: string, database: LedgerDatabase = db): Promise<boolean> {
  const { startsAt } = halloweenWindow();
  const [row] = await database.select({ createdAt: user.createdAt }).from(user).where(eq(user.id, userId)).limit(1);
  if (!row) return false;
  if (row.createdAt < startsAt) return true;
  const [turn] = await database.select({ one: sql<number>`1` }).from(usageLogs)
    .where(and(
      eq(usageLogs.userId, userId),
      sql`${usageLogs.endpoint} IN (${sql.raw(QUEST_TURN_ENDPOINTS_SQL)})`,
      gt(usageLogs.completionTokens, 0),
    ))
    .limit(1);
  return !!turn;
}

export async function halloweenTurns(userId: string, database: LedgerDatabase = db): Promise<number> {
  const { startsAt, endsAt } = halloweenWindow();
  const [r] = await database.select({ n: sql<number>`COUNT(*)` }).from(usageLogs)
    .where(and(
      eq(usageLogs.userId, userId),
      gte(usageLogs.createdAt, startsAt), lt(usageLogs.createdAt, endsAt),
      sql`${usageLogs.endpoint} IN (${sql.raw(QUEST_TURN_ENDPOINTS_SQL)})`,
      gt(usageLogs.completionTokens, 0),
    ));
  return Number(r?.n ?? 0);
}

export async function halloweenClaims(userId: string, database: LedgerDatabase = db): Promise<Map<string, number>> {
  const rows = await database.select({ questKey: questClaims.questKey, rewardAmount: questClaims.rewardAmount })
    .from(questClaims)
    .where(and(
      eq(questClaims.userId, userId),
      eq(questClaims.periodKind, HALLOWEEN_PERIOD_KIND),
      eq(questClaims.periodKey, HALLOWEEN_ID),
    ));
  return new Map(rows.map((r) => [r.questKey, r.rewardAmount]));
}

export interface HalloweenState {
  active: boolean;
  startsAt: string;
  endsAt: string;
  eligible: boolean;
  /** Spot → candy it paid. Spots not listed are still hidden. */
  found: Partial<Record<PumpkinSpot, number>>;
  allFoundBonus: number;
  allFoundClaimed: boolean;
  turns: { progress: number; goal: number; reward: number; claimed: boolean };
  /** Every mushie this event has paid this account. */
  total: number;
}

export async function halloweenState(userId: string): Promise<HalloweenState> {
  const { startsAt, endsAt } = halloweenWindow();
  const [claims, eligible, turns] = await Promise.all([
    halloweenClaims(userId), halloweenEligible(userId), halloweenTurns(userId),
  ]);
  const found: Partial<Record<PumpkinSpot, number>> = {};
  for (const spot of PUMPKIN_SPOTS) {
    const paid = claims.get(pumpkinKey(spot));
    if (paid !== undefined) found[spot] = paid;
  }
  return {
    active: halloweenActive(),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    eligible,
    found,
    allFoundBonus: ALL_FOUND_BONUS,
    allFoundClaimed: claims.has(ALL_FOUND_KEY),
    turns: { progress: Math.min(turns, TURNS_GOAL), goal: TURNS_GOAL, reward: TURNS_REWARD, claimed: claims.has(TURNS_KEY) },
    total: [...claims.values()].reduce((a, b) => a + b, 0),
  };
}

/**
 * Pay one event reward inside a transaction. Returns the new balance, or null
 * when this key was already paid (the unique key refused the claim row).
 */
async function payEventReward(
  tx: LedgerDatabase, userId: string, walletId: string, key: string, amount: number, description: string,
): Promise<number | null> {
  const inserted = await tx.insert(questClaims).values({
    userId,
    dayKey: getCheckInWindow(new Date()).dayKey,
    periodKind: HALLOWEEN_PERIOD_KIND,
    periodKey: HALLOWEEN_ID,
    questKey: key,
    rewardAmount: amount,
  }).onConflictDoNothing().returning();
  if (inserted.length === 0) return null;

  // Bonus mushies, like quest rewards: they survive the monthly refresh and
  // expire with the reward month.
  const [updated] = await tx.update(creditWallets)
    .set({
      balance: sql`${creditWallets.balance} + ${amount}`,
      addonBalance: sql`${creditWallets.addonBalance} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(creditWallets.userId, userId))
    .returning();
  if (!updated) throw new Error("HALLOWEEN_WALLET_UPDATE_FAILED");

  const reference = `event:${HALLOWEEN_ID}:${userId}:${key}`;
  if (bonusCompatibilityEnabled()) await attachBonus(tx, walletId, amount, reference, "check_in");
  await insertHashedTransaction({
    walletId, amount, type: "check_in", referenceId: reference, balanceAfter: updated.balance, description,
  }, tx);
  return Math.floor(updated.balance);
}

export type PumpkinOutcome =
  | { kind: "opened"; amount: number; trick: boolean; allFound: boolean; bonus: number; balance: number }
  | { kind: "already"; amount: number }
  | { kind: "closed" }
  | { kind: "ineligible" };

export async function openPumpkin(userId: string, spot: PumpkinSpot, random: () => number = Math.random): Promise<PumpkinOutcome> {
  if (!halloweenActive()) return { kind: "closed" };
  if (!(await halloweenEligible(userId))) return { kind: "ineligible" };
  const wallet = await ensureWallet(userId);
  const candy = drawCandy(random);

  const result = await db.transaction(async (tx): Promise<PumpkinOutcome> => {
    const [current] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, userId)).for("update");
    if (!current) throw new Error("HALLOWEEN_WALLET_MISSING");
    const label = candy.trick ? "trick, returned double" : "treat";
    const balance = await payEventReward(tx, userId, wallet.id, pumpkinKey(spot), candy.amount, `Halloween pumpkin (${spot}) · ${label}`);
    if (balance === null) {
      const [row] = await tx.select({ rewardAmount: questClaims.rewardAmount }).from(questClaims).where(and(
        eq(questClaims.userId, userId), eq(questClaims.periodKind, HALLOWEEN_PERIOD_KIND),
        eq(questClaims.periodKey, HALLOWEEN_ID), eq(questClaims.questKey, pumpkinKey(spot)),
      ));
      return { kind: "already", amount: row?.rewardAmount ?? 0 };
    }
    const claims = await halloweenClaims(userId, tx);
    const allFound = PUMPKIN_SPOTS.every((s) => claims.has(pumpkinKey(s)));
    let final = balance;
    let bonus = 0;
    if (allFound && !claims.has(ALL_FOUND_KEY)) {
      const paid = await payEventReward(tx, userId, wallet.id, ALL_FOUND_KEY, ALL_FOUND_BONUS, "Halloween · all five pumpkins found");
      if (paid !== null) { final = paid; bonus = ALL_FOUND_BONUS; }
    }
    return { kind: "opened", amount: candy.amount, trick: candy.trick, allFound, bonus, balance: final };
  });

  if (result.kind === "opened") {
    await flagWrite(userId).catch(() => {});
    if (result.bonus > 0) {
      // Lazy: the achievement engine pulls the DB seeding graph, and a failed
      // grant must never undo the candy that was just paid.
      void import("./achievements/engine.js")
        .then((m) => m.grantAchievement(userId, "pumpkin_hunter", "gold"))
        .catch(() => {});
    }
    try {
      posthog.capture({
        distinctId: userId,
        event: "halloween_pumpkin_opened",
        properties: { spot, amount: result.amount, trick: result.trick, all_found: result.allFound, bonus: result.bonus },
      });
    } catch { /* diagnostics must never change the outcome */ }
  }
  return result;
}

export type TurnsOutcome =
  | { kind: "claimed"; amount: number; balance: number }
  | { kind: "incomplete"; progress: number }
  | { kind: "already" }
  | { kind: "closed" }
  | { kind: "ineligible" };

export async function claimHalloweenTurns(userId: string): Promise<TurnsOutcome> {
  if (!halloweenActive()) return { kind: "closed" };
  if (!(await halloweenEligible(userId))) return { kind: "ineligible" };
  const progress = await halloweenTurns(userId, db);
  if (progress < TURNS_GOAL) return { kind: "incomplete", progress };
  const wallet = await ensureWallet(userId);
  const result = await db.transaction(async (tx): Promise<TurnsOutcome> => {
    const [current] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, userId)).for("update");
    if (!current) throw new Error("HALLOWEEN_WALLET_MISSING");
    const balance = await payEventReward(tx, userId, wallet.id, TURNS_KEY, TURNS_REWARD, `Halloween · ${TURNS_GOAL} turns played`);
    return balance === null ? { kind: "already" } : { kind: "claimed", amount: TURNS_REWARD, balance };
  });
  if (result.kind === "claimed") {
    await flagWrite(userId).catch(() => {});
    try {
      posthog.capture({ distinctId: userId, event: "halloween_turns_claimed", properties: { amount: result.amount } });
    } catch { /* diagnostics must never change the outcome */ }
  }
  return result;
}
