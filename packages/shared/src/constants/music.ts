/**
 * Music generation — Google Lyria 3 through OpenRouter.
 *
 * OpenRouter lists exactly two music models (2026-09-21), and both bill per
 * piece rather than per token: `pricing.prompt` / `completion` read 0 and the
 * price is in the description. `usage.cost` on the response carries the real
 * charge, so the route bills from that and only falls back to these numbers
 * when the field is missing. Audio comes back only with `stream: true`, as
 * base64 slices on `choices[0].delta.audio.data`.
 */
export type MusicLength = "clip" | "full";

export interface MusicModel {
  id: string;
  /** How the model is named on the card, so the two lengths read as two models. */
  label: string;
  /** Listed price per generated piece, USD. */
  priceUsd: number;
  /** Rough duration of one piece, for the author's expectations. */
  seconds: number;
}

export const MUSIC_MODELS: Record<MusicLength, MusicModel> = {
  clip: { id: "google/lyria-3-clip-preview", label: "Lyria 3 Clip", priceUsd: 0.04, seconds: 30 },
  full: { id: "google/lyria-3-pro-preview", label: "Lyria 3 Pro", priceUsd: 0.08, seconds: 150 },
};

export const MUSIC_MAX_PROMPT_CHARS = 600;

/** The platform markup on the provider's charge — the same 1.2 every chat
 *  model carries in model_prices. Music has no row there (it is billed per
 *  piece, not per token), so the multiplier lives here. */
export const MUSIC_MARKUP = 1.2;

export function isMusicLength(value: unknown): value is MusicLength {
  return value === "clip" || value === "full";
}
