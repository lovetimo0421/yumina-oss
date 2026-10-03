// Who may see and use per-turn pictures. Two gates, both server-side:
//
//   1. The server flag (PER_TURN_IMAGES=1 plus a generation provider and our
//      OpenRouter key for tagging). Off: nobody is offered the feature, and
//      the Settings switch is hidden (GET /users/me → turnImagesOffered).
//   2. The player's own opt-in, preferences.experimentalTurnImages, set from
//      Settings › Display › Experimental. It is an experimental, paid feature,
//      so everyone starts with it off and a missing key means off.
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
  /** Settings › Display › Experimental switch. */
  optedIn: boolean;
  /** The composer's "illustrate every reply" switch. Only means anything while opted in. */
  auto: boolean;
}

export function readTurnImagePrefs(preferences: unknown): TurnImagePrefs {
  const prefs = (preferences ?? {}) as Record<string, unknown>;
  const optedIn = prefs.experimentalTurnImages === true;
  return { optedIn, auto: optedIn && prefs.autoTurnImages === true };
}

/** The player's own switches, read from the primary (they just flipped them). */
export async function turnImagePrefs(userId: string): Promise<TurnImagePrefs> {
  const rd = await readOwn(userId);
  const [row] = await rd.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  return readTurnImagePrefs(row?.preferences);
}
