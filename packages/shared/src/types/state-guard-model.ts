/** Guard-only provider selection, stored in the existing nullable model column.
 * Untagged IDs retain legacy account-provider routing. Never send tags to an LLM. */
export const DEFAULT_STATE_GUARD_MODEL = "official::google/gemini-2.5-flash-lite";
export const FREE_STATE_GUARD_MODEL = "official::openrouter/free";

export function parseStateGuardModel(selection: string | null | undefined): { model: string | null; provider?: "official" | "private" } {
  const match = /^(official|private)::(.+)$/.exec(selection ?? "");
  return match ? { provider: match[1] as "official" | "private", model: match[2]! } : { model: selection ?? null };
}

export function stateGuardModelSelection(model: string, provider: "official" | "private"): string {
  return `${provider}::${model}`;
}
