/**
 * A label some models write in front of their trailing directives. Once the
 * directives are taken out it is left at the end of the story:
 *
 *   Narrator states complete. Directives follow.      (GLM 5.3 Flash)
 *   Directives:
 *   (unsigned); Directives then.
 *   "]                                                (a directive's remainder)
 *
 * Dropped when it is the last thing left in the story AND something was taken
 * out after it. The model also writes the strictest forms ("Directives
 * follow.", "Directives:", "Narrator states complete.") followed by nothing at
 * all; those go even then. Line based like directive-lines.ts: the label must
 * be the whole last line or the last sentence of it, so prose that merely
 * mentions directives ("She read the directives.") always stays.
 */

/** The label itself: `Directives`, `State changes`, `Updates`, optionally
 *  with follow/then/below and punctuation. Matched against one sentence. */
const LABEL_SENTENCE_RE =
  /^(?:here (?:are|is|come)\s+)?(?:(?:the|my)\s+)?(?:(?:state[-_ ]?)?directives?|(?:state|variable)[-_ ](?:changes?|updates?)|updates?)(?:\s+(?:follow(?:s|ing)?|then|below|now|here|as follows))?\s*[.:;!…—-]*$/i;
/** Meta fluff a model puts in front of the label on the same line:
 *  `Narrator states complete.`, `(unsigned);`. */
const FLUFF_SENTENCE_RE =
  /^(?:\([^()\n]{1,30}\)|(?:narrator|narration|narrative|story|output|reply|response|scene|turn)\b[^.;!?\n]{0,30}\b(?:complete|completed|done|finished|over|ends?|ended)\b)\s*[.;:!,]?$/i;
/** The same fluff alone on the line above the label (no bare parenthetical:
 *  a story line can be one). */
const FLUFF_LINE_RE =
  /^(?:narrator|narration|narrative|output|reply|response)\b[^.;!?\n]{0,30}\b(?:complete|completed|done|finished|over|ends?|ended)\b\s*[.;:!,]?$/i;
/** Labels dropped even with nothing after them: GLM writes them and then no
 *  directives at all. Strict, whole sentence only. */
const STRICT_LABEL_RE = /^(?:directives?(?:\s+(?:follows?|then|below)\s*[.:]?|\s*:)|narrator states? complete\.?)$/i;
/** `…two streets out!(unsigned);`: the same model's sign-off, glued to the
 *  end of the last line. */
const UNSIGNED_TAIL_RE = /\s*\((?:unsigned|signed)\)\s*[;:.,]?$/i;
/** What is left of a directive whose body was taken out: `"]`, `]`. */
const REMAINDER_LINE_RE = /^["'“”]?\s*\]+$/;
/** Markdown around a label: `**Directives:**`, `## Updates`. */
const unwrap = (s: string) => s.replace(/^[*_`#>\s]+/, "").replace(/[*_`\s]+$/, "");

export const isDirectiveLabelSentence = (sentence: string): boolean => {
  const s = unwrap(sentence);
  return s.length > 0 && s.length <= 80 && LABEL_SENTENCE_RE.test(s);
};

/** Between sentences, kept by split(): a space after `.;!?`, or nothing
 *  after a CJK full stop (`她关上门。Directives follow.`). */
export const SENTENCE_BREAK_RE = /((?<=[.;!?])\s+|(?<=[。！？；])\s*)/;

const normalize = (s: string) => s.replace(/[^\S\n]+/g, " ");

export interface DirectiveLabelOptions {
  /** Directives, a receipt or other bookkeeping were taken out of `raw`. */
  removedAny?: boolean;
  /** Drop a trailing label even with nothing after it yet (a reply still
   *  streaming: its directives are about to arrive). */
  force?: boolean;
}

/**
 * Drop a directive label (and its remainder line) from the end of `clean`,
 * the story left after parsing `raw`. A label counts only when `raw` holds
 * more after it, i.e. something that followed it was taken out.
 */
export function stripTrailingDirectiveLabel(clean: string, raw: string, opts: DirectiveLabelOptions = {}): string {
  const lines = clean.split("\n");
  const rawText = normalize(raw);
  let changed = false;
  let labelled = false;
  for (let guard = 0; guard < 4; guard++) {
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    if (!lines.length) break;
    const line = lines[lines.length - 1]!.trim();
    if (opts.removedAny && REMAINDER_LINE_RE.test(line)) { lines.pop(); changed = true; continue; }
    // Sentences with their separators: ["Narrator states complete.", " ", "Directives follow."].
    const parts = line.split(SENTENCE_BREAK_RE);
    const last = parts[parts.length - 1]!;
    const strict = STRICT_LABEL_RE.test(unwrap(last));
    if (!strict && !isDirectiveLabelSentence(last)) break;
    if (!opts.force && !strict) {
      const at = rawText.lastIndexOf(normalize(last));
      if (at < 0 || !rawText.slice(at + normalize(last).length).trim()) break;
    }
    parts.pop();
    parts.pop();
    while (parts.length && FLUFF_SENTENCE_RE.test(parts[parts.length - 1]!.trim())) { parts.pop(); parts.pop(); }
    const rest = parts.join("").trimEnd();
    if (rest) lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, lines[lines.length - 1]!.indexOf(rest) + rest.length);
    else lines.pop();
    changed = true;
    labelled = true;
    // The label was its own sentence after the story: nothing else to drop.
    if (rest) break;
  }
  if (labelled) {
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    if (lines.length && FLUFF_LINE_RE.test(lines[lines.length - 1]!.trim())) lines.pop();
  }
  const lastLine = lines[lines.length - 1];
  if (lastLine !== undefined && UNSIGNED_TAIL_RE.test(lastLine)) {
    lines[lines.length - 1] = lastLine.replace(UNSIGNED_TAIL_RE, "");
    if (!lines[lines.length - 1]!.trim()) lines.pop();
    changed = true;
  }
  return changed ? lines.join("\n").trimEnd() : clean;
}
