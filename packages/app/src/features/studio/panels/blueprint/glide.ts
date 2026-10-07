/**
 * How the camera moves. One place, so every move on the board has the same
 * feel: a nudge that keeps a row in view, a fit, a jump to a search hit, the
 * zoom buttons.
 *
 * They used to be 160–250ms each, picked one call site at a time. Short
 * enough that a move across half the screen read as a cut — the eye lost the
 * thing it was looking at and had to find it again. A glide is long enough to
 * follow and eases out, so it starts at once (it answers the click) and
 * settles gently (the eye lands with it).
 */
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Someone who asked their system for less motion gets cuts, not glides:
 *  a moving, zooming board is exactly what that setting is for. */
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function glide(ms: number): { duration: number; ease?: (t: number) => number; interpolate?: "linear" } {
  if (!ms || ms <= 0 || reducedMotion()) return { duration: 0 };
  const duration = Math.round(Math.min(560, Math.max(280, ms * 1.5)));
  // Long moves (a fit, a jump) ease in as well, so they do not lurch.
  // Straight, not the library's "fly": that pulls the board out and back in
  // across any long pan (85% → 58% → 85% on a move between two blocks), a
  // zoom nobody asked for and the move people called dizzying.
  return { duration, ease: duration >= 420 ? easeInOutCubic : easeOutCubic, interpolate: "linear" };
}
