import { usageObservation } from "./usage-observation.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, summaryceptionSnippets, worlds } from "../db/schema.js";
import { recordUsageLog } from "./usage-log.js";
import { billBackgroundUsage } from "./background-billing.js";
import { resolveProviderForModel } from "./resolve-provider.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { captureServerEvent } from "./analytics.js";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import type { SummaryCompactionNoOpCode } from "@yumina/shared";
import { isExtensionInstalled } from "./extensions.js";
import type { ChatMessage } from "./llm/types.js";
import { enqueueKeyedJob } from "./job-chain.js";
import { buildSummaryLanguageInstruction, correctSummaryLanguageOnce, resolveSummaryOutputLanguage, type SessionSummaryLanguage } from "./summary-language.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
  formatMessagesForStoryCompaction,
  normalizeSessionSummaryRecentTailTokens,
  selectCompactionWindow,
  selectForcedManualCompactionWindow,
  splitMessagesIntoCompactionChunks,
  type StoryMessageRow,
} from "./session-compaction-core.js";
import { DEFAULT_STORY_SUMMARY_MODEL } from "./session-compaction.js";
import {
  assembleSummaryceptionText,
  formatSummaryceptionForPrompt,
  SUMMARYCEPTION_MAX_LAYERS,
  SUMMARYCEPTION_SNIPPETS_PER_LAYER,
  SUMMARYCEPTION_SNIPPETS_PER_PROMOTION,
} from "./summaryception-core.js";

const SUMMARYCEPTION_SOURCE_HASH_VERSION = 1;
// Sized for a CJK-aware summary model (~1 token/Chinese char). Chunk ≈ one
// narrative "beat" (~2 exchanges of dense Chinese RP ≈ ~3k chars); snippet cap
// gives ~one paragraph of dense clauses to hold a beat's facts without bloat.
// Under the old grok default (cl100k, ~2 tokens/char) these were 5_000/360,
// which mapped to the same ~2.5k-char beat but compressed it ~14:1 — too lossy.
const SUMMARYCEPTION_MAX_SNIPPET_TOKENS = 500;
const SUMMARYCEPTION_TARGET_CHUNK_TOKENS = 3_000;

