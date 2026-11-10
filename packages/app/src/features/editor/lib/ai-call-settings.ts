import { PLAN_HIERARCHY, PLAY_MODELS } from "@yumina/shared";
import type { ModuleStation } from "@yumina/engine";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Model and sampling, per AI call, as the runtime decides them (server
 * lib/station-sampling.ts, lib/station-model.ts). One that talks to the
 * player on its turn answers with the player's own settings; its only author
 * knob is the model. One behind the scenes (a writer, one that steps in when
 * it is quiet, one a button calls, a custom AI) samples steadily unless the
 * author says otherwise.
 */
export const answersWithPlayerSettings = (station: Pick<ModuleStation, "kind">): boolean => station.kind === "narrator";

/** How long a background AI's answer may be when the author leaves it: a
 *  call from the card's screen (api.callAi) 800, one on its own trigger 900. */
export function stationDefaultMaxTokens(station: Pick<ModuleStation, "kind" | "trigger">): number {
  return station.kind === "custom" || station.trigger?.on === "ui" ? 800 : 900;
}

/** The author set this background AI's temperature or length. */
export const stationParamsCustom = (station: Pick<ModuleStation, "temperature" | "maxTokens">): boolean =>
  station.temperature !== undefined || station.maxTokens !== undefined;

/** The plans a player can be on, cheapest first ("internal" is staff). */
const PLAYER_PLANS = PLAN_HIERARCHY.filter((p) => p !== "internal");

/**
 * Who can run a model an author names, by the official catalog.
 *
 * A card that names a model asks for it; it never makes a card unplayable.
 * The players who cannot run it get something else (their own model, or the
 * default one behind the scenes), so the author is told who that is.
 */
export interface ModelReach {
  /** In the official model list at all. */
  known: boolean;
  name?: string;
  minPlan?: string;
  /** The plans below it: their players do not get this model. */
  shut: string[];
}

export function modelReach(id: string): ModelReach {
  const model = PLAY_MODELS.find((m) => m.id === id.trim());
  if (!model) return { known: false, shut: [] };
  const rank = PLAN_HIERARCHY.indexOf(model.minPlan as (typeof PLAN_HIERARCHY)[number]);
  return {
    known: true,
    name: model.name,
    minPlan: model.minPlan,
    shut: rank > 0 ? PLAYER_PLANS.filter((_, i) => i < rank) : [],
  };
}

/** A model id as a creator reads it: its catalog name when it has one. */
export function modelLabel(id: string): string {
  return PLAY_MODELS.find((m) => m.id === id.trim())?.name ?? id;
}

/** The plans, by their names: 「Free/Gold」. */
export function planNames(plans: string[], t: Translate): string {
  return plans.map((p) => String(t(`planName.${p}`, { ns: "common" }))).join("/");
}

/**
 * What happens to the players an author's model leaves out, as one warning,
 * or nothing when everyone can run it. A narrator falls back to the player's
 * own chat model, an AI behind the scenes to the default background model.
 * A call in the card's code falls back to the player's own model too, but a
 * model missing from the catalog fails there, so it passes "none" for that.
 */
export function modelReachWarning(
  id: string,
  fallback: "player" | "default" | "none",
  t: Translate,
  unknownFallback: "player" | "default" | "none" = fallback,
): string | undefined {
  const reach = modelReach(id);
  if (!reach.known) return String(t(`blueprint.aiCalls.modelUnknown.${unknownFallback}`));
  if (reach.shut.length === 0) return undefined;
  return String(t(`blueprint.aiCalls.modelShut.${fallback}`, { plans: planNames(reach.shut, t) }));
}
