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

  it("wiring a variable into an always-on entry gates it without touching its own flag, and unwiring hands it back", () => {
    const entry = { id: "e1", name: "secret", content: "x", keywords: [], conditions: [], alwaysSend: true, enabled: true };
    const world = { ...base, entries: [entry] } as unknown as WorldDefinition;
    const wired = applyGraphEdit(world, { op: "add-edge", edge: { id: "e", from: "var:hp", fromPort: "read", to: "entry:e1", toPort: "gate" } });
    expect(wired.entries[0]!.conditions).toHaveLength(1);
    expect(wired.entries[0]!.alwaysSend).toBe(true);
    const unwired = applyGraphEdit(wired, { op: "remove-edge", edgeId: "e:var:hp->entry:e1:0" });
    expect(unwired.entries[0]).toMatchObject({ conditions: [], alwaysSend: true });
  });

  it("unwiring the last condition clears a leftover variableBound flag, so the entry is not left gated on nothing", () => {
    const entry = {
      id: "e1", name: "secret", content: "x", keywords: [], alwaysSend: false, enabled: true, variableBound: true,
      conditions: [{ variableId: "hp", operator: "gt", value: 0 }, { variableId: "hp", operator: "lt", value: 50 }],
    };
    const world = { ...base, entries: [entry] } as unknown as WorldDefinition;
    const one = applyGraphEdit(world, { op: "remove-edge", edgeId: "e:var:hp->entry:e1:1" });
    expect(one.entries[0]).toMatchObject({ variableBound: true });
    const none = applyGraphEdit(one, { op: "remove-edge", edgeId: "e:var:hp->entry:e1:0" });
    expect(none.entries[0]).toMatchObject({ conditions: [], variableBound: false });
  });

  it("removing a behaviour's write into an array item of a variable removes that effect", () => {
    const world = {
      ...base,
      reactions: [{
        id: "r1", name: "x", enabled: true, priority: 0, when: { eventType: "turn:complete" },
        conditions: [], conditionLogic: "all", then: [{ type: "set", path: "inv[0].n", value: "sword" }],
      }],
    } as unknown as WorldDefinition;
    const next = applyGraphEdit(world, { op: "remove-edge", edgeId: "e:reaction:r1->var:inv:0" });
    expect(next.reactions![0]!.then).toHaveLength(0);
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
