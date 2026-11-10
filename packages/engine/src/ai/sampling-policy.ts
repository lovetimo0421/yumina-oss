import type { WorldSettings } from "../types/index.js";

/**
 * Who decides how an AI call samples. Every AI call in a card either follows
 * the player's own Yumina settings or uses the author's values. The author's
 * values are clamped to these ranges, so a card (or the Studio assistant
 * writing one) cannot ship a temperature of 2 or a top-K of a million.
 */
export const AUTHOR_SAMPLING_LIMITS = {
  temperature: { min: 0, max: 1.5 },
  topP: { min: 0.05, max: 1 },
  topK: { min: 0, max: 200 },
  minP: { min: 0, max: 0.5 },
  frequencyPenalty: { min: -1, max: 1 },
  presencePenalty: { min: -1, max: 1 },
} as const;

/** Background AIs (worker / quiet / custom) when the author leaves them alone. */
export const STATION_DEFAULT_TEMPERATURE = 0.2;
export const STATION_TEMPERATURE_LIMITS = { min: 0, max: 1.5 } as const;
export const STATION_MAX_TOKENS_LIMITS = { min: 50, max: 4000 } as const;

export type SamplingKey = keyof typeof AUTHOR_SAMPLING_LIMITS;
export type SamplingParams = Partial<Record<SamplingKey, number>>;

const SAMPLING_KEYS = Object.keys(AUTHOR_SAMPLING_LIMITS) as SamplingKey[];

export function clampToRange(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The author's sampling values, clamped. Missing or non-numeric keys are left out. */
export function clampAuthorSampling(values: Partial<Record<SamplingKey, unknown>> | undefined): SamplingParams {
  const out: SamplingParams = {};
  for (const key of SAMPLING_KEYS) {
    const v = values?.[key];
    if (finite(v)) out[key] = clampToRange(v, AUTHOR_SAMPLING_LIMITS[key]);
  }
  return out;
}

/**
 * The story AI's sampling for one send. "player" (default): the player's value
 * wins, the card's fills what the player left unset. "author": the card's
 * clamped value wins, the player's fills the rest.
 */
export function resolveStorySampling(
  settings: Pick<WorldSettings, SamplingKey | "samplingPolicy"> | undefined,
  player: Partial<Record<SamplingKey, number | undefined>> | undefined,
): SamplingParams {
  const author = settings?.samplingPolicy === "author";
  const card = author ? clampAuthorSampling(settings) : (settings ?? {});
  const out: SamplingParams = {};
  for (const key of SAMPLING_KEYS) {
    const p = player?.[key];
    const c = card[key];
    const v = author ? (finite(c) ? c : p) : (finite(p) ? p : c);
    if (finite(v)) out[key] = v;
  }
  return out;
}
