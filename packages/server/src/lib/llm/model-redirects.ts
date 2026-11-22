// The map lives in @yumina/shared so the app can show a saved retired id under
// its successor's name too (e.g. the backup model in Settings).
export { DEPRECATED_MODEL_REDIRECTS, applyModelRedirect } from "@yumina/shared";

/**
 * Model ids are provider-scoped slugs (e.g. "google/gemini-2.5-flash-lite",
 * "deepseek/deepseek-chat:free"). Anything outside this charset is junk or an
 * attempted payload — reject it before it lands in the database.
 */
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
