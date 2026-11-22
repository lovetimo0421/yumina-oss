import { assertPriorCoverage, continuitySnapshotGuard, LAYERED_INPUT_FIELDS } from "./continuity-guards.js";
import { NARRATIVE_EVIDENCE_RULES, stripNarrativeReasoning } from "./narrative-evidence.js";
import { isDegenerateSessionMemoryText } from "./session-memory-core.js";
import { usageObservation } from "./usage-observation.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, summaryceptionSnippets, worlds } from "../db/schema.js";
import { recordUsageLog } from "./usage-log.js";
import { backgroundUsageCost, prepareBackgroundUsageBill } from "./background-billing.js";
import { estimateCallCredits, gateBackgroundCharge } from "./background-consent.js";
import { getOfficialProviderFallbackModels, isZeroCostPlayModel } from "./llm/fallback-models.js";
import { resolveProviderForModel } from "./resolve-provider.js";
import { planAllowedModel } from "./plan-model-gate.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { captureServerEvent } from "./analytics.js";
import type { SummaryCompactionNoOpCode } from "@yumina/shared";
import { RECAP_ALL_THINKING_ERROR, SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { getInstalledExtensions } from "./extensions.js";
import { generateWithSummaryFallback } from "./summary-fallback.js";
import type { ChatMessage } from "./llm/types.js";
import { memorySourceGuard, MEMORY_CLAIM_TTL_MS, recapRunStatus } from "./session-memory-guards.js";
import { enqueueKeyedJob } from "./job-chain.js";
import { buildSummaryLanguageInstruction, correctSummaryLanguageOnce, resolveSummaryOutputLanguage, type SessionSummaryLanguage } from "./summary-language.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
  formatMessagesForStoryCompaction,
  normalizeSessionSummaryRecentTailTokens,
  normalizeStorySummaryText,
  selectCompactionWindow,
  selectForcedManualCompactionWindow,
  splitMessagesIntoCompactionChunks,
  type StoryMessageRow,
} from "./session-compaction-core.js";
import { DEFAULT_STORY_SUMMARY_MODEL } from "./session-compaction.js";
import { chatRunModel } from "./role-model.js";
import {
  assembleRecapContext,
  assembleSummaryceptionText,
  endAtLastSentence,
  formatSummaryceptionForPrompt,
  isMergeableSnippet,
  isStaleSnippet,
  LEGACY_SNIPPET_PREFIX,
  markSnippetStale,
  pickLayerToShrink,
  staleSnippetMessageIds,
  SUMMARYCEPTION_MAX_LAYERS,
  SUMMARYCEPTION_SNIPPETS_PER_LAYER,
  SUMMARYCEPTION_SNIPPETS_PER_PROMOTION,
} from "./summaryception-core.js";

const SUMMARYCEPTION_SOURCE_HASH_VERSION = 2;
function isIncompleteSnippet(snippet: { sourceHash: string | null }): boolean {
  return !!snippet.sourceHash && (snippet.sourceHash.startsWith("partial:") || snippet.sourceHash.startsWith("manual:partial:"));
}

type SummaryCandidate = { text: string; partial: boolean; charge?: Awaited<ReturnType<typeof prepareBackgroundUsageBill>> };
// Sized for a CJK-aware summary model (~1 token/Chinese char). Chunk ≈ one
// narrative "beat" (~2 exchanges of dense Chinese RP ≈ ~3k chars); snippet cap
// gives ~one paragraph of dense clauses to hold a beat's facts without bloat.
// Under the old grok default (cl100k, ~2 tokens/char) these were 5_000/360,
// which mapped to the same ~2.5k-char beat but compressed it ~14:1 — too lossy.
const SUMMARYCEPTION_MAX_SNIPPET_TOKENS = 500;
/** Output room for a recap call on the player's own API or machine. We can
 *  only switch thinking off on DeepSeek's own endpoint (deepseek.ts), so a
 *  thinking model there thinks first; at 500 it thought until the cap and
 *  wrote nothing. The chapter itself is still held to the snippet size. */
const RECAP_OWN_MODEL_MAX_TOKENS = 4_000;
/** Output cap for a recap call on our key. The prompt asks for well under it
 *  (SUMMARYCEPTION_MAX_SNIPPET_TOKENS is the size a chapter is expected to
 *  be); the room keeps a chapter from being cut off mid-fact. */
const RECAP_CALL_MAX_TOKENS = 700;
const SUMMARYCEPTION_TARGET_CHUNK_TOKENS = 3_000;
/** The passage per call on the player's own API or machine: fewer, larger
 *  calls on a key they may pay per request for (2026-11-08: 64 recap calls on
 *  one player's relay in 43 minutes). */
const RECAP_OWN_MODEL_CHUNK_TOKENS = 6_000;
/** A chapter cut off at the token cap is redone once on the first half of its
 *  passage (whole exchanges only); otherwise it is kept, ended at its last
 *  full sentence. Pausing on a cut-off (the oldest behavior) stopped the recap
 *  until the player found the retry button; three halvings (the next one) cut
 *  chapters down to a single message and multiplied the calls. */
const SUMMARYCEPTION_MAX_CHUNK_SPLITS = 1;
/** What one call reads of the recap so far (assembleRecapContext): the
 *  chapters just before the passage, and the story's opening ones. */
const RECAP_CONTEXT_TAIL_TOKENS = 3_000;
const RECAP_CONTEXT_HEAD_TOKENS = 1_000;
/** Model calls one automatic run may make, folds, merges and revisions
 *  together, on our key and on the player's own. What is left waits for the
 *  next turn's run. Before this an overflowing turn could fold 12 chunks and
 *  their merges in one go (2026-11-08: 27 calls after one failed send). */
const RECAP_AUTO_MAX_CALLS = 4;
const RECAP_OWN_MODEL_AUTO_MAX_CALLS = 2;
/** A run that has folded the recap this far over its budget merges before it
 *  folds on, instead of only at the end: a long backfill otherwise grew the
 *  recap to 13 times its budget (2026-11-03). */
const RECAP_IN_RUN_SHRINK_FACTOR = 1.25;
const RECAP_IN_RUN_MAX_MERGES = 2;

/** One run's allowance, shared by its folds, merges and revisions. */
type RecapRunState = {
  callsLeft: number;
  /** Models that refused the story this run: the rest of the run goes
   *  straight to the fallback instead of asking them again each call. */
  refused: Set<string>;
  chunkTokens: number;
  /** When the run began: a stop the player pressed after it ends it. */
  startedAt: number;
};
/** Merges per run while the recap is over its budget. Bounds one run's cost;
 *  the next fold continues. */
const RECAP_BUDGET_MAX_MERGES_PER_RUN = 4;
/** Chunks one automatic run folds. A normal fold (half of story memory) fits;
 *  a longer backlog waits for the player (see AUTO_BACKFILL_*). */
const SUMMARYCEPTION_AUTO_MAX_CHUNKS = 12;
/** Older history an automatic run may fold without asking: the larger of this
 *  and the story memory itself. Turning the recap on deep into a long story
 *  would otherwise fold hundreds of chunks on the player's credits unasked
 *  (the 2026-10-20 rebuild incident). Beyond it, the run folds the newest
 *  part and sets the rest aside; the memory panel offers the rest, priced. */
const AUTO_BACKFILL_MIN_TOKENS = 24_000;
/** Chapters one player-chosen fold may write (memory panel, "fold N"): a
 *  backstop against a loop, far above any count the panel offers. */
const RECAP_FOLD_MAX_CHUNKS = 400;

type SummaryceptionCompactionArgs = {
  sessionId: string;
  userId: string;
  fallbackModel: string;
  contextTokenLimit?: number | null;
  finalPromptRawTokenLimit?: number | null;
  force?: boolean;
  retryPartial?: boolean;
  /** Largest the recap may be (tokens); older chapters merge to stay under. */
  recapBudgetTokens?: number | null;
  /** Fold every chunk older than the kept tail in this run, not just one. */
  foldAll?: boolean;
  /** The player's story memory: an automatic fold of more older history than
   *  this (or AUTO_BACKFILL_MIN_TOKENS) waits for the player. */
  storyMemoryTokens?: number | null;
  /** The player approved folding the whole backlog (memory panel). */
  backfillApproved?: boolean;
  /** The player chose how far to fold (memory panel): fold every unfolded
   *  message up to and including this one, in as many chapters as it takes. */
  foldThroughMessageId?: string | null;
  /** Run on this model instead (the player chose the free model for the recap). */
  runModel?: string | null;
  /** Started by a turn, not by the player: held to RECAP_AUTO_MAX_CALLS. */
  automatic?: boolean;
  run?: RecapRunState;
};

export type SummaryceptionStats = {
  hasSummary: boolean;
  model: string;
  layerCount: number;
  snippetCount: number;
  tokenCount: number | null;
  status: "idle" | "updating" | "failed";
  error: string | null;
  updatedAt: string | null;
  coversUntilMessageId: string | null;
  coversUntilOrdinal: number | null;
  layers: SummaryceptionLayerStats[];
};

export type SummaryceptionLayerStats = {
  layerIndex: number;
  snippets: SummaryceptionSnippetStats[];
};

