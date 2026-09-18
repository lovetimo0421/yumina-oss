import { usageObservation } from "./usage-observation.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SessionMemory } from "@yumina/shared";
import { db } from "../db/index.js";
import { messages, playSessions, worlds } from "../db/schema.js";
import { recordUsageLog } from "./usage-log.js";
import { billBackgroundUsage, prepareBackgroundUsageBill } from "./background-billing.js";
import { resolveProviderForModel, type ResolvedProvider } from "./resolve-provider.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { captureServerEvent } from "./analytics.js";
import { runtimeIdentity } from "./runtime-identity.js";
import { memoryPromptWithBudget } from "./session-memory-prompts.js";
import { canRunMemoryQa, createMemoryQaProvider, type MemoryQaScenario } from "./session-memory-qa.js";
import type { GenerateParams } from "./llm/types.js";
import { isExtensionInstalled } from "./extensions.js";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import type { ChatMessage } from "./llm/types.js";
import { enqueueKeyedJob } from "./job-chain.js";
import { memoryClaimGuard, memoryLagGuard, memorySourceGuard, pendingMemoryRange, type MemoryJobSnapshot } from "./session-memory-guards.js";
import { buildSummaryLanguageInstruction, resolveSummaryOutputLanguage, type SessionSummaryLanguage } from "./summary-language.js";
export {
  DegenerateSessionMemoryError,
  MAX_PINNED_MEMORY_CHARS,
  TruncatedSessionMemoryError,
  emptySessionMemory,
  formatSessionMemoryForPrompt,
  generateHealthySessionMemory,
  hasSessionMemory,
  isDegenerateSessionMemoryText,
  normalizePinnedMemory,
  normalizeSessionMemory,
  sanitizeSessionMemoryForGeneration,
} from "./session-memory-core.js";
import {
  MAX_MEMORY_OUTPUT_TOKENS,
  MEMORY_TARGET_CHARS,
  MEMORY_RECOVERY_TARGET_CHARS,
  MAX_MEMORY_CHARS,
  TruncatedSessionMemoryError,
  generateCompleteMemory,
  generateHealthySessionMemory,
  emptySessionMemory,
  memoryBudgetInstruction,
  memoryBatchTurnLimit,
  hasUncertainMemoryCoverage,
  normalizeSessionMemory,
  sanitizeSessionMemoryForGeneration,
  selectPendingMemoryBatch,
  shouldUpdateSessionMemory,
  selectLaggedRebuildWindow,
} from "./session-memory-core.js";

/**
 * The output cap the updater ran with for months. Some user-selected memory
 * models behind custom/OpenAI-compatible keys still refuse anything above
 * their (often 4,096) output ceiling with a 400 instead of clamping; one
 * retry at the old cap keeps those configurations working.
 */
const LEGACY_MEMORY_OUTPUT_TOKENS = 4_000;

function isOutputCapRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /max_tokens|max_completion_tokens|maximum (?:number of )?(?:output|completion) tokens|output token limit/i.test(message);
}

// See DEFAULT_STORY_SUMMARY_MODEL: cheap, CJK-aware, and not the deprecated
// x-ai/grok-4.1-fast (which redirects to the ~20x-pricier x-ai/grok-4.20).
export const DEFAULT_SESSION_MEMORY_MODEL = "google/gemini-2.5-flash-lite";
const DEGENERATE_SESSION_MEMORY_FALLBACK_MODEL = "deepseek/deepseek-v4-flash";

const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_STATE_CHARS = 8_000;
const MAX_REBUILD_TRANSCRIPT_ROWS = 400;
const MAX_INCREMENTAL_TRANSCRIPT_ROWS = 200;
const SOURCE_HASH_VERSION = 2;

type IncrementalUpdateArgs = {
  sessionId: string;
  userId: string;
  userMessage: string;
  assistantMessage: string;
  state: unknown;
  fallbackModel: string;
  assistantMessageId?: string | null;
  force?: boolean;
};

type PreparedMemoryJob = {
  model: string;
  prompt: ChatMessage[];
  sourceHash: string;
  processedMessageId: string | null;
  snapshot?: MemoryJobSnapshot;
  clearStale?: boolean;
  sourceRows?: Array<{ id: string; content: string }>;
  excludedReplyId?: string;
};

type MemoryUsage = Parameters<typeof billBackgroundUsage>[0];
type GeneratedMemory = { memory: SessionMemory; usage?: MemoryUsage; model: string; attempts: number; synthetic?: boolean };

function memoryEvent(userId: string, props: Record<string, unknown>) {
  captureServerEvent(userId, "summary_job", {
    ...runtimeIdentity, system: "session-memory", ...props,
    memory_revision: "2026-09-15-retain-partial-memory",
    code_release: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.APP_RELEASE ?? "unknown",
  });
}

const sessionMemoryJobChains = new Map<string, Promise<unknown>>();
const queuedIncrementalUpdates = new Map<string, IncrementalUpdateArgs>();
const incrementalDrainActive = new Set<string>();

