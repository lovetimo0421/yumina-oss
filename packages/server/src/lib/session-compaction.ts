import { NARRATIVE_EVIDENCE_RULES } from "./narrative-evidence.js";
import { assertPriorCoverage, continuitySnapshotGuard, historicalStateGuard, loadHistoricalState, STORY_INPUT_FIELDS, type HistoricalState } from "./continuity-guards.js";
import { memorySourceGuard } from "./session-memory-guards.js";
import { usageObservation } from "./usage-observation.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, exists, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, usageLogs, worlds, creditTransactions, creditWallets } from "../db/schema.js";
import { recordUsageLog } from "./usage-log.js";
import {
  billBackgroundUsage,
  prepareBackgroundUsageBill,
  hasBackgroundRunBudget,
  notEnoughMushiesMessage,
} from "./background-billing.js";
import { resolveProviderForModel } from "./resolve-provider.js";
import { calculateCost } from "./credit-service.js";
import { beginModuleGeneration } from "./module-generation-access.js";
import { planAllowedModel } from "./plan-model-gate.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { captureServerEvent } from "./analytics.js";
import { isExtensionInstalled } from "./extensions.js";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import type { SummaryCompactionNoOpCode } from "@yumina/shared";
import type { ChatMessage } from "./llm/types.js";
import { enqueueKeyedJob } from "./job-chain.js";
import { omitSummaryMetadata } from "./persona-metadata.js";
import { storyPreflightFailureGuard, type StoryPreflightSnapshot } from "./session-compaction-guards.js";
import { buildEpisodeSummaryPrompt, recoverStoryMerge, withStoryMergeBudget } from "./story-summary-prompts.js";
import { recoverSummaryEpisode } from "./summary-episode-recovery.js";
import { episodeCheckpointKey, loadEpisodeCheckpoint, saveEpisodeCheckpoint } from "./summary-job-store.js";
import { SUMMARY_CLAIM_TTL_MS, type SummaryRunControl } from "./summary-job-core.js";
import {
  finalizeStorySummaryOutput,
  formatMessagesForStoryCompaction,
  estimateMessagesTokens,
  estimateMessageTokens,
  normalizeSessionSummaryRecentTailTokens,
  normalizeSessionSummaryTriggerTokens,
  normalizeStorySummaryText,
  resolveThresholdTriggerTokens,
  selectCompactionWindow,
  selectForcedManualCompactionWindow,
  splitMessagesIntoCompactionChunks,
  summarizeStoryEpisodeTranscripts,
  selectStoryCompactionRunSlice,
  estimateTextTokens,
  createStoryCompactionAttemptBudget,
  isStoryCompactionSoftBudgetError,
  LEGACY_STORY_COMPACTION_BUDGET_ERROR,
  resolveStoryCompactionBudgetDecision,
  resolveStoryCompactionBudgetWindowStart,
  STORY_COMPACTION_ATTEMPT_BUDGET_ERROR,
  STORY_COMPACTION_BUDGET_ERROR,
  STORY_COMPACTION_DEFAULT_CONTEXT_TOKENS,
  STORY_COMPACTION_HARD_BUDGET_ERROR,
  STORY_COMPACTION_MAX_MESSAGES_PER_RUN,
  STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN,
  STORY_COMPACTION_SOFT_CALL_BUDGET,
  type StoryCompactionAttemptBudget,
  type StoryMessageRow,
} from "./session-compaction-core.js";
import { buildSummaryLanguageInstruction, resolveSummaryOutputLanguage, type SessionSummaryLanguage } from "./summary-language.js";
import { generateWithSummaryFallback } from "./summary-fallback.js";
import { forEachCooperatively } from "./cooperative-tokens.js";

export {
  formatStorySummaryForPrompt,
  hasStorySummary,
  isStoryCompactionSoftBudgetError,
  normalizeSessionSummaryMode,
  normalizeStorySummaryText,
} from "./session-compaction-core.js";

// Cheap, fast, CJK-aware background summarizer. Aligns its tokenizer with the
// default CJK-aware play model (anthropic/claude-sonnet-4.6) so the compaction
// window and the prompt budget agree on Chinese token counts. (Was
// x-ai/grok-4.1-fast, now deprecated → silently redirected to the ~20x-pricier
// x-ai/grok-4.20; see DEPRECATED_MODEL_REDIRECTS in routes/messages.ts.)
export const DEFAULT_STORY_SUMMARY_MODEL = "google/gemini-3.1-flash-lite";

const STORY_SUMMARY_SOURCE_HASH_VERSION = 3;
type StoryUsage = Parameters<typeof billBackgroundUsage>[0];
const MAX_STATE_CHARS = 8_000;
// Provider safety caps leave room to finish above the prompts' soft targets.
const MAX_EPISODE_SUMMARY_TOKENS = 2_048;
const MAX_MERGE_SUMMARY_TOKENS = 4_096;

type StoryCompactionStatus = "idle" | "updating" | "failed";

type StoryCompactionArgs = {
  run?: SummaryRunControl;
  sessionId: string;
  userId: string;
  fallbackModel: string;
  contextTokenLimit?: number | null;
  finalPromptRawTokenLimit?: number | null;
  force?: boolean;
  /** The card switched the summary on (settings.storySummary), so the
   *  player's extension entitlement is not what gates this run. */
  authorRequired?: boolean;
  /** Fold ahead of the overflow: compact once the raw history passes this
   *  many tokens, keeping finalPromptRawTokenLimit as the tail. The shorter
   *  history and the new summary then reach the same prompt, so the cached
   *  conversation breaks once per fold instead of once at the cut and again
   *  when the summary lands a turn later. */
  foldAtTokens?: number | null;
  /** A first summary recaps only the newest this-many tokens of history,
   *  the part a prompt could still carry. Older rows leave the history
   *  without a recap: no prompt has shown them for a while, and summarising
   *  a long backlog at once charged one player 2,738 mushies in a single run. */
  recapWithinTokens?: number | null;
};

/** How many of the oldest `compactable` rows lie beyond the newest
 *  `withinTokens` of the transcript: they fold without being summarised.
 *  The newest compactable row is always summarised. */
function unseenBacklogCount<T extends StoryMessageRow>(
  compactable: T[],
  retained: T[],
  withinTokens: number,
  model: string,
): number {
  let seen = 0;
  for (const message of retained) seen += estimateMessageTokens(message, model);
  let i = compactable.length;
  while (i > 0 && seen + estimateMessageTokens(compactable[i - 1]!, model) <= withinTokens) {
    seen += estimateMessageTokens(compactable[--i]!, model);
  }
  return Math.min(i, compactable.length - 1);
}

/** The author's one line to the summariser, from the card's settings. */
function storySummaryFocus(settings: unknown): string | null {
  const focus = (settings as { storySummary?: { focus?: unknown } } | null)?.storySummary?.focus;
  return typeof focus === "string" && focus.trim() ? focus.trim().slice(0, 600) : null;
}

type PreparedStorySummaryJob = {
  snapshot: typeof playSessions.$inferSelect;
  boundaryState: HistoricalState;
  charges: StoryUsage[];
  claimedModel?: string;
  model: string;
  sourceHash: string;
  mode: "compact" | "regenerate";
  sourceMessages: Array<Pick<StoryMessageRow, "id" | "role" | "content">>;
  compactedMessageIds: string[];
  coversUntilMessageId: string | null;
};

export type ManualStoryCompactionResult = {
  summary: string;
  compactedCount: number;
  compactedFromMessageId: string | null;
  compactedToMessageId: string | null;
  compactedFromOrdinal: number | null;
  compactedToOrdinal: number | null;
  compactedFromPreview: string | null;
  compactedToPreview: string | null;
  compactedUntilOneLine: string | null;
  compactedTokenEstimate: number;
  retainedCount: number;
  retainedTokenEstimate: number;
  noOpReason: string | null;
  noOpReasonCode: SummaryCompactionNoOpCode | null;
};

type StorySummaryBuildResult = {
  summary: string;
  endingOneLine: string | null;
};

const storyCompactionJobChains = new Map<string, Promise<unknown>>();
const queuedStoryCompactions = new Map<string, StoryCompactionArgs>();
const storyCompactionDrainActive = new Set<string>();

