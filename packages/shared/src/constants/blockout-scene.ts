import { VIDEO_PARTNER_MARKUP } from "./video-models.js";

/**
 * An AI scene for the blockout builder: a 3D Gaussian-splat room made by
 * Viggle's JST-2 from a line of text, loaded under the mannequins in place of
 * the grey boxes, so the reference video carries the real place (its layout,
 * light and colour) and the video model keeps it the same every time.
 *
 * Viggle's rate card (2026-10-20): $0.06 for a scene from a prompt, $0.01 for
 * every other scene task. One scene is the prompt, two more 360° views a step
 * away (the splat is sharp only about a metre from where it was made; the
 * extra views push that to two or three) and one rebuild: $0.09, paid by the
 * creator at the partner markup.
 */
export const BLOCKOUT_SCENE_PROVIDER_USD = 0.06 + 0.01 * 2 + 0.01;
export const BLOCKOUT_SCENE_PRICE_MUSHIES = Math.ceil(BLOCKOUT_SCENE_PROVIDER_USD * 1000 * VIDEO_PARTNER_MARKUP);

/** Viggle takes up to 1000 characters of prompt. */
export const BLOCKOUT_SCENE_PROMPT_MAX = 1000;

/** How high JST-2's panorama camera is taken to stand, in metres: the only
 *  way to give its unitless scene a size. The floor it finds under the camera
 *  is this far down, and the mannequins (in metres) are scaled to match. */
export const BLOCKOUT_SCENE_CAMERA_HEIGHT_METRES = 1.2;

/** A scene is sharp near the panorama camera and the expansions; the
 *  camera and the people are best kept within this of the origin. */
export const BLOCKOUT_SCENE_CLEAR_RADIUS_METRES = 3;

/** How many scenes one account keeps; the oldest goes when a new one lands. */
export const BLOCKOUT_SCENE_KEEP = 24;

export type BlockoutSceneStatus = "queued" | "processing" | "ready" | "failed";

/** What the page sees of a scene (GET /generation/scenes). File URLs are
 *  same-origin routes, so the 3D view can fetch them without CORS. */
export interface BlockoutSceneInfo {
  id: string;
  prompt: string;
  status: BlockoutSceneStatus;
  errorCode: string | null;
  costMushies: number;
  refunded: boolean;
  sizeBytes: number | null;
  /** Height of the floor under the panorama camera, in the splat's own units (negative). */
  floorY: number | null;
  createdAt: string | null;
  completedAt: string | null;
  /** Present once ready. */
  files: { scene: string; panorama: string } | null;
}
