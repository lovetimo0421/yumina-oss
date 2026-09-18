import type { Condition, LoreUiBinding, Variable } from "@yumina/engine";
import { getEntryBoundSlotId as engineGetEntryBoundSlotId } from "@yumina/engine";

const OP_LABEL: Record<Condition["operator"], string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "∋",
};

export function normalizeLoreUiBindingsList(raw: unknown): LoreUiBinding[] {
  if (!Array.isArray(raw)) return [];
  const normalized: LoreUiBinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const binding = item as Partial<LoreUiBinding>;
    const slotId = typeof binding.slotId === "string" ? binding.slotId.trim() : "";
    if (!slotId) continue;
    normalized.push({
      slotId,
      entryId: typeof binding.entryId === "string" ? binding.entryId : "",
      conditions: Array.isArray(binding.conditions) ? binding.conditions : [],
      conditionLogic: binding.conditionLogic === "any" ? "any" : "all",
    });
  }
  return normalized;
}

export const getEntryBoundSlotId = engineGetEntryBoundSlotId;

/** One entry ↔ one slot. Rebind clears the previous occupant of the target slot. */
export function setEntryUiBinding(
  bindings: LoreUiBinding[],
  entryId: string,
  slotId: string | null,
): LoreUiBinding[] {
  const withoutEntry = bindings.filter((b) => b.entryId !== entryId);
  if (!slotId) return withoutEntry;
  const withoutSlot = withoutEntry.filter((b) => b.slotId !== slotId);
  return [
    ...withoutSlot,
    { slotId, entryId, conditions: [], conditionLogic: "all" },
  ];
}

export function formatConditionLabel(
  condition: Condition,
  variables: Variable[],
): string {
  const variable = variables.find((v) => v.id === condition.variableId);
  const name = variable?.name ?? condition.variableId;
  const op = OP_LABEL[condition.operator] ?? condition.operator;
  if (condition.valueRef) {
    const ref = variables.find((v) => v.id === condition.valueRef);
    return `${name} ${op} ${ref?.name ?? condition.valueRef}`;
  }
  if (typeof condition.value === "boolean") {
    return `${name} ${op} ${condition.value ? "true" : "false"}`;
  }
  if (typeof condition.value === "object" && condition.value !== null) {
    const text = JSON.stringify(condition.value);
    const short = text.length > 14 ? `${text.slice(0, 14)}…` : text;
    return `${name} ${op} ${short}`;
  }
  return `${name} ${op} ${String(condition.value)}`;
}
