/**
 * Hand-offs into Studio that have to survive a route change.
 *
 * A card started from an interface starter exists to have its screen edited,
 * so it opens ON the interface editor rather than on the canvas board with a
 * welcome tour over it and the interface a thumbnail in one block. The page
 * that creates the card cannot reach into Studio (it is not mounted yet), so
 * it leaves two notes in sessionStorage: which panel to open, and that the
 * welcome tour should not cover it. A card started from a template leaves only
 * the second note: it opens on the board it was built to fill.
 */

/** Read by the desktop stage and the phone shell: open this panel on mount. */
export const STUDIO_OPEN_PANEL_KEY = "yumina-studio-open-panel";
/** Read once by the tour: do not greet this visit. The tour then counts its
 *  welcome as seen — a card someone chose to start from is not the place for
 *  it, and a greeting held for "the next visit" turned up on a mode switch or
 *  a remount a minute later, over the same card. */
export const STUDIO_QUIET_TOUR_KEY = "yumina-studio-quiet-tour";

const storage = (): Storage | null => {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
};

/** Open Studio on the player-interface editor, tour held back. */
export function requestInterfaceEditor(): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STUDIO_OPEN_PANEL_KEY, "frontend");
    s.setItem(STUDIO_QUIET_TOUR_KEY, "1");
  } catch { /* private mode: the card still opens, just on the board */ }
}

/** Open Studio without the welcome over the card (a template's first visit). */
export function requestQuietTour(): void {
  const s = storage();
  if (!s) return;
  try { s.setItem(STUDIO_QUIET_TOUR_KEY, "1"); } catch { /* private mode: the welcome may show once */ }
}

/**
 * Removed on the next tick, not at once: React (StrictMode, and a shell that
 * re-reads its layout when the card id arrives) runs a mount twice in a row,
 * and the second run must see the same note the first one did.
 */
function forgetSoon(s: Storage, key: string): void {
  setTimeout(() => { try { s.removeItem(key); } catch { /* ignore */ } }, 0);
}

/** Whether this visit asked for quiet, leaving the note in place. Safe to
 *  call while rendering; take the note with `consumeQuietTour` once the
 *  component that read it has committed. */
export function quietTourRequested(): boolean {
  const s = storage();
  if (!s) return false;
  try { return s.getItem(STUDIO_QUIET_TOUR_KEY) === "1"; } catch { return false; }
}

/** True for the visit that asked for quiet. */
export function consumeQuietTour(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    if (s.getItem(STUDIO_QUIET_TOUR_KEY) !== "1") return false;
    forgetSoon(s, STUDIO_QUIET_TOUR_KEY);
    return true;
  } catch { return false; }
}

/** Take the pending "open this panel" note if it names one of `accepted`. */
export function takeRequestedPanel(accepted: (panel: string) => boolean): string | null {
  const s = storage();
  if (!s) return null;
  try {
    const wanted = s.getItem(STUDIO_OPEN_PANEL_KEY);
    if (!wanted || !accepted(wanted)) return null;
    forgetSoon(s, STUDIO_OPEN_PANEL_KEY);
    return wanted;
  } catch { return null; }
}