/**
 * Stop background auto-retries after this many consecutive drain failures
 * (mirror of SESSION_MEMORY_MAX_CONSECUTIVE_FAILURES). Tracked in-memory —
 * no schema change — so a restart grants a fresh budget; a successful
 * persist or any manual compaction/regenerate also resets it. Without this,
 * a persistently broken summary config (bad BYOK model, revoked key) burns a
 * full multi-call compaction on EVERY turn forever.
 */
const STORY_COMPACTION_MAX_CONSECUTIVE_FAILURES = 3;
const storyCompactionFailureCounts = new Map<string, number>();

/**
 * Per-run ceiling on how many messages one compaction job may summarize.
 * A first-time compaction of a mega backlog (9k+ uncompacted messages) used
 * to format/chunk/hash the ENTIRE transcript in-process and fire hundreds of
 * episode LLM calls in one job — heavy synchronous work on the web process
 * (2026-08-11 outage). Oldest messages compact first, chronology preserved;
 * The run-slice helper also caps the slice at 15 episode chunks. The remainder
 * compacts on subsequent runs (one slice per turn/manual run), so a huge
 * backlog drains incrementally instead of all at once.
 */
async function getStoryCompactionBudgetDecision(args: {
  sessionId: string;
  windowStartedAt: Date | null;
  resumePending: boolean;
}) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const windowStart = resolveStoryCompactionBudgetWindowStart(todayStart, args.windowStartedAt);
  const windowResult = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usageLogs)
    .where(and(
      eq(usageLogs.sessionId, args.sessionId),
      eq(usageLogs.endpoint, "story-compaction"),
      gte(usageLogs.createdAt, windowStart),
    ));
  const windowCalls = Number(windowResult[0]?.n ?? 0);
  return {
    decision: resolveStoryCompactionBudgetDecision({
      windowCalls,
      resumePending: args.resumePending,
      softLimit: STORY_COMPACTION_SOFT_CALL_BUDGET,
    }),
    windowCalls,
  };
}

function stringifyCompact(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? {}, null, 2);
  } catch {
    text = String(value ?? "");
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}\n... [truncated]`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function createStorySourceHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```(?:json|markdown|md|text)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = stripCodeFence(text);
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractEpisodeEndingOneLine(episodeSummary: string | undefined): string | null {
  if (!episodeSummary) return null;
  const parsed = parseJsonObject(episodeSummary);
  const ending = parsed?.endingOneLine;
  if (typeof ending === "string" && ending.trim()) {
    return ending.replace(/\s+/g, " ").trim().slice(0, 240);
  }
  return null;
}

function previewStoryMessage(message: StoryMessageRow | undefined, maxChars = 140): string | null {
  if (!message) return null;
  const text = message.content.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const prefix = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : message.role;
  const preview = text.length > maxChars ? `${text.slice(0, maxChars - 1).trim()}...` : text;
  return `${prefix}: ${preview}`;
}

function enqueueStoryCompactionJob<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
  return enqueueKeyedJob(storyCompactionJobChains, sessionId, job);
}

/**
 * Content-safety refusals are model-inherent, not transient: retrying the same
 * model can never summarize this session (much of the catalog is NSFW /
 * real-person roleplay, which Gemini-family filters reject wholesale — 86 of
 * the 117 failed-summary sessions on 2026-07-11 were content refusals). Retry
 * once on a tolerant non-Gemini model instead of failing the whole compaction.
 */
const STORY_SUMMARY_REFUSAL_FALLBACK_MODEL = "deepseek/deepseek-v3.2";

/**
 * OpenRouter hosts that break summary calls for a model. GMICloud serves
 * deepseek-v3.2 with reasoning on regardless of the request: in a sample of
 * 60 compaction calls over 4,096 output tokens (max_tokens 2,048/4,096,
 * reasoning off), all 60 were GMICloud with reasoning tokens, up to 49k
 * tokens per call; it also caused the "DataInspectionFailed" 502s (238
 * failed runs, 2026-10-12..18). The ~10 other hosts behaved.
 */
const SUMMARY_IGNORED_PROVIDERS: Record<string, string[]> = {
  "deepseek/deepseek-v3.2": ["gmicloud"],
};

/**
 * Set to true once a call in this run fell back to the refusal model; the
 * run's later calls then start on the fallback instead of paying another
 * refused call each. Deliberately run-scoped: it used to be persisted as the
 * session's summaryModel, which silently replaced the player's choice for
 * good after a single refusal (248 of the week's active summary sessions had
 * deepseek-v3.2 saved, 2026-10-19).
 */
type RefusalFallbackTracker = { refusalFallbackUsed: boolean };

// Exported for the run-scope summarizer (lib/run-summary.ts): one background
// LLM call with the same billing, usage logging and refusal fallback as story
// compaction — a second copy of this plumbing is how billing bugs are born.
export async function generateStorySummaryText(args: {
  signal?: AbortSignal;
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  endpoint: string;
  maxTokens: number;
  /** Background AIs may set their own; summaries stay at 0.2. */
  temperature?: number;
  /** A UI AI that answers in JSON asks the model for it. */
  responseFormat?: { type: "json_object" };
  fallbackTracker?: RefusalFallbackTracker;
  attemptBudget?: StoryCompactionAttemptBudget;
  deferUsage?: (usage: StoryUsage) => void;
}): Promise<string> {
  const candidates: Array<{ model: string; text: string; usage?: StoryUsage }> = [];
  const result = await generateWithSummaryFallback({
    model: args.fallbackTracker?.refusalFallbackUsed ? STORY_SUMMARY_REFUSAL_FALLBACK_MODEL : args.model,
    fallbackModel: STORY_SUMMARY_REFUSAL_FALLBACK_MODEL,
    onFallback: (reason) => console.warn(
      `[StoryCompaction] ${args.model} cannot summarize (${reason}) — retrying on ${STORY_SUMMARY_REFUSAL_FALLBACK_MODEL}`,
    ),
    generate: async (model, isFallback) => {
      let usage: StoryUsage | undefined;
      const text = await generateStorySummaryTextOnce({ ...args, model,
        disableModelFallback: isFallback,
        deferUsage: args.deferUsage ? value => { usage = value; } : undefined,
      });
      candidates.push({ model, text, usage });
      return text;
    },
  });
  if (args.fallbackTracker && result.model === STORY_SUMMARY_REFUSAL_FALLBACK_MODEL && result.model !== args.model) {
    args.fallbackTracker.refusalFallbackUsed = true;
  }
  const accepted = [...candidates].reverse().find(candidate => candidate.model === result.model && candidate.text === result.text);
  if (accepted?.usage) args.deferUsage?.(accepted.usage);
  return result.text;
}

