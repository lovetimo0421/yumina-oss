/**
 * Smart guides for dragging frames, the way slides do it.
 *
 * A frame being dragged snaps its left / centre / right to the left, centre
 * and right of every other frame, and its top / middle / bottom likewise —
 * and says which line it snapped to, so the canvas can draw the guide
 * between the two. Nearest candidate within `threshold` wins on each axis;
 * outside reach the frame goes exactly where the pointer put it.
 */

export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Snap {
  x: number;
  y: number;
  /** A vertical guide at `x`, drawn from `from` to `to` (board y). */
  vertical?: { x: number; from: number; to: number };
  /** A horizontal guide at `y`, drawn from `from` to `to` (board x). */
  horizontal?: { y: number; from: number; to: number };
}

export function snapToNeighbours(moving: Rect, others: Rect[], threshold: number): Snap {
  const neighbours = others.filter((o) => o.id !== moving.id);
  let bestX: { dist: number; x: number; line: number; other: Rect } | null = null;
  let bestY: { dist: number; y: number; line: number; other: Rect } | null = null;

  for (const o of neighbours) {
    // Where the moving frame's left edge would have to be for each of its
    // three x-anchors to sit on each of the neighbour's three.
    const xs = [o.x, o.x + o.width / 2, o.x + o.width];
    const mine = [0, moving.width / 2, moving.width];
    for (const line of xs) {
      for (const offset of mine) {
        const x = line - offset;
        const dist = Math.abs(x - moving.x);
        if (dist <= threshold && (!bestX || dist < bestX.dist)) bestX = { dist, x, line, other: o };
      }
    }
    const ys = [o.y, o.y + o.height / 2, o.y + o.height];
    const mineY = [0, moving.height / 2, moving.height];
    for (const line of ys) {
      for (const offset of mineY) {
        const y = line - offset;
        const dist = Math.abs(y - moving.y);
        if (dist <= threshold && (!bestY || dist < bestY.dist)) bestY = { dist, y, line, other: o };
      }
    }
  }

  const out: Snap = { x: bestX ? bestX.x : moving.x, y: bestY ? bestY.y : moving.y };
  if (bestX) {
    out.vertical = {
      x: bestX.line,
      from: Math.min(out.y, bestX.other.y),
      to: Math.max(out.y + moving.height, bestX.other.y + bestX.other.height),
    };
  }
  if (bestY) {
    out.horizontal = {
      y: bestY.line,
      from: Math.min(out.x, bestY.other.x),
      to: Math.max(out.x + moving.width, bestY.other.x + bestY.other.width),
    };
  }
  return out;
}

/** A distance Figma prints while you drag: from the moving box to its nearest
 *  neighbour on one side, along the line they face each other on. */
export interface Gap {
  axis: "x" | "y";
  /** Board coordinates of the measuring line's two ends. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  distance: number;
}

/**
 * The nearest neighbour on each side of `moving` that it actually faces (their
 * spans overlap on the other axis), and how far away it is. Only what is
 * within `reach` is measured — a number to something across the board is
 * noise.
 */
export function measureGaps(moving: Rect, others: Rect[], reach: number): Gap[] {
  const out: Gap[] = [];
  const right = moving.x + moving.width;
  const bottom = moving.y + moving.height;
  let left: Gap | null = null, rightGap: Gap | null = null, up: Gap | null = null, down: Gap | null = null;
  for (const o of others) {
    if (o.id === moving.id) continue;
    const oRight = o.x + o.width;
    const oBottom = o.y + o.height;
    const spanTop = Math.max(moving.y, o.y);
    const spanBottom = Math.min(bottom, oBottom);
    if (spanTop < spanBottom) {
      const y = (spanTop + spanBottom) / 2;
      const dl = moving.x - oRight;
      if (dl >= 0 && dl <= reach && (!left || dl < left.distance)) left = { axis: "x", x1: oRight, y1: y, x2: moving.x, y2: y, distance: dl };
      const dr = o.x - right;
      if (dr >= 0 && dr <= reach && (!rightGap || dr < rightGap.distance)) rightGap = { axis: "x", x1: right, y1: y, x2: o.x, y2: y, distance: dr };
    }
    const spanLeft = Math.max(moving.x, o.x);
    const spanRight = Math.min(right, oRight);
    if (spanLeft < spanRight) {
      const x = (spanLeft + spanRight) / 2;
      const du = moving.y - oBottom;
      if (du >= 0 && du <= reach && (!up || du < up.distance)) up = { axis: "y", x1: x, y1: oBottom, x2: x, y2: moving.y, distance: du };
      const dd = o.y - bottom;
      if (dd >= 0 && dd <= reach && (!down || dd < down.distance)) down = { axis: "y", x1: x, y1: bottom, x2: x, y2: o.y, distance: dd };
    }
  }
  for (const g of [left, rightGap, up, down]) if (g && g.distance > 0) out.push(g);
  return out;
}

/** The frames a rectangle lies over — the ones a drop there would cover. */
export function overlapping(moving: Rect, others: Rect[]): string[] {
  return others
    .filter(
      (o) =>
        o.id !== moving.id &&
        moving.x < o.x + o.width &&
        o.x < moving.x + moving.width &&
        moving.y < o.y + o.height &&
        o.y < moving.y + moving.height,
    )
    .map((o) => o.id);
}
