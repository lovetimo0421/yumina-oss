export type RepetitionReason = "token-loop" | "sentence-loop" | "paragraph-loop" | "previous-reply";

export interface RepetitionDetection {
  reason: RepetitionReason;
  occurrences: number;
  sample: string;
}

const KIMI_ANTI_REPETITION_MODEL = "moonshotai/kimi-k2-0905";

export function isKimiAntiRepetitionModel(modelId: string): boolean {
  return modelId === KIMI_ANTI_REPETITION_MODEL;
}

const MIN_SENTENCE_LENGTH = 12;
const MIN_PARAGRAPH_LENGTH = 24;

function normalizeUnit(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\[[^\]\n]{1,160}\]/g, " ")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

// ─── Token loop ─────────────────────────────────────────────────────
// A model stuck on one short word or character ("Our Our Our …", "我们我们…",
// "啊啊啊…" to max_tokens). The sentence and paragraph rules miss it: there are
// no 12+ char sentences to count. Detected on the normalized text (lowercase,
// punctuation, symbols and whitespace removed) as a run with a short period.

/** Longest repeating unit, in normalized chars ("understand" = 10). */
const TOKEN_LOOP_MAX_UNIT = 12;
/** Consecutive repeats of a multi-char unit before it can count as a loop. */
const TOKEN_LOOP_MIN_REPEATS = 20;
/** A single character needs more: screams and laughter run long on purpose. */
const TOKEN_LOOP_MIN_SINGLE_CHAR_REPEATS = 40;
/**
 * Discarding the turn (and not billing it) needs the run to cover most of the
 * reply. The reply has already streamed to the player, so a loop tacked onto
 * a useful story ("end every reply with zz zz …") must not make it free.
 */
const TOKEN_LOOP_MIN_COVERAGE = 0.5;
/** A shorter-coverage run this long is still logged (never failed or waived). */
const TOKEN_LOOP_PARTIAL_LOG_CHARS = 600;

/** Reply text a token loop is measured on: no code blocks (ASCII maps, grids),
 * HTML tags (status panels repeat `<td></td>`) or markdown link targets. */
function tokenLoopBody(text: string): string {
  return normalizeUnit(
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<[^<>\n]{0,400}>/g, " ")
      .replace(/\]\([^)\s]{0,2000}\)/g, "] "),
  );
}

/** The longest short-unit run in the reply, with the share of it that it covers. */
function findLongestTokenLoop(text: string): { detection: RepetitionDetection; runChars: number; coverage: number } | null {
  const body = tokenLoopBody(text);
  if (body.length < TOKEN_LOOP_MIN_REPEATS) return null;
  let best: { unit: string; repeats: number; runChars: number } | null = null;
  for (let size = 1; size <= TOKEN_LOOP_MAX_UNIT && size * 2 <= body.length; size++) {
    const minRepeats = size === 1 ? TOKEN_LOOP_MIN_SINGLE_CHAR_REPEATS : TOKEN_LOOP_MIN_REPEATS;
    // `matched` counts consecutive positions equal to the char `size` back: a
    // periodic run of matched + size chars.
    let matched = 0;
    for (let index = size; index <= body.length; index++) {
      if (index < body.length && body[index] === body[index - size]) {
        matched++;
        continue;
      }
      if (matched > 0) {
        const runChars = matched + size;
        const repeats = Math.floor(runChars / size);
        const start = index - runChars;
        const unit = body.slice(start, start + size);
        // Numbers repeat legitimately (tables, grids, "0 0 0 0").
        const qualifies = repeats >= minRepeats && !/^\d+$/.test(unit);
        // Smaller periods are tried first, so a tie keeps the most repeats.
        if (qualifies && (!best || runChars > best.runChars)) best = { unit, repeats, runChars };
      }
      matched = 0;
    }
  }
  if (!best) return null;
  return {
    detection: { reason: "token-loop", occurrences: best.repeats, sample: Array(3).fill(best.unit).join(" ") + " …" },
    runChars: best.runChars,
    // Coverage is measured against the whole delivered reply: stripping code,
    // HTML and links only keeps those from looking like loops, it must never
    // shrink the denominator (a big HTML panel + a short loop is not "all loop").
    coverage: best.runChars / Math.max(body.length, normalizeUnit(text).length),
  };
}

/** A token loop that IS the reply: most of it is the same short unit. */
function findTokenLoop(text: string): RepetitionDetection | null {
  const loop = findLongestTokenLoop(text);
  return loop && loop.coverage >= TOKEN_LOOP_MIN_COVERAGE ? loop.detection : null;
}

/**
 * A long token loop inside a reply that is mostly something else. For
 * monitoring only: the turn is kept and billed as usual, because the useful
 * part was delivered.
 */
