import type { SessionMemory } from "@yumina/shared";
import { estimateTokens } from "@yumina/engine";

/**
 * Session memory is a single free-form text block. The legacy format (pre
 * 2026-07) was six structured string arrays; those still exist in stored
 * jsonb rows, so normalization converts them to text on read.
 */

/** Legacy structured-memory section keys, kept only for lazy conversion. */
const LEGACY_MEMORY_KEYS = [
  "coreFacts",
  "relationshipChanges",
  "activeGoalsAndOpenThreads",
  "importantDecisionsAndPromises",
  "worldStateAndInventory",
  "currentRisksAndConstraints",
] as const;

const LEGACY_MEMORY_LABELS: Record<(typeof LEGACY_MEMORY_KEYS)[number], string> = {
  coreFacts: "Core facts",
  relationshipChanges: "Relationship changes",
  activeGoalsAndOpenThreads: "Active goals and open threads",
  importantDecisionsAndPromises: "Important decisions and promises",
  worldStateAndInventory: "World state and inventory",
  currentRisksAndConstraints: "Current risks and constraints",
};

/**
 * Hard ceiling on STORED memory text (read-side clamp). Roughly the old cap
 * (6 sections × 10 items × 260 chars). Kept at 12k so existing rows between
 * 8k and 12k chars are not cut on read.
 */
export const MAX_MEMORY_CHARS = 12_000;

/**
 * Size the updater is TOLD to write to, and the output cap that must be able
 * to hold it. These two numbers have to agree: the old prompt asked for a
 * 12,000-character memory while the LLM call capped output at 4,000 tokens —
 * ~5-6k Chinese characters — so a CJK memory was cut mid-write on ~20% of all
 * updates platform-wide, the tail sections (promises, world state, risks)
 * dying first every turn (hhltwz report, 2026-09-04). 8,192 output tokens
 * holds 8,000 CJK characters even on the 1-token-per-character estimate
 * (see estimateTokens) and is within every routed model's output limit.
 */
/** Soft size target. Complete output may use the existing 12k storage ceiling. */
export const MEMORY_TARGET_CHARS = 7_000;
/** Writing targets encourage concision; they never determine acceptance. */
export const MEMORY_WRITE_TARGET_CHARS = 5_000;
export const MEMORY_RECOVERY_TARGET_CHARS = 1_500;
/** Prompt guidance only; the actual provider output cap remains unchanged. */
export const MEMORY_RECOVERY_TARGET_TOKENS = 1_500;
export const MAX_MEMORY_OUTPUT_TOKENS = 8_192;

/**
 * Player-pinned notes: a block the player writes and the updater never
 * rewrites, injected with the memory every turn. Capped so a pasted novel
 * can't crowd the prompt.
 */
export const MAX_PINNED_MEMORY_CHARS = 6_000;

export function emptySessionMemory(): SessionMemory {
  return { text: "" };
}

/** Legacy active/failed jobs wrote an attempt position before committing.
 * Settings changes must not turn that position into trusted coverage. */
export function hasUncertainMemoryCoverage(row: {
  sessionMemoryStatus: string;
  sessionMemorySourceHash: string | null;
}): boolean {
  return row.sessionMemorySourceHash?.startsWith("repair:") === true
    || (row.sessionMemoryStatus === "failed" || row.sessionMemoryStatus === "updating")
      && !row.sessionMemorySourceHash?.startsWith("v2:");
}

/**
 * True when a generated memory hit the output cap — i.e. the model was cut
 * off mid-write. The provider's stop reason is authoritative when present
 * (`max_tokens` = cut off; anything else = it finished, even if a reasoning
 * model's hidden tokens pushed the completion count to the cap). Without it,
 * fall back to reported usage, then to the text's own estimated size.
 * The caller retries once, then may retain usable partial text with a warning.
 */
export function isTruncatedMemoryOutput(args: {
  stopReason?: string | null;
  completionTokens: number;
  text: string;
  model?: string;
  outputLimit?: number;
}): boolean {
  if (args.stopReason) return args.stopReason === "max_tokens";
  const limit = args.outputLimit ?? MAX_MEMORY_OUTPUT_TOKENS;
  if (args.completionTokens > 0) return args.completionTokens >= limit;
  return estimateTokens(args.text, args.model) >= limit;
}

