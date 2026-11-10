/**
 * Commit every debounced field's pending text now.
 *
 * Save paths (Ctrl+S, the Save button, save-and-leave) call this first: a
 * field holds up to ~300ms of typing locally, and a save that runs before the
 * timer carries the text minus its last few characters — then the timer
 * lands, the dirty dot comes back, and "saved" was not quite true. The fields
 * commit synchronously, so the store has the text by the time this returns.
 * Focus and the caret are left alone, unlike blurring the active element.
 *
 * Its own module so store-free fields (condition-editor) can listen too.
 */
export const FLUSH_PENDING_EDITS_EVENT = "yumina:editor-flush-pending-edits";
export function flushPendingEditorFields(): void {
  if (typeof window === "undefined") return;
  // The window's own Event: a test's DOM (jsdom) rejects Node's global one.
  const EventCtor = (window as unknown as { Event?: typeof Event }).Event ?? Event;
  window.dispatchEvent(new EventCtor(FLUSH_PENDING_EDITS_EVENT));
}
