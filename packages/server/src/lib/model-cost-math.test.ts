import { test } from "node:test";
import assert from "node:assert/strict";
import { inputShareFor, livePriceFromOpenRouter, planPriceSync } from "./model-cost-math.js";

const ours = [
  { modelId: "deepseek/deepseek-v4-pro", inputPricePerM: 0.87, outputPricePerM: 1.74, isActive: true },
  { modelId: "google/gemini-3-flash-preview", inputPricePerM: 0.5, outputPricePerM: 3.0, isActive: true },
  { modelId: "nousresearch/hermes-4-70b", inputPricePerM: 0.13, outputPricePerM: 0.4, isActive: true },
  { modelId: "openrouter/free", inputPricePerM: 0, outputPricePerM: 0, isActive: true },
  { modelId: "old/inactive", inputPricePerM: 1, outputPricePerM: 1, isActive: false },
];

test("planPriceSync: updates rows that moved, deactivates rows gone from OpenRouter, ignores the rest", () => {
  const live = new Map([
    ["deepseek/deepseek-v4-pro", { inputPerM: 1.6, outputPerM: 3.2 }],
    ["google/gemini-3-flash-preview", { inputPerM: 0.5, outputPerM: 3.0 }],
  ]);
  const plan = planPriceSync(ours, live);
  assert.deepEqual(plan.updates, [{
    modelId: "deepseek/deepseek-v4-pro",
    from: { inputPerM: 0.87, outputPerM: 1.74 },
    to: { inputPerM: 1.6, outputPerM: 3.2 },
  }]);
  assert.deepEqual(plan.deactivate, ["nousresearch/hermes-4-70b"]);
});

test("planPriceSync: a sub-1% wobble is not an update; a bad live value is skipped", () => {
  const live = new Map([
    ["deepseek/deepseek-v4-pro", { inputPerM: 0.874, outputPerM: 1.748 }],
    ["google/gemini-3-flash-preview", { inputPerM: Number.NaN, outputPerM: 3.0 }],
    ["nousresearch/hermes-4-70b", { inputPerM: 0.13, outputPerM: 0.4 }],
  ]);
  const plan = planPriceSync(ours, live);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deactivate, []);
});

test("inputShareFor: prompt-heavy replies put most of the cost on the prompt", () => {
  // Gemini 3 Flash at the measured medians: 32k in at $0.50/M vs 850 out at $3/M.
  const share = inputShareFor(0.5, 3.0, 32076, 852);
  assert.ok(share > 0.85 && share < 0.87, String(share));
  assert.equal(inputShareFor(null, 3.0, 1000, 100), 0.75);
  assert.equal(inputShareFor(0, 0, 1000, 100), 0.75);
});

test("livePriceFromOpenRouter: per-token strings become per-million numbers", () => {
  assert.deepEqual(livePriceFromOpenRouter({ prompt: "0.0000016", completion: "0.0000032" }), { inputPerM: 1.6, outputPerM: 3.2 });
  assert.equal(livePriceFromOpenRouter({ prompt: "abc", completion: "1" }), null);
  assert.equal(livePriceFromOpenRouter(undefined), null);
});
