import { describe, it, expect } from "vitest";
import { applyGraphEdit } from "../compiler.js";
import type { WorldDefinition, Rule, Variable } from "../../types/index.js";

const hp: Variable = { id: "hp", name: "HP", type: "number", defaultValue: 100 };
const rule: Rule = {
  id: "r1", name: "praise", trigger: { type: "keyword", keywords: ["hi"] },
  conditions: [], conditionLogic: "all", actions: [], priority: 0, enabled: true,
};
const base = { rules: [rule], variables: [hp] } as unknown as WorldDefinition;

describe("applyGraphEdit", () => {
  it("add-edge rule→var appends a modify-variable action", () => {
    const next = applyGraphEdit(base, { op: "add-edge", edge: { id: "e", from: "rule:r1", fromPort: "effect", to: "var:hp", toPort: "write" } });
    expect(next.rules[0]!.actions).toHaveLength(1);
    expect(next.rules[0]!.actions[0]).toMatchObject({ type: "modify-variable", variableId: "hp" });
  });

  it("does not mutate the input world", () => {
    applyGraphEdit(base, { op: "add-edge", edge: { id: "e", from: "rule:r1", fromPort: "effect", to: "var:hp", toPort: "write" } });
    expect(base.rules[0]!.actions).toHaveLength(0);
  });

  it("remove-node rule:r1 drops the rule", () => {
    const next = applyGraphEdit(base, { op: "remove-node", nodeId: "rule:r1" });
    expect(next.rules).toHaveLength(0);
  });

  it("update-node-data renames the rule", () => {
    const next = applyGraphEdit(base, { op: "update-node-data", nodeId: "rule:r1", data: { name: "renamed" } });
    expect(next.rules[0]!.name).toBe("renamed");
  });

  it("remove-edge rule→var removes the first matching action", () => {
    const world2 = applyGraphEdit(base, { op: "add-edge", edge: { id: "e", from: "rule:r1", fromPort: "effect", to: "var:hp", toPort: "write" } });
    const next = applyGraphEdit(world2, { op: "remove-edge", edgeId: "e:rule:r1->var:hp:0" });
    expect(next.rules[0]!.actions).toHaveLength(0);
  });

  it("add-edge evt:user→rule sets a keyword trigger", () => {
    const next = applyGraphEdit(base, { op: "add-edge", edge: { id: "e2", from: "evt:user", fromPort: "fires", to: "rule:r1", toPort: "trigger" } });
    expect(next.rules[0]!.trigger).toMatchObject({ type: "keyword", keywords: [] });
  });

  it("remove-edge by exact index removes the action at that index, not the first matching one", () => {
    // Rule with TWO modify-variable actions on the same variable: add (index 0) then subtract (index 1).
    const twoActionRule: Rule = {
      id: "r2", name: "double-hp", trigger: { type: "keyword", keywords: [] },
      conditions: [], conditionLogic: "all", priority: 0, enabled: true,
      actions: [
        { type: "modify-variable", variableId: "hp", operation: "add", value: 10 },
        { type: "modify-variable", variableId: "hp", operation: "subtract", value: 5 },
      ],
    };
    const world = { rules: [twoActionRule], variables: [hp] } as unknown as WorldDefinition;
    // Remove the edge for index :1 (the subtract action) — must NOT remove index :0.
    const next = applyGraphEdit(world, { op: "remove-edge", edgeId: "e:rule:r2->var:hp:1" });
    expect(next.rules[0]!.actions).toHaveLength(1);
    expect(next.rules[0]!.actions[0]).toMatchObject({ type: "modify-variable", variableId: "hp", operation: "add" });
  });
});
