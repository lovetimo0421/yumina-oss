import type { WorldDefinition } from "@yumina/engine";
import { edition } from "../../edition/index.js";
import { getUninstalledExtensions, isExtensionInstalled } from "../../lib/extensions.js";

export const STATE_GUARD_KEY = "state-update-guard";

/**
 * Whether the platform default (guard on without an install) may run at all.
 * The guard is an extension players install, so the default is off unless
 * `STATE_UPDATE_GUARD_DEFAULT=on`. Default-on (2026-10-06 to 10-08) failed a
 * fifth of turns visibly, and the missed-update repair already fills in what a
 * reply forgot for every player. The emergency
 * `STATE_UPDATE_GUARD_DISABLED` fails installed players' turns closed; it must
 * not start failing every default player's turns too, so it also turns the
 * default off. Editions without official models have no platform key to pay
 * for default corrections.
 */
export function stateGuardDefaultEnabled(): boolean {
  if (process.env.STATE_UPDATE_GUARD_DEFAULT?.trim().toLowerCase() !== "on") return false;
  if (process.env.STATE_UPDATE_GUARD_DISABLED === "true") return false;
  return edition.info().features.officialModels;
}

/**
 * Static form of the engine's isAiWritable (same `internal` / `aiAccess`
 * reading). Module activation is ignored on purpose: a variable gated behind
 * a module the story has not opened yet still makes this a stateful card.
 */
export function worldHasAiWritableVariables(world: Pick<WorldDefinition, "variables"> | undefined): boolean {
  return (world?.variables ?? []).some((v) => !v.internal && (v.aiAccess ?? "write") === "write");
}

/** Default-path eligibility that needs no per-user lookup. */
export function stateGuardDefaultApplies(world: Pick<WorldDefinition, "variables"> | undefined): boolean {
  return stateGuardDefaultEnabled() && worldHasAiWritableVariables(world);
}

/**
 * The activation rule, re-checked before a correction call: installed, or the
 * default applies and the player has not uninstalled the extension. The
 * per-chat `stateGuardEnabled` switch is a turn snapshot (resolveCapabilities)
 * and is deliberately not re-read mid-turn, as before.
 */
export async function isStateGuardActive(userId: string, world: Pick<WorldDefinition, "variables"> | undefined): Promise<boolean> {
  if (process.env.STATE_UPDATE_GUARD_DISABLED === "true") return false;
  if (await isExtensionInstalled(userId, STATE_GUARD_KEY)) return true;
  if (!stateGuardDefaultApplies(world)) return false;
  return !(await getUninstalledExtensions(userId)).has(STATE_GUARD_KEY);
}