export function detectPartialTokenLoop(text: string): RepetitionDetection | null {
  const loop = findLongestTokenLoop(text);
  return loop && loop.coverage < TOKEN_LOOP_MIN_COVERAGE && loop.runChars >= TOKEN_LOOP_PARTIAL_LOG_CHARS
    ? loop.detection
    : null;
}

function findDominantRepeat(
  units: string[],
  minimumLength: number,
  minimumOccurrences: number,
  minimumCoverage: number,
): { occurrences: number; sample: string } | null {
  const normalized = units
    .map((raw) => ({ raw: raw.trim(), normalized: normalizeUnit(raw) }))
    .filter((unit) => unit.normalized.length >= minimumLength);
  if (normalized.length < minimumOccurrences) return null;

  const counts = new Map<string, { occurrences: number; sample: string }>();
  for (const unit of normalized) {
    const current = counts.get(unit.normalized);
    counts.set(unit.normalized, {
      occurrences: (current?.occurrences ?? 0) + 1,
      sample: current?.sample ?? unit.raw,
    });
  }

  for (const match of counts.values()) {
    if (
      match.occurrences >= minimumOccurrences &&
      match.occurrences / normalized.length >= minimumCoverage
    ) {
      return match;
    }
  }
  return null;
}

function shingles(value: string, size = 5): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index <= value.length - size; index++) {
    result.add(value.slice(index, index + size));
  }
  return result;
}

function isNearDuplicate(current: string, previous: string): boolean {
  const currentNormalized = normalizeUnit(current);
  const previousNormalized = normalizeUnit(previous);
  if (currentNormalized.length < 96 || previousNormalized.length < 96) return false;

  const lengthRatio = Math.min(currentNormalized.length, previousNormalized.length) /
    Math.max(currentNormalized.length, previousNormalized.length);
  if (lengthRatio < 0.55) return false;

  const currentShingles = shingles(currentNormalized);
  const previousShingles = shingles(previousNormalized);
  let intersection = 0;
  for (const value of currentShingles) {
    if (previousShingles.has(value)) intersection++;
  }
  const union = currentShingles.size + previousShingles.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const containment = intersection / Math.min(currentShingles.size, previousShingles.size);
  return jaccard >= 0.72 || containment >= 0.86;
}

/**
 * Conservative final-output quality gate for pathological generation loops.
 * It intentionally ignores ordinary motif reuse and only flags when the same
 * short word runs on for most of the reply, or the same substantial sentence
 * or paragraph dominates an answer several times.
 */
export function detectDegenerateRepetition(
  text: string,
  previousReplies: readonly string[] = [],
): RepetitionDetection | null {
  const tokenLoop = findTokenLoop(text);
  if (tokenLoop) return tokenLoop;

  if (normalizeUnit(text).length < 72) return null;

  const paragraphs = text.split(/\n\s*\n+/).filter(Boolean);
  const paragraphLoop = findDominantRepeat(paragraphs, MIN_PARAGRAPH_LENGTH, 3, 0.5);
  if (paragraphLoop) {
    return { reason: "paragraph-loop", ...paragraphLoop };
  }

  const sentences = text
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const sentenceLoop = findDominantRepeat(sentences, MIN_SENTENCE_LENGTH, 4, 0.5);
  if (sentenceLoop) {
    return { reason: "sentence-loop", ...sentenceLoop };
  }

  for (const previous of previousReplies.slice(-3)) {
    if (isNearDuplicate(text, previous)) {
      return { reason: "previous-reply", occurrences: 2, sample: text.slice(0, 160) };
    }
  }

  return null;
}

/**
 * Production quality gate, run on every model's finished reply. A loop inside
 * one reply (token, sentence, paragraph) is broken output from any model — GLM
 * has filled whole replies with "Our Our Our …". The near-copy-of-a-previous-
 * reply check stays Kimi-only: other models legitimately repeat a card's fixed
 * status template, and a low-temperature regenerate can land close to the
 * reply it replaces.
 */
export function detectDegenerateRepetitionForModel(
  modelId: string,
  text: string,
  previousReplies: readonly string[] = [],
): RepetitionDetection | null {
  return detectDegenerateRepetition(text, isKimiAntiRepetitionModel(modelId) ? previousReplies : []);
}

/** Recency instruction is model-scoped so existing worlds receive the fix too. */
export function antiRepetitionInstructionForModel(modelId: string): string | null {
  if (!isKimiAntiRepetitionModel(modelId)) return null;
  return [
    "[Kimi anti-repetition rule]",
    "Continue the story with materially new events.",
    "Do not reuse the previous assistant reply's opening beat, event order, timestamps, conflict, or resolution.",
    "If the world requires a fixed report format, keep the format but make every reported event genuinely new.",
  ].join("\n");
}
