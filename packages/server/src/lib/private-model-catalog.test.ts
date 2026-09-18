import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePrivateCatalog, privateCatalogIsFresh, PRIVATE_MODEL_SYNC_TTL } from "./private-model-catalog.js";

test("upstream rename adds the new ID and removes known discovered-only old IDs", () => {
  const result = mergePrivateCatalog({
    models: ["deepseek-old", "hand-entered"],
    discoveredModels: ["deepseek-old"], defaultModel: "preferred", includeBody: { temperature: 0.8 },
  }, ["deepseek-new"], 1000)!;
  assert.deepEqual(result.models, ["preferred", "hand-entered", "deepseek-new"]);
  assert.deepEqual(result.discoveredModels, ["deepseek-new"]);
  assert.equal(result.modelsSyncedAt, 1000);
  assert.deepEqual(result.includeBody, { temperature: 0.8 });
});

test("legacy entries of unknown provenance and manually selected models survive repeated syncs", () => {
  const first = mergePrivateCatalog({ models: ["legacy-manual"], defaultModel: "selected-old" }, ["new-1"])!;
  const second = mergePrivateCatalog(first, ["new-2"])!;
  assert.deepEqual(second.models, ["selected-old", "legacy-manual", "new-2"]);
});

test("empty or malformed provider results cannot erase saved models or advance freshness", () => {
  for (const ids of [[], [null, {}, 1, "", " ", "a".repeat(257)]]) {
    const previous = { models: ["manual"], modelsSyncedAt: 10 };
    assert.equal(mergePrivateCatalog(previous, ids), null);
    assert.deepEqual(previous, { models: ["manual"], modelsSyncedAt: 10 });
  }
});

test("IDs keep upstream routing syntax and duplicates are removed", () => {
  const result = mergePrivateCatalog(null, ["deepseek/model:free", "deepseek/model:free", null, "valid"]);
  assert.deepEqual(result?.models, ["deepseek/model:free", "valid"]);
});

test("the upstream cap cannot hide new models behind a full manual catalog", () => {
  const manual = Array.from({ length: 500 }, (_, i) => `manual-${i}`);
  const result = mergePrivateCatalog({ models: manual }, ["new"])!;
  assert.ok(result.models?.includes("new"));
  assert.ok(manual.every((id) => result.models?.includes(id)));
  assert.equal(mergePrivateCatalog(null, Array.from({ length: 600 }, (_, i) => `model-${i}`))?.discoveredModels?.length, 500);
});

test("automatic refresh TTL expires, with missing and future timestamps treated as stale", () => {
  const saved = { models: ["model"], modelsSyncedAt: 1000 };
  assert.equal(privateCatalogIsFresh(saved, 1001), true);
  assert.equal(privateCatalogIsFresh(saved, 1000 + PRIVATE_MODEL_SYNC_TTL), false);
  assert.equal(privateCatalogIsFresh(saved, 999), false);
  assert.equal(privateCatalogIsFresh({ models: ["legacy"] }), false);
  assert.equal(privateCatalogIsFresh(null), false);
});
