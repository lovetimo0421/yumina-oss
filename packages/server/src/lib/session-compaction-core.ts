import { estimateTokens, estimateTokensFromMetrics, preloadTokenizer } from "@yumina/engine";
import { StorySummaryTruncatedError } from "./summary-episode-recovery.js";
import type { SessionSummaryMode } from "@yumina/shared";

/**
 * The minimum a row must expose to be COUNTED and TOKEN-ESTIMATED — no body.
 *
 * Counting is all the memory panel ever needed, but it used to get there by
 * loading every message body in the session (routes/session-memory.ts, no
 * LIMIT): ~52 MB off disk and several string-scanning passes on the single Node
 * main thread for a 7k-message session, which blocked the event loop for 20-46 s
 * and took both replicas down behind Cloudflare 502s on 2026-08-15.
 *
 * Rows carrying `contentLen`/`contentCjkLen` (from `messages.content_len` /
 * `content_cjk_len`) estimate from those integers instead. Truncating the row
 * set was the tempting alternative and the wrong one — the panel reports totals
 * over the whole backlog, so a LIMIT silently under-reports for exactly the
 * users with the biggest sessions.
 */
export type StoryMessageSizing = {
  id: string;
  role: string;
  createdAt?: Date | string | null;
  attachments?: Array<unknown> | null;
  content?: string;
  contentLen?: number | null;
  contentCjkLen?: number | null;
};

/** A row loaded WITH its body — required to actually summarize/compact. */
export type StoryMessageRow = StoryMessageSizing & { content: string };

export type CompactionWindow<T extends StoryMessageSizing = StoryMessageRow> = {
  compactable: T[];
  retained: T[];
  estimatedTotalTokens: number;
  estimatedCompactableTokens: number;
};

export type StoryCompactionProgress = {
  mode: SessionSummaryMode;
  currentTokens: number;
  triggerTokens: number;
  recentTailTokens: number;
  remainingTokens: number;
  percent: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  canCompactNow: boolean;
  compactableTokens: number;
  compactableMessageCount: number;
  retainedTokens: number;
  retainedMessageCount: number;
};

// Defaults retuned 2026-06-11 from a real dense-CJK session replay (绝世唐门
// log, ~1.4k tokens per exchange): 50k/20k compacted once in 56 turns while
// re-sending 27k of raw history per send; 32k/12k compacts every ~19 turns,
// keeps ~8 exchanges verbatim, and roughly halves the per-send raw cost.
export const STORY_COMPACTION_TRIGGER_TOKENS = 32_000;
// Minimums sit BELOW the defaults (the panel mirrors them in
// session-memory-modal.tsx). They used to EQUAL the defaults, which made the
// panel's Apply silently clamp any lower value back up — indistinguishable
// from a reset — and made it impossible to bring the trigger under a small
// context budget. A trigger below recentTail + min chunk simply waits until a
// window is workable (selectCompactionWindow returns null until then), so low
// values are safe.
export const STORY_COMPACTION_MIN_TRIGGER_TOKENS = 8_000;
export const STORY_COMPACTION_MAX_TRIGGER_TOKENS = 2_000_000;
export const STORY_COMPACTION_RECENT_TAIL_TOKENS = 12_000;
export const STORY_COMPACTION_MIN_RECENT_TAIL_TOKENS = 4_000;
export const STORY_COMPACTION_MAX_RECENT_TAIL_TOKENS = 2_000_000;
export const STORY_COMPACTION_DEFAULT_CONTEXT_TOKENS = 42_000;
export const STORY_COMPACTION_OVERFLOW_MIN_CHUNK_TOKENS = 0;
export const STORY_COMPACTION_MIN_CHUNK_TOKENS = 4_000;
export const STORY_COMPACTION_TARGET_CHUNK_TOKENS = 5_000;
export const STORY_SUMMARY_MAX_CHARS = 12_000;

export type StoryCompactionBudgetDecision =
  | "available"
  | "recovery-probe"
  | "soft-capped";

export const STORY_COMPACTION_SOFT_CALL_BUDGET = 150;
export const STORY_COMPACTION_MAX_MESSAGES_PER_RUN = 400;
export const STORY_COMPACTION_MAX_EPISODE_CHUNKS_PER_RUN = 15;
// Fifteen episode calls plus one merge call, with room for one refusal
// fallback per call. This bounds one job without locking a player out for a
// day; additional backlog is handled oldest-first by later jobs.
export const STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN =
  (STORY_COMPACTION_MAX_EPISODE_CHUNKS_PER_RUN + 1) * 2;

