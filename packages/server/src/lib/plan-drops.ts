/**
 * Scheduled drops for billing lineup v2 (plan-config-v2.ts).
 *
 * A v2 wallet's cycle pile is not handed over at once. The grant paths
 * (ensureWallet / syncPlan / refreshMonthlyCredits) pay drop 0 and record
 * `wallet_plan_drops(wallet_id, period_start, drops_released = 1, schedule)`.
 * Later drops are released lazily by `releaseDueDrops` — called from
 * checkBalance (every generation) and the wallet GET — once their day
 * threshold inside the cycle has passed. Drops land in the Monthly bucket only
 * (balance, not addon_balance), so they carry inside the cycle and reset at
 * renewal exactly like the rest of the plan pile.
 *
 * The SCHEDULE is fixed when the cycle opens (`schedule` column, see
 * DROP_SCHEDULES in plan-config-v2.ts). A paid cycle that opened under the
 * launch schedule keeps paying on days 10 and 20; only cycles that open after
 * the 2026-09-22 change pay on days 7, 14 and 21. A NULL schedule (rows from
 * before the column existed, or a cycle the grant path opened without a row)
 * is the launch schedule — nothing else could have paid its drop 0.
 *
 * Idempotent under concurrency: the wallet row is locked FOR UPDATE and the
 * drops row is compared against the wallet's current period_start, so a cycle
 * rollover or a concurrent release can never double-pay a drop.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditTransactions, creditWallets, walletPlanDrops } from "../db/schema.js";
import {
  CURRENT_DROP_SCHEDULE,
  DROP_SCHEDULES,
  PLANS_V2,
  dropsFor,
  dueDrops,
  nextDrop,
  normalizeDropSchedule,
  type DropScheduleKey,
  type PlanConfigV2,
  type PlanDrop,
} from "./plan-config-v2.js";
import type { PlanId } from "./plan-config.js";
import { insertHashedTransaction, type LedgerDatabase } from "./transaction-hash.js";

/** The v2 config for a plan (internal falls back to a single full drop). */
export function planConfigV2(plan: string): PlanConfigV2 {
  return PLANS_V2[plan as PlanId] ?? PLANS_V2.free;
}

/** Amount paid at grant time for a v2 wallet: the first drop of the CURRENT schedule. */
export function initialDropAmount(plan: string): number {
  return dropsFor(plan, CURRENT_DROP_SCHEDULE)[0]?.amount ?? 0;
}

/**
 * Record that a fresh cycle has started and drop 0 was paid. Call inside the
 * grant transaction, right after paying `initialDropAmount` — the two must
 * agree on the schedule, which is why both default to CURRENT_DROP_SCHEDULE.
 * The repair path passes the schedule it decided the cycle is on.
 */
export async function startDropCycle(
  database: LedgerDatabase,
  walletId: string,
  periodStart: Date,
  schedule: DropScheduleKey = CURRENT_DROP_SCHEDULE,
): Promise<void> {
  await database
    .insert(walletPlanDrops)
    .values({ walletId, periodStart, dropsReleased: 1, schedule, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: walletPlanDrops.walletId,
      set: { periodStart, dropsReleased: 1, schedule, updatedAt: new Date() },
    });
}

/** What the drops row says about the wallet's CURRENT cycle. */
export interface DropCycle {
  /** Drops paid so far, drop 0 included. 1 when the row is missing or stale. */
  released: number;
  /** Schedule the cycle opened under. A missing or stale row can only be the launch schedule. */
  schedule: DropScheduleKey;
  /** The cycle's drops under that schedule. */
  drops: PlanDrop[];
  /** False when the row is missing or belongs to an older cycle and needs the repair `releaseDueDrops` performs. */
  recorded: boolean;
}

function readCycle(
  wallet: { plan: string; periodStart: Date },
  row: { periodStart: Date; dropsReleased: number; schedule?: string | null } | undefined,
): DropCycle {
  const current = !!row && row.periodStart.getTime() === wallet.periodStart.getTime();
  const schedule = current ? normalizeDropSchedule(row.schedule) : "d10_20";
  return {
    released: current ? row.dropsReleased : 1,
    schedule,
    drops: dropsFor(wallet.plan, schedule),
    recorded: current,
  };
}

