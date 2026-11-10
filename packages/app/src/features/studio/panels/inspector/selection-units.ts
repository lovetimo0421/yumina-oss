import { isOnCanvas, presenceOf } from "@yumina/engine";
import type { UiElement, UiPage } from "@yumina/engine";

/** Chat, transcript and composer are the card, never "a part" to pick. */
const loadBearing = (el: UiElement) => el.type === "chat" || el.type === "messages" || el.type === "composer";

/**
 * Ctrl+A: one representative per part (a meter's three elements are one part)
 * for every part on the page — including parts that are drawn only on the
 * OTHER canvas. The rule, stated once: a selection may hold parts this canvas
 * does not draw; deleting, copying and cutting take them along, while
 * aligning, distributing and nudging only move what is drawn here (they have
 * no box on this canvas to move).
 *
 * The parts drawn here come first, so the lead — the one whose handles show —
 * is always something visible.
 */
export function selectAllOnPage(page: UiPage, canvas: "phone" | "desktop"): string[] {
  const seen = new Set<string>();
  const here: string[] = [];
  const elsewhere: string[] = [];
  for (const el of page.elements) {
    if (loadBearing(el)) continue;
    const key = el.group ? `g:${el.group}` : `e:${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const members = el.group ? page.elements.filter((e) => e.group === el.group) : [el];
    (members.some((m) => isOnCanvas(m, canvas)) ? here : elsewhere).push(el.id);
  }
  return [...here, ...elsewhere];
}

/** How many of these parts (groups counted once) are not drawn on `canvas`. */
export function offCanvasCount(page: UiPage | undefined, ids: readonly string[], canvas: "phone" | "desktop"): number {
  if (!page) return 0;
  const wanted = new Set(ids);
  const units = new Map<string, UiElement[]>();
  for (const el of page.elements) {
    if (!wanted.has(el.id)) continue;
    const key = el.group ? `g:${el.group}` : `e:${el.id}`;
    units.set(key, [...(units.get(key) ?? []), el]);
  }
  let n = 0;
  for (const members of units.values()) if (!members.some((m) => isOnCanvas(m, canvas))) n++;
  return n;
}

/** The layers-list badge for a part on one canvas only, as an i18n key. */
export function presenceBadgeKey(members: readonly UiElement[]): string | null {
  const phone = members.some((m) => presenceOf(m) === "phone" || presenceOf(m) === "both");
  const desktop = members.some((m) => presenceOf(m) === "desktop" || presenceOf(m) === "both");
  if (phone && !desktop) return "studio.canvasEdit.onlyPhone";
  if (desktop && !phone) return "studio.canvasEdit.onlyDesktop";
  return null;
}