export const STORY_COMPACTION_BUDGET_ERROR =
  "Daily story-summary budget reached for this session — automatic compaction is paused. You can dismiss this warning, resume with one recovery attempt, or run Compact manually.";
// Kept only so sessions paused by the retired 300/day policy can recover.
export const STORY_COMPACTION_HARD_BUDGET_ERROR =
  "Story-summary safety ceiling reached for this session — automatic compaction resumes when the UTC daily limit resets. Manual Compact is still available.";
export const LEGACY_STORY_COMPACTION_BUDGET_ERROR =
  "Daily story-summary budget reached for this session — auto-compaction resumes tomorrow. You can still run Compact manually from the memory panel.";
export const STORY_COMPACTION_ATTEMPT_BUDGET_ERROR =
  "Story-summary job exceeded its per-run provider-attempt safety limit";

export function isStoryCompactionSoftBudgetError(error: string | null | undefined): boolean {
  return error === STORY_COMPACTION_BUDGET_ERROR
    || error === LEGACY_STORY_COMPACTION_BUDGET_ERROR
    || error === STORY_COMPACTION_HARD_BUDGET_ERROR;
}

export type StoryCompactionAttemptBudget = {
  tryConsume: () => boolean;
  remaining: () => number;
};

/**
 * A job-local provider-attempt allowance. Consumption is synchronous, so
 * parallel episode promises cannot race past the per-run allowance.
 * Refusal fallbacks consume another attempt just like their initial request.
 */
export function createStoryCompactionAttemptBudget(maxAttempts: number): StoryCompactionAttemptBudget {
  let remainingAttempts = Math.max(0, Math.floor(maxAttempts));
  return {
    tryConsume: () => {
      if (remainingAttempts <= 0) return false;
      remainingAttempts -= 1;
      return true;
    },
    remaining: () => remainingAttempts,
  };
}

/** Pure policy helper so the safety/recovery behavior is easy to verify. */
export function resolveStoryCompactionBudgetDecision(args: {
  windowCalls: number;
  resumePending: boolean;
  softLimit: number;
}): StoryCompactionBudgetDecision {
  if (args.resumePending) return "recovery-probe";
  if (args.windowCalls >= args.softLimit) return "soft-capped";
  return "available";
}

/** The soft window never reaches behind the current UTC day boundary. */
export function resolveStoryCompactionBudgetWindowStart(
  utcDayStart: Date,
  recoveredAt: Date | null | undefined,
): Date {
  return recoveredAt && recoveredAt > utcDayStart ? recoveredAt : utcDayStart;
}

export function estimateTextTokens(text: string, modelId?: string): number {
  return estimateTokens(text, modelId);
}

export function normalizeSessionSummaryMode(input: unknown): SessionSummaryMode {
  return input === "overflow" ? "overflow" : "threshold";
}

export function normalizeSessionSummaryTriggerTokens(input: unknown): number {
  const numeric = typeof input === "number" ? input : Number(input);
  // null/0/negative mean "unset — use the default", NOT "clamp to the
  // minimum": Number(null) is 0, and while the minimums equalled the defaults
  // that case accidentally returned the default. Without this guard, lowering
  // the minimums would silently turn every UNSET session's trigger into the
  // minimum.
  if (!Number.isFinite(numeric) || numeric <= 0) return STORY_COMPACTION_TRIGGER_TOKENS;
  return Math.max(
    STORY_COMPACTION_MIN_TRIGGER_TOKENS,
    Math.min(STORY_COMPACTION_MAX_TRIGGER_TOKENS, Math.floor(numeric)),
  );
}

export function normalizeSessionSummaryRecentTailTokens(input: unknown): number {
  const numeric = typeof input === "number" ? input : Number(input);
  // See normalizeSessionSummaryTriggerTokens — unset must mean DEFAULT.
  if (!Number.isFinite(numeric) || numeric <= 0) return STORY_COMPACTION_RECENT_TAIL_TOKENS;
  return Math.max(
    STORY_COMPACTION_MIN_RECENT_TAIL_TOKENS,
    Math.min(STORY_COMPACTION_MAX_RECENT_TAIL_TOKENS, Math.floor(numeric)),
  );
}

