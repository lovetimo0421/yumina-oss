// ─── Unified Model Registry ─────────────────────────────────────────
// Single source of truth for all Yumina models. Both server (agent.ts
// allowlist) and client (play/studio pickers) import from here.
// DB `model_prices` table handles billing — this file handles identity,
// display metadata, and scope.

export type CostTier = "budget" | "standard" | "premium" | "ultra";
export type ModelScope = "play" | "studio" | "both";

export interface TimeBasedAvgCostMushies {
  peak: number;
  offPeak: number;
}

export interface YuminaModel {
  id: string;
  name: string;
  scope: ModelScope;
  /** Play UI: tier classification for grouping and color coding. */
  tier?: CostTier;
  /** Play UI: minimum plan required to select this model. */
  minPlan?: string;
  /** Play UI: average mushie cost per response. */
  avgCostMushies?: number;
  /** Play UI: time-based average cost when the upstream rate varies by period. */
  avgCostMushiesByPeriod?: TimeBasedAvgCostMushies;
  /** Play UI: badge label (e.g. "Free", "Default", "Popular"). */
  badge?: string;
  /** Play UI: i18n description key under `profile:aiProvider.models.*`. */
  descKey?: string;
  /** Studio UI: OpenRouter input price per 1M tokens (USD). */
  inputPrice?: number;
  /** Studio UI: OpenRouter output price per 1M tokens (USD). */
  outputPrice?: number;
}

