// A passage the player picked out of a reply to be drawn (they select it on
// screen). What they selected is the rendered text: markdown marks, tags,
// quotes and line breaks differ from the stored reply, so the two are matched
// on their letters and digits only. Kept apart from illustrate.ts so it
// carries no DB or GPU imports.

/** Longest passage a player can pick to be drawn. */
export const PASSAGE_MAX = 1200;
/** Longest picture description a player can write themselves. */
export const OWN_PROMPT_MAX = 1000;

const SIGNIFICANT_RE = /[\p{L}\p{N}]/u;

/** The text's letters and digits, lowercased, with where each came from in the text. */
function significant(text: string): { chars: string; from: number[]; to: number[] } {
  let chars = "";
  const from: number[] = [];
  const to: number[] = [];
  let index = 0;
  for (const ch of text) {
    if (SIGNIFICANT_RE.test(ch)) {
      const low = ch.toLowerCase();
      chars += low;
      for (let i = 0; i < low.length; i++) { from.push(index); to.push(index + ch.length); }
    }
    index += ch.length;
  }
  return { chars, from, to };
}

/** Collapses the spacing of what the player selected. */
export function tidyPassage(passage: string): string {
  return passage.replace(/\s+/g, " ").trim();
}

/** Where the passage sits in the text ([start, end) in the text's own
 *  indices), or null when the text doesn't contain it. */
export function passageIn(text: string, passage: string): { start: number; end: number } | null {
  const needle = significant(passage).chars;
  if (needle.length < 2) return null;
  const hay = significant(text);
  const found = hay.chars.indexOf(needle);
  if (found < 0) return null;
  return { start: hay.from[found]!, end: hay.to[found + needle.length - 1]! };
}
