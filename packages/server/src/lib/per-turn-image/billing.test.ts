import assert from "node:assert/strict";
import test, { before } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { creditWallets, user } from "../../db/schema.js";
import { deductCredits } from "../credit-service.js";
import { env } from "../env.js";
import { refundTurnImage, reserveTurnImage, turnImageQuote } from "./billing.js";

before(async () => {
  assert.equal(process.env.YUMINA_LOCAL_TEST, "1");
  assert.equal(process.env.DATABASE_URL, "");
  await import(new URL("../../../scripts/test-local-schema.mjs", import.meta.url).href);
});

const FREE = env.PER_TURN_IMAGE_FREE_COUNT;
const PRICE = env.PER_TURN_IMAGE_PRICE_MUSHIES;

async function wallet(balance = 100) {
  const userId = crypto.randomUUID();
  await db.insert(user).values({ id: userId, name: "Turn image test", email: `${userId}@test.invalid` });
  await db.insert(creditWallets).values({ userId, balance, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) });
  return userId;
}
const balanceOf = async (userId: string) =>
  (await db.select().from(creditWallets).where(eq(creditWallets.userId, userId)))[0]!.balance;
async function useFree(userId: string, n: number) {
  for (let i = 0; i < n; i++) assert.ok((await reserveTurnImage(userId, crypto.randomUUID())).charge);
}

test("free draws cost nothing, count down, and a refunded free draw is given back", async () => {
  const userId = await wallet();
  const { charge } = await reserveTurnImage(userId, crypto.randomUUID());
  assert.ok(charge);
  assert.equal(charge.price, 0);
  assert.equal(charge.freeLeft, FREE - 1);
  assert.equal((await turnImageQuote(userId)).freeLeft, FREE - 1);
  await refundTurnImage(charge);
  assert.equal((await turnImageQuote(userId)).freeLeft, FREE);
  assert.equal(await balanceOf(userId), 100);
});

test("two draws at once cannot both take the last free picture", async () => {
  const userId = await wallet();
  await useFree(userId, FREE - 1);
  const [a, b] = await Promise.all([reserveTurnImage(userId, crypto.randomUUID()), reserveTurnImage(userId, crypto.randomUUID())]);
  assert.deepEqual([a.charge?.price, b.charge?.price].sort((x, y) => x! - y!), [0, PRICE]);
  assert.equal(await balanceOf(userId), 100 - PRICE);
});

test("after the free pictures a draw is paid up front, and a failed one is refunded", async () => {
  const userId = await wallet();
  await useFree(userId, FREE);
  const { charge } = await reserveTurnImage(userId, crypto.randomUUID());
  assert.ok(charge);
  assert.equal(charge.price, PRICE);
  assert.equal(await balanceOf(userId), 100 - PRICE);
  await refundTurnImage(charge);
  assert.equal(await balanceOf(userId), 100);
  // A refunded paid draw doesn't hand back a free picture.
  assert.equal((await turnImageQuote(userId)).freeLeft, 0);
});

test("a player who can't pay is turned away before drawing, and chat can't spend a draw's payment", async () => {
  const userId = await wallet(PRICE);
  await useFree(userId, FREE);
  const { charge } = await reserveTurnImage(userId, crypto.randomUUID());
  assert.ok(charge);
  await assert.rejects(deductCredits(userId, 1, "chat-after-draw", "Test chat"), /INSUFFICIENT_CREDITS/);
  const broke = await reserveTurnImage(userId, crypto.randomUUID());
  assert.equal(broke.charge, null);
  assert.equal(await balanceOf(userId), 0);
});
