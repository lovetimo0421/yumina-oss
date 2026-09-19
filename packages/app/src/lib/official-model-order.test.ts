import assert from "node:assert/strict";
import test from "node:test";
import type { PlayModel } from "@yumina/shared";
import { orderOfficialModels } from "./official-model-order";

function model(id: string, overrides: Partial<PlayModel> = {}): PlayModel {
  return { id, name: id, scope: "play", tier: "budget", minPlan: "free", avgCostMushies: 1, descKey: id, ...overrides };
}

const catalog = [
  model("vendor/beta", { name: "Model 10", avgCostMushies: 10, recommendationRank: 1, addedAt: "2026-09-18" }),
  model("vendor/alpha", { name: "Model 2", avgCostMushies: 2, recommendationRank: 3, addedAt: "2026-09-17" }),
  model("vendor/gamma", { name: "Model 3", avgCostMushies: 2, recommendationRank: 2, tier: "premium" }),
];
const defaults = {
  tier: "all", query: "", sort: "recommended", pinned: [], favoritesOnly: false, recent: [],
  description: (entry: PlayModel) => entry.id === "vendor/gamma" ? "细腻的人物描写" : "Fast dialogue",
} satisfies Parameters<typeof orderOfficialModels>[1];
function ids(options: Partial<Parameters<typeof orderOfficialModels>[1]> = {}, models = catalog) {
  return orderOfficialModels(models, { ...defaults, ...options }).map(entry => entry.id);
}

test("official sorting supports recommendations, comparable costs, dates and natural names without mutating the source", () => {
  const before = catalog.map(entry => entry.id);
  assert.deepEqual(ids(), ["vendor/beta", "vendor/gamma", "vendor/alpha"]);
  assert.deepEqual(ids({ sort: "costAsc" }), ["vendor/alpha", "vendor/gamma", "vendor/beta"]);
  assert.deepEqual(ids({ sort: "costDesc" }), ["vendor/beta", "vendor/alpha", "vendor/gamma"]);
  assert.deepEqual(ids({ sort: "newest" }), ["vendor/beta", "vendor/alpha", "vendor/gamma"]);
  assert.deepEqual(ids({ sort: "name" }), ["vendor/alpha", "vendor/gamma", "vendor/beta"]);
  assert.deepEqual(catalog.map(entry => entry.id), before);
});

test("recent sorting honors usage order and keeps never-used models discoverable", () => {
  assert.deepEqual(ids({ sort: "recent", recent: ["private/model", "vendor/gamma", "vendor/beta"] }), ["vendor/gamma", "vendor/beta", "vendor/alpha"]);
  assert.deepEqual(ids({ sort: "recent" }), ["vendor/alpha", "vendor/gamma", "vendor/beta"]);
});

test("search finds names, provider IDs and localized descriptions, ignoring case and surrounding spaces", () => {
  assert.deepEqual(ids({ query: "  MODEL 10  " }), ["vendor/beta"]);
  assert.deepEqual(ids({ query: "VENDOR/ALPHA" }), ["vendor/alpha"]);
  assert.deepEqual(ids({ query: "人物" }), ["vendor/gamma"]);
  assert.deepEqual(ids({ query: "dialogue" }), ["vendor/beta", "vendor/alpha"]);
  assert.deepEqual(ids({ query: "   " }), ids());
  assert.deepEqual(ids({ query: "no such model" }), []);
});

test("favorites intersect tier and search filters and tolerate pins missing from the catalog", () => {
  const pinned = ["vendor/gamma", "vendor/beta", "removed/model"];
  assert.deepEqual(ids({ pinned, favoritesOnly: true }), ["vendor/beta", "vendor/gamma"]);
  assert.deepEqual(ids({ pinned, favoritesOnly: true, tier: "budget", query: "dialogue" }), ["vendor/beta"]);
  assert.deepEqual(ids({ pinned, favoritesOnly: true, tier: "premium", query: "dialogue" }), []);
  assert.deepEqual(ids({ favoritesOnly: true }), []);
  assert.deepEqual(ids({ pinned, favoritesOnly: false }), ids());
});

test("models without optional ranking and date metadata remain visible after ranked and dated entries", () => {
  const entries = [model("legacy", { name: "A legacy" }), model("new", { name: "Z new", recommendationRank: 1, addedAt: "2026-09-18" })];
  assert.deepEqual(ids({}, entries), ["new", "legacy"]);
  assert.deepEqual(ids({ sort: "newest" }, entries), ["new", "legacy"]);
});
