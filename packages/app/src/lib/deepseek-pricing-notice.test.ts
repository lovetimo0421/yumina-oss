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

test("DeepSeek V4 prices use the shared uncached 21.3K input and 700 output reference", () => {
  const flash = PLAY_MODELS.find((model) => model.id === "deepseek/deepseek-v4-flash");
  const pro = PLAY_MODELS.find((model) => model.id === "deepseek/deepseek-v4-pro");

  for (const model of [flash, pro]) {
    assert.ok(model);
    const reference = (21_300 * model.inputPrice! + 700 * model.outputPrice!) / 1000 * 1.2;
    assert.equal(model.avgCostMushies, Math.ceil(reference * 10) / 10);
    assert.equal(model.avgCostMushiesByPeriod, undefined);
  }
});

test("DeepSeek V4.1 Flash exposes the current peak and off-peak reference estimates", () => {
  const flash = PLAY_MODELS.find((model) => model.id === "deepseek/deepseek-v4.1-flash");
  assert.ok(flash);
  assert.deepEqual(flash.avgCostMushiesByPeriod, { peak: 8.7, offPeak: 4.4 });
  assert.equal(flash.avgCostMushies, 4.4);
});
