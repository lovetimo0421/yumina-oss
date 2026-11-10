import "../../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { creditTransactions, creditWallets, turnImageTasks, user } from "../../db/schema.js";
import { env } from "../env.js";
import { refundTurnImage, turnImageQuote } from "./billing.js";
import { cancelTurnImageTask, deliverTurnImageTask, failTurnImageTask, recoverExpiredTurnImages, startTurnImageTask, watchTurnImageTask } from "./tasks.js";

async function fixture(paid = false) {
  const userId = crypto.randomUUID(), messageId = crypto.randomUUID(), id = crypto.randomUUID();
  await db.insert(user).values({ id: userId, name: "Cancel test", email: `${userId}@test.local` });
  const [wallet] = await db.insert(creditWallets).values({ userId, balance: 100, addonBalance: 100, plan: "free", periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) }).returning();
  if (paid) {
    for (let i = 0; i < env.PER_TURN_IMAGE_FREE_COUNT; i++) await startTurnImageTask(crypto.randomUUID(), userId, messageId);
  }
  const read = async () => ({
    wallet: (await db.select().from(creditWallets).where(eq(creditWallets.id, wallet!.id)))[0]!,
    ledger: (await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, wallet!.id))).filter((r) => r.referenceId === `turn-image:${id}`),
    task: (await db.select().from(turnImageTasks).where(eq(turnImageTasks.id, id)))[0],
  });
  return { id, userId, messageId, read };
}

test("cancelling before admission prevents a delayed request from charging", async () => {
  const f = await fixture();
  assert.equal(await cancelTurnImageTask(f.id, f.userId, f.messageId), "cancelled");
  assert.deepEqual(await startTurnImageTask(f.id, f.userId, f.messageId), { reason: "cancelled" });
  assert.equal((await f.read()).ledger.length, 0);
});

test("duplicate cancels and failure cleanup refund a paid draw and purchased credits once", async () => {
  const f = await fixture(true);
  const reserved = await startTurnImageTask(f.id, f.userId, f.messageId);
  assert.ok(reserved.charge);
  assert.equal(reserved.charge.price, env.PER_TURN_IMAGE_PRICE_MUSHIES);
  const watcher = watchTurnImageTask(f.id);
  try {
    assert.deepEqual(await Promise.all([cancelTurnImageTask(f.id, f.userId, f.messageId), cancelTurnImageTask(f.id, f.userId, f.messageId)]), ["cancelled", "cancelled"]);
    await failTurnImageTask(f.id);
    await refundTurnImage(reserved.charge);
    const result = await f.read();
    assert.equal(result.wallet.balance, 100);
    assert.equal(result.wallet.addonBalance, 100);
    assert.equal(result.ledger.filter((r) => r.type === "refund").length, 1);
    assert.equal(result.task?.status, "cancelled");
    assert.equal(watcher.signal.aborted, true);
  } finally { watcher.close(); }
});

test("a cancelled free draw restores the free allowance once", async () => {
  const f = await fixture();
  await startTurnImageTask(f.id, f.userId, f.messageId);
  await cancelTurnImageTask(f.id, f.userId, f.messageId);
  await cancelTurnImageTask(f.id, f.userId, f.messageId);
  assert.equal((await turnImageQuote(f.userId)).freeLeft, env.PER_TURN_IMAGE_FREE_COUNT);
  assert.equal((await f.read()).ledger.filter((r) => r.type === "refund").length, 1);
});

test("another account or message cannot cancel or reuse the task", async () => {
  const f = await fixture(), other = await fixture();
  await startTurnImageTask(f.id, f.userId, f.messageId);
  assert.equal(await cancelTurnImageTask(f.id, other.userId, f.messageId), "invalid");
  assert.equal(await cancelTurnImageTask(f.id, f.userId, other.messageId), "invalid");
  assert.deepEqual(await startTurnImageTask(f.id, other.userId, other.messageId), { reason: "invalid" });
  assert.equal((await f.read()).task?.status, "running");
  assert.equal((await f.read()).ledger.length, 1);
});

