export interface TourBox { left: number; top: number; width: number; height: number }
const right = (box: TourBox) => box.left + box.width;
const bottom = (box: TourBox) => box.top + box.height;

/** Uses visualViewport on phones. Target and card share a body portal, so
 * sidebar offsets and transformed editor containers cannot move the guide. */
export function placeTourCard(target: TourBox | null, viewport: TourBox, size: { width: number; height: number }): TourBox {
  return placeTourCardWithSide(target, viewport, size).box;
}

/** The same placement, and which side it chose (0 right, 1 left, 2 under,
 *  3 over). A card that follows a moving target keeps its side while that
 *  side still clears the target — the best side by a pixel flips to the
 *  other one mid-glide otherwise, and the card leaps across the block. */
export function placeTourCardWithSide(target: TourBox | null, viewport: TourBox, size: { width: number; height: number }, prefer?: number): { box: TourBox; side: number } {
  const margin = 12, gap = 16;
  const width = Math.min(size.width, viewport.width - margin * 2);
  const height = Math.min(size.height, viewport.height - margin * 2);
  const minX = viewport.left + margin, minY = viewport.top + margin;
  const maxX = Math.max(minX, right(viewport) - width - margin);
  const maxY = Math.max(minY, bottom(viewport) - height - margin);
  const clamp = (box: TourBox): TourBox => ({ ...box, left: Math.max(minX, Math.min(maxX, box.left)), top: Math.max(minY, Math.min(maxY, box.top)) });
  if (!target) return { box: clamp({ left: viewport.left + (viewport.width - width) / 2, top: maxY, width, height }), side: -1 };
  // Beside the target, level with its top — or with its middle when the
  // target is taller than the card, so a card beside a whole column does
  // not sit up in the toolbar. Under / over it, centred: a card under a
  // wide shelf sits in the middle of it, clear of the zoom buttons in one
  // corner of the canvas and the minimap in the other.
  const level = target.top + Math.max(0, (target.height - height) / 2);
  const centred = target.left + (target.width - width) / 2;
  const positions = [
    { left: right(target) + gap, top: level },
    { left: target.left - width - gap, top: level },
    { left: centred, top: bottom(target) + gap },
    { left: centred, top: target.top - height - gap },
  ].map(position => clamp({ ...position, width, height }));
  const overlap = (box: TourBox) => Math.max(0, Math.min(right(box), right(target)) - Math.max(box.left, target.left)) *
    Math.max(0, Math.min(bottom(box), bottom(target)) - Math.max(box.top, target.top));
  if (prefer !== undefined && positions[prefer] && overlap(positions[prefer]) === 0) return { box: positions[prefer], side: prefer };
  let side = 0;
  for (let i = 1; i < positions.length; i++) if (overlap(positions[i]!) < overlap(positions[side]!)) side = i;
  return { box: positions[side]!, side };
}

export function clipTourTarget(box: TourBox, viewport: TourBox): TourBox | null {
  const left = Math.max(viewport.left + 4, box.left - 6);
  const top = Math.max(viewport.top + 4, box.top - 6);
  const width = Math.min(right(viewport) - 4, right(box) + 6) - left;
  const height = Math.min(bottom(viewport) - 4, bottom(box) + 6) - top;
  return width > 4 && height > 4 ? { left, top, width, height } : null;
}