/**
 * Verdict on one raw updater output. "degenerate" is checked BEFORE
 * "truncated": the classic degenerate shape is one bullet looping until the
 * output cap, and that must reach generateHealthySessionMemory's fallback-
 * model retry instead of surfacing as a misleading "cut off" error.
 */
export function classifyMemoryOutput(args: {
  stopReason?: string | null;
  completionTokens: number;
  text: string;
  model?: string;
  outputLimit?: number;
}): "ok" | "degenerate" | "truncated" | "oversized" {
  if (!args.text.trim() || isDegenerateSessionMemoryText(args.text)) return "degenerate";
  if (isTruncatedMemoryOutput(args)) return "truncated";
  if (args.text.trim().length > MAX_MEMORY_CHARS) return "oversized";
  return "ok";
}

export const MEMORY_UPDATE_MIN_TURNS = 3;
export const MEMORY_UPDATE_MIN_CHARS = 4_000;
export const MEMORY_BATCH_MAX_CHARS = 60_000;

/** Input must be the oldest unprocessed rows, ending no later than lag-one.
 * Never slice a message and then mark it covered. Overflow remains pending. */
export function selectPendingMemoryBatch(rows: MemoryTranscriptRow[], maxChars = MEMORY_BATCH_MAX_CHARS, maxTurns = Infinity) {
  let chars = 0;
  let end = 0;
  let turns = 0;
  let coveredChars = 0;
  for (let i = 0; i < rows.length; i++) {
    chars += rows[i]!.content.length + 16;
    if (rows[i]!.role !== "assistant") continue;
    if (chars > maxChars) {
      if (end === 0) throw new Error("One pending exchange is too large to update memory safely. Shorten that exchange or regenerate memory; the previous memory was kept.");
      break;
    }
    end = i + 1;
    turns++;
    coveredChars = chars;
    if (turns >= maxTurns) break;
  }
  const selected = rows.slice(0, end);
  return { rows: selected, turns, chars: coveredChars, processedMessageId: selected.at(-1)?.id ?? null };
}

/** Catch-up jobs preserve whole exchanges and never certify a sliced message.
 * After size failures, reduce new evidence instead of replaying a 60k backlog. */
export function memoryBatchTurnLimit(retryCount: number, error: string | null): number {
  if (!error?.startsWith("Memory could not fit within its size budget")) return 3;
  return retryCount >= 2 ? 1 : 2;
}

export function shouldUpdateSessionMemory(args: {
  pendingTurns: number;
  pendingChars: number;
  hasMemory: boolean;
  failed: boolean;
  overBudget: boolean;
  force?: boolean;
}): boolean {
  if (args.pendingTurns === 0) return false;
  return !!args.force || !args.hasMemory || args.failed || args.overBudget
    || args.pendingTurns >= MEMORY_UPDATE_MIN_TURNS || args.pendingChars >= MEMORY_UPDATE_MIN_CHARS;
}

/** One repair at a smaller writing target, then retain usable size-limited
 * output with a warning. Empty/repetitive output still uses semantic recovery. */
export async function generateCompleteMemory(args: {
  generate: (targetChars: number, recovery: boolean) => Promise<{
    text: string; completionTokens: number; stopReason?: string | null; outputLimit?: number;
  }>;
  model?: string;
  canRecover?: () => boolean;
  onAttempt?: (attempt: {
    targetChars: number; recovery: boolean; textChars: number;
    completionTokens: number; stopReason?: string | null; outputLimit?: number;
    verdict: ReturnType<typeof classifyMemoryOutput>;
  }) => void;
}): Promise<SessionMemory> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const targetChars = attempt === 0 ? MEMORY_WRITE_TARGET_CHARS : MEMORY_RECOVERY_TARGET_CHARS;
    const result = await args.generate(targetChars, attempt > 0);
    const text = result.text.trim();
    const verdict = classifyMemoryOutput({ ...result, text, model: args.model });
    args.onAttempt?.({ targetChars, recovery: attempt > 0, textChars: text.length,
      completionTokens: result.completionTokens, stopReason: result.stopReason,
      outputLimit: result.outputLimit, verdict });
    // Empty/repetitive output still belongs to the existing semantic fallback.
    if (verdict === "ok" || verdict === "degenerate") return { text };
    if (attempt === 0 && (args.canRecover?.() ?? true)) continue;
    // The player prefers a usable partial memory over losing both attempts.
    // Preserve the storage limit and make every lossy save explicit in the UI.
    let retained = text.slice(0, MAX_MEMORY_CHARS).trimEnd();
    if (/[\uD800-\uDBFF]$/.test(retained)) retained = retained.slice(0, -1);
    return { text: retained, warning: "truncated" };
  }
  throw new TruncatedSessionMemoryError();
}