/** Stop per-turn auto-retries after this many consecutive background failures. */
const SESSION_MEMORY_MAX_CONSECUTIVE_FAILURES = 3;

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

function trimFromStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[Earlier transcript omitted]\n${text.slice(text.length - maxChars)}`;
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

function createMemorySourceHash(value: unknown): string {
  // Unique ownership prevents an expired/retried identical-input job from
  // committing under its successor's lease. Coverage provides deduplication.
  return `v2:${createHash("sha256").update(stableStringify(value)).digest("hex")}:${randomUUID()}`;
}

function enqueueSessionMemoryJob<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
  return enqueueKeyedJob(sessionMemoryJobChains, sessionId, job);
}

/**
 * Deliberately NOT JSON. The old strict-JSON schema regularly broke with cheap
 * updater models (truncated output, unescaped quotes, CJK dialogue) and a
 * parse failure lost the whole turn's facts. Plain text can't fail to parse.
 */
function stripCodeFences(text: string): string {
  return text.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
}

// `autoSourceLabel` names what "auto" copies its language from. It matters
// most for sessions that already hold an English memory from before this
// setting existed: without the pointer the model sees English memory next to
// a Chinese turn and keeps writing English forever, so the fix never lands.
function buildMemoryFormatInstruction(language: SessionSummaryLanguage, autoSourceLabel: string): string {
  return `Return ONLY the full updated memory as plain text — no JSON, no code fences, no commentary before or after.

Organize the memory with these section headings, each followed by "- " bullet lines (omit a section entirely when it has nothing important):
Core facts:
Relationship changes:
Active goals and open threads:
Important decisions and promises:
World state and inventory:
Current risks and constraints:

Rules:
- Keep only information that will matter in future turns.
- Store session continuity only. Do not store author lore, style instructions, preset rules, or system prompt text.
- Do not invent facts.
- Update or remove old facts if the new conversation contradicts them.
- State each fact once. Merge duplicate or overlapping facts instead of repeating them.
- Prefer concise durable facts over copied prose, but keep names, objects, locations, causes, promises, and current status.
- Avoid vague items like "relationship improved" or "they have a goal" unless the item says who, what changed, and why it matters.
- Aim for the writing target provided with this request, but preserve essential continuity and finish every fact. Remove unnecessary detail and repetition first.

