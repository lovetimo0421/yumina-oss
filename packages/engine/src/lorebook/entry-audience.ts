import type { WorldEntry } from "../types/index.js";

export type LoreEntryAudience = "ai" | "player" | "both";

export function getEntryAudience(entry: WorldEntry): LoreEntryAudience {
  return entry.audience ?? "both";
}

/** Entries injected into the main AI prompt (lorebook matcher / PromptBuilder). */
export function isEntryForPrompt(entry: WorldEntry): boolean {
  const audience = getEntryAudience(entry);
  return audience === "ai" || audience === "both";
}

/** Entries eligible for Custom UI LoreSlot display. */
export function isEntryForPlayerUi(entry: WorldEntry): boolean {
  const audience = getEntryAudience(entry);
  return audience === "player" || audience === "both";
}
