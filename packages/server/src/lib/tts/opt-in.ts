// Voice readout is opt-in (Settings › Display): a player who never turned it
// on gets no synthesis and no charge. See isTtsOptedIn in @yumina/shared.

import { eq } from "drizzle-orm";
import { isTtsOptedIn, readTtsVoicePool } from "@yumina/shared";
import { readOwn } from "../../db/index.js";
import { user } from "../../db/schema.js";

export interface PlayerTtsPrefs {
  optedIn: boolean;
  /** The player's voice pool for AI casting (validated; empty = every voice). */
  pool: string[];
}

/** Read from the primary: the player may have changed these a moment ago. */
export async function playerTtsPrefs(userId: string): Promise<PlayerTtsPrefs> {
  const rd = await readOwn(userId);
  const [row] = await rd.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  return { optedIn: isTtsOptedIn(row?.preferences), pool: readTtsVoicePool(row?.preferences) };
}

export async function ttsOptedIn(userId: string): Promise<boolean> {
  return (await playerTtsPrefs(userId)).optedIn;
}

export const TTS_OFF_BODY = {
  error: "Voice readout is off. Turn it on in Settings › Display.",
  code: "TTS_OFF",
} as const;
