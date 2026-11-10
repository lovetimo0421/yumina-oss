export type ViewMode = "desktop" | "mobile";

export const VIEW_MODE_STORAGE_KEY = "yumina.studio.playtest.viewMode";
/** A phone keeps its own choice: a laptop's "desktop" must not follow the
 *  creator onto a phone, where it is the wide card scaled to unreadable. */
export const PHONE_VIEW_MODE_STORAGE_KEY = "yumina.studio.playtest.viewMode.phone";
/** Same breakpoint that swaps the Studio for its phone shell. */
const PHONE_QUERY = "(max-width: 767px)";

/** The preview a playtest opens in: what was last picked on this kind of
 *  screen, else the screen's own shape. A playtest fills the whole frame,
 *  as the card does when it is played, so a laptop plays it wide. */
export function readStoredViewMode(phone: boolean): ViewMode {
  const fallback: ViewMode = phone ? "mobile" : "desktop";
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(phone ? PHONE_VIEW_MODE_STORAGE_KEY : VIEW_MODE_STORAGE_KEY);
    return v === "mobile" || v === "desktop" ? v : fallback;
  } catch {
    return fallback;
  }
}

export function matchesPhone(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}

export function subscribePhone(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
