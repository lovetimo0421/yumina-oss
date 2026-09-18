/* Tour persistence — kept in its own tiny module so editor-shell can check the
 * flag synchronously while the tour component itself is lazy-loaded. */

const TOUR_DONE_KEY = "yumina-editor-tour-v3";

// In-memory fallback: when localStorage reads work but writes throw (Safari
// private mode, quota-full profiles), the flag write is silently lost and the
// tour would re-pop on every mount forever. The module flag at least holds the
// dismissal for the lifetime of the page.
let doneThisSession = false;

export function isEditorTourDone(): boolean {
  if (doneThisSession) return true;
  try {
    return localStorage.getItem(TOUR_DONE_KEY) === "done";
  } catch {
    return true; // storage unavailable → never auto-open
  }
}

export function markEditorTourDone() {
  doneThisSession = true;
  try {
    localStorage.setItem(TOUR_DONE_KEY, "done");
  } catch {
    /* ignore — doneThisSession covers the session */
  }
}
