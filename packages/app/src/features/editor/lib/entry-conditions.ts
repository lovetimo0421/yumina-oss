import type { Condition, Variable, WorldEntry } from "@yumina/engine";
import { isVariableBoundEntry } from "@yumina/engine";

export type ConditionOperator = Condition["operator"];

const NUMERIC_OPS: ConditionOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte"];
const STRING_OPS: ConditionOperator[] = ["eq", "neq", "contains"];
const BOOLEAN_OPS: ConditionOperator[] = ["eq", "neq"];
const JSON_OPS: ConditionOperator[] = ["eq", "neq", "contains"];

export function entryUsesVariableBinding(
  entry: Pick<WorldEntry, "variableBound" | "conditions">,
): boolean {
  return isVariableBoundEntry(entry);
}

export function resolveVariableForCondition(
  variableId: string,
  variables: Variable[],
): Variable | undefined {
  const root = variableId.split(".")[0] ?? variableId;
  return variables.find((v) => v.id === root || v.name === root);
}

export function operatorsForVariableType(
  type: Variable["type"] | undefined,
): ConditionOperator[] {
  switch (type) {
    case "string":
      return STRING_OPS;
    case "boolean":
      return BOOLEAN_OPS;
    case "json":
      return JSON_OPS;
    case "number":
    default:
      return NUMERIC_OPS;
  }
}

export function defaultConditionForVariable(variable: Variable): Condition {
  const operator = operatorsForVariableType(variable.type)[0] ?? "eq";
  switch (variable.type) {
    case "string":
      return { variableId: variable.id, operator, value: "" };
    case "boolean":
      return { variableId: variable.id, operator, value: true };
    case "json":
      return { variableId: variable.id, operator, value: [] };
    case "number":
    default:
      return { variableId: variable.id, operator, value: 0 };
  }
}

export function normalizeConditionForVariable(
  condition: Condition,
  variables: Variable[],
): Condition {
  const variable = resolveVariableForCondition(condition.variableId, variables);
  if (!variable) return condition;

  const allowed = operatorsForVariableType(variable.type);
  const operator = allowed.includes(condition.operator)
    ? condition.operator
    : (allowed[0] ?? "eq");

  if (condition.valueRef !== undefined) {
    return { ...condition, operator };
  }

  const defaults = defaultConditionForVariable(variable);
  if (variable.type === "boolean" && typeof condition.value !== "boolean") {
    return { ...condition, operator, value: defaults.value };
  }
  if (variable.type === "string" && typeof condition.value !== "string") {
    return { ...condition, operator, value: String(condition.value ?? "") };
  }
  if (variable.type === "number" && typeof condition.value !== "number") {
    const n = Number(condition.value);
    return { ...condition, operator, value: Number.isFinite(n) ? n : 0 };
  }
  if (variable.type === "json") {
    if (operator === "contains") {
      return {
        ...condition,
        operator,
        value: typeof condition.value === "string" ? condition.value : "",
      };
    }
    if (
      typeof condition.value === "object" &&
      condition.value !== null
    ) {
      return { ...condition, operator, value: condition.value };
    }
    return { ...condition, operator, value: defaults.value };
  }

  return { ...condition, operator };
}

export function parseJsonConditionValue(raw: string): Condition["value"] {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as Condition["value"];
}
