/**
 * Scheduled drops for billing lineup v2 (plan-config-v2.ts).
 *
 * A v2 wallet's cycle pile is not handed over at once. The grant paths
 * (ensureWallet / syncPlan / refreshMonthlyCredits) pay drop 0 and record
 * `wallet_plan_drops(wallet_id, period_start, drops_released = 1)`. Later
 * drops are released lazily by `releaseDueDrops` — called from checkBalance
 * (every generation) and the wallet GET — once their day threshold inside the
 * cycle has passed. Drops land in the Monthly bucket only (balance, not
 * addon_balance), so they carry inside the cycle and reset at renewal exactly
 * like the rest of the plan pile.
 *
 * Idempotent under concurrency: the wallet row is locked FOR UPDATE and the
 * drops row is compared against the wallet's current period_start, so a cycle
 * rollover or a concurrent release can never double-pay a drop.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditTransactions, creditWallets, walletPlanDrops } from "../db/schema.js";
import { PLANS_V2, dueDrops, nextDrop, type PlanConfigV2 } from "./plan-config-v2.js";
import type { PlanId } from "./plan-config.js";
import { insertHashedTransaction, type LedgerDatabase } from "./transaction-hash.js";

/** The v2 config for a plan (internal falls back to a single full drop). */
export function planConfigV2(plan: string): PlanConfigV2 {
  return PLANS_V2[plan as PlanId] ?? PLANS_V2.free;
}

/** Amount paid at grant time for a v2 wallet: the first drop. */
export function initialDropAmount(plan: string): number {
  return planConfigV2(plan).drops[0]?.amount ?? 0;
}

/** Record that a fresh cycle has started and drop 0 was paid. Call inside the grant transaction. */
export async function startDropCycle(database: LedgerDatabase, walletId: string, periodStart: Date): Promise<void> {
  await database
    .insert(walletPlanDrops)
    .values({ walletId, periodStart, dropsReleased: 1, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: walletPlanDrops.walletId,
      set: { periodStart, dropsReleased: 1, updatedAt: new Date() },
    });
}

export interface ReleasedDrop { index: number; amount: number; balanceAfter: number }

/**
 * Lock-free pre-check for `releaseDueDrops`: is there anything for it to do?
 *
 * `releaseDueDrops` opens a transaction and takes `SELECT … FOR UPDATE` on the
 * wallet row, and it is called on EVERY generation. For all but the two or
 * three days a cycle when a drop actually lands that is a write-path lock for
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
  // Drop 0 is always paid by the grant path, so before the second drop's day
  // there is provably nothing to release and nothing to read.
  const due = dueDrops(config, wallet.periodStart, now);
  if (due.length <= 1) return false;
  const [row] = await database
    .select({ periodStart: walletPlanDrops.periodStart, dropsReleased: walletPlanDrops.dropsReleased })
    .from(walletPlanDrops)
    .where(eq(walletPlanDrops.walletId, wallet.id))
    .limit(1);
  if (!row || row.periodStart.getTime() !== wallet.periodStart.getTime()) return true; // repair + release
  return due.length > row.dropsReleased;
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

    const [row] = await tx.select().from(walletPlanDrops).where(eq(walletPlanDrops.walletId, wallet.id)).limit(1);
    // A drops row from an older cycle means the grant path rolled the cycle
    // without recording it (should not happen); treat as a fresh cycle.
    const released = row && row.periodStart.getTime() === wallet.periodStart.getTime() ? row.dropsReleased : 1;
    const due = dueDrops(config, wallet.periodStart, now);
    if (due.length <= released) {
      if (!row || row.periodStart.getTime() !== wallet.periodStart.getTime()) {
        await startDropCycle(tx, wallet.id, wallet.periodStart);
      }
      return [];
    }

    const paid: ReleasedDrop[] = [];
    let balance = wallet.balance;
    for (let i = released; i < due.length; i++) {
      const drop = config.drops[i]!;
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
        description: `Scheduled drop ${i + 1}/${config.drops.length} — ${wallet.plan} plan (day ${drop.day})`,
      }, tx);
      paid.push({ index: i, amount: drop.amount, balanceAfter: balance });
    }
    await tx
      .insert(walletPlanDrops)
      .values({ walletId: wallet.id, periodStart: wallet.periodStart, dropsReleased: released + paid.length, updatedAt: now })
      .onConflictDoUpdate({
        target: walletPlanDrops.walletId,
        set: { periodStart: wallet.periodStart, dropsReleased: released + paid.length, updatedAt: now },
      });
    return paid;
  });
}

/** How many drops of the wallet's CURRENT cycle have been paid (drop 0 counts). 0 for v1 wallets. */
export async function releasedDropsFor(
  wallet: { id: string; planVersion: number; periodStart: Date },
  database: LedgerDatabase = db,
): Promise<number> {
  if (wallet.planVersion !== 2) return 0;
  const [row] = await database
    .select({ periodStart: walletPlanDrops.periodStart, dropsReleased: walletPlanDrops.dropsReleased })
    .from(walletPlanDrops)
    .where(eq(walletPlanDrops.walletId, wallet.id))
    .limit(1);
  return row && row.periodStart.getTime() === wallet.periodStart.getTime() ? row.dropsReleased : 1;
}

