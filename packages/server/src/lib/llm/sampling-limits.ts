/**
 * Per-model-family sampling-parameter limits.
 *
 * The temperature ceiling is a property of the *upstream model*, not the route:
 * Anthropic/Claude caps temperature at 1.0, while OpenAI and Google accept up to
 * 2.0. The shared generation-config slider lets a user pick up to 1.5, so any
 * value above 1.0 routed to a Claude model — whether through the native
 * Anthropic key or OpenRouter — is rejected by the upstream with
 * `temperature: range: 0..1`.
 *
 * Clamping lives here (and is applied at each provider boundary) rather than in
 * one route handler so every caller is protected: chat, Studio, and the internal
 * LLM calls (summarization, translation, memory extraction) that build their own
 * GenerateParams.
 */

/** Anthropic's Messages API rejects temperature outside [0, 1]. */
export const ANTHROPIC_TEMPERATURE_MAX = 1;

// Live OpenRouter/AtlasCloud probes (2026-09-13): LongCat 2.0 accepts
// temperature 0..1 and top_k 1..100; 1.001 or 101 independently return 400.
// Keep this exact-model scoped; other LongCat versions/endpoints are unverified.
const LONGCAT_2_MODEL = "meituan/longcat-2.0";

/** True when the model id refers to an Anthropic/Claude upstream model, whether
 *  routed via the native Anthropic key (`anthropic/claude-*`) or OpenRouter
 *  (`anthropic/claude-…`). Matches the `anthropic/` route prefix and any
 *  `claude` token so OpenRouter aliases and date-suffixed ids are covered. */
export function isAnthropicModel(modelId: string): boolean {
  return /^anthropic\//i.test(modelId) || /claude/i.test(modelId);
}

/** Clamp a temperature into [0, max]. Returns undefined for unset/NaN input so
 *  the caller omits the field entirely (preserving the prior "send nothing when
 *  unset" behavior — Anthropic then applies its own default). */
export function clampTemperature(t: number | undefined, max: number): number | undefined {
  if (t === undefined || Number.isNaN(t)) return undefined;
  return Math.min(max, Math.max(0, t));
}

/** Clamp temperature to the ceiling the given model's upstream accepts.
 *  Anthropic/Claude and LongCat 2.0 are clamped to [0, 1]; other families pass through
 *  (OpenAI/Google accept up to 2.0, well above the 1.5 slider maximum). */
export function clampTemperatureForModel(modelId: string, t: number | undefined): number | undefined {
  if (isAnthropicModel(modelId)) return clampTemperature(t, ANTHROPIC_TEMPERATURE_MAX);
  if (modelId === LONGCAT_2_MODEL) return clampTemperature(t, 1);
  return t;
}

/** Preserve the shared Top-K setting for other models; zero/unset remain disabled. */
export function clampTopKForModel(modelId: string, topK: number | undefined): number | undefined {
  if (modelId !== LONGCAT_2_MODEL || topK === undefined) return topK;
  if (!Number.isFinite(topK)) return undefined;
  return topK <= 0 ? 0 : Math.min(100, Math.max(1, Math.floor(topK)));
}

const KIMI_K2_0905 = "moonshotai/kimi-k2-0905";
const DEFAULT_KIMI_REPETITION_PENALTY = 1.08;

/**
 * OpenRouter only forwards `repetition_penalty` to models whose endpoint
 * advertises support. Kimi K2 0905 does, and it is the model where production
 * roleplay sessions showed phrase/scene loops. Keep the control model-scoped so
 * a shared sampling profile cannot make another model reject the request.
 */
export function repetitionPenaltyForModel(
  modelId: string,
  value: number | undefined,
): number | undefined {
  if (modelId !== KIMI_K2_0905) return undefined;
  const penalty = value ?? DEFAULT_KIMI_REPETITION_PENALTY;
  if (!Number.isFinite(penalty)) return DEFAULT_KIMI_REPETITION_PENALTY;
  return Math.min(Math.max(penalty, 0), 2);
}
