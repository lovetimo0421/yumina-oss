/**
 * Card lists (Discover, Featured, profiles, batch) only show a few clamped
 * lines of a card's description; the card page fetches the full text from
 * GET /api/worlds/:id. Sending every card's whole description (up to
 * MAX_WORLD_DESCRIPTION) would make each feed page carry it.
 */
export const LIST_DESCRIPTION_CHARS = 800;

export function listDescription<T extends string | null | undefined>(text: T): T {
  if (typeof text !== "string" || text.length <= LIST_DESCRIPTION_CHARS) return text;
  let cut = text.slice(0, LIST_DESCRIPTION_CHARS);
  // Never end inside an image/link tag or a {{macro}}: half a tag renders as junk.
  cut = cut.replace(/!?\[[^\]\n]*(\]\([^)\n]*)?$/, "").replace(/\{\{[^}\n]*$/, "");
  // Never split a surrogate pair (emoji).
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…` as T;
}
