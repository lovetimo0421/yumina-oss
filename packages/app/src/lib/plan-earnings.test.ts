import { test } from "node:test";
import assert from "node:assert/strict";
import { questCeilingFor, monthlyPileFor, type EarningsSource } from "./plan-earnings";

const LINEUP2: EarningsSource = {
  planVersion: 2,
  rewards: "quests",
  lineup: {
    free: { monthlyCredits: 1000, questMonthlyCap: 1000, questMaxTotal: 1000 },
    plus: { monthlyCredits: 13600, questMonthlyCap: 2800, questMaxTotal: 5300 },
    internal: { monthlyCredits: 1_000_000, questMonthlyCap: 0, questMaxTotal: 0 },
  },
  questCaps: null,
};

const LEGACY: EarningsSource = {
  planVersion: 1,
  rewards: "quests",
  lineup: null,
  questCaps: { free: 1000, plus: 5300 },
};

test("the ceiling includes the forge rungs, not just the board cap", () => {
  // 2,800 is the daily/weekly board alone; 5,300 adds the two rungs Platinum
  // can reach. Printing the board cap would understate the plan by half.
  assert.equal(questCeilingFor("plus", LINEUP2), 5300);
});

test("questMonthlyCap is the fallback when a server has not sent the total", () => {
  const older = { ...LINEUP2, lineup: { plus: { monthlyCredits: 13600, questMonthlyCap: 2800 } } };
  assert.equal(questCeilingFor("plus", older), 2800);
});

test("legacy wallets read the same ceiling off questCaps", () => {
  assert.equal(questCeilingFor("plus", LEGACY), 5300);
});

test("the kill switch puts legacy wallets back on check-ins, so no ceiling shows", () => {
  assert.equal(questCeilingFor("plus", { ...LEGACY, rewards: "check_in" }), null);
});

test("a tier with no board shows no line at all", () => {
  assert.equal(questCeilingFor("internal", LINEUP2), null);
  assert.equal(questCeilingFor("pro", LINEUP2), null, "a plan missing from the payload");
  assert.equal(questCeilingFor(null, LINEUP2), null);
});

test("the pile comes from the lineup, not from a wallet that lags a plan change", () => {
  // Wallet still holds last cycle's Gold grant; the card must say Platinum.
  assert.equal(monthlyPileFor("plus", LINEUP2, 3200), 13600);
});

test("legacy wallets fall back to what the wallet was actually granted", () => {
  assert.equal(monthlyPileFor("plus", LEGACY, 14700), 14700);
  assert.equal(monthlyPileFor("plus", LEGACY, 0), null);
  assert.equal(monthlyPileFor("plus", LEGACY, null), null);
});
