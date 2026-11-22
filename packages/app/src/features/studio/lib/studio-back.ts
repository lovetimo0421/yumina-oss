/**
 * The editor has one way back: the ← in the top-left corner. It goes back one
 * step. Whatever is open over the board (a full list, the player's screen, a
 * playtest) hears this event first and closes itself by cancelling it; only
 * when nobody does does the arrow leave the card.
 */
export const STUDIO_BACK_EVENT = "yumina:studio-back";

/** History is one entry, in ⋮: it opens 版本历史 (owned by the stage), and
 *  that dialog links on to the assistant's own change log (owned by the
 *  shell). */
export const STUDIO_OPEN_VERSIONS_EVENT = "yumina:studio-open-versions";
export const STUDIO_OPEN_AI_CHANGES_EVENT = "yumina:studio-open-ai-changes";

/** True when something closed; false means there was nothing left to close. */
export function stepBack(): boolean {
  return !window.dispatchEvent(new Event(STUDIO_BACK_EVENT, { cancelable: true }));
}
