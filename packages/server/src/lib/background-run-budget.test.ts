import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before } from "node:test";
import { db } from "../db/index.js";
import { creditWallets, user } from "../db/schema.js";
import { hasBackgroundRunBudget } from "./background-billing.js";

before(async () => {
  assert.equal(process.env.YUMINA_LOCAL_TEST, "1");
  assert.equal(process.env.DATABASE_URL, "");
  await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href);
});

async function walletWith(balance: number, plan = "free") {
  const userId = crypto.randomUUID();
  await db.insert(user).values({ id: userId, name: "Run budget test", email: `${userId}@test.invalid` });
  await db.insert(creditWallets).values({ userId, balance, plan, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) });
  return userId;
}

// 2026-10-15: a 341-message session started a ~17-mushie compaction on a
// 15-mushie wallet, ran dry before the merge, and was charged 19.7 for nothing.
test("a run the wallet cannot finish does not start", async () => {
  const userId = await walletWith(15);
  assert.equal(await hasBackgroundRunBudget(userId, async () => 17), false);
  assert.equal(await hasBackgroundRunBudget(userId, async () => 12), true);
});

test("the flat minimum still applies to cheap runs", async () => {
  const userId = await walletWith(4);
  assert.equal(await hasBackgroundRunBudget(userId, async () => 1), false);
  assert.equal(await hasBackgroundRunBudget(userId), false);
  assert.equal(await hasBackgroundRunBudget(await walletWith(5)), true);
});

test("every story compaction path checks the whole run before claiming the session", () => {
  const source = readFileSync(new URL("./session-compaction.ts", import.meta.url), "utf8");
  const gates = source.match(/canAffordStorySummaryRun\(runInput\)/g) ?? [];
  // background, background with force, regenerate-small, manual Compact
  assert.equal(gates.length, 4);
  assert.doesNotMatch(source, /hasBackgroundRunBudget\(args\.userId\)\)/, "a flat-minimum-only gate came back");
});
