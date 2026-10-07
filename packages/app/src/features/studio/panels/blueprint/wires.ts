/**
 * Where a wire lands when an object has more than one home.
 *
 * The card's own entries, variables and behaviours are drawn inside every
 * module — the same object, once per frame. A wire that touches one of them
 * therefore has several candidate blocks to anchor on, and the choice has to
 * be the one a creator would make reading the board:
 *
 *   · the other end lives in one frame → land in THAT frame's copy, so the
 *     wire never leaves the module it is about;
 *   · both ends are shared → the relation holds in every module, so it is
 *     drawn in every frame the two have in common, once each;
 *   · nothing in common (the interface in the strip reading a shared
 *     variable) → the first copy of each, and the wire crosses.
 *
 * A gate (`module:X`) counts as living in frame X, which is what makes "the
 * shared variable that opens module B" wire from B's own copy of it.
 */

export interface WireEnd {
  host: string;
  /** Whether the object has a row (and so a handle) of its own on that
   *  block; a folded row re-anchors onto the block itself. */
  shown: boolean;
  /** The frame the host sits in. Absent for the card's strip. */
  ownerId?: string;
}

export interface WirePair {
  from: WireEnd;
  to: WireEnd;
  /** The frame the pair is drawn in, when both ends share one. */
  frame?: string;
}

const frameKey = (end: WireEnd) => end.ownerId ?? "";

export function wirePairs(from: WireEnd[] | undefined, to: WireEnd[] | undefined): WirePair[] {
  if (!from?.length || !to?.length) return [];
  const toByFrame = new Map(to.map((end) => [frameKey(end), end]));
  const common: WirePair[] = [];
  for (const f of from) {
    const partner = toByFrame.get(frameKey(f));
    if (partner) common.push({ from: f, to: partner, ...(f.ownerId ? { frame: f.ownerId } : {}) });
  }
  if (common.length > 0) return common;
  return [{ from: from[0]!, to: to[0]! }];
}
