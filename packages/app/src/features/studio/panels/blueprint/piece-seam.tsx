/** Where a piece meets the one before it. A module's blocks butt together, so
 *  without this the seam is a plain line and the stack reads as one printed
 *  sheet. The knob is the neighbour's tab pushed into this piece: same fill,
 *  same hairline, drawn INSIDE the block (the shell clips its overflow), so
 *  two pieces read as clipped together rather than ruled apart. */
export function PieceSeams({ top, left }: { top?: boolean; left?: boolean }) {
  if (!top && !left) return null;
  return (
    <>
      {top && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 z-10 h-2.5 w-7 -translate-x-1/2 rounded-b-full border-x border-b border-white/[0.16] bg-[#181a24]"
        />
      )}
      {left && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-1/2 z-10 h-7 w-2.5 -translate-y-1/2 rounded-r-full border-y border-r border-white/[0.16] bg-[#181a24]"
        />
      )}
    </>
  );
}
