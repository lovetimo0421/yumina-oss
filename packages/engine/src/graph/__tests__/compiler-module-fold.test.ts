import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { WorldEntry, Worldbook, Variable } from "../../types/index.js";

// A module stuffed with plain lore entries must not explode the canvas:
// relationship-free member entries fold into one summary node per module
// once there are enough of them. Small modules keep individual nodes —
// seeing four entry names beats one "×4" box.

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "lore", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

const hp: Variable = { id: "hp", name: "hp", type: "number", defaultValue: 100 };
const B: Worldbook = { id: "B", name: "Big", order: 0, activation: { mode: "always" } };
const C: Worldbook = { id: "C", name: "Small", order: 1, activation: { mode: "always" } };

const world = {
  variables: [hp],
  rules: [],
  entries: [
    // Big module: 5 plain + 1 gated
    ...["b1", "b2", "b3", "b4", "b5"].map((id) => entry({ id, worldbookId: "B" })),
    entry({ id: "bGated", worldbookId: "B", conditions: [{ variableId: "hp", operator: "lte", value: 10 }] }),
    // Small module: 4 plain — below the fold threshold
    ...["c1", "c2", "c3", "c4"].map((id) => entry({ id, worldbookId: "C" })),
    // Core plain entry — existing core fold behavior
    entry({ id: "corePlain" }),
  ],
  worldbooks: [B, C],
};

const graph = toGraph(world);
const node = (id: string) => graph.nodes.find((n) => n.id === id);

describe("toGraph — per-module entry folding", () => {
  it("folds ≥5 relationship-free member entries into one summary node inside the module", () => {
    const fold = node("module-entries:B");
    expect(fold).toBeDefined();
    expect(fold!.kind).toBe("entry");
    expect(fold!.parentId).toBe("module:B");
    expect(fold!.data.count).toBe(5);
    for (const id of ["b1", "b2", "b3", "b4", "b5"]) {
      expect(node(`entry:${id}`)).toBeUndefined();
    }
  });

  it("entries with relationships stay individual even in a folding module", () => {
    expect(node("entry:bGated")).toBeDefined();
    expect(node("entry:bGated")!.parentId).toBe("module:B");
  });

  it("small modules keep individual entry nodes", () => {
    expect(node("module-entries:C")).toBeUndefined();
    for (const id of ["c1", "c2", "c3", "c4"]) {
      expect(node(`entry:${id}`)!.parentId).toBe("module:C");
    }
  });

  it("core folding is unchanged", () => {
    expect(node("core-entries")?.data.count).toBe(1);
    expect(node("entry:corePlain")).toBeUndefined();
  });
});
