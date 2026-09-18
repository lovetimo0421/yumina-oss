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
};

export function applyModelRedirect(model: string): string {
  return DEPRECATED_MODEL_REDIRECTS[model] ?? model;
}

/**
 * Model ids are provider-scoped slugs (e.g. "google/gemini-2.5-flash-lite",
 * "deepseek/deepseek-chat:free"). Anything outside this charset is junk or an
 * attempted payload — reject it before it lands in the database.
 */
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
