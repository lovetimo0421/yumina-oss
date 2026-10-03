import assert from "node:assert/strict";
import test from "node:test";
import { formatBalance, formatBalanceCompact } from "../../sandbox/chat/balance-format";

test("full balance format keeps separators through 100k", () => {
  assert.equal(formatBalance(85_012.7), (85_012).toLocaleString());
  assert.equal(formatBalance(100_000), (100_000).toLocaleString());
  assert.equal(formatBalance(100_001), "100k");
  assert.equal(formatBalance(123_456), "123k");
  assert.equal(formatBalance(1_234_567), "1.2M");
});

test("narrow toolbars keep full balances through 100k", () => {
  assert.equal(formatBalanceCompact(0), "0");
  assert.equal(formatBalanceCompact(999.9), "999");
  assert.equal(formatBalanceCompact(1_000), (1_000).toLocaleString());
  assert.equal(formatBalanceCompact(78_896), (78_896).toLocaleString());
  assert.equal(formatBalanceCompact(85_012.7), (85_012).toLocaleString());
  assert.equal(formatBalanceCompact(99_999), (99_999).toLocaleString());
  assert.equal(formatBalanceCompact(100_000), (100_000).toLocaleString());
  assert.equal(formatBalanceCompact(100_001), "100k");
  assert.equal(formatBalanceCompact(123_456), "123k");
  assert.equal(formatBalanceCompact(12_345_678), "12M");
});