/**
 * Background threshold compaction must fire BELOW the send-path overflow
 * trigger (≈ the final raw-history budget) or it never fires at all: the
 * awaited overflow compaction keeps the transcript pinned at the budget, the
 * 50k default is never reached, and every compaction happens synchronously
 * before a send. When the context budget is known, cap the trigger at half of
 * it — but never below what a window can actually produce (recent tail + one
 * minimum chunk). Callers should only apply this when the user has NOT set an
 * explicit custom trigger.
 */
export function resolveThresholdTriggerTokens(
  userTriggerTokens: number,
  contextTokenLimit?: number | null,
): number {
  if (typeof contextTokenLimit !== "number" || !Number.isFinite(contextTokenLimit) || contextTokenLimit <= 0) {
    return userTriggerTokens;
  }
  const minWorkableTrigger = STORY_COMPACTION_RECENT_TAIL_TOKENS + STORY_COMPACTION_MIN_CHUNK_TOKENS;
  return Math.min(userTriggerTokens, Math.max(Math.floor(contextTokenLimit / 2), minWorkableTrigger));
}

export function getStoryCompactionTargets(options: {
  mode?: SessionSummaryMode | null;
  contextTokenLimit?: number | null;
  triggerTokens?: number;
  recentTailTokens?: number;
  minCompactableTokens?: number;
} = {}): {
  mode: SessionSummaryMode;
  triggerTokens: number;
  recentTailTokens: number;
  minCompactableTokens: number;
} {
  const mode = normalizeSessionSummaryMode(options.mode);
  if (mode === "overflow") {
    const contextTokenLimit = typeof options.contextTokenLimit === "number" && Number.isFinite(options.contextTokenLimit)
      ? Math.max(1, Math.floor(options.contextTokenLimit))
      : STORY_COMPACTION_DEFAULT_CONTEXT_TOKENS;
    return {
      mode,
      triggerTokens: options.triggerTokens ?? contextTokenLimit,
      recentTailTokens: options.recentTailTokens ?? contextTokenLimit,
      minCompactableTokens: options.minCompactableTokens ?? STORY_COMPACTION_OVERFLOW_MIN_CHUNK_TOKENS,
    };
  }
  const recentTailTokens = options.recentTailTokens ?? STORY_COMPACTION_RECENT_TAIL_TOKENS;
  const minCompactableTokens = options.minCompactableTokens ?? STORY_COMPACTION_MIN_CHUNK_TOKENS;
  // A window can only form once the transcript exceeds the kept tail plus one
  // minimum chunk, so a trigger below that floor is unreachable: the progress
  // bar hit 100% while selectCompactionWindow kept returning null ("trigger
  // crossed but nothing happens"). Raising the trigger to the workable floor
  // keeps the threshold check, canCompactNow, and the panel's displayed
  // target telling the same story. Outcomes don't change — in the raised
  // range the window was always null anyway.
  return {
    mode,
    triggerTokens: Math.max(
      options.triggerTokens ?? STORY_COMPACTION_TRIGGER_TOKENS,
      recentTailTokens + minCompactableTokens,
    ),
    recentTailTokens,
    minCompactableTokens,
  };
}

type SizingFields = Pick<StoryMessageSizing, "role" | "content" | "attachments" | "contentLen" | "contentCjkLen">;
type SizingCache = Omit<SizingFields, "attachments"> & {
  modelId?: string;
  attachmentCount: number;
  tokens: number;
};
const messageTokenCache = new WeakMap<SizingFields, SizingCache>();
// Do not retain startup heuristic counts after the real tokenizer loads.
let tokenCountsStable = false;
void preloadTokenizer().then(() => { tokenCountsStable = true; });

