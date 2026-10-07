import { UI_CANVAS_W } from "@yumina/engine";

/** The phone canvas's height in design px. */
const PHONE_H = 812;
/** Below this the whole phone squeezed into the box reads as a thumbnail:
 *  at 0.6 a 14px line is 8px on screen. */
const MIN_READABLE_SCALE = 0.7;

/**
 * How big to draw the phone canvas in a box of `boxW` × `boxH` screen px.
 *
 * Fitting the whole 375×812 canvas into the box is right on a monitor (the box
 * is tall, the scale ends up near 1) and wrong on a phone, where the editor
 * column is 360px wide and a few hundred tall: the whole canvas fits only at
 * a third of its size, and the type is 5px. There the canvas takes the full
 * width at a readable scale instead, and the stage scrolls — the way a phone
 * page does.
 *
 * `null` means "fit it in the box" (the default layout). Otherwise the size
 * to draw the canvas at, in screen px.
 */
export function phoneFitFor(boxW: number, boxH: number, maxW = 390): { width: number; height: number } | null {
  if (!(boxW > 0) || !(boxH > 0)) return null;
  const width = Math.min(maxW, boxW);
  const height = Math.round((width * PHONE_H) / UI_CANVAS_W);
  if (height <= boxH) return null;
  if (boxH / PHONE_H >= MIN_READABLE_SCALE) return null;
  return { width, height };
}
