import type { LoreUiBinding, WorldEntry } from "../types/index.js";

export type EntryTriggerCategory =
  | "always-send"
  | "keywords"
  | "variables"
  | "frontend";

/** Entry is gated by variable conditions instead of manual enable / always-send. */
export function isVariableBoundEntry(
  entry: Pick<WorldEntry, "variableBound" | "conditions">,
): boolean {
  if (entry.variableBound === true) return true;
  return (entry.conditions?.length ?? 0) > 0;
}

export function getUiBoundEntryIds(
  bindings: LoreUiBinding[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(bindings)) return ids;
  for (const binding of bindings) {
    if (binding.entryId) ids.add(binding.entryId);
  }
  return ids;
}

export function isUiBoundEntry(
  entryId: string,
  bindings: LoreUiBinding[] | undefined,
): boolean {
  return getUiBoundEntryIds(bindings).has(entryId);
}

/** LoreSlot id that gates this entry, if any. */
export function getEntryBoundSlotId(
  entryId: string,
  bindings: LoreUiBinding[] | undefined,
): string | null {
  if (!Array.isArray(bindings)) return null;
  return bindings.find((b) => b.entryId === entryId)?.slotId ?? null;
}

export function getActiveLoreSlots(state: {
  metadata?: Record<string, unknown>;
}): string[] {
  const raw = state.metadata?.activeLoreSlots;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function isLoreSlotActive(
  slotId: string,
  state: { metadata?: Record<string, unknown> },
): boolean {
  return getActiveLoreSlots(state).includes(slotId);
}

/** Classify an entry for the trigger-board UI (one primary bucket per entry). */
export function classifyEntryTriggerCategory(
  entry: Pick<
    WorldEntry,
    "id" | "alwaysSend" | "keywords" | "variableBound" | "conditions"
  >,
  bindings: LoreUiBinding[] | undefined,
): EntryTriggerCategory {
  if (isUiBoundEntry(entry.id, bindings)) return "frontend";
  if (isVariableBoundEntry(entry)) return "variables";
  if (entry.alwaysSend) return "always-send";
  return "keywords";
}
