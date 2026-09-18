import type { GameState, LoreUiBinding, WorldEntry } from "../types/index.js";
import { checkConditions } from "../state/condition-evaluator.js";
import { isVariableBoundEntry, getActiveLoreSlots } from "./entry-triggers.js";
export type { LoreSlotDescriptor } from "./lore-slot-scan.js";
export { extractLoreSlotsFromFiles } from "./lore-slot-scan.js";

export interface ResolvedLoreSlot {
  entry: WorldEntry | null;
  content: string;
}

/** Resolve which entry (if any) should render in a LoreSlot at runtime. */
export function resolveLoreSlotContent(
  slotId: string,
  bindings: LoreUiBinding[] | undefined,
  entries: WorldEntry[],
  state: GameState,
): ResolvedLoreSlot {
  const binding = bindings?.find((b) => b.slotId === slotId);
  if (!binding?.entryId) return { entry: null, content: "" };

  const entry = entries.find((e) => {
    if (e.id !== binding.entryId) return false;
    if (isVariableBoundEntry(e)) return true;
    return e.enabled !== false;
  });
  if (!entry) {
    return { entry: null, content: "" };
  }

  if (
    entry.conditions.length > 0 &&
    !checkConditions(state, entry.conditions, entry.conditionLogic)
  ) {
    return { entry: null, content: "" };
  }

  return { entry, content: entry.content };
}

/**
 * OUTER GATE for frontend-controlled lore. Drop any entry wired to a
 * `<LoreSlot>` / `<LoreButton>` whose slot is NOT currently active — i.e. the
 * player hasn't toggled it on. Slot activity lives in
 * `state.metadata.activeLoreSlots` (the world-renderer PATCHes it from the
 * sandbox before the next turn; preserved by normalize/merge/thin-snapshot, so
 * it is revert/branch-safe). An active slot may carry extra binding conditions
 * that must ALSO pass.
 *
 * Entries NOT in `bindings` pass through untouched. A card with no bindings is
 * unaffected (full back-compat). Runs as a pre-filter alongside the worldbook
 * gate, BEFORE the keyword/condition matcher — so a bound entry's own
 * `alwaysSend`/keywords can no longer leak it into the prompt while its slot is
 * off (the "AI reveals the secret codex before you click" bug).
 */
export function filterEntriesByActiveLoreSlots(
  entries: WorldEntry[],
  bindings: LoreUiBinding[] | undefined,
  state: GameState,
): WorldEntry[] {
  if (!Array.isArray(bindings) || bindings.length === 0) return entries;
  // entryId → its binding (first wins if an entry is bound more than once).
  const byEntry = new Map<string, LoreUiBinding>();
  for (const b of bindings) {
    if (b.entryId && !byEntry.has(b.entryId)) byEntry.set(b.entryId, b);
  }
  if (byEntry.size === 0) return entries;
  // A slot is "on" if either signal says so:
  //  • `state.variables["__lore_{slotId}"]` — what LoreButton/LoreSwitch/LoreGroup
  //    persist (travels WITH the message state, so no separate-PATCH race), or
  //  • `metadata.activeLoreSlots` — what a bare <LoreSlot> mount writes at runtime.
  const activeSlots = new Set(getActiveLoreSlots(state));
  const vars = state.variables ?? {};
  const isSlotActive = (slotId: string): boolean =>
    activeSlots.has(slotId) ||
    vars[`__lore_${slotId}`] === true ||
    vars[`__lore_${slotId}`] === "true";
  return entries.filter((e) => {
    const binding = byEntry.get(e.id);
    if (!binding) return true; // not frontend-bound → unaffected
    if (!isSlotActive(binding.slotId)) return false; // slot off → gate out
    if (
      binding.conditions.length > 0 &&
      !checkConditions(state, binding.conditions, binding.conditionLogic)
    ) {
      return false; // slot on, but the binding's extra conditions fail
    }
    return true;
  });
}
