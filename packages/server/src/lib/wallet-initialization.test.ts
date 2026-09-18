import assert from "node:assert/strict";
import test from "node:test";
import { isLegacyReRegistrationFreezeWallet } from "./wallet-initialization.js";

const future = new Date("2026-08-15T00:00:00.000Z");

test("recognizes the obsolete zero-balance re-registration freeze", () => {
  assert.equal(isLegacyReRegistrationFreezeWallet({
    plan: "free",
    balance: 0,
    addonBalance: 0,
    lastDailyRecovery: future,
    periodEnd: future,
  }), true);
  const elapsedDeadline = new Date("2026-07-01T00:00:00.000Z");
  assert.equal(isLegacyReRegistrationFreezeWallet({
    plan: "free",
    balance: 0,
    addonBalance: 0,
    lastDailyRecovery: elapsedDeadline,
    periodEnd: elapsedDeadline,
  }), true);
});

test("never rewrites a normal or user-funded wallet", () => {
  const cases = [
    {
      plan: "free",
      balance: 2000,
      addonBalance: 0,
      lastDailyRecovery: future,
      periodEnd: future,
    },
    {
      plan: "free",
      balance: 0,
      addonBalance: 100,
      lastDailyRecovery: future,
      periodEnd: future,
    },
    {
      plan: "go",
      balance: 0,
      addonBalance: 0,
      lastDailyRecovery: future,
      periodEnd: future,
    },
    {
      plan: "free",
      balance: 0,
      addonBalance: 0,
      lastDailyRecovery: new Date("2026-07-30T00:00:00.000Z"),
      periodEnd: future,
    },
    {
      plan: "free",
      balance: 0,
      addonBalance: 0,
      lastDailyRecovery: future,
      periodEnd: new Date("2026-08-16T00:00:00.000Z"),
    },
  ];

  for (const wallet of cases) {
    assert.equal(isLegacyReRegistrationFreezeWallet(wallet), false);
  }
});