/** Read the drops row for a v2 wallet's current cycle (one primary-key lookup). */
export async function dropCycleFor(
  wallet: { id: string; plan: string; planVersion: number; periodStart: Date },
  database: LedgerDatabase = db,
): Promise<DropCycle> {
  const [row] = await database
    .select({ periodStart: walletPlanDrops.periodStart, dropsReleased: walletPlanDrops.dropsReleased, schedule: walletPlanDrops.schedule })
    .from(walletPlanDrops)
    .where(eq(walletPlanDrops.walletId, wallet.id))
    .limit(1);
  return readCycle(wallet, row);
}

export interface ReleasedDrop { index: number; amount: number; balanceAfter: number }

/** The earliest day any schedule pays a paid plan's second drop: before it, no cycle can owe anything. */
function earliestSecondDropDay(plan: string): number {
  const config = planConfigV2(plan);
  if (config.id === "free" || config.id === "internal") return config.drops[1]?.day ?? Infinity;
  return Math.min(...Object.values(DROP_SCHEDULES).map((make) => make(config.monthlyCredits)[1]?.day ?? Infinity));
}

/**
 * Lock-free pre-check for `releaseDueDrops`: is there anything for it to do?
 *
 * `releaseDueDrops` opens a transaction and takes `SELECT … FOR UPDATE` on the
 * wallet row, and it is called on EVERY generation. For all but the three or
 * four days a cycle when a drop actually lands that is a write-path lock for
 * nothing. This answers the same question from the wallet the caller already
 * holds plus one primary-key read, and returns true only when the transaction
 * would change something: a drop is due, or the drops row is missing/stale and
 * needs the same repair `releaseDueDrops` performs.
 */
export async function hasDropWork(
  wallet: { id: string; plan: string; planVersion: number; periodStart: Date },
  now = new Date(),
  database: LedgerDatabase = db,
): Promise<boolean> {
  if (wallet.planVersion !== 2) return false;
  const config = planConfigV2(wallet.plan);
  if (config.drops.length <= 1) return false;
  // Drop 0 is always paid by the grant path, so before the earliest second
  // drop of any schedule there is provably nothing to release and nothing to read.
  const elapsedDays = Math.floor((now.getTime() - wallet.periodStart.getTime()) / 86_400_000);
  if (elapsedDays < earliestSecondDropDay(wallet.plan)) return false;
  const cycle = await dropCycleFor(wallet, database);
  if (!cycle.recorded) return true; // repair + release
  return dueDrops(cycle.drops, wallet.periodStart, now).length > cycle.released;
}

/**
 * Release every drop whose day threshold has passed for a v2 wallet.
 * Returns the drops paid in this call (empty for v1 wallets, no-op cycles,
 * or when nothing is due). Never throws for a missing drops row: a v2 wallet
 * whose cycle predates the ledger is treated as having received drop 0.
 */
export async function releaseDueDrops(userId: string, now = new Date(), database: LedgerDatabase = db): Promise<ReleasedDrop[]> {
  return database.transaction(async (tx) => {
    const [wallet] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, userId)).for("update");
    if (!wallet || (wallet.planVersion ?? 1) !== 2) return [];
    const config = planConfigV2(wallet.plan);
    if (config.drops.length <= 1) return [];

    // A drops row from an older cycle means the grant path rolled the cycle
    // without recording it (should not happen); treat as a fresh cycle on the
    // launch schedule — the only one a row-less cycle can have opened under.
    const cycle = await dropCycleFor({ ...wallet, planVersion: 2 }, tx);
    const { released, schedule, drops } = cycle;
    const due = dueDrops(drops, wallet.periodStart, now);
    if (due.length <= released) {
      if (!cycle.recorded) await startDropCycle(tx, wallet.id, wallet.periodStart, schedule);
      return [];
    }

    const paid: ReleasedDrop[] = [];
    let balance = wallet.balance;
    for (let i = released; i < due.length; i++) {
      const drop = drops[i]!;
      const [updated] = await tx
        .update(creditWallets)
        .set({ balance: sql`${creditWallets.balance} + ${drop.amount}`, updatedAt: now })
        .where(and(eq(creditWallets.id, wallet.id), eq(creditWallets.periodStart, wallet.periodStart)))
        .returning();
      if (!updated) break; // cycle rolled underneath us; stop, the new cycle starts its own ledger
      balance = updated.balance;
      await insertHashedTransaction({
        walletId: wallet.id,
        amount: drop.amount,
        type: "plan_grant",
        referenceId: `drop:${wallet.id}:${wallet.periodStart.toISOString()}:${i}`,
        balanceAfter: balance,
        description: `Scheduled drop ${i + 1}/${drops.length} — ${wallet.plan} plan (day ${drop.day})`,
      }, tx);
      paid.push({ index: i, amount: drop.amount, balanceAfter: balance });
    }
    await tx
      .insert(walletPlanDrops)
      .values({ walletId: wallet.id, periodStart: wallet.periodStart, dropsReleased: released + paid.length, schedule, updatedAt: now })
      .onConflictDoUpdate({
        target: walletPlanDrops.walletId,
        set: { periodStart: wallet.periodStart, dropsReleased: released + paid.length, schedule, updatedAt: now },
      });
    return paid;
  });
}

