import assert from "node:assert/strict";
import test from "node:test";
import { PLAY_MODELS } from "@yumina/shared";
import { usesDeepSeekLatestPricing } from "./deepseek-pricing-notice.js";

test("shows the latest-pricing notice for DeepSeek V4 Flash and Pro", () => {
  assert.equal(usesDeepSeekLatestPricing("deepseek/deepseek-v4-flash"), true);
  assert.equal(usesDeepSeekLatestPricing("deepseek/deepseek-v4-pro"), true);
});

test("does not show the V4 pricing notice on unrelated models", () => {
  assert.equal(usesDeepSeekLatestPricing("deepseek/deepseek-v3.2"), false);
  assert.equal(usesDeepSeekLatestPricing("anthropic/claude-sonnet-4.6"), false);
});

test("DeepSeek V4 exposes peak and off-peak normal-reply estimates", () => {
  const flash = PLAY_MODELS.find((model) => model.id === "deepseek/deepseek-v4-flash");
  const pro = PLAY_MODELS.find((model) => model.id === "deepseek/deepseek-v4-pro");

  assert.deepEqual(flash?.avgCostMushiesByPeriod, { peak: 10.3, offPeak: 5.1 });
  assert.deepEqual(pro?.avgCostMushiesByPeriod, { peak: 33.9, offPeak: 16.9 });
  assert.equal(flash?.avgCostMushies, 6.6);
  assert.equal(pro?.avgCostMushies, 21.9);
});
