/**
 * Model family classification — one shared source of truth for server + app.
 *
 * A "family" groups a chat model by its provider/base so a player can bind a
 * prompt per family ("Gemini 用这条, Claude 用那条…"). When the chat model
 * changes, the server reads the player's binding for that model's family and
 * applies the prompt bound to it (see server lib/user-prompts.ts).
 *
 * The binding settings UI is driven by MODEL_FAMILIES so the slot list and the
 * classifier never drift apart.
 */

/** Ordered family keys. Drives the per-model binding slots in settings. */
export const MODEL_FAMILIES = [
  "gemini",
  "claude",
  "openai",
  "deepseek",
  "glm",
  "grok",
  "kimi",
  "minimax",
  "other",
] as const;

export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export function isModelFamily(value: unknown): value is ModelFamily {
  return typeof value === "string" && (MODEL_FAMILIES as readonly string[]).includes(value);
}

/**
 * Map a model id to its family. Matches the provider prefix first (the common
 * case, e.g. google/gemini-2.5-flash), then the family name anywhere in the id
 * so BYOK / private / local ids that drop the provider prefix still classify.
 * Anything unrecognised — and an empty/missing id — is "other".
 */
export function familyOf(modelId?: string | null): ModelFamily {
  const id = (modelId ?? "").trim().toLowerCase();
  if (!id) return "other";
  // Provider-prefixed ids.
  if (id.startsWith("google/")) return "gemini";
  if (id.startsWith("anthropic/")) return "claude";
  if (id.startsWith("openai/")) return "openai";
  if (id.startsWith("deepseek/")) return "deepseek";
  if (id.startsWith("z-ai/")) return "glm";
  if (id.startsWith("x-ai/")) return "grok";
  if (id.startsWith("moonshot")) return "kimi"; // moonshot/ and moonshotai/
  if (id.startsWith("minimax/")) return "minimax";
  // Prefix-less ids (BYOK, local endpoints): match the family word.
  if (id.includes("gemini")) return "gemini";
  if (id.includes("claude")) return "claude";
  if (id.includes("gpt") || id.includes("openai")) return "openai";
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("glm")) return "glm";
  if (id.includes("grok")) return "grok";
  if (id.includes("kimi")) return "kimi";
  if (id.includes("minimax")) return "minimax";
  return "other";
}