${buildSummaryLanguageInstruction(language, { keepEnglishHeadings: true, autoSourceLabel })}`;
}

async function generateMemoryText(args: {
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  resolvedProvider?: ResolvedProvider;
  resolveSizeRecovery?: () => Promise<{ model: string; resolved: ResolvedProvider } | null>;
  budget: { remaining: number };
  jobId: string;
  onAccepted: (usage: MemoryUsage | undefined, model: string) => void;
  synthetic?: boolean;
}): Promise<SessionMemory> {
  const initialProvider = args.resolvedProvider
    ?? await resolveProviderForModel(args.userId, args.model, {
      allowOfficialFallback: false,
    });
  if (!initialProvider) {
    throw new Error("No provider/API key is available for the selected memory model");
  }
  let resolved = initialProvider;
  let activeModel = args.model;

  let candidateUsage: MemoryUsage | undefined;
  let candidateWritingTarget = 0;
  let previousOutput: { text: string; completionTokens: number; stopReason: string | null; outputLimit: number } | undefined;
  const attempt = async (maxTokens: number, prompt: ChatMessage[]) => {
    if (args.budget.remaining <= 0) throw new TruncatedSessionMemoryError();
    args.budget.remaining--;
    candidateUsage = undefined;
    const start = Date.now();
    let text = "";
    let observation = usageObservation();
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let stopReason: string | null = null;
    for await (const chunk of resolved.provider.generateStream({
      conversationId: `play:${args.sessionId}`,
      model: activeModel,
      messages: prompt,
      // Must hold a MEMORY_TARGET_CHARS memory in CJK (see session-memory-core).
      // A second size-limited response may be saved with a visible warning.
      maxTokens,
      temperature: 0.2,
      // Memory needs final text; native DeepSeek thinking otherwise consumes
      // this output budget before the memory can be completed.
      disableReasoning: true,
    })) {
      if (chunk.type === "text") text += chunk.content;
      if (chunk.usage) {
        observation = usageObservation(chunk.usage);
        promptTokens = chunk.usage.promptTokens;
        completionTokens = chunk.usage.completionTokens;
        totalTokens = chunk.usage.totalTokens;
      }
      if (chunk.stopReason) stopReason = chunk.stopReason;
      if (chunk.type === "error") throw new Error(chunk.content || "Memory generation failed");
    }
    if (totalTokens > 0) {
      const usageLogId = randomUUID();
      await recordUsageLog({
        ...observation,
        id: usageLogId,
        userId: args.userId,
        sessionId: args.sessionId,
        model: activeModel,
        promptTokens,
        completionTokens,
        totalTokens,
        endpoint: "session-memory",
        apiKeyTier: resolved.apiKeyTier,
        generationTimeMs: Date.now() - start,
      });
      // Keep all provider usage for accounting, but only the accepted candidate
      // can be charged, in the same transaction as the memory commit.
      if (!resolved.isByok) {
        candidateUsage = {
          userId: args.userId,
          model: activeModel,
          promptTokens,
          completionTokens,
          usageLogId,
          endpoint: "session-memory",
        };
      }
    }
    previousOutput = { text: stripCodeFences(text), completionTokens, stopReason, outputLimit: maxTokens };
    return previousOutput;
  };

  let outputLimit = MAX_MEMORY_OUTPUT_TOKENS;
  const memory = await generateCompleteMemory({
    model: args.model,
    canRecover: () => args.budget.remaining > 0,
    onAttempt: (result) => {
      memoryEvent(args.userId, {
        outcome: "attempt", session_id: args.sessionId, job_id: args.jobId,
        synthetic: !!args.synthetic,
        model: activeModel, attempt: 2 - args.budget.remaining,
        reason: result.verdict, output_chars: result.textChars,
        completion_tokens: result.completionTokens, stop_reason: result.stopReason ?? null,
        output_limit: result.outputLimit, writing_target: candidateWritingTarget,
        acceptance_limit: MAX_MEMORY_CHARS, usage_log_id: candidateUsage?.usageLogId ?? null,
      });
    },
    generate: async (targetChars, recovery) => {
      // Semantic fallback starts a new generator but is still caller attempt 2.
      recovery ||= args.budget.remaining < 2;
      if (recovery) targetChars = MEMORY_RECOVERY_TARGET_CHARS;
      // A model that keeps copying its near-full memory also copies the shorter
      // retry. Spend the existing second attempt on the allowed fallback, just
      // as empty/repetitive output already does. Private boundaries still apply.
      if (recovery && args.resolveSizeRecovery) {
        const fallback = await args.resolveSizeRecovery();
        if (fallback) {
          activeModel = fallback.model;
          resolved = fallback.resolved;
          memoryEvent(args.userId, {
            outcome: "size_retry", session_id: args.sessionId, job_id: args.jobId,
            model: args.model, fallback_model: activeModel,
          });
        }
      }
      candidateWritingTarget = targetChars;
      const prompt = memoryPromptWithBudget(args.prompt, targetChars, recovery, previousOutput);
      try {
        return await attempt(outputLimit, prompt);
      } catch (err) {
        if (outputLimit !== MAX_MEMORY_OUTPUT_TOKENS || !isOutputCapRejection(err) || args.budget.remaining <= 0) throw err;
        outputLimit = LEGACY_MEMORY_OUTPUT_TOKENS;
        candidateWritingTarget = MEMORY_RECOVERY_TARGET_CHARS;
        return attempt(outputLimit, memoryPromptWithBudget(args.prompt, MEMORY_RECOVERY_TARGET_CHARS, true));
      }
    },
  });
  // Include warning saves in atomic accepted-output billing, never an earlier
  // rejected draft. Semantic rejection below still prevents a commit/debit.
  args.onAccepted(candidateUsage, activeModel);
  return memory;
}

async function generateHealthyMemoryText(args: {
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  jobId: string;
  qaProvider?: ResolvedProvider;
}): Promise<GeneratedMemory> {
  const fallbackModel = args.model.startsWith("deepseek/")
    ? DEFAULT_SESSION_MEMORY_MODEL
    : DEGENERATE_SESSION_MEMORY_FALLBACK_MODEL;
  const primaryProvider = args.qaProvider ?? await resolveProviderForModel(args.userId, args.model, {
    allowOfficialFallback: false,
  });
  if (!primaryProvider) {
    throw new Error(`No API key available for model ${args.model}`);
  }
  let fallbackProvider: ResolvedProvider | null = null;
  // Shared across shortening and semantic fallback: two generation attempts.
  // Providers retain their existing transport/parameter-compatibility retries.
  const budget = { remaining: 2 };
  let usage: MemoryUsage | undefined;
  let acceptedModel = args.model;

  const canRetryWithFallback = async (retryModel: string) => {
    if (args.qaProvider) return false;
    if (budget.remaining <= 0) return false;
    fallbackProvider = await resolveProviderForModel(args.userId, retryModel, {
      allowOfficialFallback: false,
    });
    if (!fallbackProvider) return false;
    // Neither size nor semantic recovery may leave the selected access boundary.
    return fallbackProvider.isByok === primaryProvider.isByok
      && fallbackProvider.providerName === primaryProvider.providerName;
  };

  const memory = await generateHealthySessionMemory({
    primaryModel: args.model,
    fallbackModel,
    generate: (model) => generateMemoryText({
      ...args,
      budget,
      synthetic: !!args.qaProvider,
      onAccepted: (acceptedUsage, model) => { usage = acceptedUsage; acceptedModel = model; },
      model,
      resolvedProvider: model === args.model ? primaryProvider : fallbackProvider ?? undefined,
      resolveSizeRecovery: model === args.model ? async () =>
        await canRetryWithFallback(fallbackModel)
          ? { model: fallbackModel, resolved: fallbackProvider! }
          : null : undefined,
    }),
    canRetry: canRetryWithFallback,
    onRetry: (retryModel) => {
      console.warn(`[SessionMemory] Repetitive output; retrying with ${retryModel}`);
      memoryEvent(args.userId, {
        system: "session-memory",
        outcome: "degenerate_retry",
        session_id: args.sessionId,
        model: args.model,
        fallback_model: retryModel,
      });
    },
    onFailure: () => {
      memoryEvent(args.userId, {
        system: "session-memory",
        outcome: "degenerate_failed",
        session_id: args.sessionId,
        model: args.model,
      });
    },
  });
  return { memory, usage, model: acceptedModel, attempts: 2 - budget.remaining, synthetic: !!args.qaProvider };
}

function buildIncrementalPrompt(args: {
  previousMemory: SessionMemory;
  transcript: string;
  state: unknown;
  worldName?: string | null;
  language: SessionSummaryLanguage;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You update continuity memory for an AI roleplay session.",
        buildMemoryFormatInstruction(args.language, "the latest turn"),
        // Oversize existing memory (legacy 8k-12k rows, or an overshoot) must
        // be compressed, not faithfully rewritten into the output cap.
        memoryBudgetInstruction(args.previousMemory.text.length),
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: [
        `World: ${args.worldName || "Unknown"}`,
        "Existing memory:",
        args.previousMemory.text || "(empty)",
        "Unprocessed exchanges, in chronological order (include every exchange):",
        args.transcript,
        "Current game state JSON:",
        stringifyCompact(args.state, MAX_STATE_CHARS),
        "Update the memory so it remains useful for future continuity.",
      ].join("\n\n"),
    },
  ];
}

function buildRegeneratePrompt(args: {
  summary: string | null;
  transcript: string;
  state: unknown;
  worldName?: string | null;
  language: SessionSummaryLanguage;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You rebuild continuity memory for an AI roleplay session from the available transcript.",
        buildMemoryFormatInstruction(args.language, "the visible transcript"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `World: ${args.worldName || "Unknown"}`,
        args.summary ? `[Compacted earlier summary]\n${args.summary}` : "[Compacted earlier summary]\nNone",
        "[Visible transcript]",
        trimFromStart(args.transcript, MAX_TRANSCRIPT_CHARS),
        "[Current game state JSON]",
        stringifyCompact(args.state, MAX_STATE_CHARS),
        "Build the best current session memory. Exclude system prompt instructions.",
      ].join("\n\n"),
    },
  ];
}

function prepareIncrementalMemoryJob(args: IncrementalUpdateArgs & { transcript: string }, row: {
  session: typeof playSessions.$inferSelect;
  worldName: string | null;
  worldLanguage: string | null;
}): PreparedMemoryJob {
  // applyModelRedirect: persisted sessionMemoryModel values can hold
  // deprecated ids that 404 on every background run (seen live: sessions
  // stuck on x-ai/grok-4.1-fast).
  const model = applyModelRedirect(row.session.sessionMemoryModel || DEFAULT_SESSION_MEMORY_MODEL || args.fallbackModel);
  const previousMemory = sanitizeSessionMemoryForGeneration(row.session.sessionMemory);
  const processedMessageId = args.assistantMessageId ?? null;
  // Resolved from the folded turn's own text — NEVER from the previous memory
  // (a legacy English memory next to a Chinese turn is exactly the trap).
  const language = resolveSummaryOutputLanguage({
    configured: row.session.summaryLanguage,
    sourceText: args.transcript,
    worldLanguage: row.worldLanguage,
  });
  const sourceHash = createMemorySourceHash({
    version: SOURCE_HASH_VERSION,
    kind: "incremental",
    sessionId: args.sessionId,
    model,
    language,
    processedMessageId,
    transcript: args.transcript,
    previousMemory,
    state: args.state,
  });

  return {
    model,
    sourceHash,
    processedMessageId,
    snapshot: row.session,
    prompt: buildIncrementalPrompt({
      previousMemory,
      transcript: args.transcript,
      state: args.state,
      worldName: row.worldName,
      language,
    }),
  };
}

function prepareRegenerateMemoryJob(args: {
  sessionId: string;
  model: string;
  transcript: string;
  summary: string | null;
  state: unknown;
  worldName?: string | null;
  processedMessageId: string | null;
  language: SessionSummaryLanguage;
}): PreparedMemoryJob {
  return {
    model: args.model,
    processedMessageId: args.processedMessageId,
    sourceHash: createMemorySourceHash({
      version: SOURCE_HASH_VERSION,
      kind: "regenerate",
      sessionId: args.sessionId,
      model: args.model,
      language: args.language,
      processedMessageId: args.processedMessageId,
      summary: args.summary,
      transcript: args.transcript,
      state: args.state,
    }),
    prompt: buildRegeneratePrompt({
      summary: args.summary,
      transcript: args.transcript,
      state: args.state,
      worldName: args.worldName,
      language: args.language,
    }),
  };
}

export async function persistSessionMemoryResult(args: {
  sessionId: string;
  userId: string;
  memory: SessionMemory;
  job: PreparedMemoryJob;
  generation?: GeneratedMemory;
}): Promise<boolean> {
  // Only the current owner may commit, and every source message must still
  // match. New chat turns may arrive while this runs without invalidating it.
  const whereClause = and(
    eq(playSessions.id, args.sessionId),
    eq(playSessions.sessionMemoryStatus, "updating"),
    eq(playSessions.sessionMemorySourceHash, args.job.sourceHash),
    memorySourceGuard(args.sessionId, args.job.sourceRows ?? []),
    memoryLagGuard(args.sessionId, args.job.excludedReplyId),
  );

  const charge = args.generation?.usage ? await prepareBackgroundUsageBill(args.generation.usage) : null;
  const committed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(playSessions)
      .set({
        sessionMemory: args.memory,
        sessionMemoryModel: args.job.model,
        sessionMemoryUpdatedAt: new Date(),
        sessionMemoryStatus: "idle",
        sessionMemoryClaimedAt: null,
        sessionMemoryError: null,
        sessionMemoryRetryCount: 0,
        sessionMemorySourceHash: args.job.sourceHash.replace(/^repair:/, ""),
        sessionMemoryProcessedMessageId: args.job.processedMessageId,
        ...(args.job.clearStale ? { sessionMemoryStaleAt: null } : {}),
      })
      .where(whereClause)
      .returning();
    if (updated.length === 0) return false;
    await charge?.(tx);
    return true;
  });

  if (!committed) {
    console.warn(`[SessionMemory] Dropped stale memory result for session ${args.sessionId}`);
    memoryEvent(args.userId, {
      system: "session-memory",
      outcome: "dropped_stale",
      job_id: args.job.sourceHash,
      session_id: args.sessionId,
      model: args.job.model,
    });
    await db
      .update(playSessions)
      .set({
        sessionMemoryStatus: "idle",
        sessionMemoryClaimedAt: null,
        sessionMemoryError: null,
      })
      .where(and(
        eq(playSessions.id, args.sessionId),
        eq(playSessions.sessionMemoryStatus, "updating"),
        eq(playSessions.sessionMemorySourceHash, args.job.sourceHash),
      ));
    return false;
  }
  memoryEvent(args.userId, {
    outcome: "ok", session_id: args.sessionId, job_id: args.job.sourceHash,
    warning: args.memory.warning ?? null, degraded: !!args.memory.warning,
    synthetic: !!args.generation?.synthetic,
    model: args.generation?.model ?? args.job.model, output_chars: args.memory.text.length,
    attempts: args.generation?.attempts, processed_message_id: args.job.processedMessageId,
    charged_usage_log_id: charge ? args.generation?.usage?.usageLogId : null,
  });
  return true;
}

async function markSessionMemoryJobUpdating(args: {
  sessionId: string;
  job: PreparedMemoryJob;
  resetRetries?: boolean;
}): Promise<boolean> {
  if (!args.job.snapshot) throw new Error("Memory job is missing its input snapshot");
  const now = new Date();
  const claimed = await db
    .update(playSessions)
    .set({
      sessionMemoryModel: args.job.model,
      sessionMemoryStatus: "updating",
      sessionMemoryClaimedAt: now,
      sessionMemoryError: null,
      // Manual regenerate = the user explicitly retrying (likely after fixing
      // a broken model config) — give the auto-retry budget a fresh window.
      ...(args.resetRetries ? { sessionMemoryRetryCount: 0 } : {}),
      sessionMemorySourceHash: args.job.sourceHash,
      // A legacy attempt position isn't coverage. Invalidating it also keeps
      // a settings change during repair from making that position trusted.
      ...(args.job.sourceHash.startsWith("repair:") ? { sessionMemoryProcessedMessageId: null } : {}),
    })
    .where(and(
      eq(playSessions.id, args.sessionId), memoryClaimGuard(args.job.snapshot, now),
      memorySourceGuard(args.sessionId, args.job.sourceRows ?? []), memoryLagGuard(args.sessionId, args.job.excludedReplyId),
    ))
    .returning();
  return claimed.length > 0;
}

async function markSessionMemoryJobFailed(args: {
  sessionId: string;
  job?: PreparedMemoryJob | null;
  error: unknown;
  fallbackMessage: string;
  snapshot?: MemoryJobSnapshot;
}): Promise<void> {
  const message = args.error instanceof Error ? args.error.message : args.fallbackMessage;
  const whereClause = args.job
    ? and(
        eq(playSessions.id, args.sessionId),
        eq(playSessions.sessionMemoryStatus, "updating"),
        eq(playSessions.sessionMemorySourceHash, args.job.sourceHash),
      )
    : args.snapshot
      ? and(eq(playSessions.id, args.sessionId), memoryClaimGuard(args.snapshot, new Date()))
      : undefined;
  if (!whereClause) return;

  await db
    .update(playSessions)
    .set({
      sessionMemoryStatus: "failed",
      sessionMemoryClaimedAt: null,
      sessionMemoryError: message,
      sessionMemoryRetryCount: sql`${playSessions.sessionMemoryRetryCount} + 1`,
    })
    .where(whereClause);
}

async function regenerateSessionMemoryForSessionNow(args: {
  sessionId: string;
  userId: string;
  model?: string | null;
  repairLegacy?: boolean;
  qaProvider?: ResolvedProvider;
  force?: boolean;
}): Promise<SessionMemory> {
  const [row] = await db
    .select({
      session: playSessions,
      worldName: worlds.name,
      worldLanguage: worlds.language,
    })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, args.sessionId), eq(playSessions.userId, args.userId)))
    .limit(1);

  if (!row) throw new Error("Session not found");

  const model = applyModelRedirect((args.model || row.session.sessionMemoryModel || DEFAULT_SESSION_MEMORY_MODEL).trim());

  let job: PreparedMemoryJob | null = null;
  try {
    const transcriptRowsDesc = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(and(
        eq(messages.sessionId, args.sessionId),
        inArray(messages.role, ["user", "assistant"]),
      ))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(MAX_REBUILD_TRANSCRIPT_ROWS);
    const transcriptRows = transcriptRowsDesc.reverse();
    // Lag-one invariant (selectLaggedRebuildWindow): rebuild from everything
    // up to the second-to-last reply, so the newest visible reply never enters
    // memory and regenerating it stays unbiased.
    const window = selectLaggedRebuildWindow(transcriptRows);
    if (window.rows.length === 0) {
      // At most one visible reply — nothing to memorize yet. Clear instead of
      // burning an LLM call over an empty window.
      await db
        .update(playSessions)
        .set({
          sessionMemory: null,
          sessionMemoryUpdatedAt: null,
          sessionMemoryStatus: "idle",
          sessionMemoryClaimedAt: null,
          sessionMemoryError: null,
          sessionMemoryRetryCount: 0,
          sessionMemorySourceHash: null,
          sessionMemoryProcessedMessageId: null,
          sessionMemoryStaleAt: null,
        })
        .where(and(eq(playSessions.id, args.sessionId), memoryClaimGuard(row.session, new Date())));
      return emptySessionMemory();
    }
    const transcript = window.rows
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    const windowTail = window.rows[window.rows.length - 1]!;
    // Legacy repair now also runs automatically. Avoid loading/parsing up to
    // 400 potentially large JSON snapshots just to use the endpoint's state.
    const [windowState] = await db.select({ stateSnapshot: messages.stateSnapshot }).from(messages)
      .where(and(eq(messages.sessionId, args.sessionId), eq(messages.id, windowTail.id))).limit(1);
    job = prepareRegenerateMemoryJob({
      sessionId: args.sessionId,
      model,
      transcript,
      summary: row.session.summary,
      // State as of the window's last reply when its snapshot survives — the
      // live state already includes the newest reply's effects.
      state: windowState?.stateSnapshot ?? {},
      worldName: row.worldName,
      processedMessageId: window.processedMessageId,
      language: resolveSummaryOutputLanguage({
        configured: row.session.summaryLanguage,
        sourceText: transcript,
        worldLanguage: row.worldLanguage,
      }),
    });
    job.snapshot = row.session;
    job.sourceRows = window.rows;
    job.excludedReplyId = transcriptRows.filter(m => m.role === "assistant").at(-1)?.id;
    job.clearStale = !args.repairLegacy;
    if (args.repairLegacy) {
      // An attempted repair cannot certify the legacy pointer. Keep this
      // marker through failure; only a successful commit removes it.
      job.sourceHash = `repair:${job.sourceHash}`;
      // Old failed rows advanced their pointer BEFORE saving, so it cannot
      // establish coverage. Rebuild once from the bounded transcript + summary,
      // retaining old durable facts that the surviving transcript doesn't contradict.
      job.prompt.splice(1, 0, { role: "user", content: `Previous memory (may be incomplete; the surviving transcript below takes precedence):\n${normalizeSessionMemory(row.session.sessionMemory).text}` });
    }
    if (!await markSessionMemoryJobUpdating({ sessionId: args.sessionId, job, resetRetries: !args.repairLegacy || args.force })) {
      return normalizeSessionMemory(row.session.sessionMemory);
    }
    const generation = await generateHealthyMemoryText({
      userId: args.userId,
      sessionId: args.sessionId,
      model: job.model,
      prompt: job.prompt,
      jobId: job.sourceHash,
      qaProvider: args.qaProvider,
    });

    const memory = generation.memory;
    const persisted = await persistSessionMemoryResult({ sessionId: args.sessionId, userId: args.userId, memory, job, generation });
    if (!persisted) {
      return normalizeSessionMemory(row.session.sessionMemory);
    }

    return memory;
  } catch (err) {
    await markSessionMemoryJobFailed({
      sessionId: args.sessionId,
      job,
      snapshot: row.session,
      error: err,
      fallbackMessage: "Failed to regenerate session memory",
    });
    memoryEvent(args.userId, {
      system: "session-memory",
      outcome: "failed",
      job_id: job?.sourceHash ?? null,
      session_id: args.sessionId,
      model: job?.model ?? model,
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function regenerateSessionMemoryForSession(args: {
  sessionId: string;
  userId: string;
  model?: string | null;
  /** Internal QA only; the public regenerate body schema does not expose it. */
  qa?: { scenario: MemoryQaScenario; calls: GenerateParams[] };
}): Promise<SessionMemory> {
  return enqueueSessionMemoryJob(args.sessionId, async () => {
    if (args.qa && !await canRunMemoryQa(args.sessionId, args.userId)) throw new Error("Memory QA is unavailable");
    return regenerateSessionMemoryForSessionNow({...args, qaProvider: args.qa ? createMemoryQaProvider(args.qa.scenario, args.qa.calls) : undefined});
  });
}

async function updateSessionMemoryIncrementally(args: IncrementalUpdateArgs): Promise<void> {
  const [row] = await db
    .select({
      session: playSessions,
      worldName: worlds.name,
      worldLanguage: worlds.language,
    })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, args.sessionId), eq(playSessions.userId, args.userId)))
    .limit(1);

  if (!row) return;
  if ((!row.session.sessionMemoryIncluded && !args.force) || !await isExtensionInstalled(args.userId, SESSION_MEMORY_EXTENSION_KEY)) return;

  // Retry the same uncovered interval on later turns, stopping after three
  // failures. Explicit Retry gives the counter a fresh window.
  if (
    !args.force && row.session.sessionMemoryStatus === "failed" &&
    (row.session.sessionMemoryRetryCount ?? 0) >= SESSION_MEMORY_MAX_CONSECUTIVE_FAILURES
  ) {
    return;
  }

  if (hasUncertainMemoryCoverage(row.session)) {
    // Legacy failed pointers describe attempted, not saved, coverage. Keep
    // already-paused sessions paused until explicit Retry (the cap above).
    await regenerateSessionMemoryForSessionNow({ ...args, repairLegacy: true });
    return;
  }

  let job: PreparedMemoryJob | null = null;
  try {
    const boundary = await loadMemoryPendingBoundary(row.session);
    if (!boundary) return;
    if (boundary.needsRebuild) {
      await regenerateSessionMemoryForSessionNow({ ...args, repairLegacy: true });
      return;
    }
    // Oldest FIRST after the successful cursor. A merged queue entry, failed
    // job or restart can delay work, but can no longer skip its input.
    const transcriptRows = await db.select({
      id: messages.id, role: messages.role, content: messages.content,
    }).from(messages).where(boundary.where)
      .orderBy(asc(messages.createdAt), asc(messages.id)).limit(MAX_INCREMENTAL_TRANSCRIPT_ROWS);
    const batch = selectPendingMemoryBatch(transcriptRows, undefined,
      memoryBatchTurnLimit(row.session.sessionMemoryRetryCount ?? 0, row.session.sessionMemoryError));
    const previousMemory = normalizeSessionMemory(row.session.sessionMemory);
    if (!shouldUpdateSessionMemory({
      pendingTurns: batch.turns, pendingChars: batch.chars,
      hasMemory: !!previousMemory.text, failed: row.session.sessionMemoryStatus === "failed",
      overBudget: previousMemory.text.length > MEMORY_TARGET_CHARS, force: args.force,
    })) return;
    // State snapshots can be much larger than the text. Read only the state
    // at this batch's endpoint, not up to 200 historical copies of it.
    const [batchState] = await db.select({ stateSnapshot: messages.stateSnapshot }).from(messages)
      .where(and(eq(messages.sessionId, args.sessionId), eq(messages.id, batch.processedMessageId!))).limit(1);
    job = prepareIncrementalMemoryJob({
      ...args,
      transcript: batch.rows.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n"),
      state: batchState?.stateSnapshot ?? {},
      assistantMessageId: batch.processedMessageId,
    }, row);
    job.sourceRows = batch.rows;
    job.excludedReplyId = boundary.latestReplyId;
    if (!await markSessionMemoryJobUpdating({ sessionId: args.sessionId, job, resetRetries: args.force })) return;
    memoryEvent(args.userId, { outcome: "started", session_id: args.sessionId, job_id: job.sourceHash,
      model: job.model, batch_turns: batch.turns, batch_chars: batch.chars });
    const generation = await generateHealthyMemoryText({
      userId: args.userId,
      sessionId: args.sessionId,
      model: job.model,
      prompt: job.prompt,
      jobId: job.sourceHash,
    });

    // A later incremental save cannot prove it recovered facts omitted earlier.
    // Full regeneration or an explicit manual edit can clear the warning.
    if (previousMemory.warning) generation.memory.warning = previousMemory.warning;
    await persistSessionMemoryResult({ sessionId: args.sessionId, userId: args.userId, memory: generation.memory, job, generation });
  } catch (err) {
    await markSessionMemoryJobFailed({
      sessionId: args.sessionId,
      job,
      snapshot: row.session,
      error: err,
      fallbackMessage: "Failed to update session memory",
    });
    memoryEvent(args.userId, {
      system: "session-memory",
      outcome: "failed",
      job_id: job?.sourceHash ?? null,
      session_id: args.sessionId,
      model: job?.model ?? row.session.sessionMemoryModel,
      error_message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function loadMemoryPendingBoundary(row: typeof playSessions.$inferSelect) {
  const replies = await db.select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages).where(and(eq(messages.sessionId, row.id), eq(messages.role, "assistant")))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(2);
  const safeTip = replies[1];
  if (!safeTip?.createdAt) return null;
  const cursorId = row.sessionMemoryProcessedMessageId;
  const cursor = cursorId ? (await db.select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages).where(and(eq(messages.sessionId, row.id), eq(messages.id, cursorId))).limit(1))[0] : null;
  const needsRebuild = !!cursorId && !cursor?.createdAt
    || !cursorId && !!normalizeSessionMemory(row.sessionMemory).text;
  return {
    needsRebuild,
    latestReplyId: replies[0]!.id,
    where: pendingMemoryRange(row.id, safeTip.id, cursor?.id ?? null),
  };
}

export async function sessionMemoryProgress(row: typeof playSessions.$inferSelect) {
  const boundary = await loadMemoryPendingBoundary(row);
  const unknownCoverage = boundary?.needsRebuild
    || hasUncertainMemoryCoverage(row);
  const [count] = boundary && !unknownCoverage ? await db.select({ n: sql<number>`count(*)::int` })
    .from(messages).where(and(boundary.where, eq(messages.role, "assistant"))) : [{ n: 0 }];
  return {
    pendingTurns: unknownCoverage ? null : count?.n ?? 0,
    autoPaused: row.sessionMemoryStatus === "failed" && row.sessionMemoryRetryCount >= SESSION_MEMORY_MAX_CONSECUTIVE_FAILURES,
    retryCount: row.sessionMemoryRetryCount,
  };
}

/** Explicit retry catches up from coverage; it does not replace existing
 * memory from a recent-history-only rebuild. A single bounded batch per click. */
export function retrySessionMemoryForSession(args: { sessionId: string; userId: string }): Promise<void> {
  return enqueueSessionMemoryJob(args.sessionId, () => updateSessionMemoryIncrementally({
    ...args, force: true, userMessage: "", assistantMessage: "", state: {}, fallbackModel: DEFAULT_SESSION_MEMORY_MODEL,
  }));
}

async function drainQueuedIncrementalUpdates(sessionId: string): Promise<void> {
  while (true) {
    const latest = queuedIncrementalUpdates.get(sessionId);
    if (!latest) return;
    queuedIncrementalUpdates.delete(sessionId);
    await updateSessionMemoryIncrementally(latest);
  }
}

export function scheduleSessionMemoryIncrementalUpdate(args: IncrementalUpdateArgs): void {
  // Self-defend: no-op when the session-memory-summary extension is uninstalled
  // (defense-in-depth behind resolveMemorySystemSettings at the call site).
  void isExtensionInstalled(args.userId, SESSION_MEMORY_EXTENSION_KEY).then((enabled) => {
    if (!enabled) return;
    queuedIncrementalUpdates.set(args.sessionId, args);
    if (incrementalDrainActive.has(args.sessionId)) return;

    incrementalDrainActive.add(args.sessionId);
    enqueueSessionMemoryJob(args.sessionId, () => drainQueuedIncrementalUpdates(args.sessionId))
      .catch((err) => {
      console.warn("[SessionMemory] Background update failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        incrementalDrainActive.delete(args.sessionId);
        const latest = queuedIncrementalUpdates.get(args.sessionId);
        if (latest) scheduleSessionMemoryIncrementalUpdate(latest);
      });
  }).catch((err) => {
    // The entitlement check reads the DB; without this catch a transient DB
    // error here becomes a process-level unhandledRejection.
    console.warn("[SessionMemory] Failed to schedule background update:", err instanceof Error ? err.message : err);
  });
}

export function discardQueuedSessionMemoryUpdates(sessionId: string): void {
  queuedIncrementalUpdates.delete(sessionId);
}

/**
 * Drop ALL queued memory updates for a user (extension uninstall). Iterates
 * the small in-process queue instead of querying every session the user owns.
 */
export function discardQueuedSessionMemoryUpdatesForUser(userId: string): void {
  for (const [sessionId, args] of queuedIncrementalUpdates) {
    if (args.userId === userId) queuedIncrementalUpdates.delete(sessionId);
  }
}
