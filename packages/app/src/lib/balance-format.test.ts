import assert from "node:assert/strict";
import test from "node:test";
import { formatBalance, formatBalanceCompact } from "../../sandbox/chat/balance-format";
import { formatMushiePill } from "./format-mushies";

test("the composer shows the header pill's number: full below 100k, then K and M", () => {
  assert.equal(formatBalance(85_012.7), formatMushiePill(85_012.7));
  assert.equal(formatBalance(85_012.7), (85_012).toLocaleString());
  assert.equal(formatBalance(99_999), (99_999).toLocaleString());
  assert.equal(formatBalance(100_000), "100.0K");
  assert.equal(formatBalance(123_456), "123.4K");
  assert.equal(formatBalance(1_234_567), "1.2M");
});

test("narrow toolbars keep the same number", () => {
  assert.equal(formatBalanceCompact(0), "0");
  assert.equal(formatBalanceCompact(31.29), (31.2).toLocaleString());
  assert.equal(formatBalanceCompact(78_896), (78_896).toLocaleString());
  assert.equal(formatBalanceCompact(12_345_678), "12.3M");
});
