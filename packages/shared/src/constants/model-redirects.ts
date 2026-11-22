/**
 * Deprecated model ids → their replacements. Applied wherever a model id
 * enters the system (chat resolveModel, session-memory/summary settings) so
 * stored model fields never reference retired ids — the provider would
 * silently redirect anyway, but then the UI shows a model name that no
 * longer exists.
 */
export const DEPRECATED_MODEL_REDIRECTS: Record<string, string> = {
  "x-ai/grok-4.1-fast": "x-ai/grok-4.20",
  "x-ai/grok-4.1": "x-ai/grok-4.20",
  "google/gemini-3.1-flash-lite-preview": "google/gemini-3.1-flash-lite",
  // OpenRouter retires the Gemini 2.5 line on 2026-10-20 and Xiaomi stops
  // serving MiMo V2.5 on 2026-10-21. Each target keeps the old model's plan
  // (all free tier); MiMo follows Xiaomi's own mapping at the same price.
  "google/gemini-2.5-flash-lite": "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash": "google/gemini-3.5-flash-lite",
  "google/gemini-2.5-pro": "google/gemini-3.5-flash",
  "xiaomi/mimo-v2.5-pro": "xiaomi/mimo-v2.6-pro",
  "xiaomi/mimo-v2.5": "xiaomi/mimo-v2.6-flash",
  // 2026-11-07: Hermes 3 405B and Euryale L3.3 70B are gone from OpenRouter (no
  // provider serves them). Both free tier, as are the targets.
  // Hermes 3 goes to Hermes 4 405B, its successor on the same plan (added 2026-11-09).
  // Euryale goes to the other community roleplay finetune.
  "nousresearch/hermes-3-llama-3.1-405b": "nousresearch/hermes-4-405b",
  "sao10k/l3.3-euryale-70b": "thedrummer/unslopnemo-12b",
};

/**
 * Models that still work today but have an announced shutdown. They stay selectable
 * until `at`, then move to `to` like the redirects above, with no deploy needed.
 */
export const SCHEDULED_MODEL_REDIRECTS: Record<string, { to: string; at: string }> = {
  // OpenRouter shuts Kimi K2.5 down on 2026-11-18. K2.6 is on the free plan too.
  "moonshotai/kimi-k2.5": { to: "moonshotai/kimi-k2.6", at: "2026-11-18T00:00:00Z" },
};

/** One argument only: it is passed straight to zod `.transform`, which would fill a second. */
export function applyModelRedirect(model: string): string {
  return applyModelRedirectAt(model, Date.now());
}

export function applyModelRedirectAt(model: string, now: number): string {
  const direct = DEPRECATED_MODEL_REDIRECTS[model];
  if (direct) return direct;
  const scheduled = SCHEDULED_MODEL_REDIRECTS[model];
  return scheduled && now >= Date.parse(scheduled.at) ? scheduled.to : model;
}
