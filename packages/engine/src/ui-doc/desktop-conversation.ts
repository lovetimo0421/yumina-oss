import { UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W } from "./types.js";
import type { UiElement, UiPage } from "./types.js";

/** How wide the conversation reads on the wide canvas when a page only ever
 *  placed it on the phone one. */
export const DESKTOP_CHAT_COLUMN_W = 720;

const CONVERSATION = new Set(["messages", "composer", "chat"]);
/** Parts that stand in rows above the conversation: a value line, a meter, a
 *  list. They go into its column with it. */
const ROW_PARTS = new Set(["meter", "text", "list"]);

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * A wide box that is only the phone's box copied over: the same left edge and
 * width, inside the phone's width. Editing used to write these when a part had
 * no wide box yet (it read the phone box as the wide one and saved it back),
 * and they draw the conversation as a strip down the left of a desktop window
 * with the input across it.
 */
function copiedFromPhone(el: UiElement): boolean {
  const d = el.desktop;
  return !!d && d.x === num(el.x) && d.w === num(el.w) && num(el.x) + num(el.w) <= UI_CANVAS_W;
}

const placedOnPhoneOnly = (el: UiElement): boolean => el.desktop === undefined || copiedFromPhone(el);

/**
 * A conversation placed only on the phone canvas, drawn on the wide one.
 *
 * Without a wide box a part keeps its phone box on the 1024×640 canvas, and the
 * phone box of a chat reaches down to 812: the input sat below the bottom of
 * every desktop window. The transcript, input and chat keep their order and
 * proportions in a centred column instead, and the rows above them (the values
 * a creator put on screen) go into the same column. A page that gave its
 * conversation a wide place keeps every part where it was put.
 */
export function withDesktopConversation(page: UiPage): UiPage {
  const elements = page.elements ?? [];
  const phoneH = Math.max(1, num(page.height, 812));
  const deskH = Math.max(1, num(page.desktopHeight, UI_DESKTOP_H));
  const sy = deskH / phoneH;
  const sx = DESKTOP_CHAT_COLUMN_W / UI_CANVAS_W;
  const left = (UI_DESKTOP_W - DESKTOP_CHAT_COLUMN_W) / 2;
  const transcriptInColumn = elements.some((el) => (el.type === "messages" || el.type === "chat") && placedOnPhoneOnly(el));
  let changed = false;
  const next = elements.map((el) => {
    if (!placedOnPhoneOnly(el)) return el;
    if (CONVERSATION.has(el.type)) {
      changed = true;
      const y = Math.round(num(el.y) * sy);
      const h = Math.max(1, Math.min(deskH - y, Math.round(num(el.h) * (el.type === "composer" ? Math.max(sy, 0.9) : sy))));
      const top = el.type === "composer" ? Math.max(0, Math.min(y, deskH - h)) : y;
      return { ...el, desktop: { x: Math.round(left + num(el.x) * sx), y: top, w: Math.round(num(el.w) * sx), h } };
    }
    if (transcriptInColumn && ROW_PARTS.has(el.type)) {
      changed = true;
      return { ...el, desktop: { x: Math.round(left + num(el.x) * sx), y: Math.round(num(el.y) * sy), w: Math.round(num(el.w) * sx), h: num(el.h) } };
    }
    return el;
  });
  return changed ? { ...page, elements: next } : page;
}
