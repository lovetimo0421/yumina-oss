import "../test/database-fixture.js";
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditTransactions, creditWallets, user, walletPlanDrops } from "../db/schema.js";
import { fulfillWechatPlanPurchase } from "./credit-service.js";
import { PLANS, type PlanId } from "./plan-config.js";

after(async () => { await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close(); });

const DAY = 86_400_000;

before(() => { process.env.BILLING_V2_EXISTING_AT = "2026-09-01T00:00:00Z"; });

async function makeWechatWallet(opts: { plan: PlanId; planVersion: 1 | 2; balance: number; periodStart: Date; released?: number }) {
  const userId = `wx-${crypto.randomUUID()}`;
  await db.insert(user).values({ id: userId, name: "WeChat renewal", email: `${userId}@test.local`, emailVerified: true });
  const periodEnd = new Date(opts.periodStart.getTime() + 30 * DAY);
  const [w] = await db.insert(creditWallets).values({
    id: crypto.randomUUID(), userId, balance: opts.balance, addonBalance: 0, plan: opts.plan,
    monthlyCredits: PLANS[opts.plan].monthlyCredits, planVersion: opts.planVersion,
    periodStart: opts.periodStart, periodEnd, subscriptionSource: "wechat",
  }).returning();
  if (opts.planVersion === 2) {
    await db.insert(walletPlanDrops).values({ walletId: w!.id, periodStart: opts.periodStart, dropsReleased: opts.released ?? 1, schedule: "d10_20", updatedAt: new Date() });
  }
  return { userId, walletId: w!.id, periodEnd };
}

const walletRow = async (walletId: string) => (await db.select().from(creditWallets).where(eq(creditWallets.id, walletId)))[0]!;
const dropsRow = async (walletId: string) => (await db.select().from(walletPlanDrops).where(eq(walletPlanDrops.walletId, walletId)))[0]!;
const ledger = (walletId: string) =>
  db.select().from(creditTransactions).where(eq(creditTransactions.walletId, walletId)).orderBy(asc(creditTransactions.createdAt));

describe("fulfillWechatPlanPurchase", () => {
  it("early same-plan renewal starts the cycle now and keeps the paid days (v1 → v2)", async () => {
    // The 2026-10-01 report: Platinum on WeChat, 14 days left, renews early.
    const now = new Date();
    const { userId, walletId, periodEnd: oldEnd } = await makeWechatWallet({
      plan: "plus", planVersion: 1, balance: 900, periodStart: new Date(now.getTime() - 16 * DAY),
    });
    assert.equal(await fulfillWechatPlanPurchase(userId, "plus", "cs_early", now), "early_renewal");

    const w = await walletRow(walletId);
    assert.ok(w.periodStart.getTime() <= Date.now(), "the cycle must never start in the future");
    assert.equal(w.periodStart.getTime(), now.getTime());
    assert.equal(w.periodEnd.getTime(), oldEnd.getTime() + 30 * DAY, "the unused days are kept");
    assert.equal(w.planVersion, 2);
    assert.equal(w.balance, 900 + 6800, "nothing held expires; drop 1 lands");
    const drops = await dropsRow(walletId);
    assert.equal(drops.periodStart.getTime(), now.getTime(), "drops 2/3 count from today, not from the old period end");
    assert.equal(drops.dropsReleased, 1);
    const rows = await ledger(walletId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.description, "Early plus renewal — +6800 mushies (new billing cycle) (drop 1)");

    // Stripe redelivers the checkout event: nothing more lands.
    await fulfillWechatPlanPurchase(userId, "plus", "cs_early", new Date(now.getTime() + 1000));
    assert.equal((await walletRow(walletId)).balance, 900 + 6800);
    assert.equal((await ledger(walletId)).length, 1);
  });

  it("early renewal on a version-2 wallet pays the old cycle's undelivered drop first", async () => {
    const now = new Date();
    const { userId, walletId } = await makeWechatWallet({
      plan: "plus", planVersion: 2, balance: 100, periodStart: new Date(now.getTime() - 18 * DAY), released: 2,
    });
    await fulfillWechatPlanPurchase(userId, "plus", "cs_v2", now);
    const w = await walletRow(walletId);
    assert.equal(w.periodStart.getTime(), now.getTime());
    assert.equal(w.balance, 100 + 3400 + 6800, "day-20 drop of the paid cycle is settled, then drop 1");
    assert.deepEqual((await ledger(walletId)).map((r) => r.amount), [3400, 6800]);
  });

  it("a renewal after expiry still resets the month from now", async () => {
    const now = new Date();
    const { userId, walletId } = await makeWechatWallet({
      plan: "plus", planVersion: 2, balance: 50, periodStart: new Date(now.getTime() - 31 * DAY), released: 3,
    });
    assert.equal(await fulfillWechatPlanPurchase(userId, "plus", "cs_late", now), "renewal");
    const w = await walletRow(walletId);
    assert.equal(w.periodStart.getTime(), now.getTime());
    assert.equal(w.periodEnd.getTime(), now.getTime() + 30 * DAY);
  });
});
