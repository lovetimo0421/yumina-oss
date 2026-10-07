import { isVariableBoundEntry, UNPLACED_WORLDBOOK_ID } from "@yumina/engine";
import type { LoreUiBinding, Worldbook, WorldEntry } from "@yumina/engine";

export type EntryDeliveryMode = "unplaced" | "disabled" | "always" | "keywords" | "conditions" | "keywords-and-conditions" | "frontend" | "unconfigured";

/** Describe configured delivery, never a prediction about the current playtest.
 * Variable conditions override alwaysSend, but the final prompt builder still
 * respects enabled. Module and frontend gates apply outside of the entry's own
 * trigger. Keep these limits visible in the summary. */
export function getEntryDeliverySummary(
  entry: WorldEntry,
  context: { worldbooks?: Worldbook[]; loreUiBindings?: LoreUiBinding[] } = {},
) {
  const variableBound = isVariableBoundEntry(entry);
  const binding = context.loreUiBindings?.find((item) => item.entryId === entry.id);
  const conditionCount = entry.conditions?.length ?? 0;
  const hasKeywords = (entry.keywords?.length ?? 0) > 0;
  const moduleScoped = Boolean(context.worldbooks?.some((book) => book.id === entry.worldbookId));
  const frontendScoped = Boolean(binding);

  let mode: EntryDeliveryMode;
  // Outside every frame it is in play nowhere, whatever else it says.
  if (entry.worldbookId === UNPLACED_WORLDBOOK_ID) mode = "unplaced";
  else if (entry.enabled === false) mode = "disabled";
  else if (entry.alwaysSend && !variableBound) mode = "always";
  else if (conditionCount > 0 && hasKeywords) mode = "keywords-and-conditions";
  else if (conditionCount > 0) mode = "conditions";
  else if (hasKeywords) mode = "keywords";
  else if (frontendScoped) mode = "frontend";
  else mode = "unconfigured";

  return {
    mode,
    moduleScoped,
    frontendScoped,
    frontendConditions: (binding?.conditions?.length ?? 0) > 0,
    conditionCount,
    conditionLogic: entry.conditionLogic === "any" ? "any" : "all",
    secondaryKeywords: (mode === "keywords" || mode === "keywords-and-conditions") && (entry.secondaryKeywords?.length ?? 0) > 0,
  };
}
