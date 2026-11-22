/**
 * State written as a header and rows instead of a bracket directive:
 *
 *   …the end of the story.
 *
 *   relationship-events
 *   Aiko | trust +4 | event=shared an umbrella
 *   Ren | trust -2 | event=was ignored
 *   location
 *   A rooftop south of the clinic
 *
 *   region: Karakura Town
 *
 * The header is a variable id on its own line (`relationship-events`,
 * `relationship-events:` or `[relationship-events]`); its body is the
 * non-blank lines that follow, up to a blank line, the next header or the
 * end. A paragraph made only of `id: value` lines sets each id. Models copy
 * these shapes from cards whose text variables hold rows. Read only in the
 * paragraphs at the very end of the reply, and only for ids that are exactly
 * known variables, so prose is never eaten.
 */

import { isDirectiveLabelSentence, SENTENCE_BREAK_RE } from "./directive-label.js";

export interface HeaderBlock {
  id: string;
  /** Body lines, trimmed, in order. Empty for a header with no rows. */
  body: string[];
}

/** What a header id is: a block to take, a known variable that ends the
 *  scan without being taken, or not a header at all. */
export type HeaderKind = "block" | "stop" | null;

const ID = "[\\w\\p{L}\\p{N}$·・.-]+";
const HEADER_RE = new RegExp(`^(?:\\[\\s*(${ID})\\s*\\]|(${ID})\\s*([:：])?)$`, "u");
/** `location: Urahara Shop`: an id, a colon and a value on one line. */
const KEY_VALUE_RE = new RegExp(`^(${ID})\\s*[:：]\\s*(\\S.*)$`, "u");
/** A bare id that is an ordinary word (`mood`, `location`) could be a line
 *  of prose: it opens a paragraph only with the colon or the brackets. Inside
 *  a block it is the next header. */
const PLAIN_WORD_RE = /^\p{L}+$/u;
const MAX_BODY_LINES = 60;
const MAX_LINE_CHARS = 1000;

function headerId(line: string, strict: boolean): string | null {
  const m = HEADER_RE.exec(line.trim());
  if (!m) return null;
  if (m[1]) return m[1];
  const id = m[2]!;
  if (strict && !m[3] && PLAIN_WORD_RE.test(id)) return null;
  return id;
}

const isLabelLine = (line: string) => isDirectiveLabelSentence(line.trim().split(SENTENCE_BREAK_RE).pop()!);

/** The blocks of one paragraph, or null when it is not made of them. */
function readParagraph(lines: string[], kindOf: (id: string) => HeaderKind): HeaderBlock[] | null {
  // `id` / `[id]` first: every line that is a known id starts the next block.
  const first = headerId(lines[0]!, true);
  if (first && kindOf(first)) {
    const blocks: HeaderBlock[] = [];
    for (const line of lines) {
      const id = headerId(line, false);
      const kind = id ? kindOf(id) : null;
      if (kind === "stop") return null;
      if (kind === "block") blocks.push({ id: id!, body: [] });
      else blocks[blocks.length - 1]!.body.push(line.trim());
    }
    return blocks.every((b) => b.body.length <= MAX_BODY_LINES) ? blocks : null;
  }
  // Every line `id: value`.
  const pairs = lines.map((line) => KEY_VALUE_RE.exec(line.trim()));
  if (pairs.every((m) => m && kindOf(m[1]!) === "block")) return pairs.map((m) => ({ id: m![1]!, body: [m![2]!.trim()] }));
  return null;
}

/**
 * Take the header blocks at the end of `text`. Returns the text without them
 * and the blocks in order; the text unchanged and no blocks when the last
 * paragraph is not made of them.
 */
export function extractTailHeaderBlocks(
  text: string,
  kindOf: (id: string) => HeaderKind,
): { text: string; blocks: HeaderBlock[] } {
  const none = { text, blocks: [] as HeaderBlock[] };
  const lines = text.split("\n");
  const blocks: HeaderBlock[] = [];
  let regionStart = -1;
  let end = lines.length - 1;
  for (;;) {
    while (end >= 0 && !lines[end]!.trim()) end--;
    if (end < 0) break;
    let start = end;
    while (start > 0 && lines[start - 1]!.trim()) start--;
    const paragraph = lines.slice(start, end + 1);
    if (paragraph.some((l) => l.length > MAX_LINE_CHARS)) break;
    // "Directives:" right above the blocks stays with the story (and is
    // dropped as a label afterwards).
    const labelled = paragraph.length > 1 && isLabelLine(paragraph[0]!);
    const read = readParagraph(labelled ? paragraph.slice(1) : paragraph, kindOf);
    if (!read) break;
    blocks.unshift(...read);
    regionStart = labelled ? start + 1 : start;
    if (labelled) break;
    end = start - 1;
  }
  if (!blocks.length) return none;
  const before = lines.slice(0, regionStart);
  if (before.filter((l) => /^\s*(?:```|~~~)/.test(l)).length % 2) return none;
  return { text: before.join("\n"), blocks };
}