export function estimateMessageTokens(message: SizingFields, modelId?: string): number {
  const attachmentCount = message.attachments?.length ?? 0;
  const cached = messageTokenCache.get(message);
  if (cached && cached.modelId === modelId && cached.content === message.content
    && cached.role === message.role && cached.contentLen === message.contentLen
    && cached.contentCjkLen === message.contentCjkLen && cached.attachmentCount === attachmentCount) return cached.tokens;
  const attachmentTokens = Array.isArray(message.attachments) && message.attachments.length > 0
    ? 16 + message.attachments.length * 24
    : 0;
  // The estimator sees `${role}: ${content}`, so the role label's characters
  // count too — they are ASCII, hence added to the total but not the CJK count.
  if (message.contentLen != null && message.contentCjkLen != null) {
    const prefixChars = message.role.length + 2; // "role" + ": "
    return (
      6 +
      estimateTokensFromMetrics(prefixChars + message.contentLen, message.contentCjkLen, modelId) +
      attachmentTokens
    );
  }
  const tokens = 6 + estimateTextTokens(`${message.role}: ${message.content ?? ""}`, modelId) + attachmentTokens;
  if (tokenCountsStable) {
    messageTokenCache.set(message, {
      modelId, content: message.content, role: message.role,
      contentLen: message.contentLen, contentCjkLen: message.contentCjkLen, attachmentCount, tokens,
    });
  }
  return tokens;
}

export function estimateMessagesTokens(messages: SizingFields[], modelId?: string): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message, modelId), 0);
}