export type SummaryceptionSnippetStats = {
  id: string;
  layerIndex: number;
  snippetOrder: number;
  text: string;
  sourceStartMessageId: string | null;
  sourceEndMessageId: string | null;
  sourceStartOrdinal: number | null;
  sourceEndOrdinal: number | null;
  fromLayer: number | null;
  mergedCount: number | null;
  promoted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SummaryceptionCompactionResult = {
  summary: string;
  compactedCount: number;
  compactedMessageIds: string[];
  compactedFromMessageId: string | null;
  compactedToMessageId: string | null;
  compactedFromOrdinal: number | null;
  compactedToOrdinal: number | null;
  compactedTokenEstimate: number;
  retainedCount: number;
  retainedTokenEstimate: number;
  noOpReason: string | null;
  noOpReasonCode: SummaryCompactionNoOpCode | null;
};

const summaryceptionJobChains = new Map<string, Promise<unknown>>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function createSummaryceptionSourceHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function enqueueSummaryceptionJob<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
  return enqueueKeyedJob(summaryceptionJobChains, sessionId, job);
}

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```(?:markdown|md|text)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * A recap model that refuses the story (Gemini filters reject much NSFW
 * roleplay outright: 26 of 132 recap chats failed this way on 2026-10-31)
 * retries that call once on a tolerant model, as the story summary does
 * (session-compaction.ts). GMICloud serves it with reasoning forced on, so
 * that host is skipped.
 */
const RECAP_REFUSAL_FALLBACK_MODEL = "deepseek/deepseek-v3.2";
const RECAP_IGNORED_PROVIDERS: Record<string, string[]> = { [RECAP_REFUSAL_FALLBACK_MODEL]: ["gmicloud"] };

function cleanSummaryceptionOutput(raw: string): string {
  return stripNarrativeReasoning(stripCodeFence(raw)).replace(/\s+/g, " ").trim();
}

async function generateSummaryceptionCandidate(args: {
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  singleAttempt?: boolean;
}): Promise<SummaryCandidate> {
  // Yumina Free costs the player nothing on any plan or key, so a player on
  // their own API who picked it in the recap dialog runs it on ours. It found
  // no key there and every run failed (2026-11-09).
  const free = isZeroCostPlayModel(args.model);
  // A summary model above the player's plan runs on the default summary model.
  const allowedModel = free ? args.model : await planAllowedModel(args.userId, args.model, DEFAULT_STORY_SUMMARY_MODEL);
  if (allowedModel !== args.model) args = { ...args, model: allowedModel };
  const resolved = await resolveProviderForModel(args.userId, args.model, {
    allowOfficialFallback: free,
  });
  if (!resolved) throw new Error("No provider/API key is available for the selected summary model");

  // The player's own API or machine: thinking cannot be switched off there,
  // and an empty reply would be empty again, so the provider's empty-reply
  // retries (meant for chat) only multiplied the calls on the player's key
  // (2026-11-03: 669 recap calls for 30 chapters). One attempt, room to think.
  const ownModel = resolved.providerName === "custom" || resolved.providerName === "local" || resolved.providerName === "ollama";
  // Yumina Free always thinks (MODEL_THINKING) and must stay free: it gets
  // the same room to think and never falls back to a priced model.
  const freeModel = isZeroCostPlayModel(args.model);
  const roomToThink = ownModel || freeModel;
  let text = "";
  let thought = false;
  let stopReason: string | undefined;
  let charge: SummaryCandidate["charge"];
  let observation = usageObservation();
    let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  const start = Date.now();

  for await (const chunk of resolved.provider.generateStream({
    conversationId: `play:${args.sessionId}`,
    model: args.model,
    messages: args.prompt,
    maxTokens: roomToThink ? RECAP_OWN_MODEL_MAX_TOKENS : RECAP_CALL_MAX_TOKENS,
    temperature: 0.2,
    disableReasoning: true,
    ignoreProviders: RECAP_IGNORED_PROVIDERS[args.model],
    singleAttempt: ownModel || args.singleAttempt,
    fallbackModels: args.singleAttempt || args.model === DEFAULT_STORY_SUMMARY_MODEL ? undefined
      // Yumina Free's daily pool runs out for the whole account (429
      // free-models-per-day): like a Free turn, the recap goes on on the
      // near-free model at our cost, still billed at Free's zero rate. Our key
      // only; on the player's own key there is no fallback.
      : freeModel ? getOfficialProviderFallbackModels(args.model, resolved.isByok)
      : [DEFAULT_STORY_SUMMARY_MODEL],
  })) {
    if (chunk.type === "text") text += chunk.content;
    if (chunk.type === "reasoning" && chunk.content.trim()) thought = true;
    if (chunk.stopReason) stopReason = chunk.stopReason;
    if (chunk.usage) {
        observation = usageObservation(chunk.usage);
      promptTokens = chunk.usage.promptTokens;
      completionTokens = chunk.usage.completionTokens;
      totalTokens = chunk.usage.totalTokens;
    }
    if (chunk.type === "error") throw new Error(chunk.content || "Summaryception generation failed");
  }

  if (totalTokens > 0) {
    const usageLogId = randomUUID();
    await recordUsageLog({
        ...observation,
      id: usageLogId,
      userId: args.userId,
      sessionId: args.sessionId,
      model: args.model,
      promptTokens,
      completionTokens,
      totalTokens,
      endpoint: "summaryception",
      apiKeyTier: resolved.apiKeyTier,
      generationTimeMs: Date.now() - start,
    });
    // Official-key background work is billed like a send; BYOK is not
    // (mirrors useProtections in routes/messages).
    if (!resolved.isByok) {
      charge = await prepareBackgroundUsageBill({
        userId: args.userId,
        model: args.model,
        promptTokens,
        completionTokens,
        usageLogId,
        endpoint: "summaryception",
      });
    }
  }

  const normalized = cleanSummaryceptionOutput(text);
  // Thinking that ran to the end with no text (some servers stream it as
  // reasoning, others inline as <think>, which the cleanup removes).
  const thoughtOnly = thought || /<(think|thinking|reasoning|thought)\b/i.test(text);
  if (!normalized) throw new Error(ownModel && thoughtOnly ? RECAP_ALL_THINKING_ERROR : "Summaryception model returned an empty summary");
  if (isDegenerateSessionMemoryText(normalized)) throw new Error("Summary model returned repetitive output");
  // A long chapter is kept as written. Redoing one over the chapter size on a
  // shorter passage (11/03) cut a wordy model's chapters down to one message
  // each and multiplied the calls; the budget merges keep the recap's size.
  const partial = stopReason === "max_tokens" || stopReason === "length";
  return { text: partial ? endAtLastSentence(normalized) : normalized, partial, charge };
}

async function generateSummaryceptionText(args: {
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  language: SessionSummaryLanguage;
  run?: RecapRunState;
}): Promise<SummaryCandidate> {
  if (args.run) args.run.callsLeft--;
  // A free recap is not retried on a priced model behind the player's back.
  const fallbackModel = isZeroCostPlayModel(args.model) ? args.model : RECAP_REFUSAL_FALLBACK_MODEL;
  let original: SummaryCandidate | undefined;
  const { model } = await generateWithSummaryFallback({
    model: args.run?.refused.has(args.model) ? fallbackModel : args.model,
    fallbackModel,
    onFallback: (reason) => {
      args.run?.refused.add(args.model);
      console.warn(`[Summaryception] ${args.model} cannot summarize (${reason}); retrying on ${RECAP_REFUSAL_FALLBACK_MODEL}`);
    },
    generate: async (candidateModel) => {
      original = await generateSummaryceptionCandidate({ ...args, model: candidateModel });
      return original.text;
    },
  });
  let corrected: SummaryCandidate | undefined;
  const text = await correctSummaryLanguageOnce({
    text: original!.text,
    language: args.language,
    generate: async (prompt) => {
      corrected = await generateSummaryceptionCandidate({ ...args, model, prompt, singleAttempt: true });
      return corrected.text;
    },
  });
  const accepted = corrected?.text === text ? corrected : original!;
  return { ...accepted, partial: original!.partial || accepted.partial };
}

function buildSummaryceptionPrompt(args: {
  worldName?: string | null;
  priorContext: string;
  passage: string;
  language: SessionSummaryLanguage;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a precise narrative-state tracker for an interactive-fiction session.",
        NARRATIVE_EVIDENCE_RULES,
        "Output only one compact continuity snippet. No preamble, no markdown heading, no commentary.",
        buildSummaryLanguageInstruction(args.language, { autoSourceLabel: "passage_in_question" }),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `World: ${args.worldName || "Unknown"}`,
        "<prior_context>",
        args.priorContext || "(none yet)",
        "</prior_context>",
        "<passage_in_question>",
        args.passage,
        "</passage_in_question>",
        "Summarize only the necessary new information from passage_in_question needed to continue the prior_context.",
        "Focus on current scene continuity, relationship changes, promises, secrets, items, injuries, locations, unresolved tensions, irreversible choices, and world-state changes.",
        "Exclude fluff, repeated atmosphere, static lore, and anything already covered in prior_context.",
        "Be specific with names and concrete consequences. Do not invent hidden motives or facts.",
        "Write one dense paragraph of semicolon-separated clauses, at most about 250 words (about 400 characters in Chinese or Japanese): names, numbers, relationship and status changes, promises, secrets, what is still unresolved. Cut atmosphere, prose and minor detail.",
      ].join("\n"),
    },
  ];
}

async function loadSession(sessionId: string, userId: string) {
  const [row] = await db
    .select({ session: playSessions, worldName: worlds.name, worldLanguage: worlds.language })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

async function loadSummaryceptionRows(sessionId: string): Promise<StoryMessageRow[]> {
  return db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.summaryceptionCompacted, false)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

/**
 * Each story message's place in the whole session (1-based, player and AI
 * messages, failed ones left out), folded or not. Chapters are labelled with
 * these: numbering only the unfolded messages started every chapter at
 * "messages 1-2", so consecutive chapters read as the same one folded again.
 */
async function loadStoryOrdinals(sessionId: string, database: typeof db | SummaryTx = db): Promise<Map<string, number>> {
  const rows = await database
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      inArray(messages.role, ["user", "assistant"]),
      sql`${messages.status} is distinct from 'failed'`,
    ))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  return new Map(rows.map((row, index) => [row.id, index + 1]));
}

/**
 * A chapter ends on a reply. Cut after a player's message, the chapter took
 * what the player meant to do as what happened, and the next one told it
 * again from the reply. `chunk` is a prefix of `pool`.
 */
function endOnReply<T extends { role: string }>(chunk: T[], pool: T[]): T[] {
  if (chunk.length === 0 || chunk.at(-1)!.role === "assistant") return chunk;
  // Keep the player's turn with the reply that answers it.
  const reply = pool.findIndex((message, index) => index >= chunk.length && message.role === "assistant");
  if (reply >= 0) return pool.slice(0, reply + 1);
  return cutBackToReply(chunk);
}

/** The chunk up to its last reply (unchanged when it has none). */
function cutBackToReply<T extends { role: string }>(chunk: T[]): T[] {
  let end = chunk.length;
  while (end > 0 && chunk[end - 1]!.role !== "assistant") end--;
  return end > 0 ? chunk.slice(0, end) : chunk;
}

async function loadSnippets(sessionId: string, database: typeof db | SummaryTx = db) {
  return database
    .select()
    .from(summaryceptionSnippets)
    .where(eq(summaryceptionSnippets.sessionId, sessionId))
    .orderBy(asc(summaryceptionSnippets.layerIndex), asc(summaryceptionSnippets.snippetOrder), asc(summaryceptionSnippets.createdAt));
}

async function nextSnippetOrder(sessionId: string, layerIndex: number, database: typeof db | SummaryTx = db): Promise<number> {
  const [row] = await database
    .select({ value: max(summaryceptionSnippets.snippetOrder) })
    .from(summaryceptionSnippets)
    .where(and(eq(summaryceptionSnippets.sessionId, sessionId), eq(summaryceptionSnippets.layerIndex, layerIndex)));
  return (row?.value ?? -1) + 1;
}

async function renumberLayer(sessionId: string, layerIndex: number, database: typeof db | SummaryTx = db): Promise<void> {
  const rows = await database
    .select()
    .from(summaryceptionSnippets)
    .where(and(eq(summaryceptionSnippets.sessionId, sessionId), eq(summaryceptionSnippets.layerIndex, layerIndex)))
    .orderBy(asc(summaryceptionSnippets.snippetOrder), asc(summaryceptionSnippets.createdAt));
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.snippetOrder !== i) {
      await database
        .update(summaryceptionSnippets)
        .set({ snippetOrder: i, updatedAt: new Date() })
        .where(eq(summaryceptionSnippets.id, rows[i]!.id));
    }
  }
}

type LayerJobArgs = {
  claim: string;
  snapshot: typeof playSessions.$inferSelect;
  sessionId: string;
  userId: string;
  model: string;
  worldName?: string | null;
  layerIndex: number;
  language: SessionSummaryLanguage;
  run?: RecapRunState;
};

/** The recap so far as one call reads it (see assembleRecapContext). */
function recapContextForCall(snippets: Array<typeof summaryceptionSnippets.$inferSelect>, model: string): string {
  return assembleRecapContext(snippets, (text) => estimateTextTokens(text, model), RECAP_CONTEXT_TAIL_TOKENS, RECAP_CONTEXT_HEAD_TOKENS);
}

function outOfCalls(run: RecapRunState | undefined): boolean {
  return !!run && run.callsLeft <= 0;
}

async function loadLayer(sessionId: string, layerIndex: number) {
  return db
    .select()
    .from(summaryceptionSnippets)
    .where(and(eq(summaryceptionSnippets.sessionId, sessionId), eq(summaryceptionSnippets.layerIndex, layerIndex)))
    .orderBy(asc(summaryceptionSnippets.snippetOrder), asc(summaryceptionSnippets.createdAt));
}

async function maybePromoteLayer(args: LayerJobArgs): Promise<void> {
  const layer = await loadLayer(args.sessionId, args.layerIndex);
  if (layer.length <= SUMMARYCEPTION_SNIPPETS_PER_LAYER) return;
  // Out of calls this run: the layer stays one over and merges next run.
  if (outOfCalls(args.run)) return;
  // Merge only from the front of the layer, so the recap stays in story
  // order. A snippet that is cut off or awaiting revision there waits for it.
  if (!layer.slice(0, 2).every(isMergeableSnippet)) return;

  // The top layer used to stop here and then grow without end; it now folds
  // its own oldest snippets together instead.
  const top = args.layerIndex >= SUMMARYCEPTION_MAX_LAYERS - 1;
  const destLayerIndex = top ? args.layerIndex : args.layerIndex + 1;

  if (!top && (await loadLayer(args.sessionId, destLayerIndex)).length === 0) {
    const seed = layer[0]!;
    await db.transaction(async (tx) => {
      await lockSummaryJob(tx, args.sessionId, args.claim, args.snapshot);
      await tx
        .update(summaryceptionSnippets)
        .set({
          layerIndex: destLayerIndex,
          snippetOrder: 0,
          promoted: true,
          fromLayer: args.layerIndex,
          updatedAt: new Date(),
        })
        .where(eq(summaryceptionSnippets.id, seed.id));
      await renumberLayer(args.sessionId, args.layerIndex, tx);
    });
    await maybePromoteLayer({ ...args, layerIndex: args.layerIndex });
    await maybePromoteLayer({ ...args, layerIndex: destLayerIndex });
    return;
  }

  if (await mergeOldestSnippets({ ...args, layer, destLayerIndex }) === "none") return;
  await maybePromoteLayer({ ...args, layerIndex: args.layerIndex });
  if (!top) await maybePromoteLayer({ ...args, layerIndex: destLayerIndex });
}

/**
 * Merge the oldest snippets of a layer into one, written to `destLayerIndex`
 * (the next layer up, or the same layer at the top). Everything in higher
 * layers is older story and is the merge's prior context. A merge cut off at
 * the token cap is kept, ended at its last full sentence: one call per merge
 * (a cut-off used to be redone on two snippets, a second call).
 */
async function mergeOldestSnippets(args: LayerJobArgs & {
  layer: Array<typeof summaryceptionSnippets.$inferSelect>;
  destLayerIndex: number;
}): Promise<"merged" | "moved" | "none"> {
  const inPlace = args.destLayerIndex === args.layerIndex;
  if (outOfCalls(args.run)) return "none";

  // Chapters merge only while their stories touch. A merge across history
  // set aside between them claimed that history as told, so it was never
  // offered again (2026-11-17: one chapter of a few lines "covered" 2,400
  // messages). The run of chapters to merge starts at the front of the layer;
  // in place (the top layer) it may start later, which keeps story order.
  let start = 0;
  let toMerge: Array<typeof summaryceptionSnippets.$inferSelect> = [];
  for (; start < args.layer.length - 1; start++) {
    toMerge = [];
    for (const snippet of args.layer.slice(start, start + SUMMARYCEPTION_SNIPPETS_PER_PROMOTION)) {
      if (!isMergeableSnippet(snippet)) break;
      if (toMerge.length > 0 && await setAsideBetween(args.sessionId, toMerge.at(-1)!, snippet)) break;
      toMerge.push(snippet);
    }
    if (toMerge.length >= 2 || !inPlace) break;
  }
  if (toMerge.length < 2) {
    // Below the top, the front chapter ends just before set-aside history:
    // it moves up alone (no call), so the layer still shrinks in order.
    const front = args.layer[0];
    if (inPlace || !front || !isMergeableSnippet(front)) return "none";
    await db.transaction(async (tx) => {
      await lockSummaryJob(tx, args.sessionId, args.claim, args.snapshot);
      const order = await nextSnippetOrder(args.sessionId, args.destLayerIndex, tx);
      await tx.update(summaryceptionSnippets)
        .set({ layerIndex: args.destLayerIndex, snippetOrder: order, promoted: true, fromLayer: args.layerIndex, updatedAt: new Date() })
        .where(eq(summaryceptionSnippets.id, front.id));
      await renumberLayer(args.sessionId, args.layerIndex, tx);
    });
    return "moved";
  }

  const firstOrder = toMerge[0]!.snippetOrder;
  const isPrior = (snippet: typeof summaryceptionSnippets.$inferSelect) =>
    snippet.layerIndex > args.layerIndex || (snippet.layerIndex === args.layerIndex && snippet.snippetOrder < firstOrder);
  const prior = (await loadSnippets(args.sessionId)).filter(isPrior);
  const firstSource = toMerge[0]!.sourceStartMessageId ?? toMerge[0]!.sourceEndMessageId;
  if (!firstSource) throw new Error("Earlier summary coverage is unknown. Repair from original messages before promoting.");
  await assertPriorCoverage(args.sessionId, prior.map(snippet => snippet.sourceEndMessageId), firstSource);
  const priorContext = assembleSummaryceptionText(prior);
  const generated = await generateSummaryceptionText({
    userId: args.userId,
    sessionId: args.sessionId,
    model: args.model,
    language: args.language,
    run: args.run,
    prompt: buildSummaryceptionPrompt({
      worldName: args.worldName,
      priorContext: recapContextForCall(prior, args.model),
      passage: toMerge.map((snippet) => snippet.text).join(" "),
      language: args.language,
    }),
  });
  const sourceHash = createSummaryceptionSourceHash({
    version: SUMMARYCEPTION_SOURCE_HASH_VERSION,
    kind: "promote",
    sessionId: args.sessionId,
    model: args.model,
    language: args.language,
    layerIndex: args.layerIndex,
    snippetIds: toMerge.map((snippet) => snippet.id),
    snippetText: toMerge.map((snippet) => snippet.text),
  });
  const text = generated.text;
  await db.transaction(async (tx) => {
    await lockSummaryJob(tx, args.sessionId, args.claim, args.snapshot);
    const current = await loadSnippets(args.sessionId, tx);
    if (!toMerge.every(source => current.some(row => row.id === source.id && row.text === source.text && row.snippetOrder === source.snippetOrder))
      || assembleSummaryceptionText(current.filter(isPrior)) !== priorContext) {
      throw new SummaryceptionInvalidatedError();
    }
    const order = inPlace ? toMerge[0]!.snippetOrder : await nextSnippetOrder(args.sessionId, args.destLayerIndex, tx);
    await tx.delete(summaryceptionSnippets).where(inArray(summaryceptionSnippets.id, toMerge.map((snippet) => snippet.id)));
    await tx.insert(summaryceptionSnippets).values({
      id: randomUUID(),
      sessionId: args.sessionId,
      layerIndex: args.destLayerIndex,
      snippetOrder: order,
      text,
      sourceHash,
      sourceStartMessageId: toMerge[0]!.sourceStartMessageId,
      sourceEndMessageId: toMerge.at(-1)!.sourceEndMessageId,
      sourceStartOrdinal: toMerge[0]!.sourceStartOrdinal,
      sourceEndOrdinal: toMerge.at(-1)!.sourceEndOrdinal,
      fromLayer: args.layerIndex,
      mergedCount: toMerge.reduce((total, snippet) => total + (snippet.mergedCount ?? 1), 0),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await renumberLayer(args.sessionId, args.layerIndex, tx);
    await generated.charge?.(tx);
  });
  return "merged";
}

/**
 * Story messages between two chapters that neither holds: history set aside
 * between them (see markRecapSkipped). Chapters next to each other in the
 * recap otherwise touch.
 */
async function setAsideBetween(
  sessionId: string,
  earlier: { sourceEndMessageId: string | null },
  later: { sourceStartMessageId: string | null },
): Promise<boolean> {
  if (!earlier.sourceEndMessageId || !later.sourceStartMessageId) return false;
  const [row] = await db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.sessionId, sessionId),
    inArray(messages.role, ["user", "assistant"]),
    sql`${messages.status} is distinct from 'failed'`,
    sql`(${messages.createdAt}, ${messages.id}) > (SELECT created_at, id FROM messages WHERE id = ${earlier.sourceEndMessageId} AND session_id = ${sessionId})`,
    sql`(${messages.createdAt}, ${messages.id}) < (SELECT created_at, id FROM messages WHERE id = ${later.sourceStartMessageId} AND session_id = ${sessionId})`,
  )).limit(1);
  return !!row;
}

/**
 * Keep the recap within the player's budget: while it is larger, merge the
 * oldest chapters (highest layer first, see pickLayerToShrink). Bounded per
 * run; a recap still over budget continues shrinking on the next fold.
 */
async function shrinkRecapToBudget(args: Omit<LayerJobArgs, "layerIndex"> & { budgetTokens: number; maxMerges?: number }): Promise<void> {
  let previous = Number.POSITIVE_INFINITY;
  for (let i = 0; i < (args.maxMerges ?? RECAP_BUDGET_MAX_MERGES_PER_RUN); i++) {
    if (outOfCalls(args.run)) return;
    const snippets = await loadSnippets(args.sessionId);
    const total = estimateTextTokens(assembleSummaryceptionText(snippets), args.model);
    if (total <= args.budgetTokens) return;
    // A merge that did not make the recap shorter will not on the next try
    // either; stop paying for it this run.
    if (total >= previous) return;
    previous = total;
    const layerIndex = pickLayerToShrink(snippets);
    if (layerIndex === null) return;
    const destLayerIndex = Math.min(layerIndex + 1, SUMMARYCEPTION_MAX_LAYERS - 1);
    const step = await mergeOldestSnippets({ ...args, layerIndex, destLayerIndex, layer: await loadLayer(args.sessionId, layerIndex) });
    if (step === "none") return;
    // A chapter moved up without a merge leaves the size as it was; the next
    // pass merges past it.
    if (step === "moved") previous = Number.POSITIVE_INFINITY;
  }
}

export async function getSummaryceptionPromptBlock(sessionId: string): Promise<string | null> {
  return formatSummaryceptionForPrompt(await loadSnippets(sessionId));
}

export async function getSummaryceptionStats(row: typeof playSessions.$inferSelect): Promise<SummaryceptionStats> {
  const snippets = await loadSnippets(row.id);
  const summary = assembleSummaryceptionText(snippets);
  const model = await chatRunModel(row.userId, "summary", row.summaryceptionModel || row.summaryModel);
  const layerIndexes = new Set(snippets.map((snippet) => snippet.layerIndex));
  // Placed by message id at read time, so chapters written before the
  // numbering fix (and any after an edit or rewind) show where they are now.
  const ordinals = snippets.length > 0 ? await loadStoryOrdinals(row.id) : new Map<string, number>();
  const place = (id: string | null, stored: number | null) => (id ? ordinals.get(id) : undefined) ?? stored ?? null;
  const ends = snippets
    .map((snippet) => place(snippet.sourceEndMessageId, snippet.sourceEndOrdinal))
    .filter((ordinal): ordinal is number => ordinal != null);
  const coversUntilOrdinal = ends.length > 0 ? Math.max(...ends) : null;
  const layers = Array.from(layerIndexes)
    .sort((a, b) => b - a)
    .map((layerIndex) => ({
      layerIndex,
      snippets: snippets
        .filter((snippet) => snippet.layerIndex === layerIndex)
        .map((snippet) => ({
          id: snippet.id,
          layerIndex: snippet.layerIndex,
          snippetOrder: snippet.snippetOrder,
          text: snippet.text,
          sourceStartMessageId: snippet.sourceStartMessageId ?? null,
          sourceEndMessageId: snippet.sourceEndMessageId ?? null,
          sourceStartOrdinal: place(snippet.sourceStartMessageId, snippet.sourceStartOrdinal),
          sourceEndOrdinal: place(snippet.sourceEndMessageId, snippet.sourceEndOrdinal),
          fromLayer: snippet.fromLayer ?? null,
          mergedCount: snippet.mergedCount ?? null,
          promoted: snippet.promoted ?? false,
          createdAt: toIso(snippet.createdAt),
          updatedAt: toIso(snippet.updatedAt),
        })),
    }));
  return {
    hasSummary: summary.length > 0,
    model,
    layerCount: layerIndexes.size,
    snippetCount: snippets.length,
    tokenCount: row.summaryceptionTokenCount ?? (summary ? estimateTextTokens(summary, model) : null),
    status: recapRunStatus(row),
    error: row.summaryceptionError ?? null,
    updatedAt: row.summaryceptionUpdatedAt ? row.summaryceptionUpdatedAt.toISOString() : null,
    coversUntilMessageId: row.summaryceptionCoversUntilMessageId ?? null,
    coversUntilOrdinal,
    layers,
  };
}

// Summaryception job bookkeeping deliberately does NOT bump the session-row
// updatedAt: it has its own summaryceptionUpdatedAt, and a bump from the
// awaited per-send compaction used to invalidate the OTHER memory systems'
// in-flight persists when their guards compared updatedAt.
type SummaryTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The marker the stop button leaves in summaryceptionSourceHash. */
export const RECAP_STOP_PREFIX = "stop:";

/** True when the player pressed stop after this run began. */
function stoppedSince(sourceHash: string | null | undefined, runStartedAt: number | undefined): boolean {
  if (runStartedAt == null || !sourceHash?.startsWith(RECAP_STOP_PREFIX)) return false;
  const at = Number(sourceHash.slice(RECAP_STOP_PREFIX.length));
  return Number.isFinite(at) && at >= runStartedAt;
}

export class SummaryceptionInvalidatedError extends Error {
  constructor() { super("Summary source changed; retry with the current conversation"); }
}

async function lockSummaryJob(tx: SummaryTx, sessionId: string, claim: string, snapshot: typeof playSessions.$inferSelect) {
  const [row] = await tx.select().from(playSessions).where(and(
    eq(playSessions.id, sessionId), eq(playSessions.summaryceptionSourceHash, claim),
    eq(playSessions.summaryceptionStatus, "updating"), continuitySnapshotGuard(snapshot, LAYERED_INPUT_FIELDS),
  )).for("update");
  if (!row) throw new SummaryceptionInvalidatedError();
}

async function markUpdating(sessionId: string, claim: string, model: string,
  source: Array<{ id: string; content: string }>, priorContext: string, snapshot: typeof playSessions.$inferSelect,
  runStartedAt?: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(playSessions).where(and(
      eq(playSessions.id, sessionId), memorySourceGuard(sessionId, source), continuitySnapshotGuard(snapshot, LAYERED_INPUT_FIELDS),
    )).for("update");
    // Stopped by the player: this run takes no further step.
    if (row && stoppedSince(row.summaryceptionSourceHash, runStartedAt)) throw new SummaryceptionInvalidatedError();
    if (!row || (row.summaryceptionStatus === "updating" && row.summaryceptionUpdatedAt
      && row.summaryceptionUpdatedAt.getTime() > Date.now() - MEMORY_CLAIM_TTL_MS)
      || assembleSummaryceptionText((await loadSnippets(sessionId, tx)).filter(s => !isIncompleteSnippet(s))) !== priorContext) {
      throw new SummaryceptionInvalidatedError();
    }
    await tx.update(playSessions).set({ summaryceptionModel: model,
      summaryceptionStatus: "updating", summaryceptionError: null,
      summaryceptionSourceHash: claim, summaryceptionUpdatedAt: new Date(),
    }).where(eq(playSessions.id, sessionId));
  });
}

async function markFailed(sessionId: string, claim: string, error: unknown): Promise<void> {
  await db.update(playSessions).set({ summaryceptionStatus: "failed",
    summaryceptionError: error instanceof Error ? error.message : "Summaryception compaction failed",
  }).where(and(eq(playSessions.id, sessionId), eq(playSessions.summaryceptionSourceHash, claim),
    eq(playSessions.summaryceptionStatus, "updating")));
}

function noOpResult(summary: string, retained: StoryMessageRow[], model: string, reason: string, code: SummaryCompactionNoOpCode | null): SummaryceptionCompactionResult {
  return {
    summary,
    compactedCount: 0,
    compactedMessageIds: [],
    compactedFromMessageId: null,
    compactedToMessageId: null,
    compactedFromOrdinal: null,
    compactedToOrdinal: null,
    compactedTokenEstimate: 0,
    retainedCount: retained.length,
    retainedTokenEstimate: estimateMessagesTokens(retained, model),
    noOpReason: reason,
    noOpReasonCode: code,
  };
}

/** The model a recap run uses, and the one its session column keeps. */
export async function recapRunModel(
  userId: string,
  session: Pick<typeof playSessions.$inferSelect, "summaryceptionModel" | "summaryModel">,
  fallbackModel?: string | null,
): Promise<{ keepModel: string; model: string }> {
  // keepModel is what the session column holds (and the claim guards check);
  // model is what this run uses: the chat's own pick (only the memory
  // extension's panel sets one), else the player's background summary AI,
  // else the platform default. See role-model.ts. Never the story model: on
  // 2026-10-31 that ran, and saved, each player's chat model for every recap
  // call (up to 7.7 mushies a call); the column a player without the
  // extension holds is ignored, which also undoes those saves.
  const ownPick = (await getInstalledExtensions(userId)).has(SESSION_MEMORY_EXTENSION_KEY)
    ? session.summaryceptionModel || session.summaryModel || null
    : null;
  const keepModel = applyModelRedirect((ownPick || DEFAULT_STORY_SUMMARY_MODEL).trim());
  let model = await chatRunModel(userId, "summary", ownPick);
  // A player on their own key alone cannot reach the platform default; their
  // recap then runs on the story's model, on that key.
  if (!ownPick && fallbackModel && fallbackModel.trim() !== model
    && !(await resolveProviderForModel(userId, model, { allowOfficialFallback: false }).catch(() => null))) {
    model = applyModelRedirect(fallbackModel.trim());
  }
  return { keepModel, model };
}

/** The language, model and transcript one run works from. */
async function resolveRunInputs(args: SummaryceptionCompactionArgs) {
  const row = await loadSession(args.sessionId, args.userId);
  if (!row) throw new Error("Session not found");
  const run = await recapRunModel(args.userId, row.session, args.fallbackModel);
  const keepModel = run.keepModel;
  const model = args.runModel?.trim() || run.model;
  const transcriptRows = await loadSummaryceptionRows(args.sessionId);
  const relevantRows = transcriptRows.filter((message) => message.role === "user" || message.role === "assistant");
  // One resolved language per run, detected from the transcript's own recent
  // text (never from earlier snippets — a legacy English snippet must not pin
  // future snippets to English).
  const language = resolveSummaryOutputLanguage({
    configured: row.session.summaryLanguage,
    sourceText: relevantRows.slice(-30).map((message) => message.content).join("\n"),
    worldLanguage: row.worldLanguage,
  });
  return { row, keepModel, model, transcriptRows, relevantRows, language };
}

/** The window of older messages this run may fold (null when none). */
function selectRunWindow(args: SummaryceptionCompactionArgs, inputs: Awaited<ReturnType<typeof resolveRunInputs>>) {
  const { row, model, transcriptRows } = inputs;
  if (args.foldThroughMessageId) {
    // The player's own choice: everything unfolded up to that message. Once
    // it is folded the window is gone and the run stops.
    const relevant = transcriptRows.filter((message) => message.role === "user" || message.role === "assistant");
    const end = relevant.findIndex((message) => message.id === args.foldThroughMessageId);
    if (end < 0) return null;
    const compactable = relevant.slice(0, end + 1);
    return {
      window: {
        compactable,
        retained: relevant.slice(end + 1),
        estimatedTotalTokens: estimateMessagesTokens(relevant, model),
        estimatedCompactableTokens: estimateMessagesTokens(compactable, model),
      },
      forced: true,
    };
  }
  const rawKeptTokens = normalizeSessionSummaryRecentTailTokens(row.session.summaryRecentTailTokens);
  const rawKeptTokensOverride = row.session.summaryRecentTailTokens == null ? undefined : rawKeptTokens;
  const rawLimit = typeof args.finalPromptRawTokenLimit === "number" && Number.isFinite(args.finalPromptRawTokenLimit)
    ? Math.max(1, Math.floor(args.finalPromptRawTokenLimit))
    : typeof args.contextTokenLimit === "number" && Number.isFinite(args.contextTokenLimit)
      ? Math.max(1, Math.floor(args.contextTokenLimit))
      : null;

  const normalWindow = rawLimit === null
    ? selectCompactionWindow(transcriptRows, {
        triggerTokens: 0,
        recentTailTokens: rawKeptTokensOverride ?? rawKeptTokens,
        modelId: model,
      })
    : selectCompactionWindow(transcriptRows, {
        mode: "overflow",
        contextTokenLimit: rawLimit,
        recentTailTokens: Math.min(rawKeptTokensOverride ?? rawLimit, rawLimit),
        minCompactableTokens: 0,
        modelId: model,
      });
  const forcedWindow = normalWindow ? null : args.force
    ? selectForcedManualCompactionWindow(transcriptRows, {
        modelId: model,
        retainedTailTokens: rawKeptTokensOverride ?? rawKeptTokens,
      })
    : null;
  const window = normalWindow ?? forcedWindow;
  return window ? { window, forced: !normalWindow } : null;
}

/** Older history an automatic run may fold before asking the player. A
 *  recap's first catch-up (no chapters yet) is held to the fixed floor: with
 *  a large story memory it otherwise folded tens of thousands of tokens of
 *  old story unasked at launch (2026-10-31). Once chapters exist, the regular
 *  fold-ahead (half of story memory) must fit. */
export function autoBackfillLimitTokens(storyMemoryTokens: number | null | undefined, hasChapters = true): number {
  if (!hasChapters) return AUTO_BACKFILL_MIN_TOKENS;
  return Math.max(AUTO_BACKFILL_MIN_TOKENS, storyMemoryTokens ?? 0);
}

/**
 * One run of the recap: carry an old rolling summary over as the first
 * chapter, revise chapters whose messages were edited, fold older messages
 * into new chapters (one, or the whole window with foldAll), then merge the
 * oldest chapters until the recap fits its budget.
 */
async function compactSummaryceptionNow(args: SummaryceptionCompactionArgs): Promise<SummaryceptionCompactionResult> {
  // The seed reads the bare session row: each step below takes its own
  // snapshot right before it claims, so a settings change in between is
  // caught by that step's claim guard rather than read past.
  const [session] = await db.select().from(playSessions)
    .where(and(eq(playSessions.id, args.sessionId), eq(playSessions.userId, args.userId))).limit(1);
  if (!session) throw new Error("Session not found");
  await seedLegacyRecap(args.sessionId, session);
  args = { ...args, run: args.run ?? await startRecapRun(args, session) };
  await reviseStaleSnippets(args);

  const maxChunks = args.foldThroughMessageId
    ? RECAP_FOLD_MAX_CHUNKS
    : !args.foldAll ? 1 : args.backfillApproved ? Number.POSITIVE_INFINITY : SUMMARYCEPTION_AUTO_MAX_CHUNKS;
  const budgetTokens = args.recapBudgetTokens && args.recapBudgetTokens > 0 ? args.recapBudgetTokens : null;
  let combined: SummaryceptionCompactionResult | null = null;
  for (let i = 0; i < maxChunks; i++) {
    if (outOfCalls(args.run)) break;
    const result = await compactOneSummaryceptionChunk(args, i === 0);
    if (result.compactedCount === 0) {
      combined ??= result;
      break;
    }
    if (budgetTokens && estimateTextTokens(result.summary) > budgetTokens * RECAP_IN_RUN_SHRINK_FACTOR) {
      await runClaimedLayeredStep(args, "budget", (step) => shrinkRecapToBudget({ ...step, budgetTokens, maxMerges: RECAP_IN_RUN_MAX_MERGES }));
    }
    combined = combined
      ? {
          ...result,
          compactedCount: combined.compactedCount + result.compactedCount,
          compactedMessageIds: [...combined.compactedMessageIds, ...result.compactedMessageIds],
          compactedFromMessageId: combined.compactedFromMessageId,
          compactedFromOrdinal: combined.compactedFromOrdinal,
          compactedTokenEstimate: combined.compactedTokenEstimate + result.compactedTokenEstimate,
        }
      : result;
  }

  if (budgetTokens && !outOfCalls(args.run)) {
    const snippets = await loadSnippets(args.sessionId);
    if (estimateTextTokens(assembleSummaryceptionText(snippets)) > budgetTokens) {
      await runClaimedLayeredStep(args, "budget", (step) => shrinkRecapToBudget({ ...step, budgetTokens }));
    }
  }
  const summary = assembleSummaryceptionText(await loadSnippets(args.sessionId));
  return { ...(combined ?? noOpResult(summary, [], args.fallbackModel, "This run's calls are used up; the next run continues.", null)), summary };
}

/** The allowance and passage size for one run (see RecapRunState). */
async function startRecapRun(args: SummaryceptionCompactionArgs, session: typeof playSessions.$inferSelect): Promise<RecapRunState> {
  const model = args.runModel?.trim() || (await recapRunModel(args.userId, session, args.fallbackModel)).model;
  const resolved = await resolveProviderForModel(args.userId, model, { allowOfficialFallback: false }).catch(() => null);
  const ownModel = resolved?.providerName === "custom" || resolved?.providerName === "local" || resolved?.providerName === "ollama";
  return {
    callsLeft: !args.automatic ? Number.POSITIVE_INFINITY : ownModel ? RECAP_OWN_MODEL_AUTO_MAX_CALLS : RECAP_AUTO_MAX_CALLS,
    refused: new Set(),
    startedAt: Date.now(),
    chunkTokens: ownModel ? RECAP_OWN_MODEL_CHUNK_TOKENS : SUMMARYCEPTION_TARGET_CHUNK_TOKENS,
  };
}

/**
 * Claim the layered job for work that folds no new messages (revisions,
 * budget merges), run it, and release the claim with the new token count.
 */
async function runClaimedLayeredStep(
  args: SummaryceptionCompactionArgs,
  label: string,
  work: (step: Omit<LayerJobArgs, "layerIndex">) => Promise<void>,
): Promise<void> {
  const inputs = await resolveRunInputs(args);
  const priorContext = assembleSummaryceptionText((await loadSnippets(args.sessionId)).filter(s => !isIncompleteSnippet(s)));
  const claim = `${label}:${randomUUID()}`;
  await markUpdating(args.sessionId, claim, inputs.keepModel, [], priorContext, inputs.row.session, args.run?.startedAt);
  const snapshot = { ...inputs.row.session, summaryceptionModel: inputs.keepModel, summaryceptionSourceHash: claim };
  try {
    await work({
      claim,
      snapshot,
      sessionId: args.sessionId,
      userId: args.userId,
      model: inputs.model,
      worldName: inputs.row.worldName,
      language: inputs.language,
      run: args.run,
    });
    await db.transaction(async (tx) => {
      await lockSummaryJob(tx, args.sessionId, claim, snapshot);
      const summary = assembleSummaryceptionText(await loadSnippets(args.sessionId, tx));
      await tx.update(playSessions).set({
        summaryceptionStatus: "idle",
        summaryceptionError: null,
        summaryceptionSourceHash: null,
        summaryceptionTokenCount: summary ? estimateTextTokens(summary, inputs.model) : null,
        summaryceptionUpdatedAt: new Date(),
      }).where(eq(playSessions.id, args.sessionId));
    });
  } catch (err) {
    await markFailed(args.sessionId, claim, err);
    throw err;
  }
}

async function compactOneSummaryceptionChunk(args: SummaryceptionCompactionArgs, firstOfRun: boolean): Promise<SummaryceptionCompactionResult> {
  const inputs = await resolveRunInputs(args);
  const { row, keepModel, model, relevantRows, language } = inputs;
  const selected = selectRunWindow(args, inputs);
  if (!selected) {
    return noOpResult(
      assembleSummaryceptionText(await loadSnippets(args.sessionId)),
      relevantRows, model,
      "Nothing older than the kept-raw tail to compact yet.", "fits-within-raw-tail",
    );
  }
  const { window, forced: usedForcedWindow } = selected;

  // A long backlog (the recap switched on deep into a story, or a story
  // memory lowered a lot) is never folded whole on the player's credits
  // unasked: the recap starts from its newest part, free of any catch-up, and
  // the older part is set aside. The memory panel offers it, priced.
  if (firstOfRun && args.foldAll && !args.backfillApproved && !args.force) {
    const limit = autoBackfillLimitTokens(args.storyMemoryTokens, (await loadSnippets(args.sessionId)).length > 0);
    if (estimateMessagesTokens(window.compactable, model) > limit) {
      let kept = 0;
      let cut = window.compactable.length;
      for (let i = window.compactable.length - 1; i >= 0; i--) {
        const tokens = estimateMessagesTokens([window.compactable[i]!], model);
        if (kept + tokens > limit) break;
        kept += tokens;
        cut = i;
      }
      await markRecapSkipped(args.sessionId, window.compactable.slice(0, cut).map((message) => message.id));
      return compactOneSummaryceptionChunk(args, false);
    }
  }

  let chunk = endOnReply(splitMessagesIntoCompactionChunks(window.compactable, args.run?.chunkTokens ?? SUMMARYCEPTION_TARGET_CHUNK_TOKENS, model)[0] ?? [], window.compactable);
  if (chunk.length === 0) throw new Error("No compactable messages found");

  const priorSnippets = (await loadSnippets(args.sessionId)).filter(s => !isIncompleteSnippet(s));
  await assertPriorCoverage(args.sessionId, priorSnippets.map(s => s.sourceEndMessageId), chunk[0]!.id);
  const priorContext = assembleSummaryceptionText(priorSnippets);
  const callContext = recapContextForCall(priorSnippets, model);
  const ordinals = await loadStoryOrdinals(args.sessionId);
  const describe = (rows: StoryMessageRow[]) => ({
    first: rows[0]!,
    last: rows.at(-1)!,
    ids: rows.map((message) => message.id),
    fromOrdinal: ordinals.get(rows[0]!.id) ?? 0,
    toOrdinal: ordinals.get(rows.at(-1)!.id) ?? 0,
    sourceHash: createSummaryceptionSourceHash({
      version: SUMMARYCEPTION_SOURCE_HASH_VERSION,
      kind: usedForcedWindow ? "layer-0-forced" : "layer-0",
      sessionId: args.sessionId,
      model,
      language,
      forced: usedForcedWindow,
      messageIds: rows.map((message) => message.id),
      messageText: rows.map((message) => [message.role, message.content]),
      priorContext,
    }),
  });
  let part = describe(chunk);

  if (row.session.summaryceptionSourceHash === part.sourceHash && row.session.summaryceptionStatus === "idle") {
    return noOpResult(
      assembleSummaryceptionText(await loadSnippets(args.sessionId)),
      window.retained, model,
      "This Summaryception batch is already compacted.", "batch-already-compacted",
    );
  }

  const claim = `${part.sourceHash}:${randomUUID()}`;
  await markUpdating(args.sessionId, claim, keepModel, chunk, priorContext, row.session, args.run?.startedAt);

  const claimedSnapshot = { ...row.session, summaryceptionModel: keepModel, summaryceptionSourceHash: claim };
  try {
    let generated: SummaryCandidate;
    for (let splits = 0; ; splits++) {
      generated = await generateSummaryceptionText({
        userId: args.userId,
        sessionId: args.sessionId,
        model,
        language,
        run: args.run,
        prompt: buildSummaryceptionPrompt({
          worldName: row.worldName,
          priorContext: callContext,
          passage: formatMessagesForStoryCompaction(chunk),
          language,
        }),
      });
      // Cut off at the token cap: summarize the first half instead (the rest
      // is the next chunk), once. Otherwise the chapter is kept, ended at its
      // last full sentence, rather than stopping the recap.
      if (!generated.partial || splits >= SUMMARYCEPTION_MAX_CHUNK_SPLITS || outOfCalls(args.run)) break;
      // Whole exchanges only. A half with no reply left a chapter of the
      // player's words alone ("the player asks to continue; nothing happens").
      const half = cutBackToReply(chunk.slice(0, Math.ceil(chunk.length / 2)));
      if (half.length === 0 || half.length >= chunk.length || half.at(-1)!.role !== "assistant") break;
      chunk = half;
      part = describe(chunk);
    }
    const text = generated.text;
    await db.transaction(async (tx) => {
      await lockSummaryJob(tx, args.sessionId, claim, claimedSnapshot);
      const [valid] = await tx.select({ id: playSessions.id }).from(playSessions).where(and(
        eq(playSessions.id, args.sessionId), memorySourceGuard(args.sessionId, chunk),
      ));
      if (!valid || assembleSummaryceptionText((await loadSnippets(args.sessionId, tx)).filter(s => !isIncompleteSnippet(s))) !== priorContext) {
        throw new SummaryceptionInvalidatedError();
      }
      // Previews left by the old pause-on-cut-off behavior.
      for (const preview of (await loadSnippets(args.sessionId, tx)).filter(s => s.sourceHash?.startsWith("partial:"))) {
        await tx.delete(summaryceptionSnippets).where(eq(summaryceptionSnippets.id, preview.id));
      }
      const order = await nextSnippetOrder(args.sessionId, 0, tx);
      await tx.insert(summaryceptionSnippets).values({
        id: randomUUID(),
        sessionId: args.sessionId,
        layerIndex: 0,
        snippetOrder: order,
        text,
        sourceStartMessageId: part.first.id,
        sourceEndMessageId: part.last.id,
        sourceStartOrdinal: part.fromOrdinal > 0 ? part.fromOrdinal : null,
        sourceEndOrdinal: part.toOrdinal > 0 ? part.toOrdinal : null,
        sourceHash: part.sourceHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await tx.update(messages)
        .set({ summaryceptionCompacted: true })
        .where(inArray(messages.id, part.ids));
      await generated.charge?.(tx);
    });

    await maybePromoteLayer({
      claim, snapshot: claimedSnapshot,
      sessionId: args.sessionId,
      userId: args.userId,
      model,
      worldName: row.worldName,
      layerIndex: 0,
      language,
      run: args.run,
    });

    const summary = await db.transaction(async (tx) => {
      await lockSummaryJob(tx, args.sessionId, claim, claimedSnapshot);
      const summary = assembleSummaryceptionText(await loadSnippets(args.sessionId, tx));
      await tx.update(playSessions)
        .set({
          summaryceptionModel: keepModel,
          summaryceptionStatus: "idle",
          summaryceptionError: null,
          summaryceptionSourceHash: part.sourceHash,
          summaryceptionCoversUntilMessageId: part.last.id,
          summaryceptionTokenCount: summary ? estimateTextTokens(summary, model) : null,
          summaryceptionUpdatedAt: new Date(),
        })
        .where(eq(playSessions.id, args.sessionId));

      return summary;
    });

    captureServerEvent(args.userId, "summary_job", {
      system: "summaryception",
      outcome: "ok",
      session_id: args.sessionId,
      model,
      compacted_count: part.ids.length,
    });

    return {
      summary,
      compactedCount: part.ids.length,
      compactedMessageIds: part.ids,
      compactedFromMessageId: part.first.id,
      compactedToMessageId: part.last.id,
      compactedFromOrdinal: part.fromOrdinal > 0 ? part.fromOrdinal : null,
      compactedToOrdinal: part.toOrdinal > 0 ? part.toOrdinal : null,
      compactedTokenEstimate: estimateMessagesTokens(chunk, model),
      retainedCount: window.retained.length,
      retainedTokenEstimate: estimateMessagesTokens(window.retained, model),
      noOpReason: null,
      noOpReasonCode: null,
    };
  } catch (err) {
    await markFailed(args.sessionId, claim, err);
    captureServerEvent(args.userId, "summary_job", {
      system: "summaryception",
      outcome: err instanceof SummaryceptionInvalidatedError ? "superseded" : "failed",
      session_id: args.sessionId,
      model,
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function compactSummaryceptionForSession(args: SummaryceptionCompactionArgs): Promise<SummaryceptionCompactionResult> {
  const job = enqueueSummaryceptionJob(args.sessionId, () => compactSummaryceptionNow(args));
  // Any successful compaction — scheduled OR manual — restores the auto-retry
  // budget. The reset must live here, not in the schedule wrapper: once the
  // budget is exhausted the wrapper never runs again, so a reset placed there
  // would be unreachable and 3 transient failures would latch auto-compaction
  // off until the next deploy.
  job.then(() => summaryceptionFailureCounts.delete(args.sessionId)).catch(() => {});
  return job;
}

/**
 * Stop background auto-retries after this many consecutive failures (mirror of
 * STORY_COMPACTION_MAX_CONSECUTIVE_FAILURES). In-memory: a restart or any
 * successful compaction (scheduled or manual) grants a fresh budget.
 */
const SUMMARYCEPTION_MAX_CONSECUTIVE_FAILURES = 3;
const summaryceptionFailureCounts = new Map<string, number>();
const summaryceptionScheduledSessions = new Set<string>();

/** One recap call: a chunk, what it reads of the recap and the instructions
 *  in; one chapter out. The consent dialog quotes a whole automatic run. */
const RECAP_CALL_PROMPT_TOKENS = SUMMARYCEPTION_TARGET_CHUNK_TOKENS + RECAP_CONTEXT_TAIL_TOKENS + RECAP_CONTEXT_HEAD_TOKENS + 600;
const RECAP_CALL_COMPLETION_TOKENS = SUMMARYCEPTION_MAX_SNIPPET_TOKENS;

/**
 * An automatic recap run asks before it charges (background-consent.ts). No
 * answer or "skip": nothing runs and nothing is lost, since the unfolded
 * messages stay where they are and the next run folds them. "free": the run
 * goes on Yumina Free. Returns the args to run with, or null.
 */
export async function gateAutomaticRecap(args: SummaryceptionCompactionArgs): Promise<SummaryceptionCompactionArgs | null> {
  const row = await loadSession(args.sessionId, args.userId);
  if (!row) return null;
  const { model: chosen } = await recapRunModel(args.userId, row.session, args.fallbackModel);
  const model = await planAllowedModel(args.userId, chosen, DEFAULT_STORY_SUMMARY_MODEL);
  const resolved = await resolveProviderForModel(args.userId, model, { allowOfficialFallback: false }).catch(() => null);
  // No provider: the run itself reports the missing key, and charges nothing.
  if (!resolved) return args;
  const gate = await gateBackgroundCharge({
    userId: args.userId,
    feature: "recap",
    model,
    isByok: resolved.isByok,
    askOnOwnKey: true,
    estimate: () => estimateCallCredits(model, RECAP_CALL_PROMPT_TOKENS * RECAP_AUTO_MAX_CALLS, RECAP_CALL_COMPLETION_TOKENS * RECAP_AUTO_MAX_CALLS),
  });
  if (!gate.run) return null;
  return gate.viaFree ? { ...args, runModel: gate.model } : args;
}

/**
 * Fire-and-forget summaryception compaction for the send path's overflow pass.
 * The send must never wait on LLM summarization (the 2026-07-11 524 incident:
 * a permanently failing summary held sends past Cloudflare's 100s origin
 * limit). Deduped per session and capped on consecutive failures so a broken
 * config can't burn a full compaction per turn forever. The caller decides
 * whether the recap is on for this player (the turn's hook dispatch).
 */
export function scheduleSummaryceptionCompaction(args: SummaryceptionCompactionArgs): void {
  if ((summaryceptionFailureCounts.get(args.sessionId) ?? 0) >= SUMMARYCEPTION_MAX_CONSECUTIVE_FAILURES) {
    console.warn(
      `[Summaryception] Auto-compaction suppressed for session ${args.sessionId} after ${SUMMARYCEPTION_MAX_CONSECUTIVE_FAILURES} consecutive failures — a successful manual compaction resets the budget`,
    );
    return;
  }
  if (summaryceptionScheduledSessions.has(args.sessionId)) return;
  summaryceptionScheduledSessions.add(args.sessionId);
  gateAutomaticRecap(args)
    .then((gated) => gated ? compactSummaryceptionForSession({ ...gated, automatic: true }) : undefined)
    .catch((err) => {
      if (err instanceof SummaryceptionInvalidatedError) return;
      summaryceptionFailureCounts.set(
        args.sessionId,
        (summaryceptionFailureCounts.get(args.sessionId) ?? 0) + 1,
      );
      console.warn("[Summaryception] Background compaction failed:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      summaryceptionScheduledSessions.delete(args.sessionId);
    });
}

/**
 * Reset the per-session summaryception bookkeeping columns (status, error,
 * hash, coverage, token count). Column reset only — snippet rows are handled
 * by clearSummaryceptionData.
 */
export function resetSummaryceptionSessionFields() {
  return {
    summaryceptionStatus: "idle" as const,
    summaryceptionError: null,
    summaryceptionUpdatedAt: null,
    summaryceptionSourceHash: null,
    summaryceptionCoversUntilMessageId: null,
    summaryceptionTokenCount: null,
  };
}

/**
 * Drop every summaryception snippet for a session and re-expose its messages
 * as raw history. For history-rewrite operations (edit/delete/swipe of a
 * covered message, revert, restart, checkpoint restore) — snippets describing
 * a timeline that no longer exists must never be injected into prompts.
 */
export async function clearSummaryceptionData(sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: playSessions.id }).from(playSessions).where(eq(playSessions.id, sessionId)).for("update");
    await tx.update(playSessions).set(resetSummaryceptionSessionFields()).where(eq(playSessions.id, sessionId));
    await tx.delete(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, sessionId));
    await tx.update(messages).set({ summaryceptionCompacted: false }).where(eq(messages.sessionId, sessionId));
  });
}

/** Story messages from one message through another, inclusive, in order. */
async function loadRangeRows(sessionId: string, startId: string, endId: string): Promise<StoryMessageRow[]> {
  return db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      sql`(${messages.createdAt}, ${messages.id}) >= (SELECT created_at, id FROM messages WHERE id = ${startId} AND session_id = ${sessionId})`,
      sql`(${messages.createdAt}, ${messages.id}) <= (SELECT created_at, id FROM messages WHERE id = ${endId} AND session_id = ${sessionId})`,
    ))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

/**
 * Carry an old rolling story summary over as the recap's first chapter
 * ("volume zero"), once, when the session has a summary and no recap yet.
 * The messages it covered count as folded, so the recap continues after it
 * instead of re-reading the whole story. The old summary itself is left in
 * place (nothing reads it any more); it keeps the carry-over reversible.
 * DB-only, no model call: cheap enough for the prompt path.
 */
export async function seedLegacyRecap(sessionId: string, session: Record<string, unknown>): Promise<boolean> {
  const summary = normalizeStorySummaryText(session.summary);
  const coversUntil = typeof session.summaryCoversUntilMessageId === "string" ? session.summaryCoversUntilMessageId : null;
  if (!summary || !coversUntil) return false;
  return db.transaction(async (tx) => {
    await tx.select({ id: playSessions.id }).from(playSessions).where(eq(playSessions.id, sessionId)).for("update");
    const [existing] = await tx.select({ id: summaryceptionSnippets.id }).from(summaryceptionSnippets)
      .where(eq(summaryceptionSnippets.sessionId, sessionId)).limit(1);
    if (existing) return false;
    const [end] = await tx.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.id, coversUntil))).limit(1);
    if (!end) return false;
    const [start] = await tx.select({ id: messages.id }).from(messages)
      .where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt), asc(messages.id)).limit(1);
    await tx.insert(summaryceptionSnippets).values({
      id: randomUUID(),
      sessionId,
      layerIndex: SUMMARYCEPTION_MAX_LAYERS - 1,
      snippetOrder: 0,
      text: summary,
      sourceHash: `${LEGACY_SNIPPET_PREFIX}${createSummaryceptionSourceHash({ sessionId, coversUntil, summary })}`,
      sourceStartMessageId: start?.id ?? end.id,
      sourceEndMessageId: end.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await tx.update(messages).set({ summaryceptionCompacted: true }).where(and(
      eq(messages.sessionId, sessionId),
      sql`(${messages.createdAt}, ${messages.id}) <= (SELECT created_at, id FROM messages WHERE id = ${end.id} AND session_id = ${sessionId})`,
    ));
    await tx.update(playSessions).set({
      summaryceptionCoversUntilMessageId: end.id,
      summaryceptionTokenCount: estimateTextTokens(summary),
      summaryceptionUpdatedAt: new Date(),
    }).where(eq(playSessions.id, sessionId));
    return true;
  });
}

/** The recap block for a turn, carrying an old summary over first if needed. */
export async function loadRecapPromptBlock(sessionId: string, session: Record<string, unknown>): Promise<{
  content: string | null;
  /** A chapter was edited and waits for its one-call revision. */
  needsRevision: boolean;
}> {
  let snippets = await loadSnippets(sessionId);
  if (snippets.length === 0 && await seedLegacyRecap(sessionId, session)) snippets = await loadSnippets(sessionId);
  return { content: formatSummaryceptionForPrompt(snippets), needsRevision: snippets.some(isStaleSnippet) };
}

/** Chapters summarized straight from their messages are redone from them when
 *  short enough; longer or merged ones are corrected in place. */
const REVISE_FROM_SOURCE_MAX_TOKENS = 6_000;

function buildRevisePrompt(args: {
  worldName?: string | null;
  summary: string;
  changed: StoryMessageRow[];
  language: SessionSummaryLanguage;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a precise narrative-state tracker for an interactive-fiction session.",
        NARRATIVE_EVIDENCE_RULES,
        "Output only the corrected continuity snippet. No preamble, no markdown heading, no commentary.",
        buildSummaryLanguageInstruction(args.language, { autoSourceLabel: "chapter_summary" }),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `World: ${args.worldName || "Unknown"}`,
        "<chapter_summary>",
        args.summary,
        "</chapter_summary>",
        "<changed_messages>",
        formatMessagesForStoryCompaction(args.changed),
        "</changed_messages>",
        "The player edited the messages above after chapter_summary was written; they show the current text.",
        "Rewrite chapter_summary so it agrees with the current messages. Keep every other fact exactly as it is, in the same dense, semicolon-separated style and about the same length.",
      ].join("\n"),
    },
  ];
}

/**
 * Revise the chapters whose messages were edited or deleted, one call each,
 * instead of throwing the whole recap away (the old behavior: an edit to any
 * folded message cleared every chapter and re-read the entire story).
 */
async function reviseStaleSnippets(args: SummaryceptionCompactionArgs): Promise<void> {
  const stale = (await loadSnippets(args.sessionId)).filter(isStaleSnippet);
  if (stale.length === 0) return;
  if (outOfCalls(args.run)) return;
  await runClaimedLayeredStep(args, "revise", async (step) => {
    for (const target of stale) {
      if (outOfCalls(step.run)) break;
      await reviseSnippet(step, target.id);
    }
  });
}

async function reviseSnippet(step: Omit<LayerJobArgs, "layerIndex">, snippetId: string): Promise<void> {
  const all = await loadSnippets(step.sessionId);
  const target = all.find((snippet) => snippet.id === snippetId);
  if (!target || !isStaleSnippet(target)) return;
  const changedIds = staleSnippetMessageIds(target.sourceHash);
  const range = target.sourceStartMessageId && target.sourceEndMessageId
    ? (await loadRangeRows(step.sessionId, target.sourceStartMessageId, target.sourceEndMessageId))
      .filter((message) => message.role === "user" || message.role === "assistant")
    : [];
  const ordered = [...all].sort((a, b) => a.layerIndex !== b.layerIndex ? b.layerIndex - a.layerIndex : a.snippetOrder - b.snippetOrder);
  const priorContext = recapContextForCall(
    ordered.slice(0, ordered.findIndex((snippet) => snippet.id === target.id)).filter((snippet) => !isIncompleteSnippet(snippet)),
    step.model,
  );
  const fromSource = target.mergedCount == null && range.length > 0
    && estimateMessagesTokens(range, step.model) <= REVISE_FROM_SOURCE_MAX_TOKENS;
  const changed = range.filter((message) => changedIds.includes(message.id));

  let generated: SummaryCandidate | null = null;
  if (fromSource) {
    generated = await generateSummaryceptionText({
      userId: step.userId,
      sessionId: step.sessionId,
      model: step.model,
      language: step.language,
      run: step.run,
      prompt: buildSummaryceptionPrompt({
        worldName: step.worldName,
        priorContext,
        passage: formatMessagesForStoryCompaction(range),
        language: step.language,
      }),
    });
  } else if (changed.length > 0) {
    generated = await generateSummaryceptionText({
      userId: step.userId,
      sessionId: step.sessionId,
      model: step.model,
      language: step.language,
      run: step.run,
      prompt: buildRevisePrompt({ worldName: step.worldName, summary: target.text, changed, language: step.language }),
    });
  }
  // A long chapter that only lost messages has nothing to compare against;
  // it keeps its text and stops waiting.

  await db.transaction(async (tx) => {
    await lockSummaryJob(tx, step.sessionId, step.claim, step.snapshot);
    const [current] = await tx.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.id, target.id)).limit(1);
    if (!current || current.text !== target.text || current.sourceHash !== target.sourceHash) {
      throw new SummaryceptionInvalidatedError();
    }
    await tx.update(summaryceptionSnippets).set({
      text: generated?.text ?? target.text,
      sourceHash: createSummaryceptionSourceHash({
        version: SUMMARYCEPTION_SOURCE_HASH_VERSION,
        kind: "revise",
        snippetId: target.id,
        changedIds,
        text: generated?.text ?? target.text,
      }),
      updatedAt: new Date(),
    }).where(eq(summaryceptionSnippets.id, target.id));
    await generated?.charge?.(tx);
  });
}

/** Stored timestamps are naive UTC; compare an instant as UTC wall time. */
function naiveUtc(at: Date | string): string {
  return new Date(at).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * A folded message was edited or deleted: mark the one chapter that covers it
 * for revision (done on the recap's next run) and keep everything else. A
 * deleted message that was a chapter's first or last moves that edge to its
 * neighbor; a chapter left with no messages is removed.
 */
export async function markRecapChangedMessage(sessionId: string, change: {
  id: string;
  createdAt: Date | string | null | undefined;
  deleted: boolean;
}): Promise<void> {
  if (!change.createdAt) return;
  const at = naiveUtc(change.createdAt);
  await db.transaction(async (tx) => {
    await tx.select({ id: playSessions.id }).from(playSessions).where(eq(playSessions.id, sessionId)).for("update");
    const snippets = await loadSnippets(sessionId, tx);
    for (const snippet of snippets) {
      const { sourceStartMessageId: startId, sourceEndMessageId: endId } = snippet;
      if (!change.deleted || (startId !== change.id && endId !== change.id)) continue;
      const after = sql`(${messages.createdAt}, ${messages.id}) > (${at}::timestamp, ${change.id})`;
      const before = sql`(${messages.createdAt}, ${messages.id}) < (${at}::timestamp, ${change.id})`;
      let nextStart = startId;
      let nextEnd = endId;
      if (startId === change.id) {
        const [row] = await tx.select({ id: messages.id }).from(messages).where(and(
          eq(messages.sessionId, sessionId), after,
          endId && endId !== change.id
            ? sql`(${messages.createdAt}, ${messages.id}) <= (SELECT created_at, id FROM messages WHERE id = ${endId} AND session_id = ${sessionId})`
            : sql`FALSE`,
        )).orderBy(asc(messages.createdAt), asc(messages.id)).limit(1);
        nextStart = row?.id ?? null;
      }
      if (endId === change.id) {
        const [row] = await tx.select({ id: messages.id }).from(messages).where(and(
          eq(messages.sessionId, sessionId), before,
          nextStart
            ? sql`(${messages.createdAt}, ${messages.id}) >= (SELECT created_at, id FROM messages WHERE id = ${nextStart} AND session_id = ${sessionId})`
            : sql`FALSE`,
        )).orderBy(sql`${messages.createdAt} desc, ${messages.id} desc`).limit(1);
        nextEnd = row?.id ?? null;
      }
      if (!nextStart || !nextEnd) {
        await tx.delete(summaryceptionSnippets).where(eq(summaryceptionSnippets.id, snippet.id));
        await renumberLayer(sessionId, snippet.layerIndex, tx);
      } else {
        await tx.update(summaryceptionSnippets).set({
          sourceStartMessageId: nextStart,
          sourceEndMessageId: nextEnd,
          sourceHash: markSnippetStale(snippet.sourceHash, change.id),
          updatedAt: new Date(),
        }).where(eq(summaryceptionSnippets.id, snippet.id));
      }
      return;
    }
    // The covering chapter: its first message at or before the change, its
    // last at or after.
    const [covering] = await tx.select({ id: summaryceptionSnippets.id, sourceHash: summaryceptionSnippets.sourceHash })
      .from(summaryceptionSnippets)
      .innerJoin(sql`messages AS first_m`, sql`first_m.id = ${summaryceptionSnippets.sourceStartMessageId}`)
      .innerJoin(sql`messages AS last_m`, sql`last_m.id = ${summaryceptionSnippets.sourceEndMessageId}`)
      .where(and(
        eq(summaryceptionSnippets.sessionId, sessionId),
        sql`(first_m.created_at, first_m.id) <= (${at}::timestamp, ${change.id})`,
        sql`(last_m.created_at, last_m.id) >= (${at}::timestamp, ${change.id})`,
      ))
      .limit(1);
    if (covering) {
      await tx.update(summaryceptionSnippets).set({
        sourceHash: markSnippetStale(covering.sourceHash, change.id),
        updatedAt: new Date(),
      }).where(eq(summaryceptionSnippets.id, covering.id));
    }
    // Stop a run that read the old text; the next run starts with the revision.
    await tx.update(playSessions).set({ summaryceptionStatus: "idle", summaryceptionSourceHash: null })
      .where(and(eq(playSessions.id, sessionId), eq(playSessions.summaryceptionStatus, "updating")));
  });
}

/**
 * After a rewind deleted the newest messages: drop only the chapters that
 * covered a deleted message, and return the surviving messages they covered
 * to the raw history (the next fold summarizes them again). Earlier chapters
 * stay. The old behavior cleared the whole recap.
 */
export async function trimRecapAfterRewind(sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: playSessions.id }).from(playSessions).where(eq(playSessions.id, sessionId)).for("update");
    const snippets = await loadSnippets(sessionId, tx);
    const endpointIds = [...new Set(snippets.flatMap((s) => [s.sourceStartMessageId, s.sourceEndMessageId]).filter((id): id is string => !!id))];
    const surviving = new Set(endpointIds.length
      ? (await tx.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.sessionId, sessionId), inArray(messages.id, endpointIds)))).map((row) => row.id)
      : []);
    const dropped = snippets.filter((s) => !s.sourceEndMessageId || !surviving.has(s.sourceEndMessageId)
      || (s.sourceStartMessageId != null && !surviving.has(s.sourceStartMessageId)));
    if (dropped.length === 0) return;
    await tx.delete(summaryceptionSnippets).where(inArray(summaryceptionSnippets.id, dropped.map((s) => s.id)));
    for (const layer of new Set(dropped.map((s) => s.layerIndex))) await renumberLayer(sessionId, layer, tx);
    const starts = dropped.map((s) => s.sourceStartMessageId).filter((id): id is string => !!id && surviving.has(id));
    // Survivors from the earliest dropped chapter's start onward go back to
    // raw history. With no surviving start, those chapters covered only
    // deleted messages.
    if (starts.length > 0) {
      const [earliest] = await tx.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.sessionId, sessionId), inArray(messages.id, starts)))
        .orderBy(asc(messages.createdAt), asc(messages.id)).limit(1);
      if (earliest) {
        await tx.update(messages).set({ summaryceptionCompacted: false }).where(and(
          eq(messages.sessionId, sessionId),
          sql`(${messages.createdAt}, ${messages.id}) >= (SELECT created_at, id FROM messages WHERE id = ${earliest.id} AND session_id = ${sessionId})`,
        ));
      }
    }
    await tx.update(playSessions).set({ summaryceptionCoversUntilMessageId: null, summaryceptionTokenCount: null })
      .where(eq(playSessions.id, sessionId));
  });
}

/** What folding the older history the recap has not reached would take. */
export async function estimateRecapBackfill(args: {
  sessionId: string;
  userId: string;
  storyMemoryTokens: number;
  recapBudgetTokens: number;
  /** Price the set-aside history too (fillSetAsideRecap). */
  setAside?: boolean;
}): Promise<{
  backlogMessages: number;
  backlogTokens: number;
  needsApproval: boolean;
  /** Mushies on the official key; null on the player's own key or an unlimited plan. */
  estimatedCredits: number | null;
  model: string;
}> {
  const inputs = await resolveRunInputs({ sessionId: args.sessionId, userId: args.userId, fallbackModel: DEFAULT_STORY_SUMMARY_MODEL });
  const window = selectCompactionWindow(inputs.transcriptRows, {
    mode: "overflow",
    contextTokenLimit: Math.max(1, args.storyMemoryTokens),
    recentTailTokens: Math.max(1, args.storyMemoryTokens),
    minCompactableTokens: 0,
    modelId: inputs.model,
  });
  const setAside = args.setAside ? await loadSetAsideRows(args.sessionId) : [];
  const backlog = [
    ...setAside,
    ...(window?.compactable ?? []).filter((message) => message.role === "user" || message.role === "assistant"),
  ];
  const backlogTokens = estimateMessagesTokens(backlog, inputs.model);
  return {
    backlogMessages: backlog.length,
    backlogTokens,
    needsApproval: setAside.length > 0 || backlogTokens > autoBackfillLimitTokens(args.storyMemoryTokens, (await loadSnippets(args.sessionId)).length > 0),
    estimatedCredits: await priceRecapFold(args.userId, inputs.model, backlogTokens, args.recapBudgetTokens),
    model: inputs.model,
  };
}

/** Mushies folding this much story would take on the official key; null on
 *  the player's own key or an unlimited plan. */
async function priceRecapFold(userId: string, model: string, tokens: number, recapBudgetTokens?: number | null): Promise<number | null> {
  // Each chunk call reads the chunk plus at most RECAP_CONTEXT_* of the recap
  // (this assumed so before the calls did: they read all of it, and a long
  // backfill cost 5 to 10 times the quote, 2026-11-03); merges, now also
  // made along the way, add about half as many calls again.
  const calls = Math.ceil(tokens / SUMMARYCEPTION_TARGET_CHUNK_TOKENS);
  const context = RECAP_CONTEXT_TAIL_TOKENS + RECAP_CONTEXT_HEAD_TOKENS;
  const recapRead = Math.min(recapBudgetTokens || context, context);
  const promptTokens = Math.round(tokens * 1.1 + calls * 1.5 * (recapRead + 600));
  const completionTokens = Math.round(calls * 1.5 * SUMMARYCEPTION_MAX_SNIPPET_TOKENS * 0.8);
  const resolved = await resolveProviderForModel(userId, model, { allowOfficialFallback: false }).catch(() => null);
  if (resolved?.isByok) return null;
  const cost = await backgroundUsageCost({ userId, model, promptTokens, completionTokens });
  return cost > 0 ? Math.ceil(cost) : null;
}

/**
 * What folding the oldest `count` unfolded messages would take (memory panel,
 * "fold N"). The newest reply and anything after it always stay word for
 * word, and the fold ends on a reply, so the count can come out one off from
 * what was asked.
 */
export async function estimateRecapFold(args: { sessionId: string; userId: string; count: number }): Promise<{
  /** Most messages a fold can take now. */
  available: number;
  /** What this fold takes (0 when nothing can be folded). */
  messages: number;
  tokens: number;
  estimatedCredits: number | null;
  /** Fold through this message (null when nothing can be folded). */
  throughMessageId: string | null;
  /** Its place in the whole story, for the label. */
  throughOrdinal: number | null;
  model: string;
}> {
  const inputs = await resolveRunInputs({ sessionId: args.sessionId, userId: args.userId, fallbackModel: DEFAULT_STORY_SUMMARY_MODEL });
  const relevant = inputs.relevantRows;
  let lastReply = relevant.length - 1;
  while (lastReply >= 0 && relevant[lastReply]!.role !== "assistant") lastReply--;
  const pool = relevant.slice(0, Math.max(0, lastReply));
  const none = { available: pool.length, messages: 0, tokens: 0, estimatedCredits: null, throughMessageId: null, throughOrdinal: null, model: inputs.model };
  if (pool.length === 0) return none;
  let end = Math.min(pool.length, Math.max(1, Math.floor(args.count))) - 1;
  if (pool[end]!.role !== "assistant") {
    const next = pool.findIndex((message, index) => index > end && message.role === "assistant");
    if (next >= 0) end = next;
    else {
      while (end >= 0 && pool[end]!.role !== "assistant") end--;
      if (end < 0) return none;
    }
  }
  const folded = pool.slice(0, end + 1);
  const tokens = estimateMessagesTokens(folded, inputs.model);
  const through = folded.at(-1)!;
  return {
    available: pool.length,
    messages: folded.length,
    tokens,
    // Each call reads the recap so far: what it is now, plus what this fold adds.
    estimatedCredits: await priceRecapFold(args.userId, inputs.model, tokens,
      (inputs.row.session.summaryceptionTokenCount ?? 0) + Math.ceil(tokens / SUMMARYCEPTION_TARGET_CHUNK_TOKENS) * SUMMARYCEPTION_MAX_SNIPPET_TOKENS),
    throughMessageId: through.id,
    throughOrdinal: (await loadStoryOrdinals(args.sessionId)).get(through.id) ?? null,
    model: inputs.model,
  };
}

/**
 * Delete one chapter (memory panel). The newest chapter's messages go back
 * to the history the AI reads word for word, like undoing that fold. An
 * older chapter is only forgotten: its messages stay out of the prompt,
 * since putting them back in the middle would leave later chapters ahead of
 * them and the next fold could not continue the story in order.
 */
export function deleteSummaryceptionSnippet(args: {
  sessionId: string;
  userId: string;
  snippetId: string;
}): Promise<{ restoredMessages: number }> {
  return enqueueSummaryceptionJob(args.sessionId, async () => {
    const row = await loadSession(args.sessionId, args.userId);
    if (!row) throw new Error("Session not found");
    return db.transaction(async (tx) => {
      await tx.select({ id: playSessions.id }).from(playSessions).where(eq(playSessions.id, args.sessionId)).for("update");
      const snippets = await loadSnippets(args.sessionId, tx);
      const target = snippets.find((snippet) => snippet.id === args.snippetId);
      if (!target) throw new Error("Snippet not found");
      const ordinals = await loadStoryOrdinals(args.sessionId, tx);
      const endOf = (snippet: typeof target) => (snippet.sourceEndMessageId ? ordinals.get(snippet.sourceEndMessageId) : undefined) ?? -1;
      const newestEnd = Math.max(...snippets.map(endOf));
      const isNewest = endOf(target) >= 0 && endOf(target) === newestEnd
        && snippets.filter((snippet) => endOf(snippet) === newestEnd).length === 1;

      await tx.delete(summaryceptionSnippets).where(eq(summaryceptionSnippets.id, target.id));
      await renumberLayer(args.sessionId, target.layerIndex, tx);

      let restoredMessages = 0;
      if (isNewest && target.sourceStartMessageId && ordinals.has(target.sourceStartMessageId)) {
        const fromStart = and(
          eq(messages.sessionId, args.sessionId),
          eq(messages.summaryceptionCompacted, true),
          sql`(${messages.createdAt}, ${messages.id}) >= (SELECT created_at, id FROM messages WHERE id = ${target.sourceStartMessageId} AND session_id = ${args.sessionId})`,
        );
        const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(messages).where(fromStart);
        await tx.update(messages).set({ summaryceptionCompacted: false }).where(fromStart);
        restoredMessages = counted?.n ?? 0;
      }

      const remaining = await loadSnippets(args.sessionId, tx);
      const newest = remaining.reduce<typeof target | null>((best, snippet) => (!best || endOf(snippet) > endOf(best) ? snippet : best), null);
      const model = applyModelRedirect((row.session.summaryceptionModel || row.session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim());
      const summary = assembleSummaryceptionText(remaining);
      await tx.update(playSessions).set({
        summaryceptionStatus: "idle",
        summaryceptionError: null,
        summaryceptionSourceHash: null,
        summaryceptionCoversUntilMessageId: newest?.sourceEndMessageId ?? null,
        summaryceptionTokenCount: summary ? estimateTextTokens(summary, model) : null,
        summaryceptionUpdatedAt: new Date(),
      }).where(eq(playSessions.id, args.sessionId));
      return { restoredMessages };
    });
  });
}

/** Set older messages aside: folded, but in no chapter. They stay out of the
 *  prompt, as they already were, and the recap continues after them. */
async function markRecapSkipped(sessionId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.select({ id: playSessions.id }).from(playSessions).where(eq(playSessions.id, sessionId)).for("update");
    await tx.update(messages).set({ summaryceptionCompacted: true })
      .where(and(eq(messages.sessionId, sessionId), inArray(messages.id, ids)));
  });
}

/**
 * The player chose to start the recap from here: older history it has not
 * reached is set aside, so the recap continues from the current story
 * instead of asking again.
 */
export function skipRecapBackfill(args: { sessionId: string; userId: string; storyMemoryTokens: number }): Promise<number> {
  return enqueueSummaryceptionJob(args.sessionId, async () => {
    const inputs = await resolveRunInputs({ sessionId: args.sessionId, userId: args.userId, fallbackModel: DEFAULT_STORY_SUMMARY_MODEL });
    const window = selectCompactionWindow(inputs.transcriptRows, {
      mode: "overflow",
      contextTokenLimit: Math.max(1, args.storyMemoryTokens),
      recentTailTokens: Math.max(1, args.storyMemoryTokens),
      minCompactableTokens: 0,
      modelId: inputs.model,
    });
    const ids = (window?.compactable ?? []).map((message) => message.id);
    await markRecapSkipped(args.sessionId, ids);
    return ids.length;
  });
}

/**
 * Fold the set-aside history into chapters after the player approved its
 * price, then whatever else is waiting. Each new chapter goes where its part
 * of the story is, between the chapters around it; the chapters already
 * written stay. This used to clear the whole recap and fold it again from
 * the first message: one click to add 100 set-aside messages threw away
 * chapters for 2,000, and a run that stopped partway left them gone
 * (2026-11-17).
 */
export function fillSetAsideRecap(args: SummaryceptionCompactionArgs): Promise<SummaryceptionCompactionResult> {
  return enqueueSummaryceptionJob(args.sessionId, async () => {
    const [session] = await db.select().from(playSessions)
      .where(and(eq(playSessions.id, args.sessionId), eq(playSessions.userId, args.userId))).limit(1);
    if (!session) throw new Error("Session not found");
    args = { ...args, run: args.run ?? await startRecapRun(args, session) };
    const budgetTokens = args.recapBudgetTokens && args.recapBudgetTokens > 0 ? args.recapBudgetTokens : null;
    for (let i = 0; i < RECAP_FOLD_MAX_CHUNKS; i++) {
      if (outOfCalls(args.run)) break;
      if (!await foldOneSetAsideChunk(args)) break;
      if (budgetTokens && estimateTextTokens(assembleSummaryceptionText(await loadSnippets(args.sessionId))) > budgetTokens * RECAP_IN_RUN_SHRINK_FACTOR) {
        await runClaimedLayeredStep(args, "budget", (step) => shrinkRecapToBudget({ ...step, budgetTokens, maxMerges: RECAP_IN_RUN_MAX_MERGES }));
      }
    }
    return compactSummaryceptionNow({ ...args, foldAll: true, backfillApproved: true });
  });
}

/** One chapter from the oldest set-aside messages, placed in story order.
 *  False when nothing is set aside. */
async function foldOneSetAsideChunk(args: SummaryceptionCompactionArgs): Promise<boolean> {
  const rows = await loadSetAsideRows(args.sessionId);
  if (rows.length === 0) return false;
  const ordinals = await loadStoryOrdinals(args.sessionId);
  const at = (id: string | null | undefined) => (id ? ordinals.get(id) : undefined) ?? -1;
  // The first unbroken stretch: a chapter never spans a chapter between.
  let run = 1;
  while (run < rows.length && at(rows[run]!.id) === at(rows[run - 1]!.id) + 1) run++;
  const stretch = rows.slice(0, run);
  let changed = false;
  await runClaimedLayeredStep(args, "fill", async (step) => {
    const chunkTokens = args.run?.chunkTokens ?? SUMMARYCEPTION_TARGET_CHUNK_TOKENS;
    const chunk = endOnReply(splitMessagesIntoCompactionChunks(stretch, chunkTokens, step.model)[0] ?? [], stretch);
    if (chunk.length === 0) return;
    const startAt = at(chunk[0]!.id);
    const before = (snippet: typeof summaryceptionSnippets.$inferSelect) => at(snippet.sourceEndMessageId) < startAt;
    const prior = (await loadSnippets(args.sessionId)).filter(before);
    const priorContext = assembleSummaryceptionText(prior);
    const generated = await generateSummaryceptionText({
      userId: args.userId,
      sessionId: args.sessionId,
      model: step.model,
      language: step.language,
      run: step.run,
      prompt: buildSummaryceptionPrompt({
        worldName: step.worldName,
        priorContext: recapContextForCall(prior, step.model),
        passage: formatMessagesForStoryCompaction(chunk),
        language: step.language,
      }),
    });
    await db.transaction(async (tx) => {
      await lockSummaryJob(tx, args.sessionId, step.claim, step.snapshot);
      const current = await loadSnippets(args.sessionId, tx);
      const [valid] = await tx.select({ id: playSessions.id }).from(playSessions).where(and(
        eq(playSessions.id, args.sessionId), memorySourceGuard(args.sessionId, chunk),
      ));
      if (!valid || assembleSummaryceptionText(current.filter(before)) !== priorContext) throw new SummaryceptionInvalidatedError();
      // Right after the chapter that ends just before it, in that chapter's
      // layer; with none, first in the oldest layer.
      const anchor = current.filter(before).sort((a, b) => at(b.sourceEndMessageId) - at(a.sourceEndMessageId))[0];
      const layerIndex = anchor?.layerIndex ?? (current.length > 0 ? Math.max(...current.map((s) => s.layerIndex)) : 0);
      const order = anchor ? anchor.snippetOrder + 1 : 0;
      await tx.update(summaryceptionSnippets)
        .set({ snippetOrder: sql`${summaryceptionSnippets.snippetOrder} + 1`, updatedAt: new Date() })
        .where(and(
          eq(summaryceptionSnippets.sessionId, args.sessionId),
          eq(summaryceptionSnippets.layerIndex, layerIndex),
          sql`${summaryceptionSnippets.snippetOrder} >= ${order}`,
        ));
      const fromOrdinal = ordinals.get(chunk[0]!.id) ?? 0;
      const toOrdinal = ordinals.get(chunk.at(-1)!.id) ?? 0;
      await tx.insert(summaryceptionSnippets).values({
        id: randomUUID(),
        sessionId: args.sessionId,
        layerIndex,
        snippetOrder: order,
        text: generated.text,
        sourceStartMessageId: chunk[0]!.id,
        sourceEndMessageId: chunk.at(-1)!.id,
        sourceStartOrdinal: fromOrdinal > 0 ? fromOrdinal : null,
        sourceEndOrdinal: toOrdinal > 0 ? toOrdinal : null,
        sourceHash: createSummaryceptionSourceHash({
          version: SUMMARYCEPTION_SOURCE_HASH_VERSION,
          kind: "set-aside",
          sessionId: args.sessionId,
          model: step.model,
          language: step.language,
          messageIds: chunk.map((message) => message.id),
          messageText: chunk.map((message) => [message.role, message.content]),
          priorContext,
        }),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await generated.charge?.(tx);
      changed = true;
    });
  });
  return changed;
}

/** Story messages folded without a chapter, in story order: set aside when
 *  the recap started from a later point. */
async function loadSetAsideRows(sessionId: string): Promise<StoryMessageRow[]> {
  return db.select({
    id: messages.id,
    role: messages.role,
    content: messages.content,
    attachments: messages.attachments,
    createdAt: messages.createdAt,
  }).from(messages).where(and(
    eq(messages.sessionId, sessionId),
    eq(messages.summaryceptionCompacted, true),
    inArray(messages.role, ["user", "assistant"]),
    sql`${messages.status} is distinct from 'failed'`,
    setAsideCondition(sessionId),
  )).orderBy(asc(messages.createdAt), asc(messages.id));
}

function setAsideCondition(sessionId: string) {
  return sql`not exists (
      select 1 from summaryception_snippets s
      join messages first_m on first_m.id = s.source_start_message_id
      join messages last_m on last_m.id = s.source_end_message_id
      where s.session_id = ${sessionId}
        and (first_m.created_at, first_m.id) <= ("messages"."created_at", "messages"."id")
        and (last_m.created_at, last_m.id) >= ("messages"."created_at", "messages"."id"))`;
}

/** Messages folded without a chapter: set aside when the recap started from a
 *  later point. */
export async function countSetAsideMessages(sessionId: string): Promise<number> {
  const [row] = await db.select({
    n: sql<number>`count(*)::int`,
  }).from(messages).where(and(
    eq(messages.sessionId, sessionId),
    eq(messages.summaryceptionCompacted, true),
    setAsideCondition(sessionId),
  ));
  return row?.n ?? 0;
}

const MAX_EDITED_SNIPPET_CHARS = 8_000;

/**
 * User-facing manual edit of a single Summaryception snippet's text. Serialized
 * through the same per-session job chain as compaction so an edit can't
 * interleave with an in-flight fold. Recomputes the session's cached
 * summaryception token count from the full snippet set after the edit.
 */
export function updateSummaryceptionSnippet(args: {
  sessionId: string;
  userId: string;
  snippetId: string;
  text: string;
}): Promise<void> {
  return enqueueSummaryceptionJob(args.sessionId, async () => {
    const row = await loadSession(args.sessionId, args.userId);
    if (!row) throw new Error("Session not found");
    const text = args.text.trim().slice(0, MAX_EDITED_SNIPPET_CHARS);
    if (!text) throw new Error("Snippet text cannot be empty");

    await db.transaction(async (tx) => {
      await tx.select({ id: playSessions.id }).from(playSessions).where(eq(playSessions.id, args.sessionId)).for("update");
      const [snippet] = await tx
        .select({ id: summaryceptionSnippets.id, sourceHash: summaryceptionSnippets.sourceHash })
        .from(summaryceptionSnippets)
        .where(and(eq(summaryceptionSnippets.id, args.snippetId), eq(summaryceptionSnippets.sessionId, args.sessionId)))
        .limit(1);
      if (!snippet) throw new Error("Snippet not found");

      await tx
        .update(summaryceptionSnippets)
        .set({ text, sourceHash: `manual:${isIncompleteSnippet(snippet) ? "partial:" : ""}${randomUUID()}`, updatedAt: new Date() })
        .where(eq(summaryceptionSnippets.id, args.snippetId));

      const model = applyModelRedirect((row.session.summaryceptionModel || row.session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim());
      const summary = assembleSummaryceptionText(await loadSnippets(args.sessionId, tx));
      await tx
        .update(playSessions)
        .set({
          summaryceptionStatus: "idle",
          summaryceptionSourceHash: null,
          summaryceptionTokenCount: summary ? estimateTextTokens(summary, model) : null,
          summaryceptionUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(playSessions.id, args.sessionId));
    });
  });
}

/** The stop button: ends the run in progress after its current call. The
 *  call in flight is discarded (its claim no longer matches) and the next
 *  step refuses to start. Chapters already written stay. */
export async function stopRecapRun(sessionId: string, userId: string): Promise<boolean> {
  const [row] = await db.update(playSessions).set({
    summaryceptionStatus: "idle",
    summaryceptionError: null,
    summaryceptionSourceHash: `${RECAP_STOP_PREFIX}${Date.now()}`,
    summaryceptionUpdatedAt: new Date(),
  }).where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId), eq(playSessions.summaryceptionStatus, "updating")))
    .returning();
  return !!row;
}
