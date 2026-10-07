import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { playtestAffectingChange } from "./playtest-stale";

const world = (over: Partial<WorldDefinition> = {}): WorldDefinition => ({
  id: "w", version: "21.0.0", name: "卡", description: "", author: "",
  entries: [], variables: [{ id: "fav", name: "好感度", type: "number", defaultValue: 10 }],
  rules: [], components: [], audioTracks: [], customUI: [],
  rootComponent: { id: "r", name: "UI", entryFile: "index.tsx", files: { "index.tsx": "x" }, updatedAt: "1" },
  ...over,
} as WorldDefinition);

describe("playtestAffectingChange", () => {
  it("flags a variable setting change", () => {
    const a = world();
    const b = { ...a, variables: [{ ...a.variables[0]!, precise: true, deltaDown: 10, deltaUp: 10 }] };
    assert.equal(playtestAffectingChange(a, b), true);
  });

  it("ignores the card's name, description and cover", () => {
    const a = world();
    assert.equal(playtestAffectingChange(a, { ...a, name: "新名字", description: "简介", avatar: "x.png" } as WorldDefinition), false);
  });

  it("ignores a recompile that only restamps the screen, and missing vs empty lists", () => {
    const a = world();
    const b = { ...a, rootComponent: { ...a.rootComponent!, updatedAt: "2" }, reactions: [] };
    assert.equal(playtestAffectingChange(a, b), false);
    assert.equal(playtestAffectingChange(a, { ...b, rootComponent: { ...b.rootComponent, files: { "index.tsx": "y" } } }), true);
  });
});
