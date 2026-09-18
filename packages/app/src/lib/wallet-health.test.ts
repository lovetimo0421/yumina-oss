import test from "node:test";
import assert from "node:assert/strict";
import { walletHealth } from "./wallet-health.js";

// The DM that started this: free plan, monthly grant fully spent, 923 mushies
// of check-in reward still in the wallet and still being spent minutes later.
// The panel showed "0 / 2,000" in red with "running out!" — she asked why her
// mushies had stopped working. Regression: health signals must read the total.
test("a wallet living on addon credits is not reported as running out", () => {
  const h = walletHealth({ balance: 923, addonBalance: 923, monthlyCredits: 2000 });

  assert.equal(h.monthly, 0, "monthly grant really is spent");
  assert.equal(h.pct, 0, "bar width still reflects the empty monthly grant");
  assert.equal(h.isCritical, false, "923 spendable mushies is not critical");
  assert.equal(h.isLow, false, "923 of 2000 is not low either");
  assert.equal(h.isEmpty, false);
  assert.equal(h.spendingAddon, true, "panel explains the mushies come from addon");
});

test("a genuinely near-empty wallet still warns", () => {
  const h = walletHealth({ balance: 50, addonBalance: 50, monthlyCredits: 2000 });

  assert.equal(h.isCritical, true, "50 of 2000 spendable is critical whatever the source");
  assert.equal(h.isLow, true);
  assert.equal(h.spendingAddon, true);
});

test("warnings fire on the monthly grant alone when no addon is held", () => {
  const noAddon = walletHealth({ balance: 80, addonBalance: 0, monthlyCredits: 2000 });
  assert.equal(noAddon.isCritical, true);
  assert.equal(noAddon.spendingAddon, false, "nothing to explain — there is no addon");

  const healthy = walletHealth({ balance: 1800, addonBalance: 0, monthlyCredits: 2000 });
  assert.equal(healthy.isCritical, false);
  assert.equal(healthy.isLow, false);
});

// Adding addon mushies can only ever REDUCE alarm, never raise it. Verified
// against prod: 1279 wallets stopped warning, 109 kept warning, 0 newly warned.
test("holding addon credits never makes a wallet look worse", () => {
  for (const balance of [0, 1, 50, 99, 400, 1999, 5000]) {
    for (const addon of [0, 1, 50, 400, 5000]) {
      if (addon > balance) continue;
      const withAddon = walletHealth({ balance, addonBalance: addon, monthlyCredits: 2000 });
      const monthlyOnly = walletHealth({ balance, addonBalance: 0, monthlyCredits: 2000 });
      assert.equal(
        withAddon.isCritical,
        monthlyOnly.isCritical,
        `balance ${balance} addon ${addon}: warning must track total, not composition`,
      );
    }
  }
});

test("an empty wallet is empty regardless of plan size", () => {
  const h = walletHealth({ balance: 0, addonBalance: 0, monthlyCredits: 2000 });
  assert.equal(h.isEmpty, true);
  assert.equal(h.isCritical, true);
  assert.equal(h.spendingAddon, false);
});

test("unlimited plans surface no warnings at all", () => {
  const h = walletHealth({ balance: 0, addonBalance: 0, monthlyCredits: 1_000_000, unlimited: true });
  assert.equal(h.isLow, false);
  assert.equal(h.isCritical, false);
  assert.equal(h.isEmpty, false);
  assert.equal(h.spendingAddon, false);
});

test("a zero monthly grant cannot divide by zero", () => {
  const h = walletHealth({ balance: 500, addonBalance: 500, monthlyCredits: 0 });
  assert.equal(h.pct, 0);
  assert.equal(h.spendPct, 0);
  assert.equal(Number.isFinite(h.spendPct), true);
});

test("null balances from a not-yet-loaded store read as zero", () => {
  const h = walletHealth({ balance: null, addonBalance: null, monthlyCredits: 2000 });
  assert.equal(h.monthly, 0);
  assert.equal(h.isEmpty, true);
});
