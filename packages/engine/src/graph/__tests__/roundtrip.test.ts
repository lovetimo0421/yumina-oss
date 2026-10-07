import { describe, it, expect } from "vitest";
import { toGraph, applyGraphEdit } from "../../index.js";
import type { WorldDefinition, Rule, Variable } from "../../types/index.js";

const hp: Variable = { id: "hp", name: "HP", type: "number", defaultValue: 100 };
const rule: Rule = {
  id: "r1", name: "hit", trigger: { type: "keyword", keywords: ["hit"] },
  conditions: [], conditionLogic: "all",
  actions: [{ type: "modify-variable", variableId: "hp", operation: "subtract", value: 5 }],
  priority: 0, enabled: true,
};
const world = { rules: [rule], variables: [hp] } as unknown as WorldDefinition;

describe("graph round-trip", () => {
  it("toGraph reflects every modify-variable action as an edge", () => {
    const g = toGraph(world);
    expect(g.edges.filter((e) => e.from === "rule:r1" && e.to === "var:hp")).toHaveLength(1);
  });

  it("add then remove an effect edge returns to the original action count", () => {
    const added = applyGraphEdit(world, { op: "add-edge", edge: { id: "x", from: "rule:r1", fromPort: "effect", to: "var:hp", toPort: "write" } });
    expect(added.rules[0]!.actions).toHaveLength(2);
    const g = toGraph(added);
    const newEdge = g.edges.filter((e) => e.from === "rule:r1" && e.to === "var:hp").at(-1)!;
    const removed = applyGraphEdit(added, { op: "remove-edge", edgeId: newEdge.id });
    expect(removed.rules[0]!.actions).toHaveLength(1);
  });
});
