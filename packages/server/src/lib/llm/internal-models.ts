/**
 * Models the platform calls on its own behalf — not the ones players pick.
 *
 * Community auto-translation (lib/translate.ts) and generation prompt
 * enhancement (lib/generation/enhance.ts) are both "rewrite this text"
 * workloads with the same two requirements, so they share one pair of ids:
 *
 *  - PRIMARY: the quality choice, picked by bakeoff on real community content.
 *  - PERMISSIVE_FALLBACK: retried when PRIMARY refuses. Yumina hosts adult and
 *    roleplay content, and instruct models with a content filter will refuse a
 *    slice of it. The fallback exists to be *more* permissive than the primary,
 *    so it must be an unmoderated model (OpenRouter `is_moderated: false`).
 *
 * These lived as duplicated string literals in both files until 2026-08-26,
 * which is how the fallback stayed pointed at a model OpenRouter had retired:
 * `google/gemini-2.0-flash-lite-001` returned 404 "No endpoints found" for
 * months while both call sites still named it. Keep them here, in one place,
 * and keep them covered by `pnpm check:models` (scripts/check-models.mts) so a
 * retirement fails a build instead of silently disabling a fallback path.
 */

/**
 * Quality primary for internal rewrite workloads.
 *
 * Picked by bakeoff over 37 real community posts x 5 models on 2026-08-27
 * (scripts/translation-bakeoff/). It beat the incumbent qwen3-235b on every
 * measured axis: echo 1 vs 4, zero URL corruption, zero refusals.
 *
 * The finding that decided it: the prompt says `Never use em dashes`, and
 * qwen3-235b broke that rule in 8 of 37 outputs (17 occurrences) while all four
 * challengers broke it zero times. That is measurable proof of a model ignoring
 * an explicit instruction, and it tracks what the prose reads like -- qwen3-235b
 * rendered the casual Chinese "往正能量上拉" as the stiff "steer storylines
 * toward a more positive tone", where this model gives "drags the plot toward
 * wholesome territory".
 *
 * It is a reasoning model: expect ~150-250 hidden reasoning tokens per call.
 * That is priced in (~$4/month at current volume) but it is NOT free headroom --
 * every caller's max_tokens has to clear reasoning plus the real answer. See the
 * budget note in generation/enhance.ts.
 */
export const INTERNAL_PRIMARY_MODEL = "z-ai/glm-5.3";

/**
 * Retry target when the primary refuses. MUST be unmoderated — a moderated
 * model here refuses everything the primary already refused, which is the
 * failure the fallback exists to prevent.
 */
export const INTERNAL_PERMISSIVE_FALLBACK_MODEL = "deepseek/deepseek-v4-flash-0731";
// Smoke-tested 2026-08-27 (scripts/smoke-free-fallback.mts): 6/6 on zh/en adult
// roleplay, dark framings and engine directives, zero refusals. Worth stating
// because its larger sibling deepseek-v4-pro DID refuse a community thread in
// the same day's bakeoff ("contains explicit sexual material") despite both
// being `is_moderated: false` in the catalog -- permissiveness does not travel
// across a model family, and the catalog flag is not evidence.

/**
 * Every model id this file pins, for the availability guard to verify.
 * Exported as a list so adding a constant above cannot forget the guard.
 */
export const INTERNAL_PINNED_MODELS: readonly string[] = [
  INTERNAL_PRIMARY_MODEL,
  INTERNAL_PERMISSIVE_FALLBACK_MODEL,
];
