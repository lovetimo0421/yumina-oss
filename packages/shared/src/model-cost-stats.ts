// ─── Measured per-reply cost, per model ─────────────────────────────
// The picker used to show one hard-coded "avg" per model, computed once from
// list prices for an imagined 21k-token prompt. Real turns (2026-09-17, 7 days,
// 380k official replies) missed those numbers by 0.12× to 3.2×, and within one
// model the 90th-percentile reply costs 1.5× to 3× the median — because cost is
// driven by context length, caching and reply length, not by the price sheet.
//
// So the server measures. Every night it takes the last `windowDays` of real
// official replies per model from the ledger and stores the distribution here.
// The UI shows a RANGE ("typically … up to …") and, inside a chat, scales it to
// that chat's current context. The number is a measurement with a stated
// spread, never a promise.

export interface ModelCostStats {
  modelId: string;
  /** Days of real replies the stats were measured over. */
  windowDays: number;
  /** How many official replies went into the measurement. */
  turns: number;
  /** Mushies per reply: the middle reply. */
  medianCredits: number;
  p25Credits: number;
  p75Credits: number;
  /** Mushies per reply that 9 in 10 replies stay under. */
  p90Credits: number;
  /** Prompt (context) size of the middle reply, in tokens. */
  medianPromptTokens: number;
  /** Output size of the middle reply, in tokens. */
  medianOutputTokens: number;
  /**
   * Share of a typical reply's cost that comes from reading the prompt, from the
   * model's list prices at the median sizes. Lets the client scale the estimate
   * with context: the prompt part grows with the chat, the reply part does not.
   */
  inputShare: number;
  /**
   * Honesty check: share of the previous 24 h of real replies that landed inside
   * the [p25, p90] band that was being shown at the time. Null until the second
   * measurement. Around 0.65 is expected by construction; drift means the shape
   * of usage moved and the range with it.
   */
  coverage24h: number | null;
  /** ISO timestamp of the measurement. */
  computedAt: string;
}

export interface ReplyCostEstimate {
  /** Mushies the middle reply would cost at this context size. */
  typical: number;
  /** Mushies 9 in 10 replies would stay under at this context size. */
  heavy: number;
  /** True when the estimate was scaled to a specific chat's context. */
  scaled: boolean;
}

/**
 * Estimate a reply's cost from the measured distribution, optionally scaled to a
 * chat's current context size (tokens the model will read). The prompt share of
 * the cost scales with context; the reply share stays. The scale is clamped to
 * [0.1, 6]× the median context so a stale token count cannot produce nonsense.
 */
export function estimateReplyCost(stats: ModelCostStats, contextTokens?: number | null): ReplyCostEstimate {
  const usable = typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0 && stats.medianPromptTokens > 0;
  if (!usable) return { typical: stats.medianCredits, heavy: stats.p90Credits, scaled: false };
  const ratio = Math.min(6, Math.max(0.1, contextTokens / stats.medianPromptTokens));
  const share = Math.min(1, Math.max(0, stats.inputShare));
  const scale = share * ratio + (1 - share);
  return { typical: stats.medianCredits * scale, heavy: stats.p90Credits * scale, scaled: true };
}

/** "8.7" under ten, "15" from ten up — the precision a reader can actually use. */
export function formatCostEstimate(mushies: number): string {
  if (!Number.isFinite(mushies) || mushies <= 0) return "0";
  if (mushies >= 10) return String(Math.round(mushies));
  const one = Math.round(mushies * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
}