// DeepSeek V4 estimates retain the catalog's normal-reply profile
// (~21.3K input + ~0.7K output tokens), assume uncached input, and include each
// model's platform multiplier. The scalar average is weighted across 7 peak
// and 17 off-peak hours so existing sorting consumers keep a useful fallback.
export const YUMINA_MODELS: YuminaModel[] = [
  // ── Play-only models ────────────────────────────────────────────────
  { id: "openrouter/free",                     name: "Yumina Free",           scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 0,     badge: "Free",         descKey: "aiProvider.models.yuminaFree" },
  { id: "google/gemini-2.5-flash-lite",        name: "Gemini 2.5 Flash Lite", scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 1.2,                          descKey: "aiProvider.models.geminiFlashLite" },
  { id: "deepseek/deepseek-v4-flash",          name: "DeepSeek V4 Flash",     scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 6.6,  avgCostMushiesByPeriod: { peak: 10.3, offPeak: 5.1 }, descKey: "aiProvider.models.deepseekV4Flash" },
  { id: "deepseek/deepseek-v3.2",              name: "DeepSeek V3.2",         scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 3.4,                          descKey: "aiProvider.models.deepseek" },
  { id: "qwen/qwen3-vl-235b-a22b-instruct",   name: "Qwen3 VL 235B",        scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 4.2,                          descKey: "aiProvider.models.qwen3Vl" },
  { id: "anthropic/claude-3-haiku",            name: "Claude 3 Haiku",        scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 5.0,                          descKey: "aiProvider.models.claude3Haiku" },
  { id: "mistralai/mistral-nemo",              name: "Mistral Nemo",          scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 0.6,   badge: "Concise",      descKey: "aiProvider.models.mistralNemo" },
  { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small 3.2", scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 2.0,                          descKey: "aiProvider.models.mistralSmall32" },
  { id: "nousresearch/hermes-4-70b",           name: "Hermes 4 70B",          scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 3.6,   badge: "Concise",      descKey: "aiProvider.models.hermes4" },
  { id: "google/gemini-3.1-flash-lite",         name: "Gemini 3.1 Flash Lite", scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 5.9,                          descKey: "aiProvider.models.gemini31FlashLite" },
  { id: "google/gemini-3.5-flash",             name: "Gemini 3.5 Flash",      scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 35.0,                         descKey: "aiProvider.models.gemini35Flash" },
  { id: "google/gemini-2.5-pro",               name: "Gemini 2.5 Pro",        scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 48.0,                         descKey: "aiProvider.models.gemini25Pro" },

  // ── 2026-09 intake (play-only) ──────────────────────────────────────────
  // Costs measured against the real pipeline on 9 published cards in 5 languages;
  // see the audit for refusal / language-drift / variable-compliance evidence.
  { id: "z-ai/glm-5.3-flash",                  name: "GLM 5.3 Flash",         scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 2.9,   badge: "Value",        descKey: "aiProvider.models.glm53Flash" },
  { id: "tencent/hy3",                         name: "Hunyuan 3",             scope: "play", tier: "budget",   minPlan: "free",  avgCostMushies: 5.0,                          descKey: "aiProvider.models.tencentHy3" },
  { id: "meituan/longcat-2.0",                 name: "LongCat 2.0",           scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 8.7,                          descKey: "aiProvider.models.longcat2" },
  { id: "google/gemini-3.5-flash-lite",        name: "Gemini 3.5 Flash Lite", scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 8.8,   badge: "Fastest",      descKey: "aiProvider.models.gemini35FlashLite" },
  { id: "stepfun/step-3.7-flash",              name: "Step 3.7 Flash",        scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 9.6,                          descKey: "aiProvider.models.step37Flash" },
  { id: "mistralai/mistral-large-2512",        name: "Mistral Large 3",       scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 15.1,                         descKey: "aiProvider.models.mistralLarge3" },
  { id: "thinkingmachines/inkling-small",      name: "Inkling Small",         scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 15.4,                         descKey: "aiProvider.models.inklingSmall" },
  { id: "google/gemini-3.7-flash",             name: "Gemini 3.7 Flash",      scope: "play", tier: "standard", minPlan: "free",  avgCostMushies: 21.5,                         descKey: "aiProvider.models.gemini37Flash" },
  { id: "openai/gpt-5.4-mini",                 name: "GPT-5.4 Mini",          scope: "play", tier: "premium",  minPlan: "go",    avgCostMushies: 23.6,                         descKey: "aiProvider.models.gpt54Mini" },
  { id: "google/gemini-3.8-flash",             name: "Gemini 3.8 Flash",      scope: "play", tier: "premium",  minPlan: "go",    avgCostMushies: 25.0,                         descKey: "aiProvider.models.gemini38Flash" },

  // ── Both play + studio ──────────────────────────────────────────────
  { id: "moonshotai/kimi-k2-0905",             name: "Kimi K2",               scope: "both", tier: "standard", minPlan: "free",  avgCostMushies: 10.5,                         descKey: "aiProvider.models.kimiK2",          inputPrice: 0.60,  outputPrice: 2.40 },
  { id: "z-ai/glm-4.6",                       name: "GLM 4.6",               scope: "both", tier: "standard", minPlan: "free",  avgCostMushies: 12.5,                         descKey: "aiProvider.models.glm46",           inputPrice: 0.43,  outputPrice: 1.75 },
  { id: "deepseek/deepseek-v4-pro",            name: "DeepSeek V4 Pro",       scope: "both", tier: "standard", minPlan: "free",  avgCostMushies: 21.9, avgCostMushiesByPeriod: { peak: 33.9, offPeak: 16.9 }, descKey: "aiProvider.models.deepseekV4Pro",   inputPrice: 0.90,  outputPrice: 0.90 },
  { id: "google/gemini-3-flash-preview",       name: "Gemini 3 Flash",        scope: "both", tier: "standard", minPlan: "free",  avgCostMushies: 13.7, badge: "Popular",       descKey: "aiProvider.models.gemini3Flash",    inputPrice: 0.15,  outputPrice: 0.60 },
  { id: "anthropic/claude-haiku-4.5",          name: "Claude Haiku 4.5",      scope: "both", tier: "premium",  minPlan: "go",    avgCostMushies: 44.2,                         descKey: "aiProvider.models.claudeHaiku",     inputPrice: 0.80,  outputPrice: 4 },
  { id: "x-ai/grok-4.3",                      name: "Grok 4.3",              scope: "both", tier: "premium",  minPlan: "go",    avgCostMushies: 46.0,                         descKey: "aiProvider.models.grok43",          inputPrice: 1.25,  outputPrice: 2.50 },
  { id: "x-ai/grok-4.20",                     name: "Grok 4.20",             scope: "both", tier: "premium",  minPlan: "go",    avgCostMushies: 53.1,                         descKey: "aiProvider.models.grok420",         inputPrice: 2,     outputPrice: 10 },
  { id: "google/gemini-3.1-pro-preview",       name: "Gemini 3.1 Pro",        scope: "both", tier: "premium",  minPlan: "go",    avgCostMushies: 63.7, badge: "Best Overall",  descKey: "aiProvider.models.geminiPro",       inputPrice: 1.25,  outputPrice: 10 },
  { id: "anthropic/claude-sonnet-4.6",         name: "Claude Sonnet 4.6",     scope: "both", tier: "ultra",    minPlan: "plus",  avgCostMushies: 155.7,                        descKey: "aiProvider.models.claudeSonnet",    inputPrice: 3,     outputPrice: 15 },
  { id: "anthropic/claude-sonnet-5",           name: "Claude Sonnet 5",       scope: "both", tier: "ultra",    minPlan: "plus",  avgCostMushies: 155.7,                        descKey: "aiProvider.models.claudeSonnet5",   inputPrice: 3,     outputPrice: 15 },
  { id: "anthropic/claude-opus-4.7",           name: "Claude Opus 4.7",       scope: "both", tier: "ultra",    minPlan: "plus",  avgCostMushies: 245.5,                        descKey: "aiProvider.models.claudeOpus",      inputPrice: 15,    outputPrice: 75 },
  { id: "anthropic/claude-opus-5",             name: "Claude Opus 5",         scope: "both", tier: "ultra",    minPlan: "plus",  avgCostMushies: 245.5,                        descKey: "aiProvider.models.claudeOpus5",     inputPrice: 5,     outputPrice: 25 },

  // ── 2026-09 intake (play + studio) ──────────────────────────────────
  { id: "openai/gpt-5.6-luna",                 name: "GPT-5.6 Luna",          scope: "both", tier: "budget",   minPlan: "free",  avgCostMushies: 6.2,                          descKey: "aiProvider.models.gpt56Luna",       inputPrice: 0.20,  outputPrice: 1.20 },
  { id: "minimax/minimax-m3",                  name: "MiniMax M3",            scope: "both", tier: "standard", minPlan: "free",  avgCostMushies: 9.6,                          descKey: "aiProvider.models.minimaxM3",       inputPrice: 0.30,  outputPrice: 1.20 },
  { id: "moonshotai/kimi-k2.6",                name: "Kimi K2.6",             scope: "both", tier: "premium",  minPlan: "go",    avgCostMushies: 46.1,                         descKey: "aiProvider.models.kimiK26",         inputPrice: 0.95,  outputPrice: 4 },
  { id: "openai/gpt-5.6-sol",                  name: "GPT-5.6 Sol",           scope: "both", tier: "ultra",    minPlan: "plus",  avgCostMushies: 68.6,                         descKey: "aiProvider.models.gpt56Sol",        inputPrice: 2,     outputPrice: 10 },

  // ── Studio-only models ──────────────────────────────────────────────
  { id: "openai/gpt-5.1-codex-mini",           name: "GPT-5.1 Codex Mini",   scope: "studio",                                                                                   inputPrice: 0.25,  outputPrice: 2 },
  { id: "openai/gpt-6-astra",                  name: "GPT-6 Astra",          scope: "studio",                                                                                   inputPrice: 10,    outputPrice: 50 },
  { id: "openai/gpt-5.3-codex",                name: "GPT-5.3 Codex",        scope: "studio",                                                                                   inputPrice: 1.75,  outputPrice: 14 },
  { id: "qwen/qwen3.7-max",                    name: "Qwen 3.7 Max",         scope: "studio",                                                                                   inputPrice: 2.50,  outputPrice: 7.50 },
];

// ── Narrowed types for scope-specific consumers ──────────────────────

export interface PlayModel extends YuminaModel {
  tier: CostTier;
  minPlan: string;
  avgCostMushies: number;
  descKey: string;
}

export interface StudioModel extends YuminaModel {
  inputPrice: number;
  outputPrice: number;
}

// ── Derived lists ─────────────────────────────────────────────────────
// Sorted cheapest-first at the source: pickers that render these lists
// directly (sandbox model picker, store fallback, admin dropdowns) inherit
// the order, so registry entries can be appended in any order above.

export const PLAY_MODELS = (YUMINA_MODELS.filter((m) => m.scope === "play" || m.scope === "both") as PlayModel[])
  .sort((a, b) => (a.avgCostMushies ?? 0) - (b.avgCostMushies ?? 0));
export const STUDIO_MODELS = (YUMINA_MODELS.filter((m) => m.scope === "studio" || m.scope === "both") as StudioModel[])
  .sort((a, b) => (a.inputPrice + a.outputPrice) - (b.inputPrice + b.outputPrice));

export const PLAY_MODEL_IDS = new Set(PLAY_MODELS.map((m) => m.id));
export const STUDIO_MODEL_IDS = new Set(STUDIO_MODELS.map((m) => m.id));

// ── Defaults ──────────────────────────────────────────────────────────

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

/** How many models a user can pin in the model pickers. Shared so the sandbox
 *  picker can name the limit in its message instead of hardcoding a number. */
export const MAX_PINNED_MODELS = 8;

/** The pinned row is the menu almost every account actually sees — 26,027 of
 *  26,034 stored sets were still byte-identical to the shipped default, so this
 *  list, not the full picker, is the product's model lineup in practice. Ordered
 *  as a ladder from "runs longest on the free grant" to "the paid aspiration".
 *  `deepseek/deepseek-v4-flash` was dropped: 18.9% of its production turns on
 *  variable-bearing cards emit a directive, so panels look broken on it. */
export const DEFAULT_PINNED_MODELS = [
  "z-ai/glm-5.3-flash",
  "tencent/hy3",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3-flash-preview",
  "minimax/minimax-m3",
  "anthropic/claude-sonnet-4.6",
];

/** Where a new account lands when the Sonnet 4.6 taster runs out: the plan-gate
 *  fallback in stores/chat.ts flips mixMode on and resends the message against
 *  this pool, so for most users this IS the post-onboarding experience (85% of
 *  mix-mode accounts got here that way, not by choosing it).
 *
 *  Every entry must be (a) free-tier, or the fallback gets gated a second time,
 *  and (b) fast to first visible token. That second rule is why the cheapest,
 *  highest-compliance models are NOT here: GLM 5.3 Flash, Hy3 and Inkling Small
 *  reason before they write, and at a 900-token budget Hy3 and Inkling Small
 *  emit no prose at all. 51 published cards cap maxTokens below 1500, so a pool
 *  entry that starves there would hand new users a blank reply. Those models sit
 *  in the pinned row instead, where the user opts in deliberately. */
export const DEFAULT_POOL: Array<{ modelId: string; weight: number }> = [
  { modelId: "google/gemini-3-flash-preview", weight: 35 },
  { modelId: "google/gemini-3.5-flash-lite", weight: 25 },
  { modelId: "google/gemini-3.1-flash-lite", weight: 20 },
  { modelId: "minimax/minimax-m3", weight: 10 },
  { modelId: "deepseek/deepseek-v3.2", weight: 10 },
];

export const DEFAULT_MIX_MODE = false;

export const STUDIO_RECOMMENDED_MODEL = "anthropic/claude-sonnet-5";

// ── Plan hierarchy ────────────────────────────────────────────────────

export const PLAN_HIERARCHY = ["free", "go", "plus", "pro", "ultra", "internal"] as const;

// ── Utilities ─────────────────────────────────────────────────────────

/** Format a model ID like "google/gemini-3.1-pro" into "Gemini 3.1 Pro". */
export function formatModelId(id: string): string {
  const slug = id.includes("/") ? id.split("/").pop()! : id;
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format avg mushie cost for display. */
export function formatAvgCost(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
}