async function generateStorySummaryTextOnce(args: {
  signal?: AbortSignal;
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  endpoint: string;
  maxTokens: number;
  temperature?: number;
  responseFormat?: { type: "json_object" };
  disableModelFallback?: boolean;
  attemptBudget?: StoryCompactionAttemptBudget;
  deferUsage?: (usage: StoryUsage) => void;
}): Promise<string> {
  args.signal?.throwIfAborted();
  if (args.attemptBudget && !args.attemptBudget.tryConsume()) {
    throw new Error(STORY_COMPACTION_ATTEMPT_BUDGET_ERROR);
  }
  // A summary model or creator station model above the player's plan runs on
  // the default summary model instead of failing or skipping the plan check.
  const allowedModel = await planAllowedModel(args.userId, args.model, DEFAULT_STORY_SUMMARY_MODEL);
  if (allowedModel !== args.model) args = { ...args, model: allowedModel };
  const moduleAccess = args.endpoint === "module-worker" ? await beginModuleGeneration(args) : null;
  try {
    const resolved = moduleAccess?.resolved ?? await resolveProviderForModel(args.userId, args.model, {
      allowOfficialFallback: false,
    });
    if (!resolved) {
      throw new Error("No provider/API key is available for the selected summary model");
    }

    let text = "";
    let observation = usageObservation();
      let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let reasoningTokens = 0;
    let sawReasoning = false;
    let stopReason: string | undefined;
    const start = Date.now();

    for await (const chunk of resolved.provider.generateStream({
      conversationId: `play:${args.sessionId}`,
      signal: args.signal,
      model: args.model,
      messages: moduleAccess?.prompt ?? args.prompt,
      maxTokens: args.maxTokens,
      temperature: args.temperature ?? 0.2,
      ...(args.responseFormat ? { responseFormat: args.responseFormat } : {}),
      // Summaries need concise final text, not hidden deliberation. DeepSeek V4
      // enables thinking by default and can otherwise spend this entire small
      // output budget on reasoning, leaving the actual summary empty.
      disableReasoning: true,
      ignoreProviders: SUMMARY_IGNORED_PROVIDERS[args.model],
      singleAttempt: !!args.attemptBudget,
      // Every possible retry must consume the shared job-local allowance. The
      // provider's internal fallback recursion is invisible to that counter, so
      // bounded jobs use only the explicit refusal fallback above.
      fallbackModels:
        moduleAccess || args.attemptBudget || args.model === DEFAULT_STORY_SUMMARY_MODEL || args.disableModelFallback
          ? undefined
          : [DEFAULT_STORY_SUMMARY_MODEL],
    })) {
      if (chunk.type === "text") text += chunk.content;
      if (chunk.type === "reasoning") sawReasoning = true;
      if (chunk.stopReason) stopReason = chunk.stopReason;
      if (chunk.usage) {
          observation = usageObservation(chunk.usage);
        promptTokens = chunk.usage.promptTokens;
        completionTokens = chunk.usage.completionTokens;
        totalTokens = chunk.usage.totalTokens;
        reasoningTokens = chunk.usage.reasoningTokens ?? 0;
      }
      if (chunk.type === "error") throw new Error(chunk.content || "Story summary generation failed");
    }

    const usageLogId = totalTokens > 0 ? randomUUID() : null;
    args.signal?.throwIfAborted();
    return await finalizeStorySummaryOutput({
      text,
      stopReason,
      sawReasoning,
      reasoningTokens,
      recordUsage: usageLogId
        ? () => recordUsageLog({
          ...observation,
            id: usageLogId,
            userId: args.userId,
            sessionId: args.sessionId,
            model: args.model,
            promptTokens,
            completionTokens,
            totalTokens,
            endpoint: args.endpoint,
            apiKeyTier: resolved.apiKeyTier,
            generationTimeMs: Date.now() - start,
          })
        : undefined,
      // Official-key background work is billed like a send only when this call
      // produced usable text. Empty calls remain observable in usage logs but do
      // not deduct mushies. BYOK users pay their provider directly.
      billUsage: usageLogId && !resolved.isByok
        ? async () => {
          const usage: StoryUsage = {
            userId: args.userId,
            model: args.model,
            promptTokens,
            completionTokens,
            usageLogId,
            endpoint: args.endpoint,
          };
          if (args.deferUsage) args.deferUsage(usage);
          else await billBackgroundUsage(usage);
        }
        : undefined,
    });
  } finally {
    await moduleAccess?.release();
  }
}

function buildMergeSummaryPrompt(args: {
  worldName?: string | null;
  previousSummary: string | null;
  episodeSummaries: string[];
  state: unknown;
  mode: "compact" | "regenerate";
  language: SessionSummaryLanguage;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You maintain the canonical compressed story summary for an ongoing interactive-fiction session.",
        NARRATIVE_EVIDENCE_RULES,
        "Return only the summary in the fixed Markdown format. Do not explain your work.",
        // The three "## " headings are a fixed skeleton and stay English;
        // the prose under them follows the session's summary language.
        buildSummaryLanguageInstruction(args.language, { keepEnglishHeadings: true, autoSourceLabel: "the new episode summaries" }),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `World: ${args.worldName || "Unknown"}`,
        args.mode === "compact"
          ? "Task: Rewrite the previous story summary together with the new episode summaries into one compact current summary."
          : "Task: Rebuild the story summary from the available episode summaries.",
        args.previousSummary
          ? `[Previous Story Summary]\n${args.previousSummary}`
          : "[Previous Story Summary]\nNone",
        "[New Episode Summaries]",
        args.episodeSummaries.map((summary, index) => `Episode ${index + 1}:\n${summary}`).join("\n\n"),
        "[Current Game State]",
        stringifyCompact(omitSummaryMetadata(args.state), MAX_STATE_CHARS),
        "Rules:",
        "- Preserve the chronological shape of the plot.",
        "- Keep important early events if they still affect the story.",
        "- Preserve promises, relationship changes, goals, secrets, important items, injuries, risks, and irreversible world-state changes.",
        "- Be specific: name characters, places, items, factions, choices, unresolved questions, and the current state of each important thread.",
        "- Include why each major event still matters when that is not obvious.",
        "- Remove obsolete, contradicted, or resolved minor details.",
        "- Do not duplicate static world lore or exact game variables unless narratively important.",
        "- Avoid vague filler such as 'the group continued their journey' unless it states a concrete location, goal, or consequence.",
        "- Follow the section budgets in the system instruction; prioritize lasting consequences over exhaustive history.",
        "Return exactly:",
        "## Story So Far",
        "...",
        "",
        "## Major Open Threads",
        "- ...",
        "",
        "## Important Past Events",
        "- ...",
      ].join("\n"),
    },
  ];
}

type StorySummaryRunInput = {
  userId: string;
  sessionId: string;
  model: string;
  rows: StoryMessageRow[];
  previousSummary: string | null;
  state: unknown;
  worldName?: string | null;
  /** The author's note on what must survive compression (settings.storySummary.focus). */
  focus?: string | null;
  mode: "compact" | "regenerate";
  language: SessionSummaryLanguage;
};

/** The episode calls a run will make, shared by the run and its cost estimate
 *  so the estimate counts exactly the chunks and checkpoints the run uses. */
function planStoryEpisodes(args: StorySummaryRunInput) {
  const chunks = splitMessagesIntoCompactionChunks(args.rows, undefined, args.model);
  const transcripts = chunks
    .map((chunk) => formatMessagesForStoryCompaction(chunk))
    .filter((transcript) => transcript.trim().length > 0);
  const promptFor = (transcript: string, recovery = false) => buildEpisodeSummaryPrompt({ worldName: args.worldName, focus: args.focus, transcript, language: args.language, recovery });
  const keyFor = (transcript: string, recovery: boolean) => episodeCheckpointKey(args.userId, args.sessionId, {
    model: args.model, prompt: promptFor(transcript, recovery), maxTokens: MAX_EPISODE_SUMMARY_TOKENS,
  });
  return { transcripts, promptFor, keyFor };
}

// Deliberately above observed outputs (episodes ~600–1,300, merges under the
// 4,096 cap) so the gate errs toward not starting a run it can't finish.
const ESTIMATED_EPISODE_OUTPUT_TOKENS = 1_000;
const ESTIMATED_MERGE_OUTPUT_TOKENS = 2_000;

function promptTokens(prompt: ChatMessage[], model: string): number {
  return estimateTextTokens(prompt.map((message) => typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content)).join("\n"), model);
}

/**
 * Mushies a run still needs from its first uncached episode through the
 * merge. Usage is charged atomically with the saved summary. This admission
 * check still avoids starting work the wallet cannot cover.
 */
async function estimateStorySummaryRunCredits(args: StorySummaryRunInput): Promise<number> {
  const { transcripts, promptFor, keyFor } = planStoryEpisodes(args);
  if (transcripts.length === 0) return 0;
  const estimateEpisode = async (transcript: string, recovery = false): Promise<{ credits: number; outputs: number }> => {
    const cached = await loadEpisodeCheckpoint(keyFor(transcript, recovery));
    if (cached?.split && !recovery) {
      const chars = Array.from(transcript);
      const midpoint = Math.floor(chars.length / 2);
      const left = await estimateEpisode(chars.slice(0, midpoint).join(""), true);
      const right = await estimateEpisode(chars.slice(midpoint).join(""), true);
      return { credits: left.credits + right.credits, outputs: left.outputs + right.outputs };
    }
    if (cached) {
      // Older checkpoints were billed immediately. New checkpoints carry their
      // accepted usage because a failed merge or stale save has not billed it yet.
      if (!cached.usage) return { credits: 0, outputs: 1 };
      const [paid] = await db.select({ id: creditTransactions.id }).from(creditTransactions)
        .innerJoin(creditWallets, eq(creditTransactions.walletId, creditWallets.id))
        .where(and(eq(creditWallets.userId, args.userId), eq(creditTransactions.type, "usage"),
          eq(creditTransactions.referenceId, cached.usage.usageLogId))).limit(1);
      return { credits: paid ? 0 : await calculateCost(cached.usage.model, cached.usage.promptTokens,
        cached.usage.completionTokens, { providerCostUsd: cached.usage.providerCostUsd }), outputs: 1 };
    }
    return { credits: await calculateCost(args.model, promptTokens(promptFor(transcript, recovery), args.model),
      ESTIMATED_EPISODE_OUTPUT_TOKENS), outputs: 1 };
  };
  let credits = 0, outputs = 0;
  for (const transcript of transcripts) {
    const episode = await estimateEpisode(transcript);
    credits += episode.credits;
    outputs += episode.outputs;
  }
  const mergeFixedTokens = promptTokens(buildMergeSummaryPrompt({ ...args, episodeSummaries: [] }), args.model);
  credits += await calculateCost(
    args.model,
    mergeFixedTokens + outputs * ESTIMATED_EPISODE_OUTPUT_TOKENS,
    ESTIMATED_MERGE_OUTPUT_TOKENS,
  );
  return credits;
}

