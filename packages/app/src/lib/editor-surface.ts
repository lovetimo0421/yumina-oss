/**
 * Which editing surface a creator sees: the visual blueprint canvas, or the
 * classic section-by-section editor.
 *
 * These used to read as two separate features — an "advanced editor" with a
 * gold "Blueprint · experimental" button inside it — so people met the canvas
 * by accident or never at all. There is one switch now, labelled 画布, in
 * both surfaces, and opening a card lands on the visual one.
 *
 * The remembered value is where the creator *left off*, not a setting they
 * ever opened a menu to change: flipping the switch on records "visual" and
 * every later card opens the canvas until they flip it back. While the canvas
 * is a beta, a creator who has never flipped it lands on the classic editor,
 * where the pill introduces the canvas once. Phones are excluded
 * — the canvas wants room a 390px screen does not have — so a phone always
 * lands on the classic editor without that counting as a choice.
 *
 * localStorage throws in private windows and when site data is blocked, so
 * every accessor swallows its own failure: a browser that refuses to remember
 * must still be able to open a card.
 */

export type EditorSurface = "visual" | "classic";

const SURFACE_KEY = "yumina-editor-surface";

const asSurface = (value: unknown): EditorSurface | null =>
  value === "visual" || value === "classic" ? value : null;

export function getEditorSurface(): EditorSurface | null {
  try {
    return asSurface(localStorage.getItem(SURFACE_KEY));
  } catch {
    return null;
  }
}

export function saveEditorSurface(surface: EditorSurface): void {
  try {
    localStorage.setItem(SURFACE_KEY, surface);
  } catch {
    /* ignore */
  }
}

export interface SurfaceDecision {
  /** Simple mode is its own editor and is never redirected. */
  mode: "simple" | "advanced";
  /** What `getEditorSurface()` returned — null when they have never chosen. */
  last: EditorSurface | null;
  /** `BLUEPRINT_ACCESS` — the canvas can be closed server-side. */
  allowed: boolean;
  /** A signed-out draft cannot open Studio: that route demands a session. */
  guest: boolean;
}

/** Whether opening `/app/worlds/:id/edit` should land on the canvas instead. */
export function shouldOpenVisual({ mode, last, allowed, guest }: SurfaceDecision): boolean {
  if (mode !== "advanced") return false;
  // A phone goes to Studio too: under 768px it is the phone studio (开场白 /
  // 设定 / 玩家界面 / 测试), not the board. Sending phones to the classic
  // editor put a newcomer who picked 画布 in the most crowded screen there is.
  if (!allowed || guest) return false;
  // Beta: the canvas is opt-in. Never chosen lands on the classic editor.
  return last === "visual";
}

const SCREEN_FIRST_KEY = "yumina-screen-first";

/**
 * Prototype: the Studio opens on the player's screen instead of the board,
 * the opening is edited where it shows, setting sits under the screen like
 * speaker notes, and a playtest takes the whole frame. Off unless turned on
 * with `?screen=1` (and back off with `?screen=0`).
 */
export function isScreenFirst(): boolean {
  try {
    const asked = new URLSearchParams(window.location.search).get("screen");
    if (asked === "1") localStorage.setItem(SCREEN_FIRST_KEY, "on");
    else if (asked === "0") localStorage.removeItem(SCREEN_FIRST_KEY);
    return localStorage.getItem(SCREEN_FIRST_KEY) === "on";
  } catch {
    return false;
  }
}
