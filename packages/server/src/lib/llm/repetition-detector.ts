export type RepetitionReason = "sentence-loop" | "paragraph-loop" | "previous-reply";

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
 * substantial sentence or paragraph dominates an answer several times.
 */
export function detectDegenerateRepetition(
  text: string,
  previousReplies: readonly string[] = [],
): RepetitionDetection | null {
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

/** Production quality gate: intentionally a no-op for every non-Kimi model. */
export function detectDegenerateRepetitionForModel(
  modelId: string,
  text: string,
  previousReplies: readonly string[] = [],
): RepetitionDetection | null {
  if (!isKimiAntiRepetitionModel(modelId)) return null;
  return detectDegenerateRepetition(text, previousReplies);
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
