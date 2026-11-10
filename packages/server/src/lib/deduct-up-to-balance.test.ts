import assert from "node:assert/strict";
import test, { before } from "node:test";
import { db } from "../db/index.js";
import { creditWallets, user } from "../db/schema.js";
import { deductCreditsUpToBalance, ensureWallet } from "./credit-service.js";
import { reserveStudioCredits } from "./credit-reservations.js";

before(async () => {
  assert.equal(process.env.YUMINA_LOCAL_TEST, "1");
  assert.equal(process.env.DATABASE_URL, "");
  await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href);
  process.env.STUDIO_CREDIT_RECOVERY_ENABLED = "true";
});

async function wallet(balance: number) {
  const userId = crypto.randomUUID();
  await db.insert(user).values({ id: userId, name: "Clamp test", email: `${userId}@test.invalid` });
  await db.insert(creditWallets).values({ userId, balance, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) });
  return userId;
}

test("a covered charge is taken in full", async () => {
  const userId = await wallet(100);
  const result = await deductCreditsUpToBalance(userId, 30, crypto.randomUUID(), "Test chat");
  assert.equal(result?.creditsDeducted, 30);
  assert.equal((await ensureWallet(userId)).balance, 70);
});

test("a reply that cost more than the balance drains the wallet to 0 instead of going free", async () => {
  const userId = await wallet(12);
  const result = await deductCreditsUpToBalance(userId, 50, crypto.randomUUID(), "Test chat");
  assert.equal(result?.creditsDeducted, 12);
  assert.equal(result?.newBalance, 0);
  assert.equal((await ensureWallet(userId)).balance, 0);
});

test("the clamp never spends credits held for another run", async () => {
  const userId = await wallet(100);
  await reserveStudioCredits({ userId, credits: 90, referenceId: crypto.randomUUID(), runId: "test-run" });
  const result = await deductCreditsUpToBalance(userId, 50, crypto.randomUUID(), "Test chat");
  assert.equal(result?.creditsDeducted, 10);
  assert.equal((await ensureWallet(userId)).balance, 90);
});

test("an empty wallet charges nothing and does not throw", async () => {
  const userId = await wallet(0);
  assert.equal(await deductCreditsUpToBalance(userId, 5, crypto.randomUUID(), "Test chat"), null);
});
