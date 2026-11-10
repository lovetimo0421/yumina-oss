/* Tour persistence — kept in its own tiny module so editor-shell can check the
 * flag synchronously while the tour component itself is lazy-loaded. */

/** Which guided tour: the advanced editor (desktop + mobile step lists) or the
 *  simple (quick-create) editor. Each has its own done-flag so finishing one
 *  never suppresses the other — a creator who learned the simple editor still
 *  gets Mushie the first time they open the advanced one. */
export type EditorTourVariant = "advanced" | "simple";

const TOUR_DONE_KEYS: Record<EditorTourVariant, string> = {
  advanced: "yumina-editor-tour-v3",
  simple: "yumina-editor-tour-simple-v1",
};

// In-memory fallback: when localStorage reads work but writes throw (Safari
// private mode, quota-full profiles), the flag write is silently lost and the
// tour would re-pop on every mount forever. The module flag at least holds the
// dismissal for the lifetime of the page.
const doneThisSession: Record<EditorTourVariant, boolean> = { advanced: false, simple: false };

export function isEditorTourDone(variant: EditorTourVariant = "advanced"): boolean {
  if (doneThisSession[variant]) return true;
  try {
    return localStorage.getItem(TOUR_DONE_KEYS[variant]) === "done";
  } catch {
    return true; // storage unavailable → never auto-open
  }
}

export function markEditorTourDone(variant: EditorTourVariant = "advanced") {
  doneThisSession[variant] = true;
  try {
    localStorage.setItem(TOUR_DONE_KEYS[variant], "done");
  } catch {
    /* ignore — doneThisSession covers the session */
  }
}