/** How many drops of the wallet's CURRENT cycle have been paid (drop 0 counts). 0 for v1 wallets. */
export async function releasedDropsFor(
  wallet: { id: string; plan: string; planVersion: number; periodStart: Date },
  database: LedgerDatabase = db,
): Promise<number> {
  if (wallet.planVersion !== 2) return 0;
  return (await dropCycleFor(wallet, database)).released;
}

export interface SettledDrop { index: number; amount: number; balanceAfter: number }

/**
 * Pay out every drop of the CURRENT cycle that has not landed yet, ahead of
 * schedule. Used when a paid upgrade restarts the billing cycle (in-app plan
 * change, 2026-09-17): the user paid for the whole pile of the plan they are
 * leaving, and the cycle restart would otherwise discard the later drops when
 * startDropCycle re-arms the ledger for the new plan.
 *
 * Must run inside the caller's transaction with the wallet row locked;
 * `wallet` is that locked row. Idempotent: the reference ids are the ones
 * releaseDueDrops would have used, and any that already exist are skipped.
 * Drops land in `balance` only (Monthly bucket), like a scheduled release.
 * The drops settled are the ones of the schedule the cycle OPENED under.
 */
export async function settleUndeliveredDrops(
  tx: LedgerDatabase,
  wallet: { id: string; plan: string; planVersion: number; periodStart: Date; balance: number },
  now = new Date(),
): Promise<SettledDrop[]> {
  if ((wallet.planVersion ?? 1) !== 2) return [];
  const config = planConfigV2(wallet.plan);
  if (config.drops.length <= 1) return [];
  const { released, schedule, drops } = await dropCycleFor({ ...wallet, planVersion: 2 }, tx);
  const paid: SettledDrop[] = [];
  let balance = wallet.balance;
  for (let i = released; i < drops.length; i++) {
    const drop = drops[i]!;
    const referenceId = `drop:${wallet.id}:${wallet.periodStart.toISOString()}:${i}`;
    const [existing] = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.walletId, wallet.id), eq(creditTransactions.referenceId, referenceId)))
      .limit(1);
    if (existing) continue;
    const [updated] = await tx
      .update(creditWallets)
      .set({ balance: sql`${creditWallets.balance} + ${drop.amount}`, updatedAt: now })
      .where(and(eq(creditWallets.id, wallet.id), eq(creditWallets.periodStart, wallet.periodStart)))
      .returning();
    if (!updated) break; // cycle rolled underneath us — the caller's lock should make this impossible
    balance = updated.balance;
    await insertHashedTransaction({
      walletId: wallet.id,
      amount: drop.amount,
      type: "plan_grant",
      referenceId,
      balanceAfter: balance,
      // No "k/n" — the admin ledger formatter rewrites slash patterns as model ids.
      description: `Upgrade settlement — ${wallet.plan} drop ${i + 1} of ${drops.length} paid early`,
    }, tx);
    paid.push({ index: i, amount: drop.amount, balanceAfter: balance });
  }
  await tx
    .insert(walletPlanDrops)
    .values({ walletId: wallet.id, periodStart: wallet.periodStart, dropsReleased: drops.length, schedule, updatedAt: now })
    .onConflictDoUpdate({
      target: walletPlanDrops.walletId,
      set: { periodStart: wallet.periodStart, dropsReleased: drops.length, schedule, updatedAt: now },
    });
  return paid;
}

/** For the wallet UI: the next scheduled drop of a v2 wallet, or null. */
export async function nextDropFor(wallet: { id: string; plan: string; planVersion: number; periodStart: Date }, database: LedgerDatabase = db): Promise<{ amount: number; at: string } | null> {
  if (wallet.planVersion !== 2) return null;
  const { released, drops } = await dropCycleFor(wallet, database);
  const next = nextDrop(drops, wallet.periodStart, released);
  return next ? { amount: next.amount, at: next.at.toISOString() } : null;
}
