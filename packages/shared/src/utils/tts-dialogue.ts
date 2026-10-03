/**
 * Dialogue-aware text scanning for TTS.
 *
 * One outermost-quote state machine shared by the server (whole-message
 * dialogue extraction in text-prep) and the app (streaming read-along
 * slicing + per-slice extraction), so the two sides can never drift.
 *
 * Design notes:
 * - Only the OUTERMOST quote pair matters. Nested quotes (`「他说『来』就来」`)
 *   stay inside the outer span as plain characters — no double extraction.
 * - Real prose heals itself. Chinese and English both re-open the quote at
 *   each paragraph of a multi-paragraph speech without closing the previous
 *   one, and models routinely forget closers. The machine treats a same-type
 *   re-open, a paragraph break, and end-of-text as implicit closers instead
 *   of discarding the span.
 * - Streaming slices may be forced to cut inside a quote (runaway-length
 *   escape hatch). The scan state at the cut is returned so the next slice
 *   can pick up mid-quote and both halves still extract as dialogue.
 */

/** Paired quotes: opener → closer. Straight `"` is handled separately (it is
 *  its own closer and heals at a single newline, mirroring how it is used). */
const PAIRED: Record<string, string> = {
  "「": "」",
  "『": "』",
  "“": "”", // “ ”
  "«": "»",
};
const PAIRED_OPENERS = new Set(Object.keys(PAIRED));
const PAIRED_CLOSERS = new Set(Object.values(PAIRED));
const STRAIGHT = '"';

/** All characters the machine treats as quote marks (used by the raya pass
 *  to skip lines that mix quote styles). */