/** False when an official-key run can't be paid for from start to merge.
 *  BYOK runs aren't billed and unlimited plans aren't charged, so both pass. */
async function canAffordStorySummaryRun(args: StorySummaryRunInput): Promise<boolean> {
  const resolved = await resolveProviderForModel(args.userId, args.model, { allowOfficialFallback: false });
  if (!resolved || resolved.isByok) return true;
  return hasBackgroundRunBudget(args.userId, () => estimateStorySummaryRunCredits(args));
}

async function summarizeRowsWithMetadata(args: StorySummaryRunInput & {
  deferUsage?: (usage: StoryUsage) => void;
  run?: SummaryRunControl;
  fallbackTracker?: RefusalFallbackTracker;
  attemptBudget?: StoryCompactionAttemptBudget;
}): Promise<StorySummaryBuildResult> {
  const { transcripts, promptFor, keyFor } = planStoryEpisodes(args);

  const signal = args.run?.signal ?? AbortSignal.timeout(10 * 60_000);
  let completed = 0;
  await args.run?.progress(0, transcripts.length, "episodes");
  const summarizeEpisode = async (transcript: string) => {
    signal.throwIfAborted();
    const results = await recoverSummaryEpisode({
      transcript,
      load: (text, recovery) => loadEpisodeCheckpoint(keyFor(text, recovery)),
      save: (text, result, recovery) => saveEpisodeCheckpoint(keyFor(text, recovery), result),
      generate: async (text, recovery) => {
        const tracker: RefusalFallbackTracker = { refusalFallbackUsed: args.fallbackTracker?.refusalFallbackUsed ?? false };
        let usage: StoryUsage | undefined;
        const summary = await generateStorySummaryText({
          userId: args.userId, sessionId: args.sessionId, model: args.model,
          prompt: promptFor(text, recovery), endpoint: "story-compaction",
          maxTokens: MAX_EPISODE_SUMMARY_TOKENS, fallbackTracker: tracker,
          attemptBudget: args.attemptBudget, signal,
          deferUsage: args.deferUsage ? value => { usage = value; } : undefined,
        });
        return { text: summary, refusalFallbackUsed: tracker.refusalFallbackUsed, usage };
      },
    });
    for (const result of results) if (result.usage) args.deferUsage?.(result.usage);
    if (args.fallbackTracker && results.some(result => result.refusalFallbackUsed)) args.fallbackTracker.refusalFallbackUsed = true;
    await args.run?.progress(++completed, transcripts.length, "episodes");
    return results.map(result => result.text);
  };

  // Custom endpoints are user-configured and may ignore provider-specific
  // controls. Probe one chunk first: if the endpoint still returns no final
  // text, the job fails after one paid call instead of launching four broken
  // requests simultaneously. Once the probe succeeds, normal concurrency
  // resumes for the remaining independent chunks.
  // Episode chunks are independent — summarize them concurrently in small
  // batches (rate-limit friendly) instead of strictly sequentially. Sequential
  // chunks made compaction latency the SUM of every LLM call: minutes on a
  // long backlog for the manual button, and a wider race window for
  // background jobs to be invalidated mid-flight. Batch boundaries preserve
  // chronological order (Promise.all keeps input order).
  const EPISODE_CONCURRENCY = 4;
  const episodeBatches = await summarizeStoryEpisodeTranscripts({
    transcripts,
    summarize: summarizeEpisode,
    probeFirst: args.model.startsWith("custom/"),
    concurrency: EPISODE_CONCURRENCY,
  });
  const episodeSummaries = episodeBatches.flat();

  if (episodeSummaries.length === 0) {
    return {
      summary: normalizeStorySummaryText(args.previousSummary),
      endingOneLine: null,
    };
  }

  signal.throwIfAborted();
  await args.run?.progress(completed, transcripts.length, "merge");
  const mergePrompt = buildMergeSummaryPrompt({
    worldName: args.worldName,
    previousSummary: args.previousSummary,
    episodeSummaries,
    state: args.state,
    mode: args.mode,
    language: args.language,
  });
  const summary = await recoverStoryMerge({ signal, generate: (recovery) => generateStorySummaryText({
    signal,
    userId: args.userId,
    sessionId: args.sessionId,
    model: args.model,
    prompt: withStoryMergeBudget(mergePrompt, recovery),
    endpoint: "story-compaction",
    maxTokens: MAX_MERGE_SUMMARY_TOKENS,
    fallbackTracker: args.fallbackTracker,
    attemptBudget: args.attemptBudget,
    deferUsage: args.deferUsage,
  }) });

  return {
    summary,
    endingOneLine: extractEpisodeEndingOneLine(episodeSummaries.at(-1)),
  };
}

async function summarizeRows(args: Parameters<typeof summarizeRowsWithMetadata>[0]): Promise<string> {
  const result = await summarizeRowsWithMetadata(args);
  return result.summary;
}

/** How long a compaction claim blocks other runners before it's considered
 *  abandoned (crashed replica, killed deploy). Generously above a normal
 *  multi-call run so healthy jobs are never stolen mid-flight. */
const STORY_COMPACTION_CLAIM_TTL_MS = SUMMARY_CLAIM_TTL_MS;

/**
 * Claim the session for a compaction job. Prod runs two app replicas whose
 * in-memory job chains can't see each other: both used to start the same
 * window concurrently, the later `updating` write overwrote the earlier
 * job's sourceHash, and the loser's whole multi-call run was dropped at
 * persist ("dropped stale") — every LLM call it made wasted. The claim guard
 * makes the second runner skip instead. Returns false when another job holds
 * a fresh claim. Manual requests also respect active claims; stale claims expire so a dead replica can't wedge the
 * session.
 */
async function markStoryJobUpdating(args: {
  sessionId: string;
  job: PreparedStorySummaryJob;
  force?: boolean;
  consumeBudgetResume?: boolean;
}): Promise<boolean> {
  if (args.job.mode === "compact" && args.job.snapshot.summary?.trim()
    && (!args.job.snapshot.summarySourceHash || args.job.snapshot.summarySourceHash.includes(":authored"))) args.job.sourceHash += ":authored";
  args.job.claimedModel = args.job.model;
  const now = new Date();
  const claimGuard = or(
        ne(playSessions.summaryStatus, "updating"),
        isNull(playSessions.summaryClaimedAt),
        lt(playSessions.summaryClaimedAt, new Date(now.getTime() - STORY_COMPACTION_CLAIM_TTL_MS)),
      );
  const budgetResumeGuard = args.consumeBudgetResume
    ? eq(playSessions.summaryBudgetResumePending, true)
    : undefined;
  const updated = await db
    .update(playSessions)
    .set({
      summaryModel: args.job.model,
      summaryStatus: "updating" satisfies StoryCompactionStatus,
      summaryError: null,
      summarySourceHash: args.job.sourceHash,
      summaryClaimedAt: now,
      ...(args.consumeBudgetResume ? { summaryBudgetResumePending: false } : {}),
    })
    .where(and(eq(playSessions.id, args.sessionId), claimGuard, budgetResumeGuard,
      continuitySnapshotGuard(args.job.snapshot, STORY_INPUT_FIELDS),
      memorySourceGuard(args.sessionId, args.job.sourceMessages),
      historicalStateGuard(args.sessionId, [args.job.boundaryState])))
    .returning();
  return updated.length > 0;
}