function cleanStorySummaryText(input: unknown): string {
  const text = typeof input === "string" ? input : String(input ?? "");
  return text
    .trim()
    .replace(/^```(?:markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function normalizeStorySummaryText(input: unknown): string {
  const trimmed = cleanStorySummaryText(input);
  if (trimmed.length <= STORY_SUMMARY_MAX_CHARS) return trimmed;
  return trimmed.slice(0, STORY_SUMMARY_MAX_CHARS).trim();
}

export class StorySummaryTooLongError extends Error {
  constructor() {
    super("Summary exceeded the safe storage size; no summary was saved");
    this.name = "StorySummaryTooLongError";
  }
}

export function storySummaryEmptyOutputMessage(args: {
  stopReason?: string;
  sawReasoning?: boolean;
  reasoningTokens?: number;
}): string {
  const reasoningOnly = !!args.sawReasoning || (args.reasoningTokens ?? 0) > 0;
  if (args.stopReason === "max_tokens" && reasoningOnly) {
    return "Summary model spent its entire output limit on reasoning and returned no story summary. "
      + "Reasoning was disabled for summaries, but the provider ignored that setting; verify the provider settings or choose another summary model.";
  }
  if (reasoningOnly) {
    return "Summary model returned reasoning but no story summary. Reasoning was disabled for summaries, "
      + "but the provider ignored that setting; verify the provider settings or choose another summary model.";
  }
  if (args.stopReason === "max_tokens") {
    return "Summary model reached its output limit without returning a story summary";
  }
  return "Summary model returned an empty story summary";
}

/**
 * Finish one provider call in billing-safe order. Usage is always recorded,
 * including empty output, but player billing happens only after usable final
 * text has been validated. The callbacks keep this policy independently
 * testable without importing the database-backed compaction worker.
 */
export async function finalizeStorySummaryOutput(args: {
  text: string;
  stopReason?: string;
  sawReasoning?: boolean;
  reasoningTokens?: number;
  recordUsage?: () => Promise<void>;
  billUsage?: () => Promise<void>;
}): Promise<string> {
  await args.recordUsage?.();
  // Generated output must pass the safety ceiling whole, before the read-side
  // clamp can discard final facts and before the player is charged.
  const normalized = cleanStorySummaryText(args.text);
  if (!normalized) throw new Error(storySummaryEmptyOutputMessage(args));
  if (args.stopReason === "max_tokens") {
    throw new StorySummaryTruncatedError();
  }
  if (normalized.length > STORY_SUMMARY_MAX_CHARS) throw new StorySummaryTooLongError();
  await args.billUsage?.();
  return normalized;
}

/** Map transcript chunks in order, optionally requiring a one-call health
 * probe before opening bounded concurrency against a custom endpoint. */
export async function summarizeStoryEpisodeTranscripts<T>(args: {
  transcripts: string[];
  summarize: (transcript: string) => Promise<T>;
  probeFirst: boolean;
  concurrency: number;
}): Promise<T[]> {
  const results: T[] = [];
  let start = 0;
  if (args.probeFirst && args.transcripts.length > 0) {
    results.push(await args.summarize(args.transcripts[0]!));
    start = 1;
  }

  const concurrency = Math.max(1, Math.floor(args.concurrency));
  for (let i = start; i < args.transcripts.length; i += concurrency) {
    // Drain siblings before releasing the session claim, including on failure.
    const batch = await Promise.allSettled(args.transcripts.slice(i, i + concurrency).map(args.summarize));
    const failed = batch.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    results.push(...batch.map(result => (result as PromiseFulfilledResult<T>).value));
  }
  return results;
}

export function hasStorySummary(summary: unknown): boolean {
  return normalizeStorySummaryText(summary).length > 0;
}

export function formatStorySummaryForPrompt(summary: unknown): string | null {
  const normalized = normalizeStorySummaryText(summary);
  return normalized ? `[Summary of earlier events]\n${normalized}` : null;
}

export function formatMessagesForStoryCompaction(messages: StoryMessageRow[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message, index) => {
      const label = message.role === "user" ? "USER" : "ASSISTANT";
      const attachmentNote = Array.isArray(message.attachments) && message.attachments.length > 0
        ? `\n[Attachments: ${message.attachments.length} file(s)]`
        : "";
      return `[${index + 1}] ${label} (${message.id})\n${message.content}${attachmentNote}`;
    })
    .join("\n\n");
}

export function selectCompactionWindow<T extends StoryMessageSizing>(
  messages: T[],
  options: {
    triggerTokens?: number;
    recentTailTokens?: number;
    minCompactableTokens?: number;
    mode?: SessionSummaryMode | null;
    contextTokenLimit?: number | null;
    modelId?: string;
  } = {},
): CompactionWindow<T> | null {
  const relevant = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const targets = getStoryCompactionTargets(options);
  const triggerTokens = targets.triggerTokens;
  const recentTailTokens = targets.recentTailTokens;
  const minCompactableTokens = targets.minCompactableTokens;
  const estimatedTotalTokens = estimateMessagesTokens(relevant, options.modelId);

  if (estimatedTotalTokens < triggerTokens) return null;
  if (relevant.length < 6) return null;

  let retainedTokens = 0;
  let splitIndex = relevant.length;
  for (let i = relevant.length - 1; i >= 0; i--) {
    retainedTokens += estimateMessageTokens(relevant[i]!, options.modelId);
    splitIndex = i;
    if (retainedTokens >= recentTailTokens && i < relevant.length - 2) break;
  }

  const compactable = relevant.slice(0, splitIndex);
  const retained = relevant.slice(splitIndex);
  const estimatedCompactableTokens = estimateMessagesTokens(compactable, options.modelId);
  if (compactable.length < 4 || estimatedCompactableTokens < minCompactableTokens) return null;

  return {
    compactable,
    retained,
    estimatedTotalTokens,
    estimatedCompactableTokens,
  };
}

export function selectForcedManualCompactionWindow(
  messages: StoryMessageRow[],
  options: {
    modelId?: string;
    retainedMessageCount?: number;
    minCompactableMessages?: number;
    retainedTailTokens?: number;
  } = {},
): CompactionWindow | null {
  const relevant = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const minCompactableMessages = Math.max(1, Math.floor(options.minCompactableMessages ?? 2));

  // Token-tail mode (preferred): honor the session's configured raw-kept tail
  // (保留原文 / recentTailTokens) even on a forced manual compaction. Keep the
  // most recent `retainedTailTokens` worth of raw dialogue and compact only what
  // is OLDER than that tail. A force relaxes the auto-window's minimum-chunk
  // guards (`selectCompactionWindow` needs >= 6 relevant msgs and a >= 4-msg /
  // minCompactableTokens chunk) so a short backlog can still be compacted — but
  // it does NOT abandon the tail budget. When the whole uncompacted transcript
  // already fits inside the tail, there is nothing older to compact and this
  // returns null (a genuine no-op) instead of crushing the raw window down to
  // the latest 2 messages.
  if (typeof options.retainedTailTokens === "number" && Number.isFinite(options.retainedTailTokens) && options.retainedTailTokens > 0) {
    const retainedTailTokens = Math.floor(options.retainedTailTokens);
    let retainedTokens = 0;
    let splitIndex = relevant.length;
    for (let i = relevant.length - 1; i >= 0; i--) {
      retainedTokens += estimateMessageTokens(relevant[i]!, options.modelId);
      splitIndex = i;
      if (retainedTokens >= retainedTailTokens) break;
    }
    const compactable = relevant.slice(0, splitIndex);
    const retained = relevant.slice(splitIndex);
    if (compactable.length < minCompactableMessages) return null;
    return {
      compactable,
      retained,
      estimatedTotalTokens: estimateMessagesTokens(relevant, options.modelId),
      estimatedCompactableTokens: estimateMessagesTokens(compactable, options.modelId),
    };
  }

  // Legacy count-based fallback: keep the latest N raw messages (default 2).
  const retainedMessageCount = Math.max(1, Math.floor(options.retainedMessageCount ?? 2));
  if (relevant.length < retainedMessageCount + minCompactableMessages) return null;

  const splitIndex = relevant.length - retainedMessageCount;
  const compactable = relevant.slice(0, splitIndex);
  const retained = relevant.slice(splitIndex);
  const estimatedTotalTokens = estimateMessagesTokens(relevant, options.modelId);
  const estimatedCompactableTokens = estimateMessagesTokens(compactable, options.modelId);
  if (compactable.length < minCompactableMessages) return null;

  return {
    compactable,
    retained,
    estimatedTotalTokens,
    estimatedCompactableTokens,
  };
}

export function splitMessagesIntoCompactionChunks(
  messages: StoryMessageRow[],
  targetTokens = STORY_COMPACTION_TARGET_CHUNK_TOKENS,
  modelId?: string,
): StoryMessageRow[][] {
  const chunks: StoryMessageRow[][] = [];
  let current: StoryMessageRow[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const tokens = estimateMessageTokens(message, modelId);
    if (current.length > 0 && currentTokens + tokens > targetTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += tokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Select the oldest bounded prefix that one compaction job may process. */
export function selectStoryCompactionRunSlice<T extends StoryMessageRow>(
  messages: T[],
  options: {
    maxMessages?: number;
    maxEpisodeChunks?: number;
    modelId?: string;
  } = {},
): { slice: T[]; remainder: T[] } {
  const maxMessages = Math.max(
    1,
    Math.floor(options.maxMessages ?? STORY_COMPACTION_MAX_MESSAGES_PER_RUN),
  );
  const maxEpisodeChunks = Math.max(
    1,
    Math.floor(options.maxEpisodeChunks ?? STORY_COMPACTION_MAX_EPISODE_CHUNKS_PER_RUN),
  );
  const messageBounded = messages.slice(0, maxMessages);
  const chunks = splitMessagesIntoCompactionChunks(messageBounded, undefined, options.modelId);
  const slice = chunks.slice(0, maxEpisodeChunks).flat() as T[];
  return {
    slice,
    remainder: messages.slice(slice.length),
  };
}

export function getStoryCompactionProgress(
  messages: StoryMessageSizing[],
  options: {
    triggerTokens?: number;
    recentTailTokens?: number;
    minCompactableTokens?: number;
    mode?: SessionSummaryMode | null;
    contextTokenLimit?: number | null;
    modelId?: string;
  } = {},
): StoryCompactionProgress {
  const relevant = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const targets = getStoryCompactionTargets(options);
  const triggerTokens = targets.triggerTokens;
  const recentTailTokens = targets.recentTailTokens;
  const currentTokens = estimateMessagesTokens(relevant, options.modelId);
  const window = selectCompactionWindow(messages, options);
  const retainedTokens = window ? estimateMessagesTokens(window.retained, options.modelId) : Math.min(currentTokens, recentTailTokens);

  return {
    mode: targets.mode,
    currentTokens,
    triggerTokens,
    recentTailTokens,
    remainingTokens: Math.max(0, triggerTokens - currentTokens),
    percent: triggerTokens > 0 ? Math.min(100, Math.round((currentTokens / triggerTokens) * 100)) : 100,
    messageCount: relevant.length,
    userMessageCount: relevant.filter((message) => message.role === "user").length,
    assistantMessageCount: relevant.filter((message) => message.role === "assistant").length,
    canCompactNow: window !== null,
    compactableTokens: window?.estimatedCompactableTokens ?? 0,
    compactableMessageCount: window?.compactable.length ?? 0,
    retainedTokens,
    retainedMessageCount: window?.retained.length ?? relevant.length,
  };
}
