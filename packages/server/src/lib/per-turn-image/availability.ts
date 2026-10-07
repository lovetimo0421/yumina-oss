// Who may see and use per-turn pictures. Two gates, both server-side:
//
//   1. The server flag (PER_TURN_IMAGES=1 plus a generation provider and our
//      OpenRouter key for tagging). Off: nobody is offered the feature, and
//      the Settings switch is hidden (GET /users/me → turnImagesOffered).
//   2. The player's own switch, preferences.experimentalTurnImages (the key
//      keeps its old name), set from Settings › Display › Story illustrations.
//      On by default: a missing key means on, only an explicit false is off.
//      Drawing still only happens when the player asks (or turns auto on).
//
// Only with both on does the player get the "draw this scene" button, the
// composer's auto switch, or any drawing at all; the illustrate endpoint
// refuses everyone else.
//
// Kept apart from illustrate.ts so /users/me can answer gate 1 without
// loading the drawing pipeline.

import { eq } from "drizzle-orm";
import { readOwn } from "../../db/index.js";
import { user } from "../../db/schema.js";
import { env } from "../env.js";
import { getGenerationProvider } from "../generation/provider.js";

export function perTurnImagesEnabled(): boolean {
  return env.PER_TURN_IMAGES === "1" && getGenerationProvider() !== null && !!env.YUMINA_OPENROUTER_KEY;
}

export interface TurnImagePrefs {
  /** Settings › Display › Story illustrations switch. */
  optedIn: boolean;
  /** The composer's "illustrate every reply" switch. Counts only when it was turned on
   *  alongside an explicit experimentalTurnImages:true (the composer writes both), so a
   *  stray autoTurnImages from before the default flip doesn't start paid drawing. */
  auto: boolean;
}

export function readTurnImagePrefs(preferences: unknown): TurnImagePrefs {
  const prefs = (preferences ?? {}) as Record<string, unknown>;
  const optedIn = prefs.experimentalTurnImages !== false;
  return { optedIn, auto: prefs.experimentalTurnImages === true && prefs.autoTurnImages === true };
}

/** The player's own switches, read from the primary (they just flipped them). */
export async function turnImagePrefs(userId: string): Promise<TurnImagePrefs> {
  const rd = await readOwn(userId);
  const [row] = await rd.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  return readTurnImagePrefs(row?.preferences);
}
