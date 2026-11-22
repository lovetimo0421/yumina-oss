import { computeVideoModelPrice, getVideoModel } from "./constants/video-models.js";

/**
 * Video models a player can pick for the short films in chat (owner
 * 2026-10-25). "h3" is the default: MiniMax H3 on our Comfy workers, the only
 * one that can continue a shot from the last one and the cheapest by far.
 * The others are partner models on Comfy Router: every shot starts fresh from
 * its keyframe or the cast's portraits, the partner's content filter applies
 * (a refused shot is skipped, not charged), and they cost several times more.
 */
export const FILM_DEFAULT_VIDEO_MODEL = "h3";
export const FILM_PARTNER_VIDEO_MODELS = ["kling-3-omni", "wan-3.0", "seedance-2.0-fast"] as const;
export type FilmPartnerVideoModel = (typeof FILM_PARTNER_VIDEO_MODELS)[number];

/** One partner shot, shaped like an H3 shot: 5 s of 16:9 at 720p, with sound. */
export const FILM_PARTNER_SHOT = { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", sound: true } as const;

export function isFilmPartnerVideoModel(id: unknown): id is FilmPartnerVideoModel {
  return typeof id === "string" && (FILM_PARTNER_VIDEO_MODELS as readonly string[]).includes(id);
}

/** Mushies one partner shot costs the player (markup included), started from a keyframe. */
export function filmPartnerShotPrice(id: FilmPartnerVideoModel): number {
  const spec = getVideoModel(id);
  if (!spec) return 0;
  return computeVideoModelPrice(spec, { ...FILM_PARTNER_SHOT, firstFrameAssetId: "keyframe" });
}
