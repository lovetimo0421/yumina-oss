import test from "node:test";
import assert from "node:assert/strict";
import {
  getModelPriceLookupIds,
  withModelPriceAliases,
} from "./model-price-aliases.js";

test("Gemini Flash Lite GA can use the identically-priced Preview row", () => {
  assert.deepEqual(getModelPriceLookupIds("google/gemini-3.1-flash-lite"), [
    "google/gemini-3.1-flash-lite",
    "google/gemini-3.1-flash-lite-preview",
  ]);

  const prices = withModelPriceAliases([
    { modelId: "google/gemini-3.1-flash-lite-preview", outputPricePerM: 1.5 },
  ]);
  assert.deepEqual(prices, [
    { modelId: "google/gemini-3.1-flash-lite-preview", outputPricePerM: 1.5 },
    { modelId: "google/gemini-3.1-flash-lite", outputPricePerM: 1.5 },
  ]);
});

test("a direct GA price wins and unrelated model redirects never become price aliases", () => {
  assert.deepEqual(getModelPriceLookupIds("x-ai/grok-4.20"), ["x-ai/grok-4.20"]);

  const prices = withModelPriceAliases([
    { modelId: "google/gemini-3.1-flash-lite-preview", outputPricePerM: 1.5 },
    { modelId: "google/gemini-3.1-flash-lite", outputPricePerM: 1.25 },
    { modelId: "x-ai/grok-4.1-fast", outputPricePerM: 0.25 },
  ]);
  assert.equal(
    prices.find((price) => price.modelId === "google/gemini-3.1-flash-lite")?.outputPricePerM,
    1.25,
  );
  assert.equal(prices.some((price) => price.modelId === "x-ai/grok-4.20"), false);
});