export interface SettledDrop { index: number; amount: number; balanceAfter: number }

/**
 * Pay out every drop of the CURRENT cycle that has not landed yet, ahead of
 * schedule. Used when a paid upgrade restarts the billing cycle (in-app plan
 * change, 2026-09-17): the user paid for the whole pile of the plan they are
 * leaving, and the cycle restart would otherwise discard drops 2/3 when
 * startDropCycle re-arms the ledger for the new plan.
 *
 * Must run inside the caller's transaction with the wallet row locked;
 * `wallet` is that locked row. Idempotent: the reference ids are the ones
 * releaseDueDrops would have used, and any that already exist are skipped.
 * Drops land in `balance` only (Monthly bucket), like a scheduled release.
 */
export async function settleUndeliveredDrops(
  tx: LedgerDatabase,
  wallet: { id: string; plan: string; planVersion: number; periodStart: Date; balance: number },
  now = new Date(),
): Promise<SettledDrop[]> {
  if ((wallet.planVersion ?? 1) !== 2) return [];
  const config = planConfigV2(wallet.plan);
  if (config.drops.length <= 1) return [];
  const released = await releasedDropsFor(wallet, tx);
  const paid: SettledDrop[] = [];
  let balance = wallet.balance;
  for (let i = released; i < config.drops.length; i++) {
    const drop = config.drops[i]!;
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
      description: `Upgrade settlement — ${wallet.plan} drop ${i + 1} of ${config.drops.length} paid early`,
    }, tx);
    paid.push({ index: i, amount: drop.amount, balanceAfter: balance });
  }
  await tx
    .insert(walletPlanDrops)
    .values({ walletId: wallet.id, periodStart: wallet.periodStart, dropsReleased: config.drops.length, updatedAt: now })
    .onConflictDoUpdate({
      target: walletPlanDrops.walletId,
      set: { periodStart: wallet.periodStart, dropsReleased: config.drops.length, updatedAt: now },
    });
  return paid;
}

/** For the wallet UI: the next scheduled drop of a v2 wallet, or null. */
export async function nextDropFor(wallet: { id: string; plan: string; planVersion: number; periodStart: Date }, database: LedgerDatabase = db): Promise<{ amount: number; at: string } | null> {
  if (wallet.planVersion !== 2) return null;
  const config = planConfigV2(wallet.plan);
  const [row] = await database.select().from(walletPlanDrops).where(eq(walletPlanDrops.walletId, wallet.id)).limit(1);
  const released = row && row.periodStart.getTime() === wallet.periodStart.getTime() ? row.dropsReleased : 1;
  const next = nextDrop(config, wallet.periodStart, released);
  return next ? { amount: next.amount, at: next.at.toISOString() } : null;
}
