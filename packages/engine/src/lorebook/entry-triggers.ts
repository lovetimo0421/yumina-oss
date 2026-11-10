import type { GameState, LoreUiBinding, WorldEntry } from "../types/index.js";
import { checkConditions } from "../state/condition-evaluator.js";

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

/**
 * Whether the entry's own settings send it to the story AI every turn: it is
 * marked always-send AND no variable condition gates it. Conditions win over
 * always-send at runtime (the matcher treats a variable-bound entry as a
 * candidate, never as always-on), and wiring a variable into an entry on the
 * canvas only appends a condition — it leaves `alwaysSend` as it was, so that
 * pulling the wire out again gives the entry back exactly as it stood. Every
 * display that says "always on" reads this, not the raw flag.
 */
export function isAlwaysSendEntry(
  entry: Pick<WorldEntry, "alwaysSend"> & Partial<Pick<WorldEntry, "variableBound" | "conditions">>,
): boolean {
  return Boolean(entry.alwaysSend) && !isVariableBoundEntry({
    variableBound: entry.variableBound,
    conditions: entry.conditions ?? [],
  });
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

/**
 * A standby entry (the canvas's 待命设定: not every-turn, no keywords, no
 * conditions, not bound to an interface slot) that a behaviour has switched
 * on. It is sent every turn from then on, the way the canvas promises
 * ("由行为开关"). Before this, switching one on only flipped `enabled`, and
 * every prompt path read `alwaysSend` first, so the entry never reached the AI.
 */
export function isStandbyOn(
  entry: Pick<WorldEntry, "id" | "alwaysSend" | "keywords" | "conditions">,
  toggledEntries: Record<string, boolean> | undefined,
  bindings?: LoreUiBinding[],
): boolean {
  if (toggledEntries?.[entry.id] !== true) return false;
  if (entry.alwaysSend) return false;
  if ((entry.keywords?.length ?? 0) > 0 || (entry.conditions?.length ?? 0) > 0) return false;
  return !isUiBoundEntry(entry.id, bindings);
}

/**
 * Whether an entry goes to the AI every turn right now: every-turn entries
 * and switched-on standby entries, after a behaviour's 启用词条 / 禁用词条
 * have had their say. For the side AIs (group voices, quiet AIs, AI calls)
 * that read the card's every-turn lore without the full prompt builder.
 *
 * Gated the way the story AI's lore is (lorebook-matcher): an entry wired to
 * variables is in while its conditions hold, one wired to an interface slot
 * while that slot is on. Read off `alwaysSend` alone, a secret written for
 * "only once the door is open" reached every side AI from the first turn.
 * Without `state` neither kind is sent.
 */
export function sendsEveryTurn(
  entry: Pick<WorldEntry, "id" | "alwaysSend" | "keywords" | "conditions" | "enabled"> & Partial<Pick<WorldEntry, "variableBound" | "conditionLogic">>,
  toggledEntries: Record<string, boolean> | undefined,
  bindings?: LoreUiBinding[],
  state?: Pick<GameState, "variables"> & { metadata?: Record<string, unknown> },
): boolean {
  const bound = isVariableBoundEntry({ variableBound: entry.variableBound, conditions: entry.conditions ?? [] });
  const slot = getEntryBoundSlotId(entry.id, bindings);
  if (slot && !(state && isLoreSlotActive(slot, state))) return false;
  if (bound) {
    // Like the story AI's lore: a variable-gated entry is in while its
    // conditions hold, whatever its own switch says; a keyword it also has
    // cannot be heard by a side AI, so it waits for the story AI.
    if (!state || (entry.keywords?.length ?? 0) > 0) return false;
    return checkConditions(state as GameState, entry.conditions ?? [], entry.conditionLogic ?? "all");
  }
  const on = toggledEntries && entry.id in toggledEntries ? toggledEntries[entry.id] : entry.enabled !== false;
  if (!on) return false;
  return entry.alwaysSend || isStandbyOn(entry, toggledEntries, bindings);
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
