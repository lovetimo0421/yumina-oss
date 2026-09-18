// ── Top-edge reveal gate ─────────────────────────────────────────────
// Pure decisions for the play-page chrome reveal (back-to-library + fullscreen
// floating bar). Shared by the sandbox's top-edge reporter
// (sandbox/component-host.tsx); kept DOM-free so it can be unit tested.

/** Band (from the viewport top, px) inside which a touch TAP can reveal the
 *  chrome. Touch keeps the wide band: taps are discrete and deliberate, and a
 *  phone has no hover, F11 or ESC to fall back on. */
export const TOP_EDGE_PX = 60;

/**
 * The only strip that reveals the chrome for a MOUSE: slam the cursor into the
 * screen edge to summon it. The old design also revealed on a 300ms dwell
 * anywhere in the top 60px band, but readers who park the cursor where they
 * read (@burlingk) kept summoning the bar over the very text they were
 * reading, with no way to turn it off. Windowed mode is a choice — the bar
 * must not badger. Desktop alternatives remain: F11 toggles, ESC exits, and
 * dropping out of immersive mode re-reveals the bar once.
 */
export const TOP_EDGE_ALWAYS_PX = 8;

export type TopEdgeSampleDecision = "fire" | "cancel";

/**
 * Classify one mousemove sample at viewport-y `y`.
 * - "fire"   — outermost strip (deliberate edge slam): reveal immediately,
 *              even over interactive controls.
 * - "cancel" — anywhere else. Mere presence in the wider band never reveals.
 */
export function classifyTopEdgeSample(y: number): TopEdgeSampleDecision {
  return y <= TOP_EDGE_ALWAYS_PX ? "fire" : "cancel";
}

/**
 * Should a discrete touch tap at viewport-y `y` reveal the play chrome?
 * In-band taps reveal unless they land on an interactive control (revealing
 * would slide the bar in on top of it and steal the follow-up tap); the
 * outermost strip always reveals.
 */
export function shouldRevealTopEdge(y: number, overInteractiveControl: boolean): boolean {
  if (y <= TOP_EDGE_ALWAYS_PX) return true;
  if (y > TOP_EDGE_PX) return false;
  return !overInteractiveControl;
}
