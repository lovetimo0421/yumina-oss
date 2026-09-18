import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProviderCostUsd,
  providerCostUsdToCredits,
} from "./provider-cost.js";

test("accepts finite non-negative OpenRouter usage costs", () => {
  assert.equal(normalizeProviderCostUsd(0), 0);
  assert.equal(normalizeProviderCostUsd(0.001234), 0.001234);
});

test("rejects missing or invalid OpenRouter usage costs", () => {
  assert.equal(normalizeProviderCostUsd(undefined), undefined);
  assert.equal(normalizeProviderCostUsd("0.001"), undefined);
  assert.equal(normalizeProviderCostUsd(-0.001), undefined);
  assert.equal(normalizeProviderCostUsd(Number.NaN), undefined);
  assert.equal(normalizeProviderCostUsd(Number.POSITIVE_INFINITY), undefined);
});

test("converts provider dollars to Yumina credits with markup and safe rounding", () => {
  assert.equal(providerCostUsdToCredits(0.001234, 1.1), 1.4);
  assert.equal(providerCostUsdToCredits(0, 1.25), 0);
});
