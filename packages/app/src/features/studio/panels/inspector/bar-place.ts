/** The floating text bar's height, in stage px. */
export const BAR_H = 34;

export type Box = { top: number; left: number; width: number; height: number };

/** The bar stood on end, for the margin beside the page. */
export const VBAR_W = 40;
export const VBAR_H = 300;

export type BarPlace = { top: number; left: number; vertical: boolean };

/**
 * Where the floating bar goes: above the part when that covers nothing else,
 * else below; when both would cover something — a title at the top of a full
 * page — stood on end in the margin beside the page, if there is one; only
 * then on the side that covers less.
 *
 * It sat above whatever was selected, and a click aimed at the part under it
 * — the readout above a status bar — landed on the bar instead, so the next
 * edit went to the part still selected.
 */
export function placeBar(
  rect: Box,
  others: Box[],
  /** The page, in the same coordinates as `rect`. */
  stage: { width: number; height: number; top?: number; left?: number },
  barW: number,
  room: { left: number; right: number } = { left: 0, right: 0 },
): BarPlace {
  const pageTop = stage.top ?? 0;
  const pageLeft = stage.left ?? 0;
  const left = Math.max(pageLeft, rect.left);
  const above = rect.top - BAR_H - 24;
  const below = rect.top + rect.height + 10;
  const covered = (top: number) => others.reduce((sum, o) => {
    const w = Math.min(left + barW, o.left + o.width) - Math.max(left, o.left);
    const h = Math.min(top + BAR_H, o.top + o.height) - Math.max(top, o.top);
    return w > 0 && h > 0 ? sum + w * h : sum;
  }, 0);
  const fitsAbove = above >= pageTop + 2;
  const fitsBelow = below + BAR_H <= pageTop + stage.height - 2;
  if (fitsAbove && covered(above) === 0) return { top: above, left, vertical: false };
  if (fitsBelow && covered(below) === 0) return { top: below, left, vertical: false };
  const sideTop = Math.max(pageTop, Math.min(rect.top, pageTop + stage.height - VBAR_H));
  if (room.right >= VBAR_W + 12) return { top: sideTop, left: pageLeft + stage.width + 10, vertical: true };
  if (room.left >= VBAR_W + 12) return { top: sideTop, left: pageLeft - VBAR_W - 10, vertical: true };
  if (fitsAbove && fitsBelow) return { top: covered(below) < covered(above) ? below : above, left, vertical: false };
  return { top: fitsAbove ? above : below, left, vertical: false };
}
