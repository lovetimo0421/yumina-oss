import test from "node:test";
import assert from "node:assert/strict";
import { usageObservation } from "./usage-observation.js";
test("provider charge is preserved, including zero; missing is not zero", () => {
  const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
  assert.equal(
    usageObservation({ ...usage, providerCostUsd: 0.0000045 }).providerCostUsd,
    "0.000004500000",
  );
  assert.equal(
    usageObservation({ ...usage, providerCostUsd: 0 }).providerCostUsd,
    "0.000000000000",
  );
  assert.equal(usageObservation(usage).providerCostUsd, null);
  assert.equal(usageObservation().tokenMeasurement, "estimated");
  assert.equal(
    usageObservation({ ...usage, providerCostUsd: Infinity }).providerCostUsd,
    null,
  );
});
