import { sql } from "drizzle-orm";
import {
  RATING_MIN_PLAYTIME_SECONDS,
  isLowRating,
  normalizeLowRatingReasons,
  parseLowRatingReasons,
  serializeLowRatingReasons,
} from "@yumina/shared";
import { nativeGameIdFromPath } from "./native-game-playtime-query.js";
import { reviewPlaytimeQuery } from "./review-playtime.js";
import type { DrizzleDB } from "../db/index.js";

/**
 * Rating is for people who opened the card. Half of 1–2★ ratings in the 60 days
 * before 2026-10-26 came from accounts with no session on the card at all.
 * Recorded playtime is the signal; a sent turn also counts so a heartbeat that
 * never landed can't lock out someone who actually played.
 */
export async function hasPlayedWorld(
  rd: DrizzleDB,
  userId: string,
  worldId: string,
  gamePath: string | null | undefined,
): Promise<boolean> {
  const played = await rd.execute(reviewPlaytimeQuery(worldId, [userId], gamePath));
  if (Number(played.rows[0]?.seconds ?? 0) >= RATING_MIN_PLAYTIME_SECONDS) return true;
  if (nativeGameIdFromPath(gamePath)) return false;
  const sent = await rd.execute(sql`
    SELECT 1 FROM play_sessions ps
    INNER JOIN worlds w ON w.id = ps.world_id
    WHERE ps.user_id = ${userId}
      AND ps.ephemeral = false
      AND (w.id = ${worldId} OR (
        w.language_group_id IS NOT NULL
        AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId})
      ))
      AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = ps.id AND m.role = 'user')
    LIMIT 1
  `);
  return sent.rows.length > 0;
}

export type LowRatingCheck =
  | { ok: true; lowReason: string | null }
  | { ok: false; code: "low_rating_needs_reason"; error: string };

/**
 * A 1–2★ rating needs at least one reason. Written details are optional for
 * every reason. Moving between 1★ and 2★ after already giving reasons
 * keeps them, so nobody has to re-pick to nudge their stars.
 */
export function checkLowRating({
  rating,
  reasons,
  content,
  existingLowReason,
}: {
  rating: number;
  reasons: unknown;
  content: string | null;
  existingLowReason: string | null;
}): LowRatingCheck {
  if (!isLowRating(rating)) return { ok: true, lowReason: null };
  const needReason = { ok: false, code: "low_rating_needs_reason", error: "Pick what went wrong for a 1 or 2 star rating" } as const;
  const given = Array.isArray(reasons) ? reasons : [];
  if (given.length === 0) {
    const kept = serializeLowRatingReasons(parseLowRatingReasons(existingLowReason));
    if (kept && !content) return { ok: true, lowReason: kept };
    return needReason;
  }
  const picked = normalizeLowRatingReasons(given);
  if (picked.length !== new Set(given).size) return needReason;
  return { ok: true, lowReason: serializeLowRatingReasons(picked) };
}
