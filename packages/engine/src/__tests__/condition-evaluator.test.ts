import { describe, it, expect } from "vitest";
import { checkConditions, evaluateCondition } from "../state/condition-evaluator.js";
import type { Condition, GameState } from "../types/index.js";

function state(vars: Record<string, unknown>): GameState {
  return { worldId: "t", variables: vars, turnCount: 1, metadata: {} };
}

describe("condition-evaluator", () => {
  it("compares booleans with eq/neq", () => {
    const on: Condition = { variableId: "flag", operator: "eq", value: true };
    const off: Condition = { variableId: "flag", operator: "eq", value: false };
    expect(evaluateCondition(state({ flag: true }), on)).toBe(true);
    expect(evaluateCondition(state({ flag: false }), on)).toBe(false);
    expect(evaluateCondition(state({ flag: false }), off)).toBe(true);
  });

  it("compares json values with deep equality", () => {
    const cond: Condition = {
      variableId: "meta",
      operator: "eq",
      value: { stage: 2, tags: ["a"] },
    };
    expect(evaluateCondition(state({ meta: { stage: 2, tags: ["a"] } }), cond)).toBe(true);
    expect(evaluateCondition(state({ meta: { stage: 1, tags: ["a"] } }), cond)).toBe(false);
  });

  it("contains works on json arrays", () => {
    const cond: Condition = {
      variableId: "flags",
      operator: "contains",
      value: "met_king",
    };
    expect(evaluateCondition(state({ flags: ["met_king", "other"] }), cond)).toBe(true);
    expect(evaluateCondition(state({ flags: ["other"] }), cond)).toBe(false);
  });

  it("supports valueRef and dot paths", () => {
    const cond: Condition = {
      variableId: "bag.gold",
      operator: "gte",
      value: 0,
      valueRef: "price",
    };
    expect(
      evaluateCondition(state({ bag: { gold: 150 }, price: 100 }), cond),
    ).toBe(true);
    expect(
      evaluateCondition(state({ bag: { gold: 50 }, price: 100 }), cond),
    ).toBe(false);
  });

  it("checkConditions respects all/any logic", () => {
    const conds: Condition[] = [
      { variableId: "a", operator: "eq", value: 1 },
      { variableId: "b", operator: "eq", value: 2 },
    ];
    expect(checkConditions(state({ a: 1, b: 2 }), conds, "all")).toBe(true);
    expect(checkConditions(state({ a: 1, b: 0 }), conds, "all")).toBe(false);
    expect(checkConditions(state({ a: 0, b: 2 }), conds, "any")).toBe(true);
  });
});