const QUOTE_CHARS = /[「」『』“”«»"]/;

/** Scan state across a slice boundary: the closer the outermost open quote
 *  is waiting for (null when outside any quote), plus whether the cut landed
 *  inside a square-bracket engine directive (`[game_state: …]` can span
 *  lines and contain quotes — while it is open, quote marks are ignored so a
 *  directive's innards can't poison the quote machine). */
export interface DialogueScanState {
  open: string | null;
  bracket?: boolean;
}

export const DIALOGUE_SCAN_START: DialogueScanState = { open: null };

export interface DialogueExtractOptions {
  /** Carry-in state from the previous slice (streaming). */
  initialState?: DialogueScanState;
  /** How many consecutive newlines heal an open paired quote. Raw streamed
   *  text separates paragraphs with blank lines ("double"); server-side
   *  text-prep collapses them to single newlines first ("single"). */
  paragraph?: "single" | "double";
}

export interface DialogueSpan {
  /** Offset of the span's first content character in the input. */
  index: number;
  text: string;
}

export interface DialogueExtraction {
  spans: DialogueSpan[];
  /** State at end-of-text — non-null `open` means the text ended inside a
   *  quote (the partial content is already emitted as a span). */
  endState: DialogueScanState;
}

/**
 * Extract spoken-dialogue spans in order of appearance.
 *
 * Covers: 「」 『』 “” «» ", Spanish raya lines (`—Dialogo —acotación—. Más.`),
 * paragraph-continuation re-opens, and unterminated quotes (salvaged to the
 * end of text / paragraph instead of dropped).
 */
export function extractDialogueSpans(
  text: string,
  opts: DialogueExtractOptions = {},
): DialogueExtraction {
  const paraLen = opts.paragraph === "single" ? 1 : 2;
  const spans: DialogueSpan[] = [];
  /** Ranges of quote spans (content start → emit end) for the raya pass. */
  const quoteRanges: Array<{ start: number; end: number }> = [];

  let open: string | null = opts.initialState?.open ?? null;
  let bracket = opts.initialState?.bracket ?? false;
  let spanStart = open !== null ? 0 : -1;

  const emit = (end: number) => {
    if (spanStart < 0) return;
    const raw = text.slice(spanStart, end);
    const trimmed = raw.trim();
    if (trimmed) {
      spans.push({ index: spanStart, text: trimmed });
      quoteRanges.push({ start: spanStart, end });
    }
    spanStart = -1;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    // ── Inside a square-bracket span (engine directive / markdown label) ──
    // Its innards are never dialogue and may contain quote marks that would
    // poison the quote machine, so consume them opaquely. A paragraph break
    // heals a stray unclosed `[`.
    if (bracket) {
      if (c === "]") {
        bracket = false;
      } else if (c === "\n") {
        let run = 1;
        while (i + run < text.length && text[i + run] === "\n") run++;
        if (run >= paraLen) {
          bracket = false;
          i += run - 1;
        }
      }
      continue;
    }

    if (open !== null) {
      // ── Inside a quote ──
      if (c === open) {
        // Closer (for straight quotes the opener char doubles as closer).
        emit(i);
        open = null;
        continue;
      }
      if (c === "\n") {
        if (open === STRAIGHT) {
          // A straight quote never spans a line — heal (salvage the span).
          emit(i);
          open = null;
          continue;
        }
        // Paired quote at a paragraph break — heal.
        let run = 1;
        while (i + run < text.length && text[i + run] === "\n") run++;
        if (run >= paraLen) {
          emit(i);
          open = null;
          i += run - 1;
        }
        continue;
      }
      if (PAIRED[c] === open) {
        // Same-type re-open while open (paragraph-continuation convention,
        // or a forgotten closer): close the previous span, start a new one.
        emit(i);
        spanStart = i + 1;
        continue;
      }
      // Anything else — including nested quotes of a different type — is
      // span content.
      continue;
    }

    // ── Outside any quote ──
    if (c === "[") {
      bracket = true;
    } else if (PAIRED_OPENERS.has(c)) {
      open = PAIRED[c]!;
      spanStart = i + 1;
    } else if (c === STRAIGHT) {
      open = STRAIGHT;
      spanStart = i + 1;
    }
    // Stray closers and everything else at depth 0 are ignored.
  }

  const endState: DialogueScanState = { open, ...(bracket ? { bracket } : {}) };
  if (open !== null) {
    // Unterminated at end-of-text — salvage what we have. Streaming callers
    // carry `endState` so the next slice continues the same quote.
    emit(text.length);
  }

  // ── Spanish raya pass ──
  // A line whose first character is a single em-dash marks dialogue; odd
  // segments between dashes are speech, even segments are attribution
  // (`—No lo sé —dijo María—. Pero es tarde.`). Only applied to lines that
  // use no quote marks of their own and sit outside every quote span
  // (a `——` line start is a CJK scene-break dash, not a raya).
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      const line = text.slice(lineStart, i);
      const trimmed = line.trimStart();
      const offset = lineStart + (line.length - trimmed.length);
      if (
        trimmed.startsWith("—") &&
        trimmed[1] !== "—" &&
        trimmed.length > 2 &&
        !QUOTE_CHARS.test(line) &&
        !quoteRanges.some((r) => offset >= r.start && offset < r.end)
      ) {
        const parts = trimmed.split("—");
        const speech = parts
          .filter((_, idx) => idx % 2 === 1)
          .map((p) => p.trim())
          .filter(Boolean)
          .join(" ");
        if (speech) spans.push({ index: offset, text: speech });
      }
      lineStart = i + 1;
    }
  }

  spans.sort((a, b) => a.index - b.index);
  return { spans, endState };
}

/** Convenience: dialogue texts only, in order. */
export function extractDialogueTexts(
  text: string,
  opts: DialogueExtractOptions = {},
): string[] {
  return extractDialogueSpans(text, opts).spans.map((s) => s.text);
}

/** Scan state after `text`, given the state before it (for streaming callers
 *  that clip a slice at an arbitrary offset, e.g. a budget cut). */
export function scanDialogueState(
  text: string,
  initial: DialogueScanState = DIALOGUE_SCAN_START,
  paragraph: "single" | "double" = "double",
): DialogueScanState {
  return extractDialogueSpans(text, { initialState: initial, paragraph }).endState;
}

// ── Streaming slice boundaries ──────────────────────────────────────

/** Sentence-ish boundary characters (unconditional). Latin `.` is handled
 *  separately so decimals and abbreviations don't create false cuts. */
const HARD_BOUNDARY = /[。！？!?…\n]/;

/** Words whose trailing dot is an abbreviation, not a sentence end. */
const DOT_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc",
  "sra", "srta", "ud", "uds", "vol", "cap",
]);

