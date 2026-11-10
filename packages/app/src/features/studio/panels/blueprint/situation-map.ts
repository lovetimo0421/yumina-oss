import type { Worldbook } from "@yumina/engine";
import { FRAME_GAP, type FrameBox } from "./board";
import { WAY_IN_ORDER, wayInOf, type WayIn } from "./situation-describe";

/**
 * Where a card's situations stand on the board: beside the card, grouped by
 * how the player gets into them.
 *
 * Packed in rows like any other frame, a card with twelve dungeons came out as
 * a sheet of small squares under the card, out of sight of the first screen,
 * the training room among the dungeons and the chronicler among both. Grouped,
 * the board reads the way the player travels: the card on the left, then a
 * column of groups — the ones an opening decides, the ones always on, the ones
 * a number opens, the ones a word opens — and the background writers last.
 *
 * A frame the author has dragged keeps its place; only the ones still in
 * formation are moved. Each group gets a box so the board can draw its
 * outline and title behind the frames.
 */

export const SITUATION_GROUP_PAD = 16;
export const SITUATION_GROUP_HEADER = 40;
/** Between one group and the next. Zoomed out, a group's title grows to stay
 *  readable and stands above the group, lifted clear of the situations' own
 *  names (situation-group-node.tsx): at the board's readable floor (0.3)
 *  that is about 100 units. At 36 the title ran into the group above and
 *  was drawn under its frames. */
const GROUP_GAP = 100;
/** How many shut frames abreast in a group. Four of them is about the width
 *  of the card's own tile, so the column reads as one shape beside it. */
const PER_ROW = 4;

export type SituationGroupWay = WayIn;

export interface SituationGroupBox { id: string; way: SituationGroupWay; x: number; y: number; width: number; height: number; count: number }

export const situationGroupId = (way: SituationGroupWay) => `situation-group:${way}`;

export function arrangeSituations(
  boxes: Map<string, FrameBox>,
  situationOf: (frameId: string) => Worldbook | undefined,
  opts: { startX: number; startY: number; pinned: Record<string, unknown> },
): SituationGroupBox[] {
  const frames = [...boxes.values()].filter((b) => situationOf(b.id));
  if (!frames.length) return [];
  const order: SituationGroupWay[] = [...WAY_IN_ORDER, "worker"];
  const groups: SituationGroupBox[] = [];
  // A frame the creator dragged stays where they left it, so the ones still
  // laid out by group must go round it: they were dealt into the column
  // regardless, and one landed on top of it.
  const pinnedRects = frames.filter((f) => opts.pinned[f.id]);
  const onPinned = (x: number, y: number, w: number, h: number) => pinnedRects.some((r) =>
    x < r.x + r.width + FRAME_GAP && x + w + FRAME_GAP > r.x && y < r.y + r.height + FRAME_GAP && y + h + FRAME_GAP > r.y);
  let y = opts.startY;
  for (const way of order) {
    const members = frames.filter((f) => wayInOf(situationOf(f.id)!) === way);
    if (!members.length) continue;
    const loose = members.filter((f) => !opts.pinned[f.id]);
    const x0 = opts.startX + SITUATION_GROUP_PAD;
    let cx = x0;
    let cy = y + SITUATION_GROUP_HEADER;
    let rowH = 0;
    let right = x0;
    let inRow = 0;
    for (const f of loose) {
      if (inRow === PER_ROW) { cx = x0; cy += rowH + FRAME_GAP; rowH = 0; inRow = 0; }
      for (let guard = 0; guard < 64 && onPinned(cx, cy, f.width, f.height); guard++) {
        cx += f.width + FRAME_GAP;
        inRow++;
        if (inRow >= PER_ROW) { cx = x0; cy += Math.max(rowH, f.height) + FRAME_GAP; rowH = 0; inRow = 0; }
      }
      boxes.set(f.id, { ...f, x: cx, y: cy });
      cx += f.width + FRAME_GAP;
      right = Math.max(right, cx - FRAME_GAP);
      rowH = Math.max(rowH, f.height);
      inRow++;
    }
    const bottom = loose.length ? cy + rowH : y + SITUATION_GROUP_HEADER;
    const box: SituationGroupBox = {
      id: situationGroupId(way),
      way,
      x: opts.startX,
      y,
      width: right - opts.startX + SITUATION_GROUP_PAD,
      height: bottom - y + SITUATION_GROUP_PAD,
      count: members.length,
    };
    groups.push(box);
    y = box.y + box.height + GROUP_GAP;
  }
  return groups;
}
