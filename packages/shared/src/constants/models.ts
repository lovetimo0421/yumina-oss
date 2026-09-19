// ─── Unified Model Registry ─────────────────────────────────────────
// Single source of truth for all Yumina models. Both server (agent.ts
// allowlist) and client (play/studio pickers) import from here.
// DB `model_prices` table handles billing — this file handles identity,
// display metadata, and scope.

export type CostTier = "budget" | "standard" | "premium" | "ultra";
export type ModelScope = "play" | "studio" | "both";

/** Previously selectable official models with no working provider. BYOK is independent. */
export const RETIRED_PLAY_MODEL_IDS = new Set(["nousresearch/hermes-4-70b", "mistralai/mistral-large-2512"]);

export interface TimeBasedAvgCostMushies {
  peak: number;
  offPeak: number;
}

export interface YuminaModel {
  /** Verified catalog limit used before the live provider catalog warms. */
  contextWindow?: number;
  /** Date added to the Play catalog, for newest-first sorting. */
  addedAt?: string;
  /** Editorial default order from the reviewed roleplay shortlist. */
  recommendationRank?: number;
  id: string;
  name: string;
  scope: ModelScope;
  /** Play UI: tier classification for grouping and color coding. */
  tier?: CostTier;
  /** Play UI: minimum plan required to select this model. */
  minPlan?: string;
  /** Play UI: reference mushie cost for a fixed comparison scenario. */
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

// Reference costs: 21,300 uncached input + 700 output tokens at 1.20×.
// Lunaris uses 6,000 input tokens to fit its 8K window. These are comparison
// estimates, not measured averages; actual billing uses provider-reported cost.
export const YUMINA_MODELS: YuminaModel[] = [
  {"id":"openrouter/free","name":"Yumina Free","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":0,"descKey":"aiProvider.models.yuminaFree","inputPrice":0,"outputPrice":0,"contextWindow":200000,"recommendationRank":50},
  {"id":"google/gemini-2.5-flash-lite","name":"Gemini 2.5 Flash Lite","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":2.9,"descKey":"aiProvider.models.geminiFlashLite","inputPrice":0.1,"outputPrice":0.4,"contextWindow":1048576,"recommendationRank":51},
  {"id":"deepseek/deepseek-v4-flash","name":"DeepSeek V4 Flash","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":1.4,"descKey":"aiProvider.models.deepseekV4Flash","inputPrice":0.04844,"outputPrice":0.09688,"contextWindow":1048576,"recommendationRank":52},
  {"id":"deepseek/deepseek-v3.2","name":"DeepSeek V3.2","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":7.3,"descKey":"aiProvider.models.deepseek","inputPrice":0.269,"outputPrice":0.4,"contextWindow":163840,"recommendationRank":53},
  {"id":"qwen/qwen3-vl-235b-a22b-instruct","name":"Qwen3 VL 235B","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":7,"descKey":"aiProvider.models.qwen3Vl","inputPrice":0.21,"outputPrice":1.9,"contextWindow":262144,"recommendationRank":54},
  {"id":"anthropic/claude-3-haiku","name":"Claude 3 Haiku","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":7.5,"descKey":"aiProvider.models.claude3Haiku","inputPrice":0.25,"outputPrice":1.25,"contextWindow":200000,"recommendationRank":55},
  {"id":"mistralai/mistral-nemo","name":"Mistral Nemo","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":0.6,"descKey":"aiProvider.models.mistralNemo","inputPrice":0.019,"outputPrice":0.03,"contextWindow":131072,"recommendationRank":56},
  {"id":"mistralai/mistral-small-3.2-24b-instruct","name":"Mistral Small 3.2","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":2.7,"descKey":"aiProvider.models.mistralSmall32","inputPrice":0.09375,"outputPrice":0.25,"contextWindow":256000,"recommendationRank":57},
  {"id":"google/gemini-3.1-flash-lite","name":"Gemini 3.1 Flash Lite","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":7.7,"descKey":"aiProvider.models.gemini31FlashLite","inputPrice":0.25,"outputPrice":1.5,"contextWindow":1048576,"recommendationRank":59},
  {"id":"google/gemini-3.5-flash","name":"Gemini 3.5 Flash","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":45.9,"descKey":"aiProvider.models.gemini35Flash","inputPrice":1.5,"outputPrice":9,"contextWindow":1048576,"recommendationRank":60},
  {"id":"google/gemini-2.5-pro","name":"Gemini 2.5 Pro","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":40.4,"descKey":"aiProvider.models.gemini25Pro","inputPrice":1.25,"outputPrice":10,"contextWindow":1048576,"recommendationRank":61},
  {"id":"z-ai/glm-5.3-flash","name":"GLM 5.3 Flash","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":2.6,"descKey":"aiProvider.models.glm53Flash","inputPrice":0.09,"outputPrice":0.3,"contextWindow":1310720,"recommendationRank":62},
  {"id":"tencent/hy3","name":"Hunyuan 3","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":3.9,"avgCostMushiesByPeriod":{"peak":3.9,"offPeak":2.4},"descKey":"aiProvider.models.tencentHy3","inputPrice":0.132,"outputPrice":0.528,"contextWindow":262144,"recommendationRank":63},
  {"id":"meituan/longcat-2.0","name":"LongCat 2.0","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":8.7,"descKey":"aiProvider.models.longcat2","inputPrice":0.3,"outputPrice":1.2,"contextWindow":1048756,"recommendationRank":64},
  {"id":"google/gemini-3.5-flash-lite","name":"Gemini 3.5 Flash Lite","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":9.8,"descKey":"aiProvider.models.gemini35FlashLite","inputPrice":0.3,"outputPrice":2.5,"contextWindow":1048576,"recommendationRank":65},
  {"id":"stepfun/step-3.7-flash","name":"Step 3.7 Flash","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":6.1,"descKey":"aiProvider.models.step37Flash","inputPrice":0.2,"outputPrice":1.15,"contextWindow":262144,"recommendationRank":66},
  {"id":"thinkingmachines/inkling-small","name":"Inkling Small","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":12.6,"descKey":"aiProvider.models.inklingSmall","inputPrice":0.45,"outputPrice":1.2,"contextWindow":1048576,"recommendationRank":68},
  {"id":"google/gemini-3.7-flash","name":"Gemini 3.7 Flash","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":22.4,"descKey":"aiProvider.models.gemini37Flash","inputPrice":0.75,"outputPrice":3.75,"contextWindow":1048576,"recommendationRank":69},
  {"id":"openai/gpt-5.4-mini","name":"GPT-5.4 Mini","scope":"play","tier":"premium","minPlan":"go","avgCostMushies":23,"descKey":"aiProvider.models.gpt54Mini","inputPrice":0.75,"outputPrice":4.5,"contextWindow":400000,"recommendationRank":70},
  {"id":"google/gemini-3.8-flash","name":"Gemini 3.8 Flash","scope":"play","tier":"premium","minPlan":"go","avgCostMushies":22.4,"descKey":"aiProvider.models.gemini38Flash","inputPrice":0.75,"outputPrice":3.75,"contextWindow":1048576,"recommendationRank":71},
  {"id":"moonshotai/kimi-k2-0905","name":"Kimi K2","scope":"both","tier":"standard","minPlan":"free","avgCostMushies":17.5,"descKey":"aiProvider.models.kimiK2","inputPrice":0.6,"outputPrice":2.5,"contextWindow":262144,"recommendationRank":72},
  {"id":"z-ai/glm-4.6","name":"GLM 4.6","scope":"both","tier":"standard","minPlan":"free","avgCostMushies":12.5,"descKey":"aiProvider.models.glm46","inputPrice":0.43,"outputPrice":1.75,"contextWindow":204800,"recommendationRank":73},
  {"id":"deepseek/deepseek-v4-pro","name":"DeepSeek V4 Pro","scope":"both","tier":"standard","minPlan":"free","avgCostMushies":17.4,"descKey":"aiProvider.models.deepseekV4Pro","inputPrice":0.635274,"outputPrice":1.270548,"contextWindow":1048576,"recommendationRank":74},
  {"id":"google/gemini-3-flash-preview","name":"Gemini 3 Flash","scope":"both","tier":"standard","minPlan":"free","avgCostMushies":15.3,"descKey":"aiProvider.models.gemini3Flash","inputPrice":0.5,"outputPrice":3,"contextWindow":1048576,"recommendationRank":75},
  {"id":"anthropic/claude-haiku-4.5","name":"Claude Haiku 4.5","scope":"both","tier":"premium","minPlan":"go","avgCostMushies":29.8,"descKey":"aiProvider.models.claudeHaiku","inputPrice":1,"outputPrice":5,"contextWindow":200000,"recommendationRank":76},
  {"id":"x-ai/grok-4.3","name":"Grok 4.3","scope":"both","tier":"premium","minPlan":"go","avgCostMushies":34.1,"descKey":"aiProvider.models.grok43","inputPrice":1.25,"outputPrice":2.5,"contextWindow":1000000,"recommendationRank":77},
  {"id":"x-ai/grok-4.20","name":"Grok 4.20","scope":"both","tier":"premium","minPlan":"go","avgCostMushies":34.1,"descKey":"aiProvider.models.grok420","inputPrice":1.25,"outputPrice":2.5,"contextWindow":2000000,"recommendationRank":78},
  {"id":"google/gemini-3.1-pro-preview","name":"Gemini 3.1 Pro","scope":"both","tier":"premium","minPlan":"go","avgCostMushies":61.2,"descKey":"aiProvider.models.geminiPro","inputPrice":2,"outputPrice":12,"contextWindow":1048576,"recommendationRank":79},
  {"id":"anthropic/claude-sonnet-4.6","name":"Claude Sonnet 4.6","scope":"both","tier":"ultra","minPlan":"plus","avgCostMushies":89.3,"descKey":"aiProvider.models.claudeSonnet","inputPrice":3,"outputPrice":15,"contextWindow":1000000,"recommendationRank":80},
  {"id":"anthropic/claude-sonnet-5","name":"Claude Sonnet 5","scope":"both","tier":"ultra","minPlan":"plus","avgCostMushies":59.6,"descKey":"aiProvider.models.claudeSonnet5","inputPrice":2,"outputPrice":10,"contextWindow":1000000,"recommendationRank":81},
  {"id":"anthropic/claude-opus-4.7","name":"Claude Opus 4.7","scope":"both","tier":"ultra","minPlan":"plus","avgCostMushies":148.8,"descKey":"aiProvider.models.claudeOpus","inputPrice":5,"outputPrice":25,"contextWindow":1000000,"recommendationRank":82},
  {"id":"anthropic/claude-opus-5","name":"Claude Opus 5","scope":"both","tier":"ultra","minPlan":"plus","avgCostMushies":148.8,"descKey":"aiProvider.models.claudeOpus5","inputPrice":5,"outputPrice":25,"contextWindow":1000000,"recommendationRank":83},
  {"id":"openai/gpt-5.6-luna","name":"GPT-5.6 Luna","scope":"both","tier":"budget","minPlan":"free","avgCostMushies":6.2,"descKey":"aiProvider.models.gpt56Luna","inputPrice":0.2,"outputPrice":1.2,"contextWindow":1050000,"recommendationRank":84},
  {"id":"minimax/minimax-m3","name":"MiniMax M3","scope":"both","tier":"standard","minPlan":"free","avgCostMushies":8.7,"descKey":"aiProvider.models.minimaxM3","inputPrice":0.3,"outputPrice":1.2,"contextWindow":1048576,"recommendationRank":85},
  {"id":"moonshotai/kimi-k2.6","name":"Kimi K2.6","scope":"both","tier":"premium","minPlan":"go","avgCostMushies":27.7,"descKey":"aiProvider.models.kimiK26","inputPrice":0.95,"outputPrice":4,"contextWindow":262144,"recommendationRank":86},
  {"id":"openai/gpt-5.6-sol","name":"GPT-5.6 Sol","scope":"both","tier":"ultra","minPlan":"plus","avgCostMushies":59.6,"descKey":"aiProvider.models.gpt56Sol","inputPrice":2,"outputPrice":10,"contextWindow":1050000,"recommendationRank":87},
  {"id":"z-ai/glm-5.2","name":"GLM 5.2","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":15.7,"descKey":"aiProvider.models.z_ai_glm_5_2","inputPrice":0.5544,"outputPrice":1.7424,"contextWindow":1048576,"addedAt":"2026-09-19","recommendationRank":1},
  {"id":"xiaomi/mimo-v2.5-pro","name":"MiMo V2.5 Pro","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":11.9,"descKey":"aiProvider.models.xiaomi_mimo_v2_5_pro","inputPrice":0.435,"outputPrice":0.87,"contextWindow":1050000,"addedAt":"2026-09-19","recommendationRank":2},
  {"id":"xiaomi/mimo-v2.5","name":"MiMo V2.5","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":3.9,"descKey":"aiProvider.models.xiaomi_mimo_v2_5","inputPrice":0.14,"outputPrice":0.28,"contextWindow":1050000,"addedAt":"2026-09-19","recommendationRank":4},
  {"id":"nvidia/nemotron-3-ultra-550b-a55b","name":"Nemotron 3 Ultra","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":17.4,"descKey":"aiProvider.models.nvidia_nemotron_3_ultra_550b_a55b","inputPrice":0.6,"outputPrice":2.4,"contextWindow":262144,"addedAt":"2026-09-19","recommendationRank":5},
  {"id":"google/gemma-4-31b-it","name":"Gemma 4 31B","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":2.6,"descKey":"aiProvider.models.google_gemma_4_31b_it","inputPrice":0.09,"outputPrice":0.34,"contextWindow":262144,"addedAt":"2026-09-19","recommendationRank":7},
  {"id":"deepseek/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":4.4,"avgCostMushiesByPeriod":{"peak":8.7,"offPeak":4.4},"descKey":"aiProvider.models.deepseek_deepseek_v4_1_flash","inputPrice":0.15,"outputPrice":0.6,"contextWindow":1048576,"addedAt":"2026-09-19","recommendationRank":8},
  {"id":"aion-labs/aion-2.0","name":"Aion 2","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":21.8,"descKey":"aiProvider.models.aion_labs_aion_2_0","inputPrice":0.8,"outputPrice":1.6,"contextWindow":131072,"addedAt":"2026-09-19","recommendationRank":9},
  {"id":"nousresearch/hermes-3-llama-3.1-405b","name":"Hermes 3 405B","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":26.4,"descKey":"aiProvider.models.nousresearch_hermes_3_llama_3_1_405b","inputPrice":1,"outputPrice":1,"contextWindow":131072,"addedAt":"2026-09-19","recommendationRank":11},
  {"id":"aion-labs/aion-3.0-mini","name":"Aion 3 Mini","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":19.1,"descKey":"aiProvider.models.aion_labs_aion_3_0_mini","inputPrice":0.7,"outputPrice":1.4,"contextWindow":131072,"addedAt":"2026-09-19","recommendationRank":12},
  {"id":"sao10k/l3.3-euryale-70b","name":"Euryale L3.3 70B","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":17.3,"descKey":"aiProvider.models.sao10k_l3_3_euryale_70b","inputPrice":0.65,"outputPrice":0.75,"contextWindow":131072,"addedAt":"2026-09-19","recommendationRank":13},
  {"id":"sao10k/l3-lunaris-8b","name":"Lunaris 8B","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":0.4,"descKey":"aiProvider.models.sao10k_l3_lunaris_8b","inputPrice":0.04,"outputPrice":0.05,"contextWindow":8192,"addedAt":"2026-09-19","recommendationRank":14},
  {"id":"thedrummer/unslopnemo-12b","name":"UnslopNemo 12B","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":10.6,"descKey":"aiProvider.models.thedrummer_unslopnemo_12b","inputPrice":0.4,"outputPrice":0.4,"contextWindow":1024000,"addedAt":"2026-09-19","recommendationRank":15},
  {"id":"z-ai/glm-4.7","name":"GLM 4.7","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":11.7,"descKey":"aiProvider.models.z_ai_glm_4_7","inputPrice":0.4,"outputPrice":1.75,"contextWindow":204800,"addedAt":"2026-09-19","recommendationRank":16},
  {"id":"moonshotai/kimi-k2.5","name":"Kimi K2.5","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":13.4,"descKey":"aiProvider.models.moonshotai_kimi_k2_5","inputPrice":0.45,"outputPrice":2.25,"contextWindow":262144,"addedAt":"2026-09-19","recommendationRank":17},
  {"id":"deepseek/deepseek-chat-v3-0324","name":"DeepSeek V3 0324","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":7.3,"descKey":"aiProvider.models.deepseek_deepseek_chat_v3_0324","inputPrice":0.25,"outputPrice":1,"contextWindow":163840,"addedAt":"2026-09-19","recommendationRank":18},
  {"id":"qwen/qwen3-32b","name":"Qwen3 32B","scope":"play","tier":"budget","minPlan":"free","avgCostMushies":2.3,"descKey":"aiProvider.models.qwen_qwen3_32b","inputPrice":0.08,"outputPrice":0.28,"contextWindow":131072,"addedAt":"2026-09-19","recommendationRank":19},
  {"id":"deepseek/deepseek-v4-pro-0813","name":"DeepSeek V4 Pro 0813","scope":"play","tier":"standard","minPlan":"free","avgCostMushies":16.3,"descKey":"aiProvider.models.deepseek_deepseek_v4_pro_0813","inputPrice":0.57816,"outputPrice":1.73448,"contextWindow":1048576,"addedAt":"2026-09-19","recommendationRank":24},
  {"id":"aion-labs/aion-3.0","name":"Aion 3","scope":"play","tier":"premium","minPlan":"go","avgCostMushies":81.8,"descKey":"aiProvider.models.aion_labs_aion_3_0","inputPrice":3,"outputPrice":6,"contextWindow":131072,"addedAt":"2026-09-19","recommendationRank":-8},
  {"id":"x-ai/grok-4.6","name":"Grok 4.6","scope":"play","tier":"premium","minPlan":"go","avgCostMushies":56.2,"descKey":"aiProvider.models.x_ai_grok_4_6","inputPrice":2,"outputPrice":6,"contextWindow":500000,"addedAt":"2026-09-19","recommendationRank":-7},
  {"id":"openai/gpt-5.6-terra","name":"GPT-5.6 Terra","scope":"play","tier":"premium","minPlan":"go","avgCostMushies":61.2,"descKey":"aiProvider.models.openai_gpt_5_6_terra","inputPrice":2,"outputPrice":12,"contextWindow":1050000,"addedAt":"2026-09-19","recommendationRank":-6},
  {"id":"qwen/qwen3.8-max-0902","name":"Qwen3.8 Max (0902)","scope":"play","tier":"premium","minPlan":"go","avgCostMushies":56.2,"descKey":"aiProvider.models.qwen_qwen3_8_max_0902","inputPrice":2,"outputPrice":6,"contextWindow":1000000,"addedAt":"2026-09-19","recommendationRank":-4},
  {"id":"moonshotai/kimi-k3","name":"Kimi K3","scope":"play","tier":"ultra","minPlan":"plus","avgCostMushies":62.7,"descKey":"aiProvider.models.moonshotai_kimi_k3","inputPrice":2.0695,"outputPrice":11.5892,"contextWindow":1048576,"addedAt":"2026-09-19","recommendationRank":112},
  {"id":"anthropic/claude-fable-5.1","name":"Claude Fable 5.1","scope":"play","tier":"ultra","minPlan":"plus","avgCostMushies":297.6,"descKey":"aiProvider.models.anthropic_claude_fable_5_1","inputPrice":10,"outputPrice":50,"contextWindow":1000000,"addedAt":"2026-09-19","recommendationRank":113},
  {"id":"anthropic/claude-opus-4.8","name":"Claude Opus 4.8","scope":"play","tier":"ultra","minPlan":"plus","avgCostMushies":148.8,"descKey":"aiProvider.models.anthropic_claude_opus_4_8","inputPrice":5,"outputPrice":25,"contextWindow":1000000,"addedAt":"2026-09-19","recommendationRank":114},
  {"id":"openai/gpt-5.5","name":"GPT-5.5","scope":"play","tier":"ultra","minPlan":"plus","avgCostMushies":153,"descKey":"aiProvider.models.openai_gpt_5_5","inputPrice":5,"outputPrice":30,"contextWindow":1050000,"addedAt":"2026-09-19","recommendationRank":115},
  {"id":"openai/gpt-6-astra","name":"GPT-6 Astra","scope":"both","tier":"ultra","minPlan":"plus","avgCostMushies":297.6,"descKey":"aiProvider.models.openai_gpt_6_astra","inputPrice":10,"outputPrice":50,"contextWindow":1050000,"addedAt":"2026-09-19","recommendationRank":116},
  {"id":"thinkingmachines/inkling","name":"Inkling","scope":"play","tier":"premium","minPlan":"go","avgCostMushies":29,"descKey":"aiProvider.models.thinkingmachines_inkling","inputPrice":1,"outputPrice":4.05,"contextWindow":1048576,"addedAt":"2026-09-19","recommendationRank":-10},
  {"id":"openai/gpt-4.1","name":"GPT-4.1","scope":"play","tier":"premium","minPlan":"go","avgCostMushies":57.9,"descKey":"aiProvider.models.openai_gpt_4_1","inputPrice":2,"outputPrice":8,"contextWindow":1047576,"addedAt":"2026-09-19","recommendationRank":-11},
  {"id":"anthropic/claude-opus-4.5","name":"Claude Opus 4.5","scope":"play","tier":"ultra","minPlan":"plus","avgCostMushies":148.8,"descKey":"aiProvider.models.anthropic_claude_opus_4_5","inputPrice":5,"outputPrice":25,"contextWindow":200000,"addedAt":"2026-09-19","recommendationRank":166},
  {"id":"openai/gpt-5.1-codex-mini","name":"GPT-5.1 Codex Mini","scope":"studio","inputPrice":0.25,"outputPrice":2},
  {"id":"openai/gpt-5.3-codex","name":"GPT-5.3 Codex","scope":"studio","inputPrice":1.75,"outputPrice":14},
  {"id":"qwen/qwen3.7-max","name":"Qwen 3.7 Max","scope":"studio","inputPrice":2.5,"outputPrice":7.5},
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
