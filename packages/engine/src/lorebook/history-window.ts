import type { WorldDefinition, WorldSettings, Worldbook } from "../types";
import { activeNarrator, resolveStation } from "./station";

/**
 * Author-controlled history window.
 *
 * Every card used to hand the model the whole transcript and let the token
 * budget cut it from the oldest end. That budget belongs to the PLAYER (their
 * settings, their plan) — the author had no say in how much of the past the
 * story AI reads. These two knobs are the author's:
 *
 * - `settings.historyLimit` — the AI sees only the latest N messages of the
 *   current run. Undefined means "everything the budget allows", the way it
 *   has always worked. A narrating module can carry its own `historyLimit`
 *   that wins while that module answers the player.
 * - `settings.contextPolicy: "author"` — the card's `maxContext` is the one
 *   that counts; the player's per-send override no longer replaces it. The
 *   plan cap and the model window still clamp it afterwards.
 *
 * Both are prompt-side only: the stored transcript keeps every word, and
 * lorebook scanning, macros and memory still read the real tail.
 */

export const HISTORY_LIMIT_MAX = 500;

/** The message-count window that applies to this turn, if the author set one. */
export function resolveHistoryLimit(
  world: Pick<WorldDefinition, "settings" | "worldbooks">,
  activeBookIds: ReadonlySet<string>,
): number | undefined {
  const narrator = activeNarrator(world.worldbooks as Worldbook[] | undefined, activeBookIds);
  const station = narrator ? resolveStation(narrator) : null;
  const fromModule = station?.historyLimit;
  const fromCard = world.settings?.historyLimit;
  const limit = fromModule ?? fromCard;
  if (limit === undefined || limit === null) return undefined;
  if (!Number.isFinite(limit) || limit < 1) return undefined;
  return Math.min(Math.floor(limit), HISTORY_LIMIT_MAX);
}

/** Keep only the latest `limit` rows. No limit → the rows untouched. */
export function applyHistoryLimit<T>(rows: readonly T[], limit: number | undefined): T[] {
  if (limit === undefined || rows.length <= limit) return [...rows];
  return rows.slice(rows.length - limit);
}

/**
 * Which context budget a send honours. Player wins by default (their
 * settings, their plan); an author-locked card keeps its own number.
 */
export function resolveRequestedMaxContext(
  settings: Pick<WorldSettings, "maxContext" | "contextPolicy"> | undefined,
  playerOverride: number | undefined,
  fallback = 200000,
): number {
  if (settings?.contextPolicy === "author") {
    return settings.maxContext ?? playerOverride ?? fallback;
  }
  return playerOverride ?? settings?.maxContext ?? fallback;
}
