import type { Condition, GameState } from "../types/index.js";
import { getByPath } from "./path-utils.js";

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** Evaluate a single game-state condition (supports dot-paths and valueRef). */
export function evaluateCondition(state: GameState, condition: Condition): boolean {
  const current = getByPath(state.variables, condition.variableId);
  if (current === undefined) return false;

  const target =
    condition.valueRef !== undefined
      ? getByPath(state.variables, condition.valueRef)
      : condition.value;
  if (condition.valueRef !== undefined && target === undefined) return false;

  switch (condition.operator) {
    case "eq":
      return valuesEqual(current, target);
    case "neq":
      return !valuesEqual(current, target);
    case "gt":
      return typeof current === "number" && typeof target === "number" && current > target;
    case "gte":
      return typeof current === "number" && typeof target === "number" && current >= target;
    case "lt":
      return typeof current === "number" && typeof target === "number" && current < target;
    case "lte":
      return typeof current === "number" && typeof target === "number" && current <= target;
    case "contains":
      if (Array.isArray(current)) {
        return current.some((item) => valuesEqual(item, target) || item === target);
      }
      return typeof current === "string" && typeof target === "string" && current.includes(target);
    default:
      return false;
  }
}

export function checkConditions(
  state: GameState,
  conditions: Condition[],
  logic: "all" | "any",
): boolean {
  if (conditions.length === 0) return true;
  if (logic === "all") {
    return conditions.every((c) => evaluateCondition(state, c));
  }
  return conditions.some((c) => evaluateCondition(state, c));
}
