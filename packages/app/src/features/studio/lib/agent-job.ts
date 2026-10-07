/**
 * Where on the canvas the assistant is working: the block or row it is
 * changing glows, with a short label. Driven by the run's tool calls
 * (see agent-presence.ts), drawn by ai-presence.tsx.
 */

export interface AiPresence {
  /** CSS selector of the element to mark; a list is tried in order (the
   *  exact row first, then its block). */
  target: string | string[];
  label: string;
}

export const AI_PRESENCE_EVENT = "yumina:studio-ai-presence";
/** The block the assistant just started changing, by canvas node id: the
 *  board brings it into view (a pan) unless the creator is moving it. */
export const AI_FOLLOW_EVENT = "yumina:studio-ai-follow";

export function showAiPresence(presence: AiPresence | null) {
  window.dispatchEvent(new CustomEvent(AI_PRESENCE_EVENT, { detail: presence }));
}
