import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateReplyCost, formatCostEstimate } from "../dist/index.js";

const stats = {
  modelId: "google/gemini-3-flash-preview",
  windowDays: 7,
  turns: 105288,
  medianCredits: 8.7,
  p25Credits: 6.2,
  p75Credits: 11.9,
  p90Credits: 14.8,
  medianPromptTokens: 32076,
  medianOutputTokens: 852,
  inputShare: 0.76,
  coverage24h: null,
  computedAt: "2026-09-17T05:00:00.000Z",
};

test("no context → the measured median and p90, unscaled", () => {
  const e = estimateReplyCost(stats, null);
  assert.deepEqual(e, { typical: 8.7, heavy: 14.8, scaled: false });
  assert.equal(estimateReplyCost(stats, 0).scaled, false);
  assert.equal(estimateReplyCost(stats, Number.NaN).scaled, false);
});

test("a chat at the median context reproduces the median", () => {
  const e = estimateReplyCost(stats, 32076);
  assert.ok(Math.abs(e.typical - 8.7) < 1e-9);
  assert.ok(Math.abs(e.heavy - 14.8) < 1e-9);
  assert.equal(e.scaled, true);
});

test("twice the context scales only the prompt share of the cost", () => {
  const e = estimateReplyCost(stats, 32076 * 2);
  // prompt share 0.76 doubles, reply share 0.24 stays: scale = 0.76*2 + 0.24 = 1.76
  assert.ok(Math.abs(e.typical - 8.7 * 1.76) < 1e-9);
  assert.ok(Math.abs(e.heavy - 14.8 * 1.76) < 1e-9);
});

test("a tiny or absurd context is clamped so the estimate stays sane", () => {
  const tiny = estimateReplyCost(stats, 10);
  assert.ok(Math.abs(tiny.typical - 8.7 * (0.76 * 0.1 + 0.24)) < 1e-9);
  const huge = estimateReplyCost(stats, 10_000_000);
  assert.ok(Math.abs(huge.typical - 8.7 * (0.76 * 6 + 0.24)) < 1e-9);
});

test("formatCostEstimate: one decimal under ten, whole numbers from ten", () => {
  assert.equal(formatCostEstimate(8.66), "8.7");
  assert.equal(formatCostEstimate(3), "3");
  assert.equal(formatCostEstimate(14.8), "15");
  assert.equal(formatCostEstimate(0), "0");
  assert.equal(formatCostEstimate(-1), "0");
});
