import {
  clampToRange, resolveStorySampling, STATION_DEFAULT_TEMPERATURE, STATION_MAX_TOKENS_LIMITS, STATION_TEMPERATURE_LIMITS,
  type ModuleStation, type SamplingKey, type SamplingParams, type WorldSettings,
} from "@yumina/engine";
import { clampPlayerSampling, PLAYER_SAMPLING_BOUNDS } from "@yumina/shared";

/**
 * How a background AI (behind the scenes, steps in, custom) samples: the
 * author's own temperature and length when set, clamped, else the kind's
 * default. Narrator stations never come here — they answer with the
 * player's settings.
 */
export function stationSampling(
  station: Pick<ModuleStation, "temperature" | "maxTokens"> | null | undefined,
  defaultMaxTokens: number,
): { temperature: number; maxTokens: number } {
  const t = station?.temperature, m = station?.maxTokens;
  return {
    temperature: typeof t === "number" && Number.isFinite(t) ? clampToRange(t, STATION_TEMPERATURE_LIMITS) : STATION_DEFAULT_TEMPERATURE,
    maxTokens: typeof m === "number" && Number.isFinite(m) ? Math.round(clampToRange(m, STATION_MAX_TOKENS_LIMITS)) : defaultMaxTokens,
  };
}

/**
 * The story AI's sampling for one send: the player's settings, or the card's
 * own clamped values when it locked them (samplingPolicy "author").
 * Temperature always ends up set (default 1.0) and within the player range.
 *
 * The player's values are clamped here, at request time, rather than in the
 * stored preferences: accounts that saved a presence penalty of 1.7 before the
 * sliders were narrowed get a sane request on their next send, no migration.
 * This covers every route (official, BYOK, custom endpoint) since all of them
 * receive these params.
 */
export function storySamplingParams(
  settings: WorldSettings | undefined,
  player: Partial<Record<SamplingKey, number | undefined>> | undefined,
  clamp: (v: number, min: number, max: number) => number,
): SamplingParams & { temperature: number } {
  const sampling = resolveStorySampling(settings, clampPlayerSampling(player));
  const { min, max } = PLAYER_SAMPLING_BOUNDS.temperature;
  return { ...sampling, temperature: clamp(sampling.temperature ?? 1.0, min, max) };
}
