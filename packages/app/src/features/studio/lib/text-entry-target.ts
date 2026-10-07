/**
 * Whether a key event landed somewhere the creator is typing.
 *
 * Shared by every Studio shortcut that owns a key a text field also owns —
 * Ctrl+Z most of all. Inside the AI composer or a search box that key means
 * "undo my typing", and the editor's global undo taking it instead silently
 * reverted a card edit the creator never meant to touch.
 */
export function isTextEntryTarget(target: EventTarget | null | undefined): boolean {
  return typeof Element !== "undefined" && target instanceof Element && Boolean(target.closest(
    'input, textarea, select, [role="textbox"], [role="combobox"], [role="listbox"], [contenteditable]:not([contenteditable="false"]), .nokey',
  ));
}

const TYPING_FIELDS =
  'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="color"]):not([type="file"]), [role="textbox"], [contenteditable]:not([contenteditable="false"]), .nokey';

/**
 * Whether Ctrl+Z belongs to the field rather than the card: the creator is
 * typing into something that keeps its own text (the AI composer, a search
 * box, a local draft). A select or a checkbox has no undo of its own, so it
 * leaves the card's undo working; and the editor's debounced fields opt back
 * in with `data-editor-undo`, because they resync from the store on undo.
 */
export function ownsTypingUndo(target: EventTarget | null | undefined): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(TYPING_FIELDS)) && !target.closest("[data-editor-undo]");
}
