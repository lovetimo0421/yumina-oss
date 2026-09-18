import { describe, it, expect } from "vitest";
import { ReactionEvaluator } from "../reactions/reaction-evaluator.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { getByPath } from "../state/path-utils.js";
import { createMockVariable, createMockWorld } from "./test-utils.js";
import type { Reaction } from "../events/types.js";
import type { Condition, GameState } from "../types/index.js";

function makeState(vars: Record<string, unknown>): GameState {
  return { worldId: "t", variables: vars, turnCount: 1, metadata: {} };
}

function condReaction(condition: Condition): Reaction {
  return {
    id: "r", name: "r", when: { eventType: "turn:complete" },
    conditions: [condition], conditionLogic: "all",
    then: [{ type: "set", path: "fired", value: true, operation: "set" }],
    priority: 0, enabled: true,
  };
}

describe("getByPath", () => {
  it("reads flat and nested paths", () => {
    const vars = { hp: 10, bag: { gold: 150, items: [{ id: "sword" }] } };
    expect(getByPath(vars, "hp")).toBe(10);
    expect(getByPath(vars, "bag.gold")).toBe(150);
    expect(getByPath(vars, "bag.items.0.id")).toBe("sword");
    expect(getByPath(vars, "bag.missing")).toBeUndefined();
    expect(getByPath(vars, "nope.deep")).toBeUndefined();
    expect(getByPath(vars, "")).toBeUndefined();
  });
});

describe("variable-vs-variable conditions", () => {
  const ev = new ReactionEvaluator();
  const fire = (vars: Record<string, unknown>, condition: Condition) =>
    ev.evaluate({ type: "turn:complete", turnCount: 1 }, [condReaction(condition)], [], makeState(vars)).firedIds;

  it("compares two variables via valueRef", () => {
    expect(fire({ 好感: 50, 戒心: 30 }, { variableId: "好感", operator: "gt", value: 0, valueRef: "戒心" })).toContain("r");
    expect(fire({ 好感: 20, 戒心: 30 }, { variableId: "好感", operator: "gt", value: 0, valueRef: "戒心" })).toHaveLength(0);
  });

  it("resolves a nested dot-path on the LHS", () => {
    expect(fire({ 背包: { 金币: 150 } }, { variableId: "背包.金币", operator: "gte", value: 100 })).toContain("r");
    expect(fire({ 背包: { 金币: 50 } }, { variableId: "背包.金币", operator: "gte", value: 100 })).toHaveLength(0);
  });

  it("contains works on arrays", () => {
    expect(fire({ 旗标: ["见过国王"] }, { variableId: "旗标", operator: "contains", value: "见过国王" })).toContain("r");
    expect(fire({ 旗标: ["别的"] }, { variableId: "旗标", operator: "contains", value: "见过国王" })).toHaveLength(0);
  });

  it("falls back to the literal when valueRef is absent (back-compat)", () => {
    expect(fire({ 好感: 90 }, { variableId: "好感", operator: "gte", value: 80 })).toContain("r");
  });

  it("does not fire when valueRef is unresolved", () => {
    expect(fire({ 好感: 50 }, { variableId: "好感", operator: "gt", value: 0, valueRef: "不存在" })).toHaveLength(0);
  });
});

describe("variable-driven effect operands", () => {
  const numVar = (id: string, def = 0) => createMockVariable({ id, name: id, type: "number", defaultValue: def });

  it("subtracts one variable's value from another (valueRef operand)", () => {
    const mgr = new GameStateManager(createMockWorld({ variables: [numVar("生命", 100), numVar("力量", 15)] }));
    const changes = mgr.applyEffects([{ variableId: "生命", operation: "subtract", value: 0, valueRef: "力量" }]);
    expect(mgr.get("生命")).toBe(85);
    expect(changes).toHaveLength(1);
  });

  it("copies another variable's value with set", () => {
    const mgr = new GameStateManager(createMockWorld({ variables: [numVar("a", 0), numVar("b", 42)] }));
    mgr.applyEffects([{ variableId: "a", operation: "set", value: 0, valueRef: "b" }]);
    expect(mgr.get("a")).toBe(42);
  });

  it("skips the effect when the operand reference is unresolved", () => {
    const mgr = new GameStateManager(createMockWorld({ variables: [numVar("生命", 100)] }));
    const changes = mgr.applyEffects([{ variableId: "生命", operation: "subtract", value: 0, valueRef: "不存在" }]);
    expect(mgr.get("生命")).toBe(100);
    expect(changes).toHaveLength(0);
  });
});