test("cancellation wins against late delivery; a committed delivery cannot be refunded", async () => {
  const f = await fixture();
  await startTurnImageTask(f.id, f.userId, f.messageId);
  await cancelTurnImageTask(f.id, f.userId, f.messageId);
  let wrote = false;
  assert.equal(await deliverTurnImageTask(f.id, async () => { wrote = true; return "new picture"; }), null);
  assert.equal(wrote, false);
  const completed = await fixture();
  await startTurnImageTask(completed.id, completed.userId, completed.messageId);
  assert.equal(await deliverTurnImageTask(completed.id, async () => "delivered"), "delivered");
  assert.equal(await cancelTurnImageTask(completed.id, completed.userId, completed.messageId), "completed");
  await failTurnImageTask(completed.id);
  assert.equal((await completed.read()).ledger.filter((r) => r.type === "refund").length, 0);
});

test("delivery rolls back its task guard on error and permits cancellation", async () => {
  const f = await fixture();
  await startTurnImageTask(f.id, f.userId, f.messageId);
  await assert.rejects(deliverTurnImageTask(f.id, async () => { throw new Error("synthetic save failure"); }));
  assert.equal(await cancelTurnImageTask(f.id, f.userId, f.messageId), "cancelled");
});

test("expired work after a lost replica is refunded and cannot deliver", async () => {
  const f = await fixture(true);
  await startTurnImageTask(f.id, f.userId, f.messageId);
  await db.update(turnImageTasks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(turnImageTasks.id, f.id));
  await recoverExpiredTurnImages(f.userId);
  await recoverExpiredTurnImages(f.userId);
  assert.equal((await f.read()).wallet.balance, 100);
  assert.equal((await f.read()).task?.status, "failed");
  assert.equal(await deliverTurnImageTask(f.id, async () => "late"), null);
});

test("a refund failure rolls back cancellation so it can be safely retried", async () => {
  const f = await fixture(true);
  await startTurnImageTask(f.id, f.userId, f.messageId);
  await db.execute(sql.raw(`CREATE FUNCTION reject_cancel_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.reference_id = 'turn-image:${f.id}' AND NEW.type = 'refund' THEN RAISE EXCEPTION 'synthetic ledger failure'; END IF;
    RETURN NEW; END $$;`));
  await db.execute(sql.raw("CREATE TRIGGER reject_cancel_refund BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION reject_cancel_refund();"));
  try {
    await assert.rejects(cancelTurnImageTask(f.id, f.userId, f.messageId));
    const state = await f.read();
    assert.equal(state.task?.status, "running");
    assert.equal(state.wallet.balance, 100 - env.PER_TURN_IMAGE_PRICE_MUSHIES);
  } finally {
    await db.execute(sql.raw("DROP TRIGGER reject_cancel_refund ON credit_transactions;"));
    await db.execute(sql.raw("DROP FUNCTION reject_cancel_refund();"));
  }
  assert.equal(await cancelTurnImageTask(f.id, f.userId, f.messageId), "cancelled");
  assert.equal((await f.read()).wallet.balance, 100);
});

test("a concurrent cancel waits for message delivery to commit and cannot refund it", async () => {
  const f = await fixture(true);
  await startTurnImageTask(f.id, f.userId, f.messageId);
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(r => { entered = r; });
  const allow = new Promise<void>(r => { release = r; });
  const delivery = deliverTurnImageTask(f.id, async () => { entered(); await allow; return "saved"; });
  await inside;
  const cancellation = cancelTurnImageTask(f.id, f.userId, f.messageId);
  release();
  assert.equal(await delivery, "saved");
  assert.equal(await cancellation, "completed");
  assert.equal((await f.read()).wallet.balance, 100 - env.PER_TURN_IMAGE_PRICE_MUSHIES);
  assert.equal((await f.read()).ledger.filter(r => r.type === "refund").length, 0);
});
