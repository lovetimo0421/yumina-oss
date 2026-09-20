import "../test/database-fixture.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditTransactions, creditWallets, user } from "../db/schema.js";
import { deductCredits, refreshMonthlyCredits, syncPlan } from "./credit-service.js";
import { insertHashedTransaction } from "./transaction-hash.js";
import { verifyLedger } from "./ledger-verifier.js";

after(async () => { await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close(); });

const DAY = 86_400_000;

async function makeWallet(opts: { plan: string; balance: number; addon: number; periodEnd: Date; monthly?: number; source?: string | null }) {
  const userId = `lg-${crypto.randomUUID()}`;
  await db.insert(user).values({ id: userId, name: "Ledger guard", email: `${userId}@test.local`, emailVerified: true });
  const [w] = await db.insert(creditWallets).values({
    id: crypto.randomUUID(),
    userId,
    balance: opts.balance,
    addonBalance: opts.addon,
    plan: opts.plan,
    monthlyCredits: opts.monthly ?? 2000,
    planVersion: 1,
    periodStart: new Date(opts.periodEnd.getTime() - 30 * DAY),
    periodEnd: opts.periodEnd,
    subscriptionSource: opts.source === undefined ? null : opts.source,
  }).returning();
  // Opening row so the chain has a genesis matching the seeded balance.
  await insertHashedTransaction({ walletId: w!.id, amount: opts.balance, type: "plan_grant", balanceAfter: opts.balance, description: "seed" });
  return { userId, walletId: w!.id };
}

async function ledger(walletId: string) {
  return db.select().from(creditTransactions).where(eq(creditTransactions.walletId, walletId)).orderBy(asc(creditTransactions.createdAt), asc(creditTransactions.id));
}

async function balanceOf(walletId: string) {
  const [row] = await db.select({ balance: creditWallets.balance }).from(creditWallets).where(eq(creditWallets.id, walletId));
  return row!.balance;
}

describe("ledger guard (database constraint)", () => {
  it("rejects a balance change that writes no ledger row, and keeps the old balance", async () => {
    const { walletId } = await makeWallet({ plan: "free", balance: 500, addon: 0, periodEnd: new Date(Date.now() + 10 * DAY) });
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.update(creditWallets).set({ balance: sql`${creditWallets.balance} - 100` }).where(eq(creditWallets.id, walletId));
      }),
      /LEDGER_GUARD/,
    );
    assert.equal(await balanceOf(walletId), 500);
  });

  it("rejects a ledger row that does not match the new balance", async () => {
    const { walletId } = await makeWallet({ plan: "free", balance: 500, addon: 0, periodEnd: new Date(Date.now() + 10 * DAY) });
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.update(creditWallets).set({ balance: sql`${creditWallets.balance} - 100` }).where(eq(creditWallets.id, walletId));
        await insertHashedTransaction({ walletId, amount: -50, type: "usage", balanceAfter: 450, description: "wrong" }, tx);
      }),
      /LEDGER_GUARD/,
    );
    assert.equal(await balanceOf(walletId), 500);
  });

  it("accepts a balance change with a matching ledger row, including several moves in one transaction", async () => {
    const { walletId } = await makeWallet({ plan: "free", balance: 500, addon: 0, periodEnd: new Date(Date.now() + 10 * DAY) });
    await db.transaction(async (tx) => {
      await tx.update(creditWallets).set({ balance: sql`${creditWallets.balance} - 100` }).where(eq(creditWallets.id, walletId));
      await insertHashedTransaction({ walletId, amount: -100, type: "usage", balanceAfter: 400, description: "step 1" }, tx);
      await tx.update(creditWallets).set({ balance: sql`${creditWallets.balance} + 30` }).where(eq(creditWallets.id, walletId));
      await insertHashedTransaction({ walletId, amount: 30, type: "refund", balanceAfter: 430, description: "step 2" }, tx);
    });
    assert.equal(await balanceOf(walletId), 430);
  });

  it("lets the ordinary debit path through", async () => {
    const { userId, walletId } = await makeWallet({ plan: "free", balance: 500, addon: 0, periodEnd: new Date(Date.now() + 10 * DAY) });
    const r = await deductCredits(userId, 12.5, "usage-1", "model — 100 tokens (stopped)");
    assert.equal(r.newBalance, 487.5);
    assert.equal(await balanceOf(walletId), 487.5);
  });
});

describe("monthly reset writes the expiry down", () => {
  it("renewal: expiry row for the unused monthly mushies, then the grant, chain intact", async () => {
    const { userId, walletId } = await makeWallet({ plan: "free", balance: 1240, addon: 100, periodEnd: new Date(Date.now() - 60_000) });
    assert.equal(await refreshMonthlyCredits(userId), true);
    const rows = (await ledger(walletId)).slice(1);
    assert.deepEqual(rows.map((r) => [r.type, r.amount, r.balanceAfter, r.description]), [
      ["monthly_expiry", -1140, 100, "Unused monthly mushies expired at renewal"],
      ["plan_grant", 2000, 2100, "Monthly free plan renewal"],
    ]);
    assert.equal(await balanceOf(walletId), 2100);
    // No expiry row when nothing monthly is left.
    const empty = await makeWallet({ plan: "free", balance: 100, addon: 100, periodEnd: new Date(Date.now() - 60_000) });
    await refreshMonthlyCredits(empty.userId);
    assert.deepEqual((await ledger(empty.walletId)).slice(1).map((r) => r.type), ["plan_grant"]);
  });

  it("plan change and plan end name the reason", async () => {
    const change = await makeWallet({ plan: "free", balance: 800, addon: 0, periodEnd: new Date(Date.now() + 10 * DAY) });
    await syncPlan(change.userId, "go", { referenceId: "cs_test_1", source: "stripe" });
    const changeRows = (await ledger(change.walletId)).slice(1);
    assert.deepEqual(changeRows.map((r) => [r.type, r.amount, r.referenceId, r.description]), [
      ["monthly_expiry", -800, "cs_test_1:expiry", "Unused monthly mushies expired at plan change"],
      ["plan_grant", 4000, "cs_test_1", "go plan — 4000 monthly mushies"],
    ]);
    assert.equal(await balanceOf(change.walletId), 4000);
    // Same referenceId again: idempotent, nothing more written.
    await syncPlan(change.userId, "go", { referenceId: "cs_test_1", source: "stripe" });
    assert.equal((await ledger(change.walletId)).length, 3);

    const ended = await makeWallet({ plan: "go", balance: 3200, addon: 200, periodEnd: new Date(Date.now() + 10 * DAY), monthly: 4000, source: "stripe" });
    await syncPlan(ended.userId, "free");
    const endedRows = (await ledger(ended.walletId)).slice(1);
    assert.equal(endedRows[0]!.type, "monthly_expiry");
    assert.equal(endedRows[0]!.amount, -3000);
    assert.equal(endedRows[0]!.description, "Unused monthly mushies expired when the plan ended");
    assert.equal(endedRows[1]!.type, "plan_grant");
    assert.equal(await balanceOf(ended.walletId), 2000 + 200);
  });

  it("verifier reports a clean chain after resets and debits", async () => {
    const { userId } = await makeWallet({ plan: "free", balance: 900, addon: 50, periodEnd: new Date(Date.now() - 60_000) });
    await refreshMonthlyCredits(userId);
    await deductCredits(userId, 40, "usage-v", "model — 10 tokens");
    const result = await verifyLedger(24);
    assert.equal(result.tailMismatches, 0);
    assert.deepEqual(result.chainGaps, []);
    assert.equal(result.clean, true);
  });
});
