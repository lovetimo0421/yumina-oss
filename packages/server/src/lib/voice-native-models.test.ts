import assert from "node:assert/strict";
import test from "node:test";
import "../../scripts/test-local-schema.mjs";
import { db } from "../db/index.js";
import { modelPrices } from "../db/schema.js";
import {
  getAllModelPrices,
  getModelPrice,
  invalidateModelPriceCache,
  isOfficialModel,
} from "./model-price-cache.js";
import { resolveProviderForModel } from "./resolve-provider.js";

test("native billing catalog never grants text capability including bypass options", async () => {
  for (const modelId of ["gpt-realtime-2.1", "gpt-4o-transcribe"])
    await db
      .insert(modelPrices)
      .values({
        modelId,
        inputPricePerM: 4,
        outputPricePerM: 24,
        minPlan: "free",
        markupMultiplier: 1.2,
      });
  await invalidateModelPriceCache();
  for (const modelId of ["gpt-realtime-2.1", "gpt-4o-transcribe"]) {
    assert.ok(await getModelPrice(modelId));
    assert.equal(await isOfficialModel(modelId), false);
    assert.equal(
      (await getAllModelPrices()).some((p) => p.modelId === modelId),
      false,
    );
    for (const options of [
      {},
      { forcePrivate: true },
      { allowNonPriced: true },
      { forceOfficial: true },
      { allowRetiredForAccessCheck: true },
    ])
      assert.equal(
        await resolveProviderForModel(
          "no-user-key-or-wallet-read",
          modelId,
          options,
        ),
        null,
      );
  }
});