function isSentenceDot(text: string, i: number): boolean {
  const next = text[i + 1];
  // Decimals ("3.5") and dotted tokens ("e.g.") have no whitespace after.
  // A closing quote right after the dot (`."` / .』) still ends a sentence.
  if (next !== undefined && !/[\s"」』”»'’]/.test(next)) return false;
  // Preceding word: letters walking back from the dot.
  let start = i;
  while (start > 0 && /[\p{L}]/u.test(text[start - 1]!)) start--;
  const word = text.slice(start, i);
  if (word.length === 1 && /[A-Z]/.test(word)) return false; // "J. Smith"
  if (DOT_ABBREVIATIONS.has(word.toLowerCase())) return false;
  return true;
}

export interface StreamCut {
  /** Cut position — the slice is `text.slice(0, end)`. */
  end: number;
  /** Quote-scan state at the cut, to carry into the next slice. */
  state: DialogueScanState;
}

export interface StreamCutResult {
  /** Last boundary OUTSIDE any quote, ≥ minChars — the preferred cut. */
  clean: StreamCut | null;
  /** Last boundary anywhere (even mid-quote) — the runaway escape hatch. */
  raw: StreamCut | null;
}

/**
 * Find slice boundaries in streamed text. A "clean" cut never lands inside
 * an open quote — `。` inside `「…」` doesn't count, and a closer that ends a
 * quote right after sentence punctuation (`。」`) extends the cut past itself.
 */
export function findStreamCut(
  text: string,
  opts: { minChars: number; initialState?: DialogueScanState; paragraph?: "single" | "double" },
): StreamCutResult {
  const paraLen = opts.paragraph === "single" ? 1 : 2;
  let open: string | null = opts.initialState?.open ?? null;
  let bracket = opts.initialState?.bracket ?? false;
  let clean: StreamCut | null = null;
  let raw: StreamCut | null = null;
  /** A boundary char was seen and only closers have followed since. */
  let pending = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    let isBoundary = HARD_BOUNDARY.test(c);
    if (!isBoundary && c === "." && isSentenceDot(text, i)) isBoundary = true;

    // ── Inside a `[...]` span: no clean cuts (a directive split across
    // slices would be voiced as fragments), quote marks opaque. Boundaries
    // still record a raw (escape-hatch) cut carrying the bracket state.
    if (bracket) {
      if (c === "]") {
        bracket = false;
      } else if (c === "\n") {
        let run = 1;
        while (i + run < text.length && text[i + run] === "\n") run++;
        if (run >= paraLen) bracket = false;
        else if (isBoundary) raw = { end: i + 1, state: { open, bracket: true } };
        if (bracket) continue;
        // healed at the paragraph — the break itself is a boundary below
      } else {
        if (isBoundary) raw = { end: i + 1, state: { open, bracket: true } };
        continue;
      }
      if (bracket) continue;
      pending = false;
      continue;
    }

    // ── State transitions (must mirror extractDialogueSpans) ──
    let closedHere = false;
    if (open !== null) {
      if (c === open) {
        open = null;
        closedHere = true;
      } else if (c === "\n") {
        if (open === STRAIGHT) {
          open = null;
          closedHere = true;
        } else {
          let run = 1;
          while (i + run < text.length && text[i + run] === "\n") run++;
          if (run >= paraLen) {
            open = null;
            closedHere = true;
          }
        }
      } else if (PAIRED[c] === open) {
        // same-type re-open: still inside a quote
      }
    } else if (c === "[") {
      bracket = true;
    } else if (PAIRED_OPENERS.has(c)) {
      open = PAIRED[c]!;
    } else if (c === STRAIGHT) {
      open = STRAIGHT;
    }

    // ── Boundary bookkeeping ──
    // `pending` survives through a chain of closing quotes so `。」`, `?"`
    // and `.'` cut AFTER the quote closes, not inside it.
    const isChainCloser = closedHere || PAIRED_CLOSERS.has(c) || c === "'" || c === "’";
    if (isBoundary) {
      pending = true;
      raw = { end: i + 1, state: { open } };
    } else if (!isChainCloser) {
      pending = false;
    }
    if (pending && open === null && (isBoundary || isChainCloser)) {
      if (i + 1 >= opts.minChars) clean = { end: i + 1, state: { open: null } };
      pending = false;
    }
  }

  return { clean, raw };
}