type SummaryceptionCompactionArgs = {
  sessionId: string;
  userId: string;
  fallbackModel: string;
  contextTokenLimit?: number | null;
  finalPromptRawTokenLimit?: number | null;
  force?: boolean;
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

function cleanSummaryceptionOutput(raw: string): string {
  return stripCodeFence(raw)
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<reflect>[\s\S]*?<\/reflect>/gi, "")
    .replace(/<output>([\s\S]*?)<\/output>/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

async function generateSummaryceptionCandidate(args: {
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  singleAttempt?: boolean;
}): Promise<string> {
  const resolved = await resolveProviderForModel(args.userId, args.model, {
    allowOfficialFallback: false,
  });
  if (!resolved) throw new Error("No provider/API key is available for the selected summary model");

  let text = "";
  let observation = usageObservation();
    let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  const start = Date.now();

  for await (const chunk of resolved.provider.generateStream({
    conversationId: `play:${args.sessionId}`,
    model: args.model,
    messages: args.prompt,
    maxTokens: SUMMARYCEPTION_MAX_SNIPPET_TOKENS,
    temperature: 0.2,
    singleAttempt: args.singleAttempt,
    fallbackModels: args.singleAttempt || args.model === DEFAULT_STORY_SUMMARY_MODEL ? undefined : [DEFAULT_STORY_SUMMARY_MODEL],
  })) {
    if (chunk.type === "text") text += chunk.content;
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
      await billBackgroundUsage({
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
  if (!normalized) throw new Error("Summaryception model returned an empty summary");
  return normalized;
}

async function generateSummaryceptionText(args: {
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  language: SessionSummaryLanguage;
}): Promise<string> {
  const text = await generateSummaryceptionCandidate(args);
  return correctSummaryLanguageOnce({
    text,
    language: args.language,
    // Call the candidate generator directly, never this checked wrapper.
    generate: (prompt) => generateSummaryceptionCandidate({ ...args, prompt, singleAttempt: true }),
  });
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
        "You are a precise narrative-state tracker for an AI roleplay session.",
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
        "Write as many dense, semicolon-separated clauses as needed to preserve every load-bearing fact — names, numbers, relationship and status changes, promises, secrets. Omit nothing that affects future turns; cut only atmosphere and prose.",
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
    .orderBy(asc(messages.createdAt));
}

async function loadSnippets(sessionId: string) {
  return db
    .select()
    .from(summaryceptionSnippets)
    .where(eq(summaryceptionSnippets.sessionId, sessionId))
    .orderBy(asc(summaryceptionSnippets.layerIndex), asc(summaryceptionSnippets.snippetOrder), asc(summaryceptionSnippets.createdAt));
}

async function nextSnippetOrder(sessionId: string, layerIndex: number): Promise<number> {
  const [row] = await db
    .select({ value: max(summaryceptionSnippets.snippetOrder) })
    .from(summaryceptionSnippets)
    .where(and(eq(summaryceptionSnippets.sessionId, sessionId), eq(summaryceptionSnippets.layerIndex, layerIndex)));
  return (row?.value ?? -1) + 1;
}

async function renumberLayer(sessionId: string, layerIndex: number): Promise<void> {
  const rows = await db
    .select()
    .from(summaryceptionSnippets)
    .where(and(eq(summaryceptionSnippets.sessionId, sessionId), eq(summaryceptionSnippets.layerIndex, layerIndex)))
    .orderBy(asc(summaryceptionSnippets.snippetOrder), asc(summaryceptionSnippets.createdAt));
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.snippetOrder !== i) {
      await db
        .update(summaryceptionSnippets)
        .set({ snippetOrder: i, updatedAt: new Date() })
        .where(eq(summaryceptionSnippets.id, rows[i]!.id));
    }
  }
}

async function buildPriorContext(sessionId: string, downToLayer = 0, excludeIds = new Set<string>()): Promise<string> {
  const snippets = (await loadSnippets(sessionId))
    .filter((snippet) => snippet.layerIndex >= downToLayer && !excludeIds.has(snippet.id));
  return assembleSummaryceptionText(snippets);
}

async function maybePromoteLayer(args: {
  sessionId: string;
  userId: string;
  model: string;
  worldName?: string | null;
  layerIndex: number;
  language: SessionSummaryLanguage;
}): Promise<void> {
  if (args.layerIndex >= SUMMARYCEPTION_MAX_LAYERS - 1) return;

  const layer = await db
    .select()
    .from(summaryceptionSnippets)
    .where(and(eq(summaryceptionSnippets.sessionId, args.sessionId), eq(summaryceptionSnippets.layerIndex, args.layerIndex)))
    .orderBy(asc(summaryceptionSnippets.snippetOrder), asc(summaryceptionSnippets.createdAt));

  if (layer.length <= SUMMARYCEPTION_SNIPPETS_PER_LAYER) return;

  const destLayerIndex = args.layerIndex + 1;
  const dest = await db
    .select()
    .from(summaryceptionSnippets)
    .where(and(eq(summaryceptionSnippets.sessionId, args.sessionId), eq(summaryceptionSnippets.layerIndex, destLayerIndex)))
    .orderBy(asc(summaryceptionSnippets.snippetOrder), asc(summaryceptionSnippets.createdAt));

  if (dest.length === 0) {
    const seed = layer[0]!;
    await db
      .update(summaryceptionSnippets)
      .set({
        layerIndex: destLayerIndex,
        snippetOrder: 0,
        promoted: true,
        fromLayer: args.layerIndex,
        updatedAt: new Date(),
      })
      .where(eq(summaryceptionSnippets.id, seed.id));
    await renumberLayer(args.sessionId, args.layerIndex);
    await maybePromoteLayer({ ...args, layerIndex: args.layerIndex });
    await maybePromoteLayer({ ...args, layerIndex: destLayerIndex });
    return;
  }

  const toMerge = layer.slice(0, SUMMARYCEPTION_SNIPPETS_PER_PROMOTION);
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
  const priorContext = await buildPriorContext(args.sessionId, destLayerIndex, new Set(toMerge.map((snippet) => snippet.id)));
  const text = await generateSummaryceptionText({
    userId: args.userId,
    sessionId: args.sessionId,
    model: args.model,
    language: args.language,
    prompt: buildSummaryceptionPrompt({
      worldName: args.worldName,
      priorContext,
      passage: toMerge.map((snippet) => snippet.text).join(" "),
      language: args.language,
    }),
  });

  const order = await nextSnippetOrder(args.sessionId, destLayerIndex);
  await db.delete(summaryceptionSnippets).where(inArray(summaryceptionSnippets.id, toMerge.map((snippet) => snippet.id)));
  await db.insert(summaryceptionSnippets).values({
    id: randomUUID(),
    sessionId: args.sessionId,
    layerIndex: destLayerIndex,
    snippetOrder: order,
    text,
    sourceHash,
    fromLayer: args.layerIndex,
    mergedCount: toMerge.length,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await renumberLayer(args.sessionId, args.layerIndex);
  await maybePromoteLayer({ ...args, layerIndex: args.layerIndex });
  await maybePromoteLayer({ ...args, layerIndex: destLayerIndex });
}

export async function getSummaryceptionPromptBlock(sessionId: string): Promise<string | null> {
  return formatSummaryceptionForPrompt(await loadSnippets(sessionId));
}

export async function getSummaryceptionStats(row: typeof playSessions.$inferSelect): Promise<SummaryceptionStats> {
  const snippets = await loadSnippets(row.id);
  const summary = assembleSummaryceptionText(snippets);
  const model = applyModelRedirect(row.summaryceptionModel || row.summaryModel || DEFAULT_STORY_SUMMARY_MODEL);
  const layerIndexes = new Set(snippets.map((snippet) => snippet.layerIndex));
  const layerZero = snippets.filter((snippet) => snippet.layerIndex === 0 && snippet.sourceEndOrdinal != null);
  const coversUntilOrdinal = layerZero.length > 0
    ? Math.max(...layerZero.map((snippet) => snippet.sourceEndOrdinal ?? 0))
    : null;
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
          sourceStartOrdinal: snippet.sourceStartOrdinal ?? null,
          sourceEndOrdinal: snippet.sourceEndOrdinal ?? null,
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
    status: row.summaryceptionStatus || "idle",
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
async function markUpdating(sessionId: string, sourceHash: string, model: string): Promise<void> {
  await db.update(playSessions)
    .set({
      summaryceptionModel: model,
      summaryceptionStatus: "updating",
      summaryceptionError: null,
      summaryceptionSourceHash: sourceHash,
    })
    .where(eq(playSessions.id, sessionId));
}

async function markFailed(sessionId: string, error: unknown): Promise<void> {
  await db.update(playSessions)
    .set({
      summaryceptionStatus: "failed",
      summaryceptionError: error instanceof Error ? error.message : "Summaryception compaction failed",
    })
    .where(eq(playSessions.id, sessionId));
}

async function compactSummaryceptionNow(args: SummaryceptionCompactionArgs): Promise<SummaryceptionCompactionResult> {
  const row = await loadSession(args.sessionId, args.userId);
  if (!row) throw new Error("Session not found");

  const model = applyModelRedirect((row.session.summaryceptionModel || row.session.summaryModel || args.fallbackModel || DEFAULT_STORY_SUMMARY_MODEL).trim());
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
  const usedForcedWindow = !normalWindow && !!forcedWindow;

  if (!window) {
    const summary = assembleSummaryceptionText(await loadSnippets(args.sessionId));
    const retainedTokenEstimate = estimateMessagesTokens(relevantRows, model);
    return {
      summary,
      compactedCount: 0,
      compactedMessageIds: [],
      compactedFromMessageId: null,
      compactedToMessageId: null,
      compactedFromOrdinal: null,
      compactedToOrdinal: null,
      compactedTokenEstimate: 0,
      retainedCount: relevantRows.length,
      retainedTokenEstimate,
      noOpReason: "Nothing older than the kept-raw tail to compact yet.",
      noOpReasonCode: "fits-within-raw-tail",
    };
  }

  const chunk = splitMessagesIntoCompactionChunks(window.compactable, SUMMARYCEPTION_TARGET_CHUNK_TOKENS, model)[0] ?? [];
  if (chunk.length === 0) throw new Error("No compactable messages found");

  const first = chunk[0]!;
  const last = chunk.at(-1)!;
  const compactedMessageIds = chunk.map((message) => message.id);
  const compactedFromOrdinal = relevantRows.findIndex((message) => message.id === first.id) + 1;
  const compactedToOrdinal = relevantRows.findIndex((message) => message.id === last.id) + 1;
  const priorContext = await buildPriorContext(args.sessionId, 0);
  const passage = formatMessagesForStoryCompaction(chunk);
  const sourceHash = createSummaryceptionSourceHash({
    version: SUMMARYCEPTION_SOURCE_HASH_VERSION,
    kind: usedForcedWindow ? "layer-0-forced" : "layer-0",
    sessionId: args.sessionId,
    model,
    language,
    forced: usedForcedWindow,
    messageIds: compactedMessageIds,
    messageText: chunk.map((message) => [message.role, message.content]),
    priorContext,
  });

  if (row.session.summaryceptionSourceHash === sourceHash && row.session.summaryceptionStatus === "idle") {
    const summary = assembleSummaryceptionText(await loadSnippets(args.sessionId));
    return {
      summary,
      compactedCount: 0,
      compactedMessageIds: [],
      compactedFromMessageId: null,
      compactedToMessageId: null,
      compactedFromOrdinal: null,
      compactedToOrdinal: null,
      compactedTokenEstimate: 0,
      retainedCount: window.retained.length,
      retainedTokenEstimate: estimateMessagesTokens(window.retained, model),
      noOpReason: "This Summaryception batch is already compacted.",
      noOpReasonCode: "batch-already-compacted",
    };
  }

  await markUpdating(args.sessionId, sourceHash, model);

  try {
    const text = await generateSummaryceptionText({
      userId: args.userId,
      sessionId: args.sessionId,
      model,
      language,
      prompt: buildSummaryceptionPrompt({
        worldName: row.worldName,
        priorContext,
        passage,
        language,
      }),
    });
    const order = await nextSnippetOrder(args.sessionId, 0);
    await db.insert(summaryceptionSnippets).values({
      id: randomUUID(),
      sessionId: args.sessionId,
      layerIndex: 0,
      snippetOrder: order,
      text,
      sourceStartMessageId: first.id,
      sourceEndMessageId: last.id,
      sourceStartOrdinal: compactedFromOrdinal > 0 ? compactedFromOrdinal : null,
      sourceEndOrdinal: compactedToOrdinal > 0 ? compactedToOrdinal : null,
      sourceHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.update(messages)
      .set({ summaryceptionCompacted: true })
      .where(inArray(messages.id, compactedMessageIds));

    await maybePromoteLayer({
      sessionId: args.sessionId,
      userId: args.userId,
      model,
      worldName: row.worldName,
      layerIndex: 0,
      language,
    });

    const summary = assembleSummaryceptionText(await loadSnippets(args.sessionId));
    await db.update(playSessions)
      .set({
        summaryceptionModel: model,
        summaryceptionStatus: "idle",
        summaryceptionError: null,
        summaryceptionSourceHash: sourceHash,
        summaryceptionCoversUntilMessageId: last.id,
        summaryceptionTokenCount: summary ? estimateTextTokens(summary, model) : null,
        summaryceptionUpdatedAt: new Date(),
      })
      .where(eq(playSessions.id, args.sessionId));

    captureServerEvent(args.userId, "summary_job", {
      system: "summaryception",
      outcome: "ok",
      session_id: args.sessionId,
      model,
      compacted_count: compactedMessageIds.length,
    });

    return {
      summary,
      compactedCount: compactedMessageIds.length,
      compactedMessageIds,
      compactedFromMessageId: first.id,
      compactedToMessageId: last.id,
      compactedFromOrdinal: compactedFromOrdinal > 0 ? compactedFromOrdinal : null,
      compactedToOrdinal: compactedToOrdinal > 0 ? compactedToOrdinal : null,
      compactedTokenEstimate: estimateMessagesTokens(chunk, model),
      retainedCount: window.retained.length,
      retainedTokenEstimate: estimateMessagesTokens(window.retained, model),
      noOpReason: null,
      noOpReasonCode: null,
    };
  } catch (err) {
    await markFailed(args.sessionId, err);
    captureServerEvent(args.userId, "summary_job", {
      system: "summaryception",
      outcome: "failed",
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

/**
 * Fire-and-forget summaryception compaction for the send path's overflow pass.
 * The send must never wait on LLM summarization (the 2026-07-11 524 incident:
 * a permanently failing summary held sends past Cloudflare's 100s origin
 * limit). Deduped per session and capped on consecutive failures so a broken
 * config can't burn a full compaction per turn forever.
 */
export function scheduleSummaryceptionCompaction(args: SummaryceptionCompactionArgs): void {
  // Self-defend against the uninstall race (mirror of scheduleStoryCompaction):
  // never burn a paid compaction for a feature the user just removed.
  void isExtensionInstalled(args.userId, SESSION_MEMORY_EXTENSION_KEY).then((enabled) => {
    if (!enabled) return;
    if ((summaryceptionFailureCounts.get(args.sessionId) ?? 0) >= SUMMARYCEPTION_MAX_CONSECUTIVE_FAILURES) {
      console.warn(
        `[Summaryception] Auto-compaction suppressed for session ${args.sessionId} after ${SUMMARYCEPTION_MAX_CONSECUTIVE_FAILURES} consecutive failures — a successful manual compaction resets the budget`,
      );
      return;
    }
    if (summaryceptionScheduledSessions.has(args.sessionId)) return;
    summaryceptionScheduledSessions.add(args.sessionId);
    compactSummaryceptionForSession(args)
      .catch((err) => {
        summaryceptionFailureCounts.set(
          args.sessionId,
          (summaryceptionFailureCounts.get(args.sessionId) ?? 0) + 1,
        );
        console.warn("[Summaryception] Background compaction failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        summaryceptionScheduledSessions.delete(args.sessionId);
      });
  }).catch((err) => {
    console.warn("[Summaryception] Failed to schedule background compaction:", err instanceof Error ? err.message : err);
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
  await db.delete(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, sessionId));
  await db.update(messages).set({ summaryceptionCompacted: false }).where(eq(messages.sessionId, sessionId));
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

    const [snippet] = await db
      .select({ id: summaryceptionSnippets.id })
      .from(summaryceptionSnippets)
      .where(and(eq(summaryceptionSnippets.id, args.snippetId), eq(summaryceptionSnippets.sessionId, args.sessionId)))
      .limit(1);
    if (!snippet) throw new Error("Snippet not found");

    await db
      .update(summaryceptionSnippets)
      .set({ text, updatedAt: new Date() })
      .where(eq(summaryceptionSnippets.id, args.snippetId));

    const model = applyModelRedirect((row.session.summaryceptionModel || row.session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim());
    const summary = assembleSummaryceptionText(await loadSnippets(args.sessionId));
    await db
      .update(playSessions)
      .set({
        summaryceptionTokenCount: summary ? estimateTextTokens(summary, model) : null,
        summaryceptionUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(playSessions.id, args.sessionId));
  });
}
