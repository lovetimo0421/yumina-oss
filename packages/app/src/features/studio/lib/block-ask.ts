/**
 * "Write this one for me" — the assistant, scoped to a block.
 *
 * The assistant can already write entries, variables and behaviours; what it
 * could not do was start from a block. A creator staring at an empty
 * variables block had to open the chat and describe, in their own words, a
 * thing they had not learned the name of yet.
 *
 * The button fills the composer rather than sending: the creator sees the
 * exact request before it costs them anything, and can change it. One click
 * to a full sentence beats one click to a spent credit.
 */
export const STUDIO_ASK_EVENT = "yumina:studio-ask";

export type AskableBlockKind = "opening" | "lore" | "state" | "behavior" | "image" | "audio";

export interface StudioAskDetail {
  /** Pre-filled into the assistant's composer, focused, not sent. */
  prompt: string;
}

const KEY: Record<AskableBlockKind, string> = {
  opening: "openings",
  lore: "lore",
  state: "variables",
  behavior: "behaviors",
  image: "sceneImages",
  audio: "audio",
};

/**
 * The translation key for this block's request. Returned rather than
 * translated here: the caller already holds a namespace-bound `t`, and a
 * module that only knows about blocks has no business owning an i18n type.
 *
 * The sentences themselves say how many to write — an unbounded "write me
 * some lore" comes back as either one line or twenty, and neither is what
 * the creator meant.
 */
export function blockAskKey(kind: AskableBlockKind, empty: boolean): string {
  return `blueprint.ask.${KEY[kind]}${empty ? "Empty" : "More"}`;
}

/** Fill the assistant's composer with an already-translated request. */
export function askForBlock(prompt: string): void {
  const detail: StudioAskDetail = { prompt };
  window.dispatchEvent(new CustomEvent(STUDIO_ASK_EVENT, { detail }));
}
