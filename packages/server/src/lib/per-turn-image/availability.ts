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

import { eq, sql } from "drizzle-orm";
import { db, readOwn } from "../../db/index.js";
import { user } from "../../db/schema.js";
import { env } from "../env.js";
import { getGenerationProvider } from "../generation/provider.js";

export function perTurnImagesEnabled(): boolean {
  return env.PER_TURN_IMAGES === "1" && getGenerationProvider() !== null && !!env.YUMINA_OPENROUTER_KEY;
}

/** How pictures are drawn: "default" is Anima Turbo, "detailed" Anima's full
 *  model (slower, flatter anime), "vivid" WAI (glossier, brighter; one-person
 *  pictures only, the rest stay on Anima). preferences.turnImageStyle; anything
 *  else reads as default. */
export const TURN_IMAGE_STYLES = ["default", "detailed", "vivid"] as const;
export type TurnImageStyle = (typeof TURN_IMAGE_STYLES)[number];

export interface TurnImagePrefs {
  /** Settings › Display › Story illustrations switch. */
  optedIn: boolean;
  /** The composer's "illustrate every reply" switch. Counts only when it was turned on
   *  alongside an explicit experimentalTurnImages:true (the composer writes both), so a
   *  stray autoTurnImages from before the default flip doesn't start paid drawing. */
  auto: boolean;
  style: TurnImageStyle;
}

export function readTurnImagePrefs(preferences: unknown): TurnImagePrefs {
  const prefs = (preferences ?? {}) as Record<string, unknown>;
  const optedIn = prefs.experimentalTurnImages !== false;
  const style = TURN_IMAGE_STYLES.find((s) => s === prefs.turnImageStyle) ?? "default";
  return { optedIn, auto: prefs.experimentalTurnImages === true && prefs.autoTurnImages === true, style };
}

/** Cards whose interface the player let draw paid pictures without asking again
 *  (preferences.cardImageWorlds, world ids). */
export function cardImagesAllowed(preferences: unknown, worldId: string): boolean {
  const list = ((preferences ?? {}) as Record<string, unknown>).cardImageWorlds;
  return Array.isArray(list) && list.includes(worldId);
}

export async function allowCardImages(userId: string, worldId: string): Promise<void> {
  await db.update(user).set({
    preferences: sql`coalesce(${user.preferences}, '{}'::jsonb) || jsonb_build_object('cardImageWorlds',
      (CASE WHEN jsonb_typeof(${user.preferences}->'cardImageWorlds') = 'array' THEN ${user.preferences}->'cardImageWorlds' ELSE '[]'::jsonb END) || to_jsonb(${worldId}::text))`,
  }).where(sql`${user.id} = ${userId} AND NOT coalesce(${user.preferences}->'cardImageWorlds' ? ${worldId}, false)`);
}

export async function userPreferences(userId: string): Promise<unknown> {
  const rd = await readOwn(userId);
  const [row] = await rd.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.preferences ?? null;
}

/** The player's own switches, read from the primary (they just flipped them). */
export async function turnImagePrefs(userId: string): Promise<TurnImagePrefs> {
  const rd = await readOwn(userId);
  const [row] = await rd.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  return readTurnImagePrefs(row?.preferences);
}
