/**
 * Model families for the per-model prompt binding (replaces the old 解除限制
 * variant logic). A "family" groups model ids so a player can bind one of their
 * installed prompts to auto-apply whenever a model of that family is selected.
 *
 * `familyOf` is the engine's (shared with the server), so the chat can never
 * disagree with the prompt the server actually applies.
 */

import { familyOf as engineFamilyOf } from "@yumina/engine";

/** Every family key `familyOf` can return. Includes `minimax`, which has no
 *  binding slot in settings but is still reported so the chat status line never
 *  disagrees with what the server actually applies. */
export type ModelFamily =
  | "gemini"
  | "claude"
  | "openai"
  | "deepseek"
  | "glm"
  | "grok"
  | "kimi"
  | "minimax"
  | "other";

/** The binding slots shown in 设置 › 提示词, in display order. Drives the rows
 *  and validates PUT /api/user-prompts/bindings inputs. `minimax` is intentionally
 *  not a slot (no distinct preset today); such models fall back to always-on. */
export const MODEL_FAMILIES: readonly ModelFamily[] = [
  "gemini",
  "claude",
  "openai",
  "deepseek",
  "glm",
  "grok",
  "kimi",
  "other",
];

/** Which family a model id belongs to — the engine's classifier itself, the
 *  one the server uses to pick the prompt each turn. A copy here drifted on
 *  prefix-less BYOK / custom-endpoint ids ("custom/MiniMax-M2" → server
 *  minimax, app other), so the chat showed an "other"-bound prompt as applied
 *  while the server never sent it. */
export function familyOf(modelId: string | null | undefined): ModelFamily {
  return engineFamilyOf(modelId);
}

/** Brand label for a family. `other` has no fixed brand — the caller supplies a
 *  localized string for it (i18n `unrestrict:bindings.families.other`). */
const BRAND_LABELS: Record<Exclude<ModelFamily, "other">, string> = {
  gemini: "Gemini",
  claude: "Claude",
  openai: "GPT",
  deepseek: "DeepSeek",
  glm: "GLM",
  grok: "Grok",
  kimi: "Kimi",
  minimax: "MiniMax",
};

/** Display label for a family key. Pass `otherLabel` (localized 其他) for the
 *  `other` slot; unknown keys fall back to the key itself. */
export function familyLabel(family: string, otherLabel: string): string {
  if (family === "other") return otherLabel;
  return BRAND_LABELS[family as Exclude<ModelFamily, "other">] ?? family;
}
