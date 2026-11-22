/** The tags the platform reads out of a reply or an entry: never prose. */
const PLATFORM_TAG = /\[\s*(?:image|video|audio|speaker|bg)\s*:[^\]\n]*\]/gi;
const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;
const HTML_TAG = /<\/?[a-z][^>\n]*>/gi;
/** A line's markdown lead: a heading, a quote, a list bullet or number. */
const LINE_LEAD = /^[ \t]{0,3}(?:#{1,6}|>|[-*+•]|\d{1,3}[.)])[ \t]+/gm;
const RULE_LINE = /^[ \t]*(?:[-*_][ \t]*){3,}$/gm;
/** `**bold**`, `*italic*`, `~~struck~~`, `` `code` `` — the marks, not the words. */
const EMPHASIS = /(?<![A-Za-z0-9])(\*\*|\*|~~|`)(?=\S)([^\n]*?\S)\1(?![A-Za-z0-9])/g;

/**
 * What a row on the board shows of an entry: its words, the way a reader
 * would see them. The raw text carries the things the engine reads (an
 * `[image:@asset:…]` tag, a `#` heading, HTML from an imported card), and on
 * the board they read as a broken page.
 */
export function previewText(text: string): string {
  return text
    .replace(CODE_FENCE, " ")
    .replace(PLATFORM_TAG, " ")
    .replace(HTML_TAG, " ")
    .replace(RULE_LINE, " ")
    .replace(LINE_LEAD, "")
    .replace(EMPHASIS, "$2")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
