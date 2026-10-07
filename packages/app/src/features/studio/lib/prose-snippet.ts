/**
 * The prose of an entry, for a canvas row to preview.
 *
 * Creators wrap entry content in XML-ish tags (`<personality>`, `<world_info>`)
 * because that is how the prompt wants it — but a BOARD row is for the person,
 * and a preview that spends its first forty characters on `<character_notes>`
 * says nothing about the card. Tags are display noise here, never data: the
 * stored content is untouched, and the inline editor still shows the raw text.
 *
 * The tag pattern is deliberately narrow — `</?word …>` with no stray angle
 * brackets inside — so prose like "HP < 10 就会 > 崩溃" survives intact.
 */
const TAG = /<\/?[A-Za-z][\w-]{0,30}(?:\s[^<>]{0,120})?\/?>/g;

export function proseSnippet(content: string, max = 260): string {
  const stripped = content
    .replace(TAG, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s*\n\s*\n[\s\n]*/g, "\n")
    .trim();
  return stripped.slice(0, max);
}
