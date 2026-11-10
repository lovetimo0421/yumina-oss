/**
 * Put a request in the assistant's composer from elsewhere in the Studio (the
 * language-variant banner, the phone shell). It fills the composer rather than
 * sending: the creator sees the exact request before it costs them anything,
 * and can change it.
 *
 * Blocks on the board used to have a ✦ that did this; it was taken off on
 * 9/28 for having no label, and its leftover wiring went on 10/13.
 */
export const STUDIO_ASK_EVENT = "yumina:studio-ask";

export interface StudioAskDetail {
  /** Pre-filled into the assistant's composer, focused, not sent. */
  prompt: string;
  /** Diagnostics append to existing writing and survive mobile event replay. */
  append?: boolean;
  requestId?: string;
  worldId?: string;
}