async function markStoryJobFailed(args: {
  sessionId: string;
  error: unknown;
} & (
  | { job: PreparedStorySummaryJob; preflightSnapshot?: never }
  | { job?: never; preflightSnapshot: StoryPreflightSnapshot }
)): Promise<boolean> {
  const message = args.error instanceof Error ? args.error.message : "Failed to update story summary";
  const whereClause = args.job
    ? and(
        eq(playSessions.id, args.sessionId),
        eq(playSessions.summaryStatus, "updating"),
        eq(playSessions.summarySourceHash, args.job.sourceHash),
      )
    : and(
        eq(playSessions.id, args.sessionId),
        storyPreflightFailureGuard(
          args.preflightSnapshot,
          new Date(Date.now() - STORY_COMPACTION_CLAIM_TTL_MS),
        ),
      );

  const updated = await db
    .update(playSessions)
    .set({
      summaryStatus: "failed" satisfies StoryCompactionStatus,
      summaryError: message,
      summaryClaimedAt: null,
    })
    .where(whereClause)
    .returning();
  return updated.length > 0;
}

async function persistStorySummaryResult(args: {
  sessionId: string;
  userId: string;
  summary: string;
  job: PreparedStorySummaryJob;
  resetBudgetWindow?: boolean;
}): Promise<boolean> {
  // Guard on status + source hash only. Every history-invalidating operation
  // (edit/delete/swipe of covered messages, revert, restart, checkpoint
  // restore) clears summaryStatus/summarySourceHash, which this matches.
  // Deliberately NOT guarded on play_sessions.updatedAt: every chat turn
  // bumps it, so a multi-call compaction racing an actively playing user was
  // dropped every time — the summary could never persist while its LLM calls
  // were re-burned each turn. Newly appended messages don't invalidate a
  // summary of OLDER messages.
  // The last message this summary covers must still exist (checked inside the
  // same UPDATE, so nothing can delete it between a check and the write). A
  // revert that landed after this job read its rows but before it claimed the
  // row deletes the tail without touching the guard fields, so the status/hash
  // check alone would let a summary describing deleted turns through — and,
  // since the revert now KEEPS a summary whose pointer survives, that summary
  // would then be merged into every later one.
  const whereClause = and(
    eq(playSessions.id, args.sessionId),
    eq(playSessions.summaryStatus, "updating"),
    eq(playSessions.summarySourceHash, args.job.sourceHash),
    historicalStateGuard(args.sessionId, [args.job.boundaryState]),
    continuitySnapshotGuard({ ...args.job.snapshot, summaryModel: args.job.claimedModel ?? args.job.model }, STORY_INPUT_FIELDS.filter(k => k !== "summarySourceHash")),
    args.job.coversUntilMessageId == null
      ? undefined
      : exists(db.select({ id: messages.id }).from(messages).where(eq(messages.id, args.job.coversUntilMessageId))),
  );

  const charges = await Promise.all(args.job.charges.map(prepareBackgroundUsageBill));
  const persisted = await db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: playSessions.id }).from(playSessions).where(whereClause).for("update");
    if (!owner) return false;
    if (args.job.sourceMessages.length > 0) {
      const currentMessages = await tx
        .select({ id: messages.id, role: messages.role, content: messages.content })
        .from(messages)
        .where(inArray(messages.id, args.job.sourceMessages.map((message) => message.id)))
        .for("update");
      const currentById = new Map(currentMessages.map((message) => [message.id, message]));
      const sourceStillMatches = args.job.sourceMessages.every((expected) => {
        const current = currentById.get(expected.id);
        return current?.role === expected.role && current.content === expected.content;
      });
      if (!sourceStillMatches || currentMessages.length !== args.job.sourceMessages.length) return false;
    }

    const updated = await tx
      .update(playSessions)
      .set({
        summary: args.summary,
        summaryModel: args.job.model,
        summaryUpdatedAt: new Date(),
        summaryStatus: "idle" satisfies StoryCompactionStatus,
        summaryError: null,
        summarySourceHash: args.job.sourceHash,
        summaryCoversUntilMessageId: args.job.coversUntilMessageId,
        summaryTokenCount: estimateTextTokens(args.summary, args.job.model),
        summaryClaimedAt: null,
        ...(args.resetBudgetWindow
          ? { summaryBudgetWindowStartedAt: new Date(), summaryBudgetResumePending: false }
          : {}),
      })
      .where(whereClause)
      .returning();

    if (updated.length === 0) return false;
    if (args.job.compactedMessageIds.length > 0) {
      await tx
        .update(messages)
        .set({ compacted: true })
        .where(inArray(messages.id, args.job.compactedMessageIds));
    }
    for (const charge of charges) await charge?.(tx);
    return true;
  });

  if (!persisted) {
    console.warn(`[StoryCompaction] Dropped stale story summary result for session ${args.sessionId}`);
    captureServerEvent(args.userId, "summary_job", {
      system: "story-compaction",
      outcome: "dropped_stale",
      session_id: args.sessionId,
      model: args.job.model,
    });
    await db
      .update(playSessions)
      .set({
        summaryStatus: "idle" satisfies StoryCompactionStatus,
        summaryError: null,
        summaryClaimedAt: null,
      })
      .where(and(
        eq(playSessions.id, args.sessionId),
        eq(playSessions.summaryStatus, "updating"),
        eq(playSessions.summarySourceHash, args.job.sourceHash),
      ));
    return false;
  }

  storyCompactionFailureCounts.delete(args.sessionId);
  captureServerEvent(args.userId, "summary_job", {
    system: "story-compaction",
    outcome: "ok",
    session_id: args.sessionId,
    model: args.job.model,
    compacted_count: args.job.compactedMessageIds.length,
  });
  return true;
}

