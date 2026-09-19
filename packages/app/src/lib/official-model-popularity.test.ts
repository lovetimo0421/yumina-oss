import assert from "node:assert/strict";
import test from "node:test";
import type { PlayModel } from "@yumina/shared";
import { blendModelPopularity } from "../../../shared/src/types/model-popularity";
import { orderOfficialModels } from "./official-model-order";

function model(id: string, overrides: Partial<PlayModel> = {}): PlayModel {
  return { id, name: id, scope: "play", tier: "budget", minPlan: "free", avgCostMushies: 1, descKey: id, ...overrides };
}

const catalog = [
  model("external", { name: "Model 10", recommendationRank: 1 }),
  model("local", { name: "Model 2", recommendationRank: 9, tier: "ultra", minPlan: "plus" }),
  model("balanced", { name: "Model 3", recommendationRank: 2, tier: "ultra", minPlan: "plus" }),
];
const defaults = {
  tier: "all", query: "", sort: "popular", pinned: [], favoritesOnly: false, recent: [],
  description: (entry: PlayModel) => entry.id === "local" ? "人物描写" : "Fast dialogue",
} satisfies Parameters<typeof orderOfficialModels>[1];
const scores = blendModelPopularity(
  catalog.map(entry => entry.id),
  { external: 700_000_000, local: 100_000_000, balanced: 200_000_000 },
  { external: 0, local: 80, balanced: 20 },
);

function ids(options: Partial<Parameters<typeof orderOfficialModels>[1]> = {}) {
  return orderOfficialModels(catalog, { ...defaults, popularityScores: scores, ...options }).map(entry => entry.id);
}

test("popular order uses equally weighted source shares despite different traffic scales", () => {
  // Raw token totals favor external; normalized 50/50 shares favor local.
  assert.deepEqual(ids(), ["local", "external", "balanced"]);
  assert.equal(scores.local, 0.45);
  assert.equal(scores.external, 0.35);
  assert.equal(scores.balanced, 0.2);
  assert.deepEqual(catalog.map(entry => entry.id), ["external", "local", "balanced"]);
});

test("favorites and recent usage do not silently boost the global popularity order", () => {
  assert.deepEqual(ids({ pinned: ["balanced"], recent: ["balanced", "external"] }), ids());
  assert.deepEqual(ids({ pinned: ["balanced", "local", "removed"], favoritesOnly: true }), ["local", "balanced"]);
  assert.deepEqual(ids({ favoritesOnly: true }), []);
});

test("tier and localized search filter the popularity results without dropping locked-plan models", () => {
  assert.deepEqual(ids({ tier: "ultra" }), ["local", "balanced"]);
  assert.deepEqual(ids({ tier: "ultra", query: "dialogue" }), ["balanced"]);
  assert.deepEqual(ids({ query: " 人物 " }), ["local"]);
  assert.deepEqual(ids({ query: "MODEL 10" }), ["external"]);
});

test("unmeasured and tied models remain discoverable with deterministic natural-name ordering", () => {
  assert.deepEqual(ids({ popularityScores: { external: 0.5 } }), ["external", "local", "balanced"]);
  assert.deepEqual(ids({ popularityScores: {} }), ["local", "balanced", "external"]);
  assert.deepEqual(ids({ popularityScores: { external: 0.5, local: 0.5, balanced: 0.5 } }), ["local", "balanced", "external"]);
  assert.deepEqual(ids({ popularityScores: undefined }), ["local", "balanced", "external"]);
});

test("changing the explicit sort mode is not overridden by popularity", () => {
  assert.deepEqual(ids({ sort: "recommended" }), ["external", "balanced", "local"]);
  assert.deepEqual(ids({ sort: "recent", recent: ["balanced", "external"] }), ["balanced", "external", "local"]);
  assert.deepEqual(ids({ sort: "name" }), ["local", "balanced", "external"]);
});
