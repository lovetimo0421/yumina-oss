import { UI_CANVAS_W, UI_DESKTOP_W } from "./types.js";
import type { UiDoc, UiElement } from "./types.js";

/**
 * The play menu's shape, shared by the templates that add to it and the page
 * removal that takes from it.
 *
 * Play pages (a bag, a map, a phone) are reached from one menu page, one row
 * each. Removing a play page must take its row with it — a 「地图」 button
 * that goes nowhere is worse than none — and close the gap it leaves, so the
 * rows are laid out here, by position in the list, rather than remembered.
 */

export const PLAY_MENU_ID = "play-menu";
export const MENU_ITEM_SUFFIX = "-menuitem";
export const MENU_OPENER_ID = `${PLAY_MENU_ID}-opener`;

const PAD = 24;
const COL = UI_CANVAS_W - PAD * 2;
const PLAY_TOP = 176;
const DESK_TOP = 146;

/** Where the k-th row of the menu sits, on the phone and on the wide canvas. */
export function menuItemBox(k: number): { x: number; y: number; w: number; h: number; desktop: { x: number; y: number; w: number; h: number } } {
  const bw = (COL - 12) / 2;
  // The wide canvas keeps the same centred column as every template page.
  const col = 520;
  const left = (UI_DESKTOP_W - col) / 2;
  const dw = (col - 12) / 2;
  return {
    x: PAD + (k % 2) * (bw + 12), y: PLAY_TOP + Math.floor(k / 2) * 76, w: bw, h: 64,
    desktop: { x: left + (k % 2) * (dw + 12), y: DESK_TOP + Math.floor(k / 2) * 76, w: dw, h: 64 },
  };
}

const actionsOf = (el: UiElement) => (el.type === "button" && Array.isArray(el.actions) ? el.actions : null);

/**
 * After a page is removed: menu rows (and the menu button) left with nothing
 * to do go, the remaining rows close up, and a menu with no rows left goes
 * too, taking its button on the conversation with it.
 */
export function tidyPlayMenu(doc: UiDoc): UiDoc {
  const menu = (doc.pages ?? []).find((p) => p.id === PLAY_MENU_ID);
  if (!menu) return doc;
  const dead = (el: UiElement) => {
    const actions = actionsOf(el);
    return actions !== null && actions.length === 0 && (el.id.endsWith(MENU_ITEM_SUFFIX) || el.id === MENU_OPENER_ID);
  };
  let k = 0;
  const rows = menu.elements
    .filter((el) => !dead(el))
    .map((el) => {
      if (!el.id.endsWith(MENU_ITEM_SUFFIX)) return el;
      const at = menuItemBox(k++);
      return { ...el, x: at.x, y: at.y, w: at.w, h: at.h, desktop: at.desktop };
    });
  if (k === 0) {
    // Nothing left to open: the menu and its button go.
    const pages = doc.pages
      .filter((p) => p.id !== PLAY_MENU_ID)
      .map((p) => ({ ...p, elements: p.elements.filter((el) => el.id !== MENU_OPENER_ID) }));
    return { ...doc, pages, entryPageId: doc.entryPageId === PLAY_MENU_ID ? pages[0]!.id : doc.entryPageId };
  }
  const pages = doc.pages.map((p) => {
    if (p.id === PLAY_MENU_ID) return { ...p, elements: rows };
    return p.elements.some(dead) ? { ...p, elements: p.elements.filter((el) => !dead(el)) } : p;
  });
  return { ...doc, pages };
}