async function loadSessionForSummary(sessionId: string, userId: string) {
  const [row] = await db
    .select({
      session: playSessions,
      worldName: worlds.name,
      worldLanguage: worlds.language,
      // Only the settings object, not the card: the summariser needs one
      // line of it (storySummary.focus) and a card can be megabytes.
      worldSettings: sql<unknown>`${worlds.schema} -> 'settings'`,
    })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

async function loadStoryRows(sessionId: string, includeCompacted: boolean): Promise<StoryMessageRow[]> {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(includeCompacted ? eq(messages.sessionId, sessionId) : and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  return rows;
}

/** Recent user/assistant text for output-language detection — the detector
 *  itself only reads the trailing few thousand characters of this. */
function storyLanguageSample(rows: StoryMessageRow[]): string {
  return rows
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-30)
    .map((message) => message.content)
    .join("\n");
}

async function compactStorySummaryForSessionNow(args: StoryCompactionArgs): Promise<string | null> {
  args.run?.signal.throwIfAborted();
  const row = await loadSessionForSummary(args.sessionId, args.userId);
  if (!row) throw new Error("Session not found");

  // applyModelRedirect: persisted summaryModel values can hold deprecated ids
  // (e.g. x-ai/grok-4.1-fast) saved before a redirect shipped; without the
  // redirect they 404 on every background run.
  const model = applyModelRedirect((
    args.force
      ? args.fallbackModel
      : row.session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL || args.fallbackModel
  ).trim());
  const summaryMode = "threshold";
  const userTriggerTokens = normalizeSessionSummaryTriggerTokens(row.session.summaryTriggerTokens);
  // An explicit user-set trigger is respected as-is; the default is capped
  // below the send-path overflow point so compaction happens in the
  // background instead of synchronously before a send.
  const summaryTriggerTokens = row.session.summaryTriggerTokens == null
    ? resolveThresholdTriggerTokens(userTriggerTokens, args.contextTokenLimit)
    : userTriggerTokens;
  const summaryRecentTailTokens = normalizeSessionSummaryRecentTailTokens(row.session.summaryRecentTailTokens);
  const summaryRecentTailTokensOverride = row.session.summaryRecentTailTokens == null ? undefined : summaryRecentTailTokens;
  const finalPromptRawTokenLimit = typeof args.finalPromptRawTokenLimit === "number" && Number.isFinite(args.finalPromptRawTokenLimit)
    ? Math.max(1, Math.floor(args.finalPromptRawTokenLimit))
    : null;
  const transcriptRows = await loadStoryRows(args.sessionId, args.force === true);
  await forEachCooperatively(transcriptRows, message => { estimateMessageTokens(message, model); });
  // One resolved language for the whole run (episodes + merge) from the
  // transcript's own recent text, so the merge step can't flip back to the
  // language of an older English summary.
  const language = resolveSummaryOutputLanguage({
    configured: row.session.summaryLanguage,
    sourceText: storyLanguageSample(transcriptRows),
    worldLanguage: row.worldLanguage,
  });
  if (args.force) {
    const relevantRows = transcriptRows.filter((message) => message.role === "user" || message.role === "assistant");
    const { remainder } = selectStoryCompactionRunSlice(relevantRows, { modelId: model });
    if (remainder.length > 0) {
      throw new Error("This session is too large to regenerate safely in one job. Use Compact to update its existing summary incrementally.");
    }
  }
  const window = args.force
    ? selectCompactionWindow(transcriptRows, { triggerTokens: 0, minCompactableTokens: 0, modelId: model })
    : finalPromptRawTokenLimit !== null
      ? selectCompactionWindow(transcriptRows, {
          mode: "overflow",
          contextTokenLimit: finalPromptRawTokenLimit,
          recentTailTokens: Math.min(summaryRecentTailTokensOverride ?? finalPromptRawTokenLimit, finalPromptRawTokenLimit),
          ...(args.foldAtTokens != null ? { triggerTokens: Math.max(1, Math.floor(args.foldAtTokens)) } : {}),
          modelId: model,
        })
    : selectCompactionWindow(transcriptRows, {
        mode: summaryMode,
        contextTokenLimit: args.contextTokenLimit,
        triggerTokens: summaryTriggerTokens,
        recentTailTokens: summaryRecentTailTokensOverride,
        modelId: model,
      });

  if (!window) {
    if (!args.force) return row.session.summary ?? null;
    const allRows = transcriptRows.filter((message) => message.role === "user" || message.role === "assistant");
    if (allRows.length === 0) return row.session.summary ?? null;
    const { slice: boundedRows } = selectStoryCompactionRunSlice(allRows, { modelId: model });
    const boundaryState = await loadHistoricalState(args.sessionId, boundedRows.at(-1)!.id);
    const sourceHash = createStorySourceHash({
      version: STORY_SUMMARY_SOURCE_HASH_VERSION,
      kind: "regenerate-small",
      // Fence retries of identical input: an abandoned run cannot persist
      // against its replacement's database claim.
      runId: args.run?.id,
      sessionId: args.sessionId,
      model,
      language,
      messageIds: boundedRows.map((message) => message.id),
      messageText: boundedRows.map((message) => [message.role, message.content]),
      state: boundaryState.snapshot,
    });
    const job: PreparedStorySummaryJob = {
      snapshot: row.session, boundaryState, charges: [],
      model,
      sourceHash,
      mode: "regenerate",
      sourceMessages: boundedRows.map(({ id, role, content }) => ({ id, role, content })),
      compactedMessageIds: [],
      // This summary is written from every bounded row, so record that it
      // covers through the last one. The revert keep-rule (invalidateForRevert)
      // trusts this pointer; leaving the stale previous value here let a
      // regenerated summary survive a rewind that deleted turns it described.
      coversUntilMessageId: boundedRows.at(-1)?.id ?? null,
    };
    const runInput: StorySummaryRunInput = {
      userId: args.userId,
      sessionId: args.sessionId,
      model,
      rows: boundedRows,
      previousSummary: null,
      state: boundaryState.snapshot,
      worldName: row.worldName,
      focus: storySummaryFocus(row.worldSettings),
      mode: "regenerate",
      language,
    };
    if (!(await canAffordStorySummaryRun(runInput))) {
      throw new Error(notEnoughMushiesMessage("story-compaction"));
    }
    if (!(await markStoryJobUpdating({ sessionId: args.sessionId, job, force: true }))) {
      throw new Error("A story summary is already updating. Wait for it to finish before retrying.");
    }
    try {
      const fallbackTracker: RefusalFallbackTracker = { refusalFallbackUsed: false };
      const summary = await summarizeRows({
        ...runInput,
        run: args.run,
        deferUsage: usage => job.charges.push(usage),
        fallbackTracker,
        attemptBudget: createStoryCompactionAttemptBudget(STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN),
      });
      args.run?.signal.throwIfAborted();
      const persisted = await persistStorySummaryResult({
        sessionId: args.sessionId,
        userId: args.userId,
        summary,
        job,
        resetBudgetWindow: true,
      });
      if (!persisted) throw new Error("Session changed while compacting. Please try again.");
      return summary;
    } catch (err) {
      await markStoryJobFailed({ sessionId: args.sessionId, job, error: err });
      captureServerEvent(args.userId, "summary_job", {
        system: "story-compaction",
        outcome: "failed",
        session_id: args.sessionId,
        model,
        error_message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // A first summary over a long backlog recaps only what a prompt could still
  // carry; the older rows fold with it, unsummarised. Later runs continue an
  // existing summary, so they never skip.
  const unseen = !args.force && args.recapWithinTokens != null && !row.session.summary?.trim()
    ? unseenBacklogCount(window.compactable, window.retained, args.recapWithinTokens, model)
    : 0;
  // Bounded slice — the remainder compacts on subsequent runs.
  const { slice: compactableSlice } = selectStoryCompactionRunSlice(window.compactable.slice(unseen), {
    maxMessages: STORY_COMPACTION_MAX_MESSAGES_PER_RUN,
    modelId: model,
  });
  const compactedMessageIds = [...window.compactable.slice(0, unseen), ...compactableSlice].map((message) => message.id);
  const coversUntilMessageId = compactableSlice.at(-1)?.id ?? null;
  if (!args.force && row.session.summary?.trim()) await assertPriorCoverage(args.sessionId, [row.session.summaryCoversUntilMessageId], compactableSlice[0]!.id);
  const boundaryState = await loadHistoricalState(args.sessionId, coversUntilMessageId!);
  const mode = args.force ? "regenerate" : "compact";
  const sourceHash = createStorySourceHash({
    version: STORY_SUMMARY_SOURCE_HASH_VERSION,
    kind: mode,
    runId: args.run?.id,
    summaryMode,
    summaryTriggerTokens,
    summaryRecentTailTokens: summaryRecentTailTokensOverride ?? null,
    finalPromptRawTokenLimit,
    contextTokenLimit: args.contextTokenLimit ?? null,
    sessionId: args.sessionId,
    model,
    language,
    previousSummary: args.force ? null : row.session.summary,
    compactedMessageIds,
    compactedMessageText: compactableSlice.map((message) => [message.role, message.content]),
    state: boundaryState.snapshot,
  });
  const job: PreparedStorySummaryJob = {
    snapshot: row.session, boundaryState, charges: [],
    model,
    sourceHash,
    mode,
    sourceMessages: compactableSlice.map(({ id, role, content }) => ({ id, role, content })),
    compactedMessageIds,
    coversUntilMessageId,
  };

  if (row.session.summarySourceHash === job.sourceHash && row.session.summaryStatus === "idle") {
    return row.session.summary ?? null;
  }

  const runInput: StorySummaryRunInput = {
    userId: args.userId,
    sessionId: args.sessionId,
    model,
    rows: compactableSlice,
    previousSummary: args.force ? null : row.session.summary,
    state: boundaryState.snapshot,
    worldName: row.worldName,
    focus: storySummaryFocus(row.worldSettings),
    mode,
    language,
  };
  if (args.force && !(await canAffordStorySummaryRun(runInput))) {
    throw new Error(notEnoughMushiesMessage("story-compaction"));
  }

  let budgetRecoveryProbe = false;
  let attemptBudget: StoryCompactionAttemptBudget | undefined;
  if (!args.force) {
    // The soft window pauses a pathological loop while still allowing an
    // explicit one-shot recovery. A separate job-local allowance bounds each
    // run, including refusal fallbacks, without locking the session for a day.
    const budget = await getStoryCompactionBudgetDecision({
      sessionId: args.sessionId,
      windowStartedAt: row.session.summaryBudgetWindowStartedAt,
      resumePending: row.session.summaryBudgetResumePending,
    });
    if (budget.decision === "soft-capped") {
      const paused = await markStoryJobFailed({
        sessionId: args.sessionId,
        preflightSnapshot: row.session,
        error: new Error(STORY_COMPACTION_BUDGET_ERROR),
      });
      if (paused) captureServerEvent(args.userId, "summary_job", {
        system: "story-compaction",
        outcome: "budget_capped",
        session_id: args.sessionId,
        model,
      });
      return row.session.summary ?? null;
    }
    budgetRecoveryProbe = budget.decision === "recovery-probe";
    attemptBudget = createStoryCompactionAttemptBudget(STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN);

    // Affordability pre-gate (never blocks chat): skip official-key runs
    // when the wallet cannot cover all generated episodes through
    // the merge — the panel shows why. BYOK runs aren't billed and aren't gated.
    if (!(await canAffordStorySummaryRun(runInput))) {
      const paused = await markStoryJobFailed({
        sessionId: args.sessionId,
        preflightSnapshot: row.session,
        error: new Error(notEnoughMushiesMessage("story-compaction")),
      });
      if (paused) captureServerEvent(args.userId, "summary_job", {
        system: "story-compaction",
        outcome: "skipped_no_credits",
        session_id: args.sessionId,
        model,
      });
      return row.session.summary ?? null;
    }
  }

  const claimed = await markStoryJobUpdating({
    sessionId: args.sessionId,
    job,
    force: args.force,
    consumeBudgetResume: budgetRecoveryProbe,
  });
  if (!claimed) {
    if (args.force) throw new Error("A story summary is already updating. Wait for it to finish before retrying.");
    // Another replica's job holds a fresh claim on this session — skip instead
    // of clobbering its sourceHash (which wasted its whole multi-call run).
    console.warn(`[StoryCompaction] Skipping run for session ${args.sessionId} — another job holds the claim`);
    captureServerEvent(args.userId, "summary_job", {
      system: "story-compaction",
      outcome: "claim_skipped",
      session_id: args.sessionId,
      model,
    });
    return row.session.summary ?? null;
  }

  try {
    const fallbackTracker: RefusalFallbackTracker = { refusalFallbackUsed: false };
    const summary = await summarizeRows({
      ...runInput,
      run: args.run,
      deferUsage: usage => job.charges.push(usage),
      fallbackTracker,
      attemptBudget: attemptBudget ?? createStoryCompactionAttemptBudget(STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN),
    });
    args.run?.signal.throwIfAborted();
    const persisted = await persistStorySummaryResult({
      sessionId: args.sessionId,
      userId: args.userId,
      summary,
      job,
      resetBudgetWindow: args.force || budgetRecoveryProbe,
    });
    if (args.force && !persisted) throw new Error("Session changed while compacting. Please try again.");
    return persisted ? summary : row.session.summary ?? null;
  } catch (err) {
    await markStoryJobFailed({ sessionId: args.sessionId, job, error: err });
    captureServerEvent(args.userId, "summary_job", {
      system: "story-compaction",
      outcome: "failed",
      session_id: args.sessionId,
      model,
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function drainQueuedStoryCompactions(sessionId: string): Promise<void> {
  while (true) {
    const latest = queuedStoryCompactions.get(sessionId);
    if (!latest) return;
    queuedStoryCompactions.delete(sessionId);
    await compactStorySummaryForSessionNow(latest);
  }
}

export function scheduleStoryCompaction(args: StoryCompactionArgs): void {
  // Self-defend: never schedule when the session-memory-summary extension is
  // uninstalled. The primary gate is resolveMemorySystemSettings at the call
  // site; this closes the race where an uninstall lands mid-request, after the
  // settings read but before this fire-and-forget schedule.
  // A card that asked for the summary itself is not gated by the install.
  const entitled = args.authorRequired ? Promise.resolve(true) : isExtensionInstalled(args.userId, SESSION_MEMORY_EXTENSION_KEY);
  void entitled.then((enabled) => {
    if (!enabled) return;
    if ((storyCompactionFailureCounts.get(args.sessionId) ?? 0) >= STORY_COMPACTION_MAX_CONSECUTIVE_FAILURES) {
      // Persistently failing config — stop burning a compaction per turn.
      // The panel shows the failed status; manual compact/regenerate resets.
      // Must stay loud: a silent skip here reads as "auto-trigger is broken".
      console.warn(
        `[StoryCompaction] Auto-compaction suppressed for session ${args.sessionId} after ${STORY_COMPACTION_MAX_CONSECUTIVE_FAILURES} consecutive failures — manual compact/regenerate resets the budget`,
      );
      return;
    }
    // Last-write-wins queue, EXCEPT that a threshold-mode enqueue (no
    // finalPromptRawTokenLimit, e.g. turn-complete) must not clobber a queued
    // overflow-mode request — for sessions whose user-set trigger sits above
    // the overflow point, the overflow job is the only one that would ever
    // repair the summary.
    const queued = queuedStoryCompactions.get(args.sessionId);
    const merged = queued?.finalPromptRawTokenLimit != null && args.finalPromptRawTokenLimit == null
      ? { ...args, finalPromptRawTokenLimit: queued.finalPromptRawTokenLimit }
      : args;
    queuedStoryCompactions.set(args.sessionId, merged);
    if (storyCompactionDrainActive.has(args.sessionId)) return;

    storyCompactionDrainActive.add(args.sessionId);
    enqueueStoryCompactionJob(args.sessionId, () => drainQueuedStoryCompactions(args.sessionId))
      .catch((err) => {
        storyCompactionFailureCounts.set(
          args.sessionId,
          (storyCompactionFailureCounts.get(args.sessionId) ?? 0) + 1,
        );
        console.warn("[StoryCompaction] Background update failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        storyCompactionDrainActive.delete(args.sessionId);
        const latest = queuedStoryCompactions.get(args.sessionId);
        if (latest) scheduleStoryCompaction(latest);
      });
  }).catch((err) => {
    // The entitlement check reads the DB; without this catch a transient DB
    // error here becomes a process-level unhandledRejection.
    console.warn("[StoryCompaction] Failed to schedule background update:", err instanceof Error ? err.message : err);
  });
}

export function compactStorySummaryForSession(args: StoryCompactionArgs): Promise<string | null> {
  return enqueueStoryCompactionJob(args.sessionId, () => compactStorySummaryForSessionNow(args));
}

/**
 * Re-derive the story summary after a REVERT. The revert path has already
 * DROPPED the old summary and un-compacted every surviving message, so this is
 * a normal threshold-mode compaction over the FULL surviving transcript: it
 * regenerates the summary only when the surviving conversation is still over the
 * trigger, and otherwise no-ops (the summary stays empty — the whole chat now
 * fits raw). Self-contained defaults so the revert path needn't supply a live
 * model / context window; the session's own summaryModel + summaryTriggerTokens
 * take precedence inside compactStorySummaryForSessionNow.
 */
export function recompactStorySummaryAfterRevert(args: { sessionId: string; userId: string }): Promise<string | null> {
  return compactStorySummaryForSession({
    sessionId: args.sessionId,
    userId: args.userId,
    fallbackModel: DEFAULT_STORY_SUMMARY_MODEL,
    contextTokenLimit: STORY_COMPACTION_DEFAULT_CONTEXT_TOKENS,
  });
}

export function compactStorySummaryForSessionManually(args: {
  sessionId: string;
  userId: string;
  model?: string | null;
  contextTokenLimit?: number | null;
  force?: boolean;
}): Promise<ManualStoryCompactionResult> {
  return enqueueStoryCompactionJob(args.sessionId, async () => {
    // The user explicitly retrying (likely after fixing a broken model
    // config) — give the background auto-retry budget a fresh window.
    storyCompactionFailureCounts.delete(args.sessionId);
    const row = await loadSessionForSummary(args.sessionId, args.userId);
    if (!row) throw new Error("Session not found");

    const model = applyModelRedirect((args.model || row.session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim());
    const summaryMode = "threshold";
    const summaryTriggerTokens = normalizeSessionSummaryTriggerTokens(row.session.summaryTriggerTokens);
    const summaryRecentTailTokens = normalizeSessionSummaryRecentTailTokens(row.session.summaryRecentTailTokens);
    const summaryRecentTailTokensOverride = row.session.summaryRecentTailTokens == null ? undefined : summaryRecentTailTokens;
    const transcriptRows = await loadStoryRows(args.sessionId, false);
    await forEachCooperatively(transcriptRows, message => { estimateMessageTokens(message, model); });
    const language = resolveSummaryOutputLanguage({
      configured: row.session.summaryLanguage,
      sourceText: storyLanguageSample(transcriptRows),
      worldLanguage: row.worldLanguage,
    });
    const relevantRows = transcriptRows.filter((message) => message.role === "user" || message.role === "assistant");
    const normalWindow = selectCompactionWindow(transcriptRows, {
      triggerTokens: 0,
      recentTailTokens: summaryRecentTailTokensOverride ?? summaryRecentTailTokens,
      modelId: model,
    });
    const forcedWindow = normalWindow ? null : args.force
      ? selectForcedManualCompactionWindow(transcriptRows, {
          modelId: model,
          retainedTailTokens: summaryRecentTailTokensOverride ?? summaryRecentTailTokens,
        })
      : null;
    const window = normalWindow ?? forcedWindow;
    const usedForcedWindow = !normalWindow && !!forcedWindow;
    const currentSummary = normalizeStorySummaryText(row.session.summary);

    if (!window) {
      const totalTokens = estimateMessagesTokens(relevantRows, model);
      return {
        summary: currentSummary,
        compactedCount: 0,
        compactedFromMessageId: null,
        compactedToMessageId: null,
        compactedFromOrdinal: null,
        compactedToOrdinal: null,
        compactedFromPreview: null,
        compactedToPreview: null,
        compactedUntilOneLine: null,
        compactedTokenEstimate: 0,
        retainedCount: relevantRows.length,
        retainedTokenEstimate: totalTokens,
        noOpReason: "Nothing older than the kept-raw tail to compact yet.",
        noOpReasonCode: "fits-within-raw-tail",
      };
    }

    // Bounded slice — a huge backlog compacts over several manual/auto runs.
    const { slice: manualSlice, remainder: manualRemainder } = selectStoryCompactionRunSlice(window.compactable, {
      maxMessages: STORY_COMPACTION_MAX_MESSAGES_PER_RUN,
      modelId: model,
    });
    const firstCompacted = manualSlice[0];
    const lastCompacted = manualSlice.at(-1);
    const compactedMessageIds = manualSlice.map((message) => message.id);
    const coversUntilMessageId = lastCompacted?.id ?? null;
    const compactedFromOrdinal = firstCompacted
      ? relevantRows.findIndex((message) => message.id === firstCompacted.id) + 1
      : null;
    const compactedToOrdinal = lastCompacted
      ? relevantRows.findIndex((message) => message.id === lastCompacted.id) + 1
      : null;
    if (row.session.summary?.trim()) await assertPriorCoverage(args.sessionId, [row.session.summaryCoversUntilMessageId], firstCompacted!.id);
    const boundaryState = await loadHistoricalState(args.sessionId, coversUntilMessageId!);
    const sourceHash = createStorySourceHash({
      version: STORY_SUMMARY_SOURCE_HASH_VERSION,
      kind: usedForcedWindow ? "manual-compact-forced" : "manual-compact",
      summaryMode,
      summaryTriggerTokens,
      summaryRecentTailTokens: summaryRecentTailTokensOverride ?? null,
      contextTokenLimit: args.contextTokenLimit ?? null,
      forced: usedForcedWindow,
      sessionId: args.sessionId,
      model,
      language,
      previousSummary: row.session.summary,
      compactedMessageIds,
      compactedMessageText: manualSlice.map((message) => [message.role, message.content]),
      state: boundaryState.snapshot,
    });
    const job: PreparedStorySummaryJob = {
      snapshot: row.session, boundaryState, charges: [],
      model,
      sourceHash,
      mode: "compact",
      sourceMessages: manualSlice.map(({ id, role, content }) => ({ id, role, content })),
      compactedMessageIds,
      coversUntilMessageId,
    };
    const runInput: StorySummaryRunInput = {
      userId: args.userId,
      sessionId: args.sessionId,
      model,
      rows: manualSlice,
      previousSummary: row.session.summary,
      state: boundaryState.snapshot,
      worldName: row.worldName,
      focus: storySummaryFocus(row.worldSettings),
      mode: "compact",
      language,
    };
    if (!(await canAffordStorySummaryRun(runInput))) {
      throw new Error(notEnoughMushiesMessage("story-compaction"));
    }

    if (!(await markStoryJobUpdating({ sessionId: args.sessionId, job, force: true }))) {
      throw new Error("A story summary is already updating. Wait for it to finish before retrying.");
    }

    try {
      const fallbackTracker: RefusalFallbackTracker = { refusalFallbackUsed: false };
      const result = await summarizeRowsWithMetadata({
        ...runInput,
        deferUsage: usage => job.charges.push(usage),
        fallbackTracker,
        attemptBudget: createStoryCompactionAttemptBudget(STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN),
      });
      const persisted = await persistStorySummaryResult({
        sessionId: args.sessionId,
        userId: args.userId,
        summary: result.summary,
        job,
        resetBudgetWindow: true,
      });
      if (!persisted) {
        throw new Error("Session changed while compacting. Please try again.");
      }

      const fallbackEnding = previewStoryMessage(lastCompacted);
      // Rows past the per-run cap stay raw this run — report them as retained
      // so the panel's counts stay honest; they compact on the next run.
      const retainedRows = [...manualRemainder, ...window.retained];
      return {
        summary: result.summary,
        compactedCount: manualSlice.length,
        compactedFromMessageId: firstCompacted?.id ?? null,
        compactedToMessageId: lastCompacted?.id ?? null,
        compactedFromOrdinal: compactedFromOrdinal && compactedFromOrdinal > 0 ? compactedFromOrdinal : null,
        compactedToOrdinal: compactedToOrdinal && compactedToOrdinal > 0 ? compactedToOrdinal : null,
        compactedFromPreview: previewStoryMessage(firstCompacted),
        compactedToPreview: previewStoryMessage(lastCompacted),
        compactedUntilOneLine: result.endingOneLine || fallbackEnding,
        compactedTokenEstimate: estimateMessagesTokens(manualSlice, model),
        retainedCount: retainedRows.length,
        retainedTokenEstimate: estimateMessagesTokens(retainedRows, model),
        noOpReason: null,
        noOpReasonCode: null,
      };
    } catch (err) {
      await markStoryJobFailed({ sessionId: args.sessionId, job, error: err });
      captureServerEvent(args.userId, "summary_job", {
        system: "story-compaction",
        outcome: "failed",
        session_id: args.sessionId,
        model,
        error_message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}

export function regenerateStorySummaryForSession(args: {
  run?: SummaryRunControl;
  sessionId: string;
  userId: string;
  model?: string | null;
}): Promise<string | null> {
  return enqueueStoryCompactionJob(args.sessionId, async () => {
    // Manual regenerate resets the background auto-retry budget (see
    // compactStorySummaryForSessionManually).
    storyCompactionFailureCounts.delete(args.sessionId);
    const row = await loadSessionForSummary(args.sessionId, args.userId);
    if (!row) throw new Error("Session not found");
    return compactStorySummaryForSessionNow({
      sessionId: args.sessionId,
      userId: args.userId,
      fallbackModel: (args.model || row.session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim(),
      run: args.run,
      force: true,
    });
  });
}

/**
 * Queue exactly one automatic recovery attempt for a capped session.
 * The pending bit is consumed when the next background job successfully
 * claims the session; a successful persist then starts a fresh soft window.
 */
export async function resumeStoryCompactionForSession(args: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  const updated = await db
    .update(playSessions)
    .set({
      summaryBudgetResumePending: true,
      summaryStatus: "idle" satisfies StoryCompactionStatus,
      summaryError: null,
      summaryClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(playSessions.id, args.sessionId),
      eq(playSessions.userId, args.userId),
      or(
        eq(playSessions.summaryError, STORY_COMPACTION_BUDGET_ERROR),
        eq(playSessions.summaryError, LEGACY_STORY_COMPACTION_BUDGET_ERROR),
        eq(playSessions.summaryError, STORY_COMPACTION_HARD_BUDGET_ERROR),
      ),
    ))
    .returning();
  if (updated.length > 0) storyCompactionFailureCounts.delete(args.sessionId);
  return updated.length > 0;
}

export function discardQueuedStoryCompactions(sessionId: string): void {
  queuedStoryCompactions.delete(sessionId);
}

/**
 * Drop ALL queued compactions for a user (extension uninstall). Iterates the
 * small in-process queue (size = pending jobs, typically 0-2) instead of
 * querying every session the user owns.
 */
export function discardQueuedStoryCompactionsForUser(userId: string): void {
  for (const [sessionId, args] of queuedStoryCompactions) {
    if (args.userId === userId) queuedStoryCompactions.delete(sessionId);
  }
}
