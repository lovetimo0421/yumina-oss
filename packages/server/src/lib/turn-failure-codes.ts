/**
 * Failure classification for a generation turn. Deliberately free of any DB /
 * env import so it stays a pure unit (see turn-failure.ts for the writes).
 */

/** Emitted to the client so the UI can offer the one action that actually helps. */
export const FAILURE_CODE = {
  MODEL_FALLBACK_REQUIRED: "MODEL_FALLBACK_REQUIRED",
  STATE_VALIDATION: "STATE_VALIDATION",
  /** OpenRouter's account-wide daily cap on free models. Retrying the same
   *  model cannot succeed — only switching models (or waiting) does. */
  FREE_POOL_EXHAUSTED: "FREE_POOL_EXHAUSTED",
  /** Upstream refused the content. Non-deterministic; a retry often passes. */
  CONTENT_FILTER: "CONTENT_FILTER",
  /** Upstream is rate-limited or briefly unavailable. Retrying later works. */
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  /** Stream died between us and the client (mobile backgrounding, network
   *  drop, page reload). Nothing was persisted, so a resend is safe. */
  INTERRUPTED: "INTERRUPTED",
} as const;

export type FailureCode = (typeof FAILURE_CODE)[keyof typeof FAILURE_CODE];

export interface ClassifiedFailure {
  code: FailureCode | null;
  /** Player-facing text. Falls back to the raw upstream message. */
  message: string;
}

/**
 * Map a raw upstream/stream error onto a player-facing message + action code.
 *
 * Only patterns actually observed in prod logs are matched here. An
 * unrecognized error keeps its original text: a wrong-but-friendly message is
 * worse than an ugly-but-true one, because it sends the player down the wrong
 * recovery path.
 */
export function classifyGenerationFailure(raw: string): ClassifiedFailure {
  const text = raw ?? "";
  if (text.startsWith("State update check failed") || text.startsWith("Not enough mushies for the state update correction")) {
    return { code: FAILURE_CODE.STATE_VALIDATION, message: text };
  }

  // Observed: "OpenRouter error (429): Rate limit exceeded: free-models-per-day-high-balance."
  // Checked before the generic rate-limit branch below — this one is NOT
  // recoverable by waiting a moment, so it must not be described as such.
  if (/free-models-per-day/i.test(text)) {
    return {
      code: FAILURE_CODE.FREE_POOL_EXHAUSTED,
      message:
        "Yumina Free has hit its daily limit upstream. Switch to another model to keep playing — your story is saved.",
    };
  }

  // Observed: "Response blocked by safety/content filter…", "Gemini blocked the
  // request: PROHIBITED_CONTENT", "Upstream error from Alibaba: Output data may
  // contain inappropriate content."
  if (/safety\/content filter|PROHIBITED_CONTENT|inappropriate content/i.test(text)) {
    return {
      code: FAILURE_CODE.CONTENT_FILTER,
      message:
        "The model's safety filter blocked this reply. It's non-deterministic — tap retry, or switch models if it keeps happening.",
    };
  }

  // Observed: "…is temporarily rate-limited upstream", "provider failed
  // upstream", plain 429/502/503 passthroughs.
  if (/rate.?limit|temporarily|failed upstream|\b(429|502|503|504)\b/i.test(text)) {
    return {
      code: FAILURE_CODE.UPSTREAM_UNAVAILABLE,
      message:
        "The model provider is busy right now. Tap retry in a moment, or switch models.",
    };
  }

  return { code: null, message: text || "Generation failed" };
}
