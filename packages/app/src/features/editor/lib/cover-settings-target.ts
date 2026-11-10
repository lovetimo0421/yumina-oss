export type CoverSettingsTarget = "portrait" | "landscape";

declare module "@tanstack/react-router" {
  interface HistoryState { coverSettingsVisit?: string }
}

let nextVisit = 0;
export function coverSettingsNavigation(worldId: string, cover: CoverSettingsTarget) {
  return {
    to: "/app/worlds/$worldId/edit" as const,
    params: { worldId },
    search: { cover },
    // Repeated clicks on the same URL still need to reveal and focus the field.
    state: { coverSettingsVisit: `${Date.now()}:${++nextVisit}` },
  };
}

/** Asked of an open canvas: show this card's cover settings where it is,
 *  instead of sending the creator to the classic editor for one field. */
export const STUDIO_FOCUS_COVER_EVENT = "yumina:studio-focus-cover";
export interface StudioFocusCoverDetail { worldId: string; cover: CoverSettingsTarget }

/** True when a canvas open on this card took the request. Nothing listens on
 *  the classic editor or the phone studio, and the caller goes to /edit. */
export function focusCoverInStudio(worldId: string, cover: CoverSettingsTarget): boolean {
  const event = new CustomEvent<StudioFocusCoverDetail>(STUDIO_FOCUS_COVER_EVENT, { detail: { worldId, cover }, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Only cover destinations are accepted from a publish shortcut or shared URL. */
export function coverSettingsSearch(search: Record<string, unknown>): { cover?: CoverSettingsTarget } {
  return search.cover === "portrait" || search.cover === "landscape" ? { cover: search.cover } : {};
}

/** Reveal the existing upload controls without opening a file picker or editing the draft. */
export function focusCoverSettings(root: HTMLElement, target: CoverSettingsTarget): () => void {
  const section = root.querySelector<HTMLElement>(`[data-cover-shape="${target}"]`);
  if (!section) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    section.scrollIntoView({ block: "center", behavior: "instant" });
    section.dataset.coverFocus = "true";
    section.querySelector<HTMLButtonElement>("[data-cover-upload]:not(:disabled)")?.focus({ preventScroll: true });
    timer = setTimeout(() => { delete section.dataset.coverFocus; }, 3000);
  });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    delete section.dataset.coverFocus;
  };
}