/**
 * Extra prompt line when the existing memory is already over the size target
 * (legacy rows up to MAX_MEMORY_CHARS, or a model that overshot). Without it
 * the model faithfully rewrites an oversize memory, hits the output cap, and
 * the update fails every turn.
 */
export function memoryBudgetInstruction(previousMemoryChars: number): string {
  if (previousMemoryChars <= MEMORY_TARGET_CHARS) return "";
  return `The existing memory is above the preferred size (${previousMemoryChars} characters). Aim for about ${MEMORY_TARGET_CHARS} characters by merging overlapping facts and resolved history. Preserve essential continuity and finish the memory even if that requires going over the target.`;
}

export class TruncatedSessionMemoryError extends Error {
  constructor() {
    super(
      "Memory could not fit within its size budget after a shorter retry. The previous memory and its coverage were kept. Pending turns will be included on retry; automatic updates pause after 3 consecutive failures.",
    );
    this.name = "TruncatedSessionMemoryError";
  }
}

/** Trim, drop blanks to null, clamp to the pinned cap. Accepts any input shape. */
export function normalizePinnedMemory(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.length <= MAX_PINNED_MEMORY_CHARS ? trimmed : trimmed.slice(0, MAX_PINNED_MEMORY_CHARS);
}

function isLegacyStructuredMemory(record: Record<string, unknown>): boolean {
  return LEGACY_MEMORY_KEYS.some((key) => Array.isArray(record[key]));
}

