/**
 * Bookkeeping wrappers some models put around (or next to) their state
 * directives. None of it is story, so none of it may reach the player:
 *
 *   <rationale>Harry's scarf is a kindness … so her Guard drops …</rationale>
 *   <directive>\n[mood: set "calm"]\n</directive>        (often empty)
 *   [state-changes]\n[hp: -5]\n[/state-changes]           (often empty)
 *
 * observed in prod play from Claude Haiku 5.5 (`<rationale>`, `<directive>`)
 * and GLM 5.2 (`[state-changes]`). A rationale is an explanation of changes,
 * never a command, so it is dropped whole, including any `[x: y]` it quotes
 * (applying those would double-apply the real directives). The directives
 * inside a `<directive>` / `[state-changes]` block ARE the writes, so those
 * blocks are only unwrapped for the directive scanners; any prose left inside
 * them is dropped afterwards.
 *
 * Exact tag names only: `<directive-format>`, `<inner>`, `<options>`,
 * `[image: …]` and other tags cards use are not touched.
 */

/** A whole `<rationale>` block. Unclosed (a reply cut off mid-rationale) it
 *  runs to the end of the text. */
export const RATIONALE_BLOCK_RE = /<rationale(?:\s[^>]*)?>[\s\S]*?(?:<\/rationale\s*>|$)/gi;

/** A closed `<directive>…</directive>` block; group 1 is its body. */
export const DIRECTIVE_BLOCK_RE = /<directive(?:\s[^>]*)?>([\s\S]*?)<\/directive\s*>/gi;

/** A closed state-changes block; group 1 is its body. GLM mixes delimiters,
 *  so `[`/`<` open it and `[/`/`</` close it in any combination:
 *  `[state-changes]…[/state-changes]`, `[state-changes]…</state-changes>`. */
export const STATE_CHANGES_BLOCK_RE = /[[<]\s*state[-_ ]changes\s*[\]>]([\s\S]*?)[[<]\s*\/\s*state[-_ ]changes\s*[\]>]/gi;

/** A lone opening or closing wrapper tag left after the blocks above. */
export const STRAY_BOOKKEEPING_TAG_RE = /<\/?(?:rationale|directive)(?:\s[^>]*)?>|[[<]\s*\/?\s*state[-_ ]changes\s*[\]>]/gi;

/** Marks the body of an unwrapped block so the parser can drop what the
 *  directive scanners leave of it. Control characters never in model prose. */
export const BOOKKEEPING_OPEN = "\x01";
export const BOOKKEEPING_CLOSE = "\x02";
const MARKED_BODY_RE = /\x01[\s\S]*?\x02/g;
const LEFTOVER_MARK_RE = /[\x01\x02]/g;

/** Step 1 (before the directive scanners): drop rationales, mark the bodies
 *  of directive / state-changes blocks, drop stray wrapper tags. */
export function unwrapBookkeepingBlocks(text: string): string {
  if (!/rationale|directive|state[-_ ]changes/i.test(text)) return text;
  return text
    .replace(RATIONALE_BLOCK_RE, "")
    .replace(DIRECTIVE_BLOCK_RE, (_m, body: string) => `${BOOKKEEPING_OPEN}${body}${BOOKKEEPING_CLOSE}`)
    .replace(STATE_CHANGES_BLOCK_RE, (_m, body: string) => `${BOOKKEEPING_OPEN}${body}${BOOKKEEPING_CLOSE}`)
    .replace(STRAY_BOOKKEEPING_TAG_RE, "");
}

/** Step 2 (after the directive scanners): drop whatever is left of the marked
 *  bodies (blank lines, prose a model put inside the wrapper). */
export function dropMarkedBookkeeping(text: string): string {
  if (!text.includes(BOOKKEEPING_OPEN) && !text.includes(BOOKKEEPING_CLOSE)) return text;
  return text.replace(MARKED_BODY_RE, "").replace(LEFTOVER_MARK_RE, "");
}

/** While streaming: a wrapper tag cut off at the end of the text so far
 *  (`<rati`, `</direct`, `[state-ch`). Held back for the next chunk, so the
 *  bubble never flashes it. Only prefixes of these exact names. */
export const PARTIAL_BOOKKEEPING_TAIL_RE =
  /(?:<\/?(?:r(?:a(?:t(?:i(?:o(?:n(?:a(?:le?)?)?)?)?)?)?)?|d(?:i(?:r(?:e(?:c(?:t(?:i(?:ve?)?)?)?)?)?)?)?|s(?:t(?:a(?:t(?:e(?:[-_ ](?:c(?:h(?:a(?:n(?:g(?:es?)?)?)?)?)?)?)?)?)?)?)?)?|\[\s*\/?\s*(?:s(?:t(?:a(?:t(?:e(?:[-_ ](?:c(?:h(?:a(?:n(?:g(?:es?)?)?)?)?)?)?)?)?)?)?)?)?)$/i;

/** Display-only stripper for text without directive parsing (streaming):
 *  whole blocks go, content included, and a rationale still being written
 *  is hidden up to the end of the text. */
export function stripBookkeepingBlocks(text: string): string {
  return dropMarkedBookkeeping(unwrapBookkeepingBlocks(text));
}
