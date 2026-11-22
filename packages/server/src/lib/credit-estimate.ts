// ─── Credit Estimate ────────────────────────────────────────────────
// Pure cost estimation used before and during a stream: the pre-flight
// "out of mushies" gate and the mid-stream abort. No database access here, so
// the math is unit-testable on its own. Actual charges never use these numbers:
// a finished turn is billed from the provider's reported cost (calculateCost).

/** Per-million-token list prices for one model, markup already applied. */
export interface ModelCostRates {
  inputPricePerM: number;
  outputPricePerM: number;
}

/**
 * Conservative token-per-character ratio for cost estimation.
 * Used only when the done chunk is unavailable (abort, cancel, error) and for
 * the pre-flight gate when the session has no billed turn to learn from.
 * Normal completions always use exact token counts from the provider.
 *
 * 2.0 chars/token is deliberately conservative:
 * - CJK text: ~1.5-2 chars/token → estimation is roughly accurate
 * - English text: ~4 chars/token → we over-estimate by ~2x
 *
 * Over-estimating is intentional: we'd rather charge slightly more on
 * rare aborts than under-charge and lose money. The 2.5x margin on
 * credit purchases means even a 2x over-estimate on aborts still
 * leaves positive margin.
 */
export const CONSERVATIVE_CHARS_PER_TOKEN = 2.0;

/** Estimate token count from character count (conservative — never under-counts). */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CONSERVATIVE_CHARS_PER_TOKEN);
}

/** Estimate credits from character counts. Used for mid-stream tracking and abort fallback. */
export function estimateCreditsFromChars(
  rates: ModelCostRates,
  promptChars: number,
  outputChars: number,
): number {
  const estimatedPromptTokens = estimateTokensFromChars(promptChars);
  const estimatedOutputTokens = estimateTokensFromChars(outputChars);
  const costDollars = (estimatedPromptTokens * rates.inputPricePerM + estimatedOutputTokens * rates.outputPricePerM) / 1_000_000;
  return Math.ceil(costDollars * 1000 * 10) / 10;
}

// ─── Calibration from the session's last billed turn ───────────────
// The conservative estimate above prices every prompt token at the list input
// rate and assumes 2 chars/token. On prod ~72% of prompt tokens are cache reads
// and English prompts run ~4 chars/token, so the prompt-only estimate came out
// at ~3x the whole real turn (Gemini Flash ~5.6x) and refused players who still
// had 100+ mushies. When the same session already paid for a turn on the same
// model, that turn's real provider cost says what a prompt token actually costs
// here, caching included.

/**
 * Chars per token assumed for the current prompt when it is calibrated. Card
 * prompts mix English prose (~4) with markup and CJK (lower); 3 sits between.
 * The last turn's real prompt token count is the floor (see
 * estimatePromptTokens), which covers CJK prompts this ratio under-counts.
 */
export const CALIBRATED_CHARS_PER_TOKEN = 3;

/**
 * The learned per-token rate never drops below this share of the list input
 * price. Cache reads cost 10–50% of list on the providers we route to; a lower
 * figure means the output side of the last turn was mispriced (cheaper
 * upstream provider, reasoning tokens), not that prompts are nearly free.
 */
export const MIN_CALIBRATED_INPUT_SHARE = 0.1;

/** What the last completed turn on this session and model really cost. */
export interface LastTurnUsage {
  /** OpenRouter's reported charge for the turn (usage_logs.provider_cost_usd). */
  providerCostUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface PromptCostCalibration {
  /** Credits per prompt token, cache-aware, markup included. */
  creditsPerPromptToken: number;
  /** Prompt tokens the provider counted on that turn. */
  lastPromptTokens: number;
}

/**
 * Derive a cache-aware input rate from a turn that was actually billed.
 * The turn's credits are converted exactly as calculateCost does for a real
 * charge (provider USD × markup × 1000); the output part is taken off at the
 * list output rate, and what is left is spread over the prompt tokens.
 * The result is clamped to [MIN_CALIBRATED_INPUT_SHARE × list, list], so it can
 * only ever lower the estimate. Returns null when the row is not usable.
 */
export function calibrateFromLastTurn(
  rates: ModelCostRates,
  markup: number,
  last: LastTurnUsage,
): PromptCostCalibration | null {
  const listPerToken = rates.inputPricePerM / 1000;
  if (!(listPerToken > 0) || !(markup > 0)) return null;
  if (!(last.promptTokens > 0) || !Number.isFinite(last.providerCostUsd) || last.providerCostUsd < 0) return null;
  const turnCredits = last.providerCostUsd * markup * 1000;
  const outputCredits = Math.max(0, last.completionTokens || 0) * rates.outputPricePerM / 1000;
  const learned = (turnCredits - outputCredits) / last.promptTokens;
  const creditsPerPromptToken = Math.min(listPerToken, Math.max(listPerToken * MIN_CALIBRATED_INPUT_SHARE, learned));
  return { creditsPerPromptToken, lastPromptTokens: Math.ceil(last.promptTokens) };
}

/**
 * Prompt tokens for the current turn. Uncalibrated: the conservative 2
 * chars/token. Calibrated: a typical ratio, but never fewer than the last
 * turn's real count — a session's prompt mostly grows by one exchange per turn.
 */
export function estimatePromptTokens(promptChars: number, calibration: PromptCostCalibration | null): number {
  if (!calibration) return estimateTokensFromChars(promptChars);
  return Math.max(calibration.lastPromptTokens, Math.ceil(promptChars / CALIBRATED_CHARS_PER_TOKEN));
}

/**
 * A prompt this many times the last real one is a different turn shape (context
 * raised, big lorebook hit): the last turn says nothing about it, so the whole
 * estimate falls back to the conservative one.
 */
export const MAX_CALIBRATED_PROMPT_GROWTH = 2;

/**
 * Estimated credits for a turn's prompt plus `outputChars` streamed so far.
 * Without a calibration this is exactly estimateCreditsFromChars. Calibrated,
 * only the last turn's prompt size — the part that can plausibly hit the
 * cache — gets the learned rate; tokens beyond it are priced at list. A prompt
 * more than MAX_CALIBRATED_PROMPT_GROWTH× the last one is uncalibrated.
 * Output keeps the conservative chars/token ratio and list price either way.
 */
export function estimateTurnCredits(
  rates: ModelCostRates,
  promptChars: number,
  outputChars: number,
  calibration: PromptCostCalibration | null,
): number {
  if (!calibration) return estimateCreditsFromChars(rates, promptChars, outputChars);
  const promptTokens = estimatePromptTokens(promptChars, calibration);
  if (promptTokens > calibration.lastPromptTokens * MAX_CALIBRATED_PROMPT_GROWTH) {
    return estimateCreditsFromChars(rates, promptChars, outputChars);
  }
  const cachedTokens = Math.min(promptTokens, calibration.lastPromptTokens);
  const newTokens = promptTokens - cachedTokens;
  const promptCredits = cachedTokens * calibration.creditsPerPromptToken + newTokens * rates.inputPricePerM / 1000;
  const outputCredits = estimateTokensFromChars(outputChars) * rates.outputPricePerM / 1000;
  return Math.ceil((promptCredits + outputCredits) * 10) / 10;
}