function convertLegacyMemoryToText(record: Record<string, unknown>): string {
  const sections: string[] = [];
  for (const key of LEGACY_MEMORY_KEYS) {
    const raw = record[key];
    if (!Array.isArray(raw)) continue;
    const items = raw
      .map((item) => String(item ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (items.length === 0) continue;
    sections.push(`${LEGACY_MEMORY_LABELS[key]}:\n${items.map((item) => `- ${item}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

export function clampMemoryText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_MEMORY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_MEMORY_CHARS).trim()}\n... [truncated]`;
}

/**
 * Accepts any historical/persisted shape and returns `{ text }`:
 * - `{ text: string }` (current) — used as-is
 * - plain string — wrapped
 * - legacy six-array structured object — converted to labeled text sections
 * - `{ memory: ... }` wrapper (old client payloads) — unwrapped first
 * - anything else — empty memory
 */
export function normalizeSessionMemory(input: unknown): SessionMemory {
  const source =
    input && typeof input === "object" && "memory" in input
      ? (input as { memory?: unknown }).memory
      : input;

  if (typeof source === "string") {
    return { text: clampMemoryText(source) };
  }
  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    if (typeof record.text === "string") {
      return { text: clampMemoryText(record.text), ...(record.warning === "truncated" ? { warning: "truncated" as const } : {}) };
    }
    if (isLegacyStructuredMemory(record)) {
      return { text: clampMemoryText(convertLegacyMemoryToText(record)) };
    }
  }
  return emptySessionMemory();
}

export function hasSessionMemory(memory: unknown): boolean {
  return normalizeSessionMemory(memory).text.length > 0;
}

const MIN_REPEATED_UNIT_CHARS = 12;
const MIN_REPEATED_UNIT_COUNT = 4;
const MIN_DEGENERATE_TEXT_CHARS = 80;
const MIN_REPEATED_COVERAGE = 0.5;
const REPETITION_NGRAM_LENGTHS = [12, 24, 48, 96, 192] as const;

function normalizeRepetitionUnit(text: string): string {
  return text
    .replace(/^[\s>*#\-–—•·\d.)、]+/u, "")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function hasRepeatedNgramCoverage(compactText: string): boolean {
  for (const unitLength of REPETITION_NGRAM_LENGTHS) {
    if (compactText.length < unitLength * MIN_REPEATED_UNIT_COUNT) continue;
    const occurrences = new Map<string, { count: number; lastEnd: number }>();
    for (let start = 0; start <= compactText.length - unitLength; start++) {
      const unit = compactText.slice(start, start + unitLength);
      const previous = occurrences.get(unit);
      if (!previous) {
        occurrences.set(unit, { count: 1, lastEnd: start + unitLength });
        continue;
      }
      if (start < previous.lastEnd) continue;
      previous.count++;
      previous.lastEnd = start + unitLength;
      if (
        previous.count >= MIN_REPEATED_UNIT_COUNT &&
        (unitLength * previous.count) / compactText.length >= MIN_REPEATED_COVERAGE
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect the common LLM failure mode where one sentence or bullet is emitted
 * over and over until the output cap. The thresholds are deliberately strict:
 * at least four copies of a meaningful unit must occupy half the memory.
 */
export function isDegenerateSessionMemoryText(text: string): boolean {
  const compactText = normalizeRepetitionUnit(text);
  if (compactText.length < MIN_DEGENERATE_TEXT_CHARS) return false;

  const unitGroups = [
    text.split(/[。！？!?；;\n.]+/u),
    text.split(/[，,]+/u),
  ];
  for (const units of unitGroups) {
    const counts = new Map<string, number>();
    for (const unit of units) {
      const normalized = normalizeRepetitionUnit(unit);
      if (normalized.length < MIN_REPEATED_UNIT_CHARS) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }

    for (const [unit, count] of counts) {
      if (count < MIN_REPEATED_UNIT_COUNT) continue;
      if ((unit.length * count) / compactText.length >= MIN_REPEATED_COVERAGE) {
        return true;
      }
    }
  }
  return hasRepeatedNgramCoverage(compactText);
}

export class DegenerateSessionMemoryError extends Error {
  constructor() {
    super("Memory generation returned empty or repetitive output");
    this.name = "DegenerateSessionMemoryError";
  }
}

type GenerateHealthySessionMemoryArgs = {
  primaryModel: string;
  fallbackModel?: string;
  generate: (model: string) => Promise<SessionMemory>;
  canRetry?: (fallbackModel: string) => boolean | Promise<boolean>;
  onRetry?: (fallbackModel: string) => void | Promise<void>;
  onFailure?: () => void | Promise<void>;
};

/** Accept only useful output and retry one time with a different model family. */
export async function generateHealthySessionMemory(
  args: GenerateHealthySessionMemoryArgs,
): Promise<SessionMemory> {
  const primary = await args.generate(args.primaryModel);
  if (primary.text.trim() && !isDegenerateSessionMemoryText(primary.text)) return primary;

  const hasDistinctFallback = Boolean(
    args.fallbackModel && args.fallbackModel !== args.primaryModel,
  );
  const canRetry = hasDistinctFallback && (
    args.canRetry ? await args.canRetry(args.fallbackModel!) : true
  );
  if (canRetry) {
    await args.onRetry?.(args.fallbackModel!);
    const fallback = await args.generate(args.fallbackModel!);
    if (fallback.text.trim() && !isDegenerateSessionMemoryText(fallback.text)) return fallback;
  }

  await args.onFailure?.();
  throw new DegenerateSessionMemoryError();
}

/** Existing bad rows stay editable in the panel but never seed new output. */
export function sanitizeSessionMemoryForGeneration(memory: unknown): SessionMemory {
  const normalized = normalizeSessionMemory(memory);
  return isDegenerateSessionMemoryText(normalized.text) ? emptySessionMemory() : normalized;
}

// ─── Lag-one turn selection ─────────────────────────────────────────
//
// The lag-one invariant: session memory must never include the newest visible
// assistant reply. A memory that already contains the newest reply's facts
// biases a regenerate/swipe of that reply toward reproducing the same content,
// and the post-turn update then merges both versions' facts into one memory.
// So the incremental updater folds the exchange BEFORE the reply that just
// finished, and the full rebuild stops before the last exchange.

export interface MemoryTranscriptRow {
  id: string;
  role: string;
  content: string;
  stateSnapshot?: unknown;
  createdAt?: Date | null;
}

export interface LaggedIncrementalTurn {
  /** The folded exchange's assistant reply — becomes the processed pointer. */
  assistantMessageId: string;
  assistantMessage: string;
  userMessage: string;
  /** Game state as of that reply, when a snapshot was captured. */
  stateSnapshot: unknown | null;
}

/**
 * Pick the exchange to fold into memory after a turn finished: the assistant
 * reply immediately BEFORE the one identified by `currentAssistantMessageId`
 * (falling back to the transcript's last reply when the id is unknown, e.g.
 * already deleted), plus the user message that prompted it. Returns null when
 * no older exchange exists yet — the memory simply stays as-is.
 */
export function selectLaggedIncrementalTurn(
  rows: MemoryTranscriptRow[],
  currentAssistantMessageId?: string | null,
): LaggedIncrementalTurn | null {
  const visible = rows.filter((r) => r.role === "user" || r.role === "assistant");
  let currentIdx = currentAssistantMessageId != null
    ? visible.findIndex((r) => r.id === currentAssistantMessageId)
    : -1;
  if (currentIdx === -1) {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i]!.role === "assistant") {
        currentIdx = i;
        break;
      }
    }
  }
  if (currentIdx === -1) return null;

  let prevIdx = -1;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (visible[i]!.role === "assistant") {
      prevIdx = i;
      break;
    }
  }
  if (prevIdx === -1) return null;

  const prev = visible[prevIdx]!;
  const before = visible[prevIdx - 1];
  const userMessage = before?.role === "user" ? before.content : "";
  return {
    assistantMessageId: prev.id,
    assistantMessage: prev.content,
    userMessage,
    stateSnapshot: prev.stateSnapshot ?? null,
  };
}

export interface LaggedRebuildWindow {
  /** Visible transcript up to and including the second-to-last reply. */
  rows: MemoryTranscriptRow[];
  /** The window's last assistant reply, or null when the window is empty. */
  processedMessageId: string | null;
}

/**
 * The full-rebuild counterpart of selectLaggedIncrementalTurn: everything up
 * to and including the second-to-last assistant reply. With at most one reply
 * the window is empty — under the lag-one invariant there is nothing to
 * memorize yet.
 */
export function selectLaggedRebuildWindow(rows: MemoryTranscriptRow[]): LaggedRebuildWindow {
  const visible = rows.filter((r) => r.role === "user" || r.role === "assistant");
  let lastIdx = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i]!.role === "assistant") {
      lastIdx = i;
      break;
    }
  }
  let prevIdx = -1;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (visible[i]!.role === "assistant") {
      prevIdx = i;
      break;
    }
  }
  if (prevIdx === -1) return { rows: [], processedMessageId: null };
  return { rows: visible.slice(0, prevIdx + 1), processedMessageId: visible[prevIdx]!.id };
}

export function formatSessionMemoryForPrompt(
  memory: unknown,
  opts?: {
    /** The player edited/deleted a message this memory may still describe
     *  (see playSessions.sessionMemoryStaleAt). The standing soft caveat below
     *  was not enough to stop a model from re-asserting an edited-away fact,
     *  so a stale memory gets a targeted, imperative warning instead. */
    staleSinceEdit?: boolean;
    /** Player-pinned notes (playSessions.sessionMemoryPinned). Listed FIRST
     *  and marked authoritative so they win over auto-written facts; injected
     *  even when the auto memory is empty or suppressed as degenerate. */
    pinned?: string | null;
  },
): string | null {
  const normalized = normalizeSessionMemory(memory);
  const memoryText =
    !normalized.text || isDegenerateSessionMemoryText(normalized.text) ? "" : normalized.text;
  const pinned = normalizePinnedMemory(opts?.pinned);
  if (!memoryText && !pinned) return null;

  const lines = ["[Session Memory]"];
  if (pinned) {
    lines.push(
      "Player-pinned notes — written by the player and never auto-edited. These are standing facts and instructions for this session: when anything in the auto-written memory or the recent chat contradicts them, the pinned notes win.",
      pinned,
    );
  }
  if (memoryText) {
    lines.push(
      "The following is editable continuity memory for this play session. Treat it as durable context, but prefer the recent visible chat if there is a direct contradiction.",
    );
    if (opts?.staleSinceEdit) {
      lines.push(
        "IMPORTANT: The player has EDITED or REMOVED earlier messages since this memory was written. Any detail below that the current transcript no longer supports (locations, events, wording) is obsolete — follow the transcript, never this memory, wherever they disagree.",
      );
    }
    lines.push(memoryText);
  }
  return lines.join("\n");
}
