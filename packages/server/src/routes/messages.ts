import { bodyLimit } from "hono/body-limit";
import { validateChatImages, storeChatImages, restoreChatImages, imagePromptChars } from "../lib/chat-images.js";
import { assertImageModel } from "../lib/llm/image-capability.js";
import { usageObservation } from "../lib/usage-observation.js";
import { edition } from "../edition/index.js";
import { Hono } from "hono";
import { setImmediate as yieldForIO } from "node:timers/promises";
import { guardPrompt, TurnOutputAttempt, appendTurnStateChanges } from "../lib/turn-output-validation.js";
import type { StateValidationAudit } from "@yumina/shared";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { eq, and, or, desc, gt, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, readOwn } from "../db/index.js";
import {
  messages,
  playSessions,
  worlds,
  worldPendingEdits,
  apiKeys,
  creditWallets,
} from "../db/schema.js";
import { recordUsageLog } from "../lib/usage-log.js";
import { settleStoppedGeneration } from "../lib/stopped-generation.js";
import { recordWallHit } from "../lib/wall-events.js";
import { canReuseFallbackMessage, modelFallbackError, parseModelFallbackRecord } from "../lib/model-fallback.js";
import { bumpWorldMessageCount } from "../lib/world-message-counter.js";
import { onMessageSent, onUsageLogged, onRegenerate } from "../lib/achievements/engine.js";
import { registerStream, stopSessionStream, isClientAbort, isShutdownAbort } from "../lib/stream-registry.js";
import {
  markTurnFailed,
  clearTurnFailure,
  classifyGenerationFailure,
  FAILURE_CODE,
} from "../lib/turn-failure.js";
import { authMiddleware } from "../middleware/auth.js";
import { decryptApiKey } from "../lib/crypto.js";
import { createProvider } from "../lib/llm/provider-factory.js";
import type { ProviderName } from "../lib/llm/provider-factory.js";
import { clampMaxContextToModel } from "../lib/llm/context-window.js";
import { applyModelRedirect } from "../lib/llm/model-redirects.js";
import {
  allowsTransientFallback,
  getOfficialProviderFallbackModels,
  isFreeRouterFallback,
  turnNeedsVision,
} from "../lib/llm/fallback-models.js";
import { ensureOpenRouterCatalog, registerContextWindows, getCatalogImageSupport } from "../lib/llm/model-catalog.js";
import {
  antiRepetitionInstructionForModel,
  detectDegenerateRepetitionForModel,
} from "../lib/llm/repetition-detector.js";
import { resolveProviderForModel } from "../lib/resolve-provider.js";
import { isForkOrphaned } from "../lib/fork-orphan.js";
import {
  GameStateManager,
  PromptBuilder,
  ResponseParser,
  StructuredResponseParser,
  IncrementalSegmentExtractor,
  ThinkingTagFilter,
  StateReceiptFilter,
  migrateWorldDefinition,
  ReactionEvaluator,
  buildMessageUserEvent,
  buildMessageAIEvent,
  buildTurnCompleteEvent,
  buildSessionStartEvent,
  runReactionChain,
  preserveSetupScopedVariables,
  filterAiEffects,
  filterAiAudioEffects,
  filterResumableAudioEffects,
} from "@yumina/engine";
import type { WorldDefinition, GameEvent, Effect, Variable } from "@yumina/engine";

import type { AppEnv } from "../lib/types.js";
import { captureServerEvent } from "../lib/analytics.js";
import { retrieveLorebookEntries } from "../lib/lorebook-retriever.js";
import { applyPersonaMetadata } from "../lib/persona-metadata.js";
import { loadUserPrompts } from "../lib/user-prompts.js";
import { appendPersonaSystemMessage } from "../lib/persona-prompt.js";
import { resolvePersonaForSession } from "../lib/resolve-persona.js";
import { checkRateLimit, acquireConcurrency, releaseConcurrency } from "../middleware/rate-limit.js";
import { redis } from "../lib/redis.js";
import { checkBalance, validateModelAccess, calculateCost, deductCredits, getModelCostRates, estimateCreditsFromChars, estimateTokensFromChars } from "../lib/credit-service.js";
import { insertHashedTransaction } from "../lib/transaction-hash.js";
import { MidStreamTracker } from "../lib/credit-guard.js";
import { PLANS } from "../lib/plan-config.js";
import { getAllModelPrices } from "../lib/model-price-cache.js";
import { getModelPopularity } from "../lib/model-popularity.js";
import { getModelCostStats } from "../lib/model-cost-stats.js";
import type { ModelCostStats } from "@yumina/shared";
import { DEFAULT_MODEL, MAX_USER_MESSAGE_CHARS, PLAY_MODELS, PLAY_MODEL_IDS, RETIRED_PLAY_MODEL_IDS, resolveStoryMemory, resolveLorebookBudget } from "@yumina/shared";
import { env } from "../lib/env.js";
import {
  compactTurnOverflowIfNeeded,
  estimatePromptMessagesTokens,
  injectMemoryPromptBlocks,
  loadBoundedRawHistory,
  loadTurnMemoryBlocks,
  scheduleTurnMemoryUpdates,
  type TurnPromptMessage,
} from "../lib/turn-memory.js";
import {
  collectExtensionInvalidation,
  runExtensionInvalidation,
} from "../lib/extension-hooks.js";

import { generationBaseline, regenerationState } from "../lib/regeneration-state.js";
import { normalizeGameState, reconcileTurnState } from "../lib/game-state.js";
import { thinSnapshotForStorage, pruneSessionSnapshots } from "../lib/snapshot.js";
import { messageContentUpdate } from "../lib/message-edit.js";
import { viewerSeesWorkingCopy } from "../lib/working-copy.js";
import { resolveSessionVariables } from "../lib/pending-edit.js";
import {
  diffStateVariables,
  resolveCharacterCreationTurn,
} from "../lib/character-creation.js";


/**
 * Story memory for this turn: how much CONVERSATION is sent word for word.
 *
 * Separate from maxContext on purpose. maxContext is the ceiling on the whole
 * request and is what the plan caps; this governs only the trimmable history,
 * so a big world no longer eats the conversation and a small world no longer
 * lets it sprawl. Resolution rules and the migration-safety argument live in
 * packages/shared/src/story-memory.ts.
 */
function turnStoryMemory(args: {
  override: number | undefined;
  maxContext: number;
  accountCreatedAt: Date | null | undefined;
}): { tokens: number; source: "chosen" | "new-account-default" | "carried-over" } {
  const raw = env.STORY_MEMORY_DEFAULT_AT;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return resolveStoryMemory({
    saved: args.override,
    maxContext: args.maxContext,
    accountCreatedAt: args.accountCreatedAt ?? null,
    newAccountsFrom: Number.isFinite(parsed) ? new Date(parsed) : null,
  });
}

const messageRoutes = new Hono<AppEnv>();

messageRoutes.use("/sessions/*", authMiddleware);
messageRoutes.use("/messages/*", authMiddleware);
messageRoutes.use("/models", authMiddleware);
messageRoutes.use("/models/popularity", authMiddleware);

/** Honor the user's explicit model choice. We used to swap any model
 *  not in `model_prices` to a fallback, but that broke BYOK users whose
 *  key supports models we don't sell officially (e.g. moonshotai/kimi-k2.6,
 *  z-ai/glm-4.6). Plan/access gating happens later in resolveProviderForModel
 *  + validateModelAccess — those return clear errors when the user can't
 *  run the chosen model. */
async function resolveModel(requestedModel: string | undefined): Promise<string> {
  // Warm the OpenRouter model catalog (TTL-guarded no-op once loaded) so the
  // context-budget clamp uses live context_length instead of the hardcoded
  // fallback. Fire-and-forget — first request may use the fallback, fine.
  void ensureOpenRouterCatalog();
  const resolvedModel = requestedModel ?? DEFAULT_MODEL;
  const redirected = applyModelRedirect(resolvedModel);
  if (redirected !== resolvedModel) {
    console.log(`[Model] Redirecting deprecated ${resolvedModel} → ${redirected}`);
  }
  return redirected;
}

type SwipeWithUsage = {
  modelFallback?: import("@yumina/shared").ModelFallbackRecord;
  stateValidation?: StateValidationAudit;
  content: string;
  rawContent?: string;
  stateChanges?: Record<string, unknown>;
  stateSnapshot?: Record<string, unknown>;
  generationState?: Record<string, unknown>;
  createdAt: string;
  model?: string;
  tokenCount?: number;
  creditCost?: number;
  creditBalanceAfter?: number;
};

async function persistSwipeCredits(
  messageId: string,
  swipeIndex: number,
  cost: number,
  balanceAfter: number | undefined,
  mode: "set" | "add" = "set",
): Promise<void> {
  const rows = await db
    .select({ swipes: messages.swipes })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  const swipes = (rows[0]?.swipes ?? []) as SwipeWithUsage[];
  if (swipeIndex < 0 || swipeIndex >= swipes.length) return;

  const updated = swipes.map((swipe, index) => {
    if (index !== swipeIndex) return swipe;
    const nextCost =
      mode === "add" ? (Number(swipe.creditCost ?? 0) + cost) : cost;
    return {
      ...swipe,
      creditCost: nextCost,
      ...(balanceAfter !== undefined ? { creditBalanceAfter: balanceAfter } : {}),
    };
  });

  await db
    .update(messages)
    .set({ swipes: updated })
    .where(eq(messages.id, messageId));
}

function creditsPayload(cost: number | undefined, balance: number | undefined) {
  if (cost == null) return undefined;
  return {
    cost,
    ...(balance != null && Number.isFinite(balance)
      ? { balance: Math.floor(balance) }
      : {}),
  };
}

/**
 * Minimum cache breakpoint offset from the end of chat history. The actual
 * offset is adaptive — we compute max(MIN, maxKeywordDepth + 1) so the
 * breakpoint always sits past the deepest keyword-triggered depth entry,
 * keeping the volatile (possibly-firing) entries below the cache boundary.
 *
 * Convention enforced in editor UI: keyword entries default to section=chat-history
 * with depth=4. A creator setting depth>4 pushes the breakpoint deeper automatically.
 */
const MIN_CACHE_DEPTH_OFFSET = 5;

type PromptMessage = TurnPromptMessage;

// Message-change invalidation now lives in the extension hook registry — see
// src/extensions/session-memory/hooks.ts (reason: message-edited/-deleted).

/**
 * Keep the SSE connection warm while we're waiting for the LLM's first token.
 *
 * Cloudflare (and Railway's edge) close idle streaming connections after
 * ~100s — long-context sessions with slow models routinely exceed that
 * window before the model emits anything to flush, and Safari surfaces the
 * dropped fetch as the cryptic `"Load failed"` toast (see chat session
 * 0855489b — last successful call took 64s, every retry after that died
 * silently).
 *
 * Sending a `ping` event every 30s is enough traffic to reset the idle
 * timer at every hop. The event isn't in the client's SSE switch (sse.ts:73),
 * so it's silently dropped — no client-side handling needed.
 *
 * Each caller must invoke the returned stop fn in `finally` to clear the
 * interval; the ping write itself is wrapped in `.catch` so a closed
 * connection doesn't propagate a rejection past the stream handler.
 */
const KEEPALIVE_INTERVAL_MS = 30_000;
function startKeepalive(stream: SSEStreamingApi): () => void {
  const interval = setInterval(() => {
    stream.writeSSE({ event: "ping", data: "{}" }).catch(() => { /* connection already closed */ });
  }, KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(interval);
}

/**
 * Compute the effective cache-depth offset for a world. Scans keyword-triggered
 * chat-history entries for the deepest depth and returns max(MIN, maxDepth + 1).
 * This guarantees every volatile depth entry lands in the uncached tail.
 */
function computeCacheDepthOffset(worldDef: WorldDefinition): number {
  let max = MIN_CACHE_DEPTH_OFFSET - 1;
  for (const entry of worldDef.entries) {
    if (entry.section === "chat-history" && entry.keywords.length > 0) {
      const d = entry.depth ?? 4;
      if (d > max) max = d;
    }
  }
  return max + 1;
}

const reactionEvaluator = new ReactionEvaluator();
const promptBuilder = new PromptBuilder();
const responseParser = new ResponseParser();

/** Check if user is suspended from generation. Uses session user (already loaded by auth middleware). */
function checkSuspended(sessionUser: AppEnv["Variables"]["user"]): boolean {
  return !!sessionUser.isSuspended;
}

// Helper: populate macro context metadata on the state manager
function populateMacroContext(
  stateManager: GameStateManager,
  historyRows: Array<{ role: string; content: string; createdAt: Date | string | null }>,
  model: string
): void {
  let lastMessage: string | undefined;
  let lastUserMessage: string | undefined;
  let lastCharMessage: string | undefined;
  let lastUserMessageAt: string | undefined;

  for (let i = historyRows.length - 1; i >= 0; i--) {
    const row = historyRows[i]!;
    if (!lastMessage) lastMessage = row.content;
    if (!lastUserMessage && row.role === "user") {
      lastUserMessage = row.content;
      if (row.createdAt) {
        lastUserMessageAt = row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : row.createdAt;
      }
    }
    if (!lastCharMessage && row.role === "assistant") {
      lastCharMessage = row.content;
    }
    if (lastMessage && lastUserMessage && lastCharMessage) break;
  }

  if (lastMessage) stateManager.setMetadata("lastMessage", lastMessage);
  if (lastUserMessage) stateManager.setMetadata("lastUserMessage", lastUserMessage);
  if (lastCharMessage) stateManager.setMetadata("lastCharMessage", lastCharMessage);
  if (lastUserMessageAt) stateManager.setMetadata("lastUserMessageAt", lastUserMessageAt);
  stateManager.setMetadata("model", model);
}

function findLatestCharacterCreateBoundary<
  T extends { role: string; content: string }
>(rows: T[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (
      row.role === "assistant" &&
      typeof row.content === "string" &&
      row.content.includes("[CHARACTER_CREATE]")
    ) {
      return i;
    }
  }

  return 0;
}

function limitHistoryToCurrentRun<T extends { role: string; content: string }>(
  rows: T[]
): T[] {
  if (rows.length === 0) return rows;

  const boundaryIndex = findLatestCharacterCreateBoundary(rows);
  return boundaryIndex > 0 ? rows.slice(boundaryIndex) : rows;
}

// Helper: load session with world definition (applies migration)
// Single JOIN query: playSessions → worlds → LEFT JOIN sourceWorld
const sourceWorld = alias(worlds, "source_world");

// In-memory cache for migrated WorldDefinition objects.
//
// Why a cache: world schemas are multi-MB JSONB; re-running
// migrateWorldDefinition() on every chat turn was a measurable source of
// latency before 5ff2ceb1 (perf commit, 2026-03-29).
//
// Why keyed by updatedAt and NOT a wall-clock TTL: the original 5-minute TTL
// (replaced 2026-05-19) served stale schemas for up to 5 minutes after any
// creator edit — deleted/disabled entries kept appearing in the prompt,
// surfacing to creators as "AI 写了我没注入的内容". updatedAt is the
// authoritative version stamp; on every load we re-fetch it cheaply and only
// trust the cache when versions match. Self-healing across processes — no
// per-write-site invalidation needed.
//
// DO NOT reintroduce a TTL fallback: it would mask the same staleness bug.
const WORLD_DEF_CACHE_MAX = 200;
const worldDefCache = new Map<string, { worldDef: WorldDefinition; updatedAt: number }>();

// Separate, viewer-scoped cache for the CREATOR's held working copy of a
// published world. Principle: the author's own edits take effect immediately
// for the author (preview AND play/prompt), while everyone else keeps getting
// the approved live schema until an admin approves. This MUST stay distinct
// from worldDefCache so the author's unapproved pending def never leaks into
// the shared live cache that serves other players. Keyed by the pending row's
// updatedAt — same version-stamp self-healing as the live cache (no TTL).
const pendingDefCache = new Map<string, { worldDef: WorldDefinition; updatedAt: number }>();

function getCachedPendingDef(worldId: string, updatedAt: Date | null): WorldDefinition | null {
  if (!updatedAt) return null;
  const entry = pendingDefCache.get(worldId);
  if (!entry || entry.updatedAt !== updatedAt.getTime()) return null;
  return entry.worldDef;
}

function setCachedPendingDef(worldId: string, updatedAt: Date | null, worldDef: WorldDefinition): void {
  if (!updatedAt) return;
  if (pendingDefCache.size >= WORLD_DEF_CACHE_MAX && !pendingDefCache.has(worldId)) {
    const oldest = pendingDefCache.keys().next().value!;
    pendingDefCache.delete(oldest);
  }
  pendingDefCache.set(worldId, { worldDef, updatedAt: updatedAt.getTime() });
}

// updatedAt is `Date | null` in the schema (defaultNow but not notNull).
// Treat null as "never cache" — forces a re-parse, which is the safe choice.
function getCachedWorldDef(worldId: string, updatedAt: Date | null): WorldDefinition | null {
  if (!updatedAt) return null;
  const entry = worldDefCache.get(worldId);
  if (!entry || entry.updatedAt !== updatedAt.getTime()) return null;
  return entry.worldDef;
}

function setCachedWorldDef(worldId: string, updatedAt: Date | null, worldDef: WorldDefinition): void {
  if (!updatedAt) return;
  if (worldDefCache.size >= WORLD_DEF_CACHE_MAX && !worldDefCache.has(worldId)) {
    const oldest = worldDefCache.keys().next().value!;
    worldDefCache.delete(oldest);
  }
  worldDefCache.set(worldId, { worldDef, updatedAt: updatedAt.getTime() });
}

async function loadSessionContext(sessionId: string, userId: string) {
  // Lightweight query: pull session + world metadata + updatedAt, but NOT the
  // multi-MB schema JSONB. Schema is fetched separately on cache miss only.
  const rows = await db
    .select({
      session: playSessions,
      worldId: worlds.id,
      worldUpdatedAt: worlds.updatedAt,
      worldStatus: worlds.status,
      worldCreatorId: worlds.creatorId,
      worldSourceWorldId: worlds.sourceWorldId,
      worldAllowEdit: worlds.allowEdit,
      worldAllowCustomApi: worlds.allowCustomApi,
      sourceWorldStatus: sourceWorld.status,
      sourceWorldIsPublished: sourceWorld.isPublished,
      sourceWorldPublishedAt: sourceWorld.publishedAt,
      sourceWorldCreatorId: sourceWorld.creatorId,
    })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .leftJoin(sourceWorld, eq(worlds.sourceWorldId, sourceWorld.id))
    .where(
      and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId))
    );

  if (rows.length === 0) return null;

  const row = rows[0]!;
  const sourceWorldTakenDown = isForkOrphaned({
    sourceWorldId: row.worldSourceWorldId,
    sourceStatus: row.sourceWorldStatus,
    sourceIsPublished: row.sourceWorldIsPublished,
    sourcePublishedAt: row.sourceWorldPublishedAt,
    sourceCreatorId: row.sourceWorldCreatorId,
    worldCreatorId: row.worldCreatorId,
  });

  let worldDef = getCachedWorldDef(row.worldId, row.worldUpdatedAt);
  if (!worldDef) {
    // Cache miss (first load, or schema edited since last cache write).
    // Fetch schema and re-parse.
    const schemaRows = await db
      .select({ schema: worlds.schema })
      .from(worlds)
      .where(eq(worlds.id, row.worldId));
    if (schemaRows.length === 0) return null;
    const rawWorldDef = schemaRows[0]!.schema as unknown as WorldDefinition;
    worldDef = migrateWorldDefinition(rawWorldDef);
    setCachedWorldDef(row.worldId, row.worldUpdatedAt, worldDef);
  }

  // Creator-only overlay: when the author plays/prompts their OWN published
  // world while a material edit is held for review, run the prompt off the
  // held working copy so their unapproved entry/rule/frontend edits take effect
  // immediately for them. Players and non-creators never enter this branch and
  // keep getting the approved live worldDef above. Cheap probe (updatedAt only)
  // gates the multi-MB schema fetch + migrate to a pending-cache miss.
  let pendingVersion: string | null = null;
  if (viewerSeesWorkingCopy(row.worldStatus, row.worldCreatorId, userId)) {
    const [pendMeta] = await db
      .select({ updatedAt: worldPendingEdits.updatedAt })
      .from(worldPendingEdits)
      .where(eq(worldPendingEdits.worldId, row.worldId))
      .limit(1);
    if (pendMeta) {
      pendingVersion = pendMeta.updatedAt?.toISOString() ?? null;
      let pendingDef = getCachedPendingDef(row.worldId, pendMeta.updatedAt);
      if (!pendingDef) {
        const [pendFull] = await db
          .select({ schema: worldPendingEdits.schema })
          .from(worldPendingEdits)
          .where(eq(worldPendingEdits.worldId, row.worldId))
          .limit(1);
        if (pendFull?.schema) {
          pendingDef = migrateWorldDefinition(pendFull.schema as unknown as WorldDefinition);
          setCachedPendingDef(row.worldId, pendMeta.updatedAt, pendingDef);
        }
      }
      if (pendingDef) worldDef = pendingDef;
    }
  }

  const gameState = normalizeGameState(worldDef, row.session.state);

  return {
    session: row.session,
    worldDef,
    gameState,
    worldStatus: row.worldStatus,
    worldCreatorId: row.worldCreatorId,
    worldAllowEdit: row.worldAllowEdit,
    worldAllowCustomApi: row.worldAllowCustomApi,
    sourceWorldTakenDown,
    worldVersion: row.worldUpdatedAt?.toISOString() ?? null,
    pendingVersion,
  };
}

/** Page size for message history reads. Requests may lower it, never raise it
 *  past MESSAGES_PAGE_MAX. Unbounded history reads on mega sessions (12k+
 *  rows) froze the event loop — the 2026-08-11 502/524 outage. */
const MESSAGES_PAGE_DEFAULT = 200;
const MESSAGES_PAGE_MAX = 500;

// GET /api/sessions/:sessionId/messages — recent message window for a session.
// Newest MESSAGES_PAGE_DEFAULT rows by default; page older history with
// ?before=<createdAt ISO>&beforeId=<id> (keyset, exclusive). Response stays
// { data: [...] } (ascending) so pre-pagination clients keep working — they
// now receive the recent window instead of the full history.
messageRoutes.get("/sessions/:sessionId/messages", async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const sessionId = c.req.param("sessionId");

  // Verify session ownership
  const sessionRows = await rd
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.id, sessionId),
        eq(playSessions.userId, currentUser.id)
      )
    );

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1
    ? Math.min(Math.floor(limitRaw), MESSAGES_PAGE_MAX)
    : MESSAGES_PAGE_DEFAULT;

  const beforeRaw = c.req.query("before");
  const beforeId = c.req.query("beforeId");
  const before = beforeRaw ? new Date(beforeRaw) : null;
  const cursorCondition = before && !Number.isNaN(before.getTime())
    ? beforeId
      ? or(
          lt(messages.createdAt, before),
          and(eq(messages.createdAt, before), lt(messages.id, beforeId)),
        )
      : lt(messages.createdAt, before)
    : undefined;

  // limit+1 probe row: tells us whether an older page exists without a count.
  const pageDesc = await rd
    .select({
      id: messages.id,
      sessionId: messages.sessionId,
      role: messages.role,
      content: messages.content,
      status: messages.status,
      // Without this the client can render "failed" but never say WHY, and the
      // one-tap recovery (retry vs switch model) is keyed off the code stored
      // in this column. See lib/turn-failure.ts.
      errorMessage: messages.errorMessage,
      stateChanges: messages.stateChanges,
      stateValidation: messages.stateValidation,
      swipes: messages.swipes,
      activeSwipeIndex: messages.activeSwipeIndex,
      model: messages.model,
      tokenCount: messages.tokenCount,
      generationTimeMs: messages.generationTimeMs,
      compacted: messages.compacted,
      stateSnapshot: messages.stateSnapshot,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(cursorCondition ? and(eq(messages.sessionId, sessionId), cursorCondition) : eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const hasMore = pageDesc.length > limit;
  const result = (hasMore ? pageDesc.slice(0, limit) : pageDesc).reverse();

  // A dead process cannot leave a permanent validation spinner on reload.
  for (const message of result) {
    const audit = message.stateValidation;
    if (audit && ["validating", "repairing"].includes(audit.outcome) && Date.now() - Date.parse(audit.startedAt) > 180_000) {
      message.stateValidation = { ...audit, outcome: "stale", diagnostics: [...audit.diagnostics, "interrupted"].slice(-32) };
    }
  }

  return c.json({ data: result, meta: { hasMore } });
});

/**
 * Load the persisted state changes of the newest ASSISTANT message the model
 * will actually see in history — rendered into the format block so the AI
 * knows what already happened last turn (its own directives AND behavior /
 * engine writes, both invisible in stored history: directives are stripped
 * into cleanText before persistence).
 *
 * Fetched by PK instead of widening the history select: state_changes is
 * jsonb, and the history query is deliberately narrow (detoasting jsonb for
 * every row was the heaviest per-turn query — see the perf note there).
 */
async function loadLastTurnChanges(
  history: Array<{ id?: string; role: string }>
): Promise<Array<{ variableId: string; oldValue?: unknown; newValue?: unknown }> | undefined> {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "assistant") continue;
    if (!m.id) return undefined;
    const rows = await db
      .select({ stateChanges: messages.stateChanges })
      .from(messages)
      .where(eq(messages.id, m.id))
      .limit(1);
    const raw = rows[0]?.stateChanges;
    return Array.isArray(raw) && raw.length > 0
      ? (raw as Array<{ variableId: string; oldValue?: unknown; newValue?: unknown }>)
      : undefined;
  }
  return undefined;
}

// POST /api/sessions/:sessionId/messages — send user message + trigger AI generation (SSE)
// POST /api/sessions/:sessionId/messages/stop — explicit stop for an
// in-flight generation. A plain SSE disconnect no longer aborts generation
// (the reply finishes and persists so suspended mobile tabs stop losing
// content), so the client's stop button calls this to actually cancel.
messageRoutes.post("/sessions/:sessionId/messages/stop", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");

  const sessionRows = await db
    .select({ id: playSessions.id })
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .limit(1);
  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const stopped = stopSessionStream(sessionId);
  return c.json({ data: { stopped } });
});

messageRoutes.post("/sessions/:sessionId/messages", bodyLimit({ maxSize: 24 * 1024 * 1024 }), async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{
    content?: string;
    model?: string;
    continue?: boolean;
    /** Mix-mode auto-retry of a send whose first attempt failed mid-generation
     *  (after the user message was persisted). Lets the server reuse that row
     *  instead of inserting a duplicate. */
    mixRetry?: boolean;
    retryMessageId?: string;
    modelFallback?: unknown;
    attachments?: Array<{ type: string; data: string; mimeType: string; name: string }>;
    overrides?: {
      maxTokens?: number;
      maxContext?: number;
      storyMemory?: number;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      repetitionPenalty?: number;
      topK?: number;
      minP?: number;
      reasoningEffort?: string;
      streaming?: boolean;
    };
  }>();

  let inputImages;
  try { inputImages = await validateChatImages(body.attachments); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid images", code: "INVALID_IMAGES" }, 400); }
  const isContinueMode = body.continue === true;
  const rawUserContent = typeof body.content === "string" ? body.content.trim() : "";
  if (!rawUserContent && !inputImages.length && !isContinueMode) {
    return c.json({ error: "Content is required" }, 400);
  }

  if (rawUserContent.length > MAX_USER_MESSAGE_CHARS) {
    return c.json({
      error: `Your message is too long (${rawUserContent.length.toLocaleString()} characters). The maximum is ${MAX_USER_MESSAGE_CHARS.toLocaleString()} characters.`,
      code: "MESSAGE_TOO_LONG",
      maxLength: MAX_USER_MESSAGE_CHARS,
    }, 400);
  }

  const context = await loadSessionContext(sessionId, currentUser.id);
  if (!context) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Block message generation if world is unpublished and user is not creator
  if (context.worldStatus === "unpublished" && context.worldCreatorId !== currentUser.id) {
    return c.json(
      { error: "This world is no longer available. The creator has unpublished it." },
      403
    );
  }

  // A fork goes dark once its source card was pulled after being live (see
  // lib/fork-orphan.ts). A never-published source — a DM-shared draft — does not.
  if (context.sourceWorldTakenDown) {
    return c.json(
      { error: "The original world has been unpublished by its creator. This fork is no longer accessible." },
      403
    );
  }

  const { worldDef, gameState } = context;
  if (worldDef.systems?.includes("kochuu-survival-v1")) {
    const status = new GameStateManager(worldDef, gameState).get("game-status");
    if (status === "dead" || status === "won") return c.json({ error: "本局已结束。可查看记录、回退或重新开局。", code: "GAME_ENDED" }, 409);
    if (!new GameStateManager(worldDef, gameState).get("player-name")) return c.json({ error: "请先完成角色档案。", code: "CHARACTER_REQUIRED" }, 409);
  }
  // Lightweight check: has this session ever had a user message?
  const [hasUserRow] = await db
    .select({ hasUser: sql<boolean>`EXISTS(SELECT 1 FROM messages WHERE session_id = ${sessionId} AND role = 'user')` })
    .from(sql`(SELECT 1) AS _dummy`);
  // A confirmed retry reuses the user row and its already persisted creation seed.
  const shouldIncrementRunCount = typeof body.retryMessageId !== "string" && !!hasUserRow?.hasUser;
  const characterCreation = isContinueMode ? null : resolveCharacterCreationTurn({
    worldDef,
    currentState: gameState,
    rawInput: rawUserContent,
    incrementRunCount: shouldIncrementRunCount,
  });
  const userContent =
    characterCreation?.canonicalUserContent ?? rawUserContent;
  const seedChanges = characterCreation
    ? diffStateVariables(gameState, characterCreation.seededState)
    : [];
  const effectiveGameState =
    characterCreation?.seededState ?? gameState;

  const model = await resolveModel(body.model);
  const [activeUserPrompts] = await Promise.all([
    loadUserPrompts(currentUser.id),
  ]);

  // Protected worlds (allowCustomApi=false) must use official keys to prevent prompt leaking via BYOK
  const isProtectedWorld = context.worldAllowCustomApi === false && context.worldCreatorId !== currentUser.id;
  const resolved = await resolveProviderForModel(currentUser.id, model, { forceOfficial: isProtectedWorld, allowRetiredForAccessCheck: true });
  if (!resolved) {
    if (isProtectedWorld) {
      return c.json({ error: "This world requires an official model. The creator has restricted this world to protect its content.", code: "PROTECTED_WORLD" }, 403);
    }
    return c.json({ error: "No API key configured for this provider. Add one in Settings." }, 400);
  }

  // Official key users get rate limiting, concurrency limits, credit checks, and suspend checks.
  // BYOK users are using their own API key — skip protections.
  if (!resolved.isByok && RETIRED_PLAY_MODEL_IDS.has(model)) {
    return c.json({ error: "This model is unavailable. Please select another model.", code: "MODEL_UNAVAILABLE" }, 403);
  }
  if (inputImages.length) {
    try { await assertImageModel(resolved, model); }
    catch (error) { return c.json({ error: (error as Error).message, code: "IMAGE_MODEL_REQUIRED" }, 400); }
  }
  const useProtections = !resolved.isByok;
  // Read plan from wallet (fresh DB query), NEVER from cached session.
  // The auth session cache can be stale for up to 60s after a plan change.
  const walletCheck = useProtections ? await checkBalance(currentUser.id) : null;
  const userPlan = walletCheck?.wallet.plan ?? "free";
  const planConfig = PLANS[userPlan] ?? PLANS.free;
  const GROK_TRIAL_MODEL = "anthropic/claude-sonnet-4.6";
  let grokTrialBypass = false;
  if (useProtections && model === GROK_TRIAL_MODEL) {
    const [claimed] = await db.update(creditWallets)
      .set({ grokTrialRemaining: sql`GREATEST(grok_trial_remaining - 1, 0)` })
      .where(and(eq(creditWallets.userId, currentUser.id), gt(creditWallets.grokTrialRemaining, 0)))
      .returning();
    if (claimed) grokTrialBypass = true;
  }
  // A Sonnet-trial use was already claimed above (atomic decrement). If anything
  // rejects or fails this request without delivering a reply — a pre-stream gate,
  // the deleted-session insert race, or a mid-stream failure — hand the trial use
  // back. Decrement-then-refund keeps the existing trial-eligibility logic intact
  // (the gates read grokTrialBypass) without introducing an eligibility/consume
  // race. Idempotent per request: done-handler and catch paths can both call it.
  let grokTrialRefunded = false;
  const refundTrialIfClaimed = async () => {
    if (!grokTrialBypass || grokTrialRefunded) return;
    grokTrialRefunded = true;
    try {
      await db.update(creditWallets)
        .set({ grokTrialRemaining: sql`grok_trial_remaining + 1` })
        .where(eq(creditWallets.userId, currentUser.id));
    } catch (err) {
      console.error("[GrokTrial] refund failed:", err instanceof Error ? err.message : err);
    }
  };
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const rawMaxContext = clamp(body.overrides?.maxContext ?? worldDef.settings?.maxContext ?? 200000, 4096, 2000000);
  const userMaxContext = (useProtections && walletCheck?.wallet.memoryCap) ? Math.min(rawMaxContext, walletCheck.wallet.memoryCap) : rawMaxContext;
  // Clamp to the selected model's real context window so a big world + long history
  // never overflows it (e.g. DeepSeek's 163,840 cap → OpenRouter pre-flight 400).
  // Reserves room for the output budget; no-op for unknown/custom models.
  const maxContext = clampMaxContextToModel(
    userMaxContext,
    model,
    clamp(body.overrides?.maxTokens ?? worldDef.settings?.maxTokens ?? 4096, 256, 32768),
    body.overrides?.reasoningEffort,
    await resolved.provider.getContextWindow?.(),
  );
  const storyMemory = turnStoryMemory({
    override: body.overrides?.storyMemory,
    maxContext,
    accountCreatedAt: currentUser?.createdAt,
  });
  if (useProtections) {
    if (checkSuspended(currentUser)) {
      await refundTrialIfClaimed();
      return c.json({ error: "Your account has been temporarily suspended from AI generation. If you believe this is a mistake, please contact support.", code: "SUSPENDED" }, 403);
    }
    if (!walletCheck!.ok && !grokTrialBypass) {
      recordWallHit({ userId: currentUser.id, plan: userPlan, planVersion: walletCheck?.wallet.planVersion, balance: 0, model, endpoint: "send", stage: "preflight" });
      return c.json({ error: "You've used all your credits for this period. Purchase additional credits or upgrade your plan.", code: "NO_CREDITS", balance: 0 }, 402);
    }
    const [modelAccess, rateLimitError] = await Promise.all([
      grokTrialBypass ? Promise.resolve({ allowed: true, reason: "" }) : validateModelAccess(userPlan, model),
      checkRateLimit(currentUser.id, planConfig.rateLimit),
    ]);
    if (!modelAccess.allowed) {
      await refundTrialIfClaimed();
      return c.json({ error: modelAccess.reason, code: "MODEL_NOT_ALLOWED" }, 403);
    }
    if (rateLimitError) {
      await refundTrialIfClaimed();
      c.header("Retry-After", String(rateLimitError.retryAfter));
      return c.json(rateLimitError, 429);
    }
    if (!(await acquireConcurrency(currentUser.id, planConfig.maxConcurrent))) {
      await refundTrialIfClaimed();
      return c.json({ error: "You already have a response being generated. Please wait for it to finish.", code: "CONCURRENT_LIMIT", retryAfter: 5 }, 429);
    }
  }

  // Roll back only this request's new row if historical images reject the model.
  // A retry may reuse an older row, which must remain intact.
  let insertedUserMessageId: string | null = null;
  // Ensure concurrency slot is released if any pre-stream setup throws unexpectedly
  try {

  const attachmentMeta = inputImages.length ? await storeChatImages(currentUser.id, inputImages) : undefined;

  // Save user message (skip in continue mode — no new user message)
  let userMsg: { id: string } | null = null;
  if (!isContinueMode) {
    // Mix-mode auto-retry re-POSTs the same send after a mid-generation error,
    // but attempt #1 already persisted the user row (the insert runs before the
    // stream). When the client marks the request as a retry, reuse the dangling
    // row instead of inserting a duplicate. Guarded strictly: the session's
    // latest message must be a fresh user row with identical content.
    if (body.mixRetry === true || typeof body.retryMessageId === "string") {
      const [latest] = await db
        .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (
        typeof body.retryMessageId === "string"
          ? canReuseFallbackMessage(latest, body.retryMessageId, userContent)
          : (
        latest?.role === "user" &&
        latest.content === userContent &&
        latest.createdAt != null &&
        Date.now() - latest.createdAt.getTime() < 2 * 60 * 1000)
      ) {
        userMsg = { id: latest!.id };
      }
    }
    if (typeof body.retryMessageId === "string" && !userMsg) {
      if (useProtections) await releaseConcurrency(currentUser.id);
      await refundTrialIfClaimed();
      return c.json({ error: "This turn has changed. Refresh the conversation before retrying.", code: "TURN_CHANGED" }, 409);
    }
    if (!userMsg) {
      try {
        const userMsgResult = await db
          .insert(messages)
          .values({
            sessionId,
            role: "user",
            content: userContent,
            ...(attachmentMeta && { attachments: attachmentMeta }),
          })
          .returning();
        userMsg = userMsgResult[0]!;
        insertedUserMessageId = userMsg.id;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("violates foreign key constraint")) {
          // Session was deleted/forked between load and insert. This is an early
          // return (not a throw), so the outer catch/finally that release the
          // concurrency slot never run — release it here or the user is locked
          // out of generation until the 90s safety TTL expires.
          if (useProtections) await releaseConcurrency(currentUser.id);
          await refundTrialIfClaimed();
          return c.json({ error: "Session no longer exists" }, 404);
        }
        throw e;
      }
    }
  }

  const turnMemory = await loadTurnMemoryBlocks({
    ownerUserId: context.session.userId,
    sessionId,
    session: context.session,
    suppressSummaryBlocks: Boolean(characterCreation),
  });
  const outputContract = guardPrompt(turnMemory.dispatch);
  // No awaited compaction anywhere on this path: the post-turn background job
  // owns threshold compaction (a one-turn summary lag by design), and the
  // final-budget overflow pass below only SCHEDULES background compaction —
  // this turn trims, the repaired summary lands next turn.

  // Build prompt
  const stateManager = new GameStateManager(worldDef, effectiveGameState);
  stateManager.incrementTurn();

  // Load non-compacted message history for AI prompt (compacted ones excluded).
  // Bounded window (newest RAW_HISTORY_MAX_ROWS) — the clamp keeps only the
  // recent tail that fits maxContext anyway; loading the full backlog froze
  // the event loop on mega sessions (2026-08-11 outage).
  const historyRows = await loadBoundedRawHistory(sessionId, turnMemory);
  const currentRunHistory = limitHistoryToCurrentRun(historyRows);

  // Populate macro context (lastMessage, lastUserMessage, etc.)
  populateMacroContext(stateManager, currentRunHistory, model);

  // Inject the resolved persona into macro context (fallback to Yumina display name so {{user}} is never blank).
  // Unlocked sessions follow the current account persona; locked sessions keep their selection.
  // Centralized in applyPersonaMetadata so the branching rule matches every other endpoint
  // exactly — previous bugs came from different subsets of fields being set at different sites.
  const activePersona = await resolvePersonaForSession(context.session);
  applyPersonaMetadata(stateManager, activePersona, {
    username: currentUser.username,
    displayUsername: currentUser.displayUsername,
    name: currentUser.name,
    image: currentUser.image,
  });

  const snapshot = stateManager.getSnapshot();

  // Deterministic entry retrieval (engine-level matching)
  const scanDepth = worldDef.settings?.lorebookScanDepth ?? 2;
  const budgetPercent = worldDef.settings?.lorebookBudgetPercent ?? 100;
  const budgetCap = worldDef.settings?.lorebookBudgetCap ?? 0;
  // Story memory is a reservation, not a leftover: the world trims to leave
  // the conversation its room, rather than the conversation losing turns to
  // a large world. Which entries MATCH is untouched; this only sets how many
  // of the matched ones survive (packages/shared/src/lorebook-budget.ts).
  const tokenBudget = resolveLorebookBudget({
    maxContext,
    outputReserve: outputContract.reserve,
    storyMemory: storyMemory.tokens,
    storyMemorySource: storyMemory.source,
    budgetPercent,
    budgetCap,
    reserveStoryMemory: env.LOREBOOK_RESERVES_STORY_MEMORY,
  });
  const recentTexts = currentRunHistory.slice(-scanDepth).map((m) => m.content);
  const lorebookResult = retrieveLorebookEntries({
    entries: worldDef.entries,
    recentMessages: recentTexts,
    state: snapshot,
    tokenBudget,
    settings: { lorebookRecursionDepth: worldDef.settings?.lorebookRecursionDepth },
    modelId: model,
    loreUiBindings: worldDef.loreUiBindings,
    worldbooks: worldDef.worldbooks,
  });
  const matchedEntries = [...lorebookResult.alwaysSend, ...lorebookResult.triggered];

  // Build context-aware message list — optimized for prompt caching.
  // Static content (alwaysSend entries) forms a stable prefix → cacheable.
  // Dynamic content (keyword entries, variables, post-history) goes at the end → recency attention.
  const contextMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  // 1. System messages — only alwaysSend entries (stable prefix for caching)
  const systemMessages = promptBuilder.buildSystemMessages(worldDef, snapshot, undefined, activeUserPrompts, snapshot.ruleState?.activeDirectives ?? [], snapshot.ruleState?.toggledEntries ?? {});
  contextMessages.push(...systemMessages);

  // 1.5. Auto-inject active persona description into prompt
  appendPersonaSystemMessage(contextMessages, activePersona);

  // 2. Static format reference — behavior rules, directive syntax, audio (cacheable, per-world constant)
  const staticFormatBlock = promptBuilder.buildStaticFormatBlock(worldDef);
  if (staticFormatBlock) {
    contextMessages.push({ role: "system", content: staticFormatBlock });
  }

  // 3. Example dialogue (parsed into user/assistant pairs with [Example Chat] markers)
  const exampleMessages = promptBuilder.buildExampleMessages(worldDef, snapshot, undefined, activeUserPrompts, snapshot.ruleState?.toggledEntries ?? {});
  if (exampleMessages.length > 0) {
    contextMessages.push(...exampleMessages);
  }

  // Mark the stable prefix boundary for caching — everything above is alwaysSend + persona + static + examples,
  // all of which are invariant across turns. Keyword-triggered system entries go AFTER this boundary so they
  // don't invalidate the cache prefix when different keywords fire on different turns.
  const stablePrefixEnd = contextMessages.length - 1;

  // 3.2. Triggered system-block entries (keyword-matched, section !== chat-history/post-history).
  // Previously dropped because buildSystemMessages was called with matchedEntries=undefined.
  const triggeredSystemMessages = promptBuilder.buildTriggeredSystemMessages(worldDef, snapshot, lorebookResult.triggered, snapshot.ruleState?.toggledEntries ?? {});
  if (triggeredSystemMessages.length > 0) {
    contextMessages.push(...triggeredSystemMessages);
  }

  // 3.3. [Start a new Chat] marker before real history
  if (currentRunHistory.length > 0) {
    contextMessages.push({ role: "system", content: "[Start a new Chat]" });
  }

  // 3.5 Inject memory blocks (story summary / summaryception / session memory)
  const memoryIndices = injectMemoryPromptBlocks(contextMessages, turnMemory);

  // 4. Actual message history (with depth entries injected)
  const depthEntries = promptBuilder.buildDepthEntries(worldDef, snapshot, matchedEntries, activeUserPrompts, snapshot.ruleState?.toggledEntries ?? {});
  const historyMessages: PromptMessage[] = currentRunHistory.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
    sourceMessageId: m.id,
    imageTokens: m.imageTokens,
  }));

  for (const de of depthEntries) {
    const insertIdx = Math.max(0, historyMessages.length - de.depth);
    historyMessages.splice(insertIdx, 0, {
      role: de.apiRole,
      content: de.content,
    });
  }

  let historyStart = contextMessages.length;
  contextMessages.push(...historyMessages);

  // 7. Triggered lorebook entries now flow through buildDepthEntries (injected at depth 0 by default).
  // No separate lorebook message block needed — they're already in the history above.

  // 7.5. Inject pending context from previous turn's @ai.context / @prompt.context effects
  const pendingContext = (snapshot.metadata?.pendingContext as Array<{ message: string; role: string }>) ?? [];
  if (pendingContext.length > 0) {
    for (const ctx of pendingContext) {
      contextMessages.push({
        role: (ctx.role as "system" | "user") ?? "system",
        content: ctx.message,
      });
    }
    // Clear pending context so it's only injected once
    stateManager.setMetadata("pendingContext", undefined);
  }

  // 8. Format instructions + variable summary (only if world has variables or audio)
  const lastTurnChanges = await loadLastTurnChanges(currentRunHistory);
  const formatBlock = promptBuilder.buildFormatBlock(worldDef, snapshot, lastTurnChanges);
  if (formatBlock) {
    contextMessages.push({ role: "system", content: formatBlock });
  }

  // 9. Post-history entries (jailbreak / post-history instructions — after all chat)
  const postHistoryEntries = promptBuilder.buildPostHistoryEntries(worldDef, snapshot, matchedEntries, activeUserPrompts);
  for (const entry of postHistoryEntries) {
    contextMessages.push({ role: entry.apiRole, content: entry.content });
  }

  const antiRepetitionInstruction = antiRepetitionInstructionForModel(model);
  if (antiRepetitionInstruction) {
    contextMessages.push({ role: "system", content: antiRepetitionInstruction });
  }

  // Trim only chat history (middle), preserving system prefix + post-history suffix
  const suffixCount = postHistoryEntries.length + (formatBlock ? 1 : 0) + (antiRepetitionInstruction ? 1 : 0);
  // Depth entries and pending context live INSIDE the trim window but are not
  // conversation. Story memory is a budget for what the player said and the
  // AI replied; a world that injects a lot of keyword-triggered lore must not
  // silently shrink it. Measured once and added to the allowance, so the
  // effective cap on real history stays exactly storyMemory.
  const nonRawHistoryMessages = [
    ...depthEntries.map((entry) => ({ role: entry.apiRole, content: entry.content })),
    ...pendingContext.map((ctx) => ({
      role: (ctx.role as "system" | "user") ?? "system",
      content: ctx.message,
    })),
  ];
  const historyWindowBudget = storyMemory.tokens + estimatePromptMessagesTokens(nonRawHistoryMessages, model);

  historyStart = await compactTurnOverflowIfNeeded({
    pathLabel: "send",
    turn: turnMemory,
    userId: currentUser.id,
    model,
    maxContext,
    storyMemory: storyMemory.tokens,
    contextMessages,
    historyStart,
    suffixCount,
    nonRawHistoryMessages,
    indices: memoryIndices,
  });
  const chatMessages = await promptBuilder.buildMessageHistoryAsync(
    contextMessages,
    yieldForIO,
    maxContext - outputContract.reserve,
    historyStart,
    suffixCount,
    model,
    historyWindowBudget,
  );

  if (outputContract.content) chatMessages.push({ role: "system", content: outputContract.content });
  // Cache breakpoint: offset messages back from the end of chat history. Offset is adaptive
  // (max of MIN_CACHE_DEPTH_OFFSET and deepest keyword-triggered depth + 1) so every
  // volatile depth entry lands in the uncached tail.
  const cacheDepthOffset = computeCacheDepthOffset(worldDef);
  const cacheBreakpointIndex = chatMessages.length - 1 - suffixCount - (outputContract.content ? 1 : 0) - cacheDepthOffset;

  // Two-breakpoint caching: (1) end of stable prefix (cheap insurance if triggered system
  // entries ever fire — always-send content stays cached), (2) depth-resilient floor.
  const breakpoints = Array.from(new Set([stablePrefixEnd, cacheBreakpointIndex].filter((i) => i >= 0))).sort((a, b) => a - b);

  const providerMessages = await restoreChatImages(sessionId, chatMessages);
  if (turnNeedsVision(providerMessages)) await assertImageModel(resolved, model);

  // Commit turn side effects only after image capability validation succeeds.
  if (insertedUserMessageId) bumpWorldMessageCount(context.session.worldId);
  if (characterCreation) {
    // Extensions reset their derived per-session state (summaries, memory);
    // the returned fields merge into this one atomic update with the state.
    const invalidation = collectExtensionInvalidation({ reason: "character-creation", sessionId });
    await db
      .update(playSessions)
      .set({
        state: effectiveGameState as unknown as Record<string, unknown>,
        ...invalidation.sessionFields,
        updatedAt: new Date(),
      })
      .where(eq(playSessions.id, sessionId));
    await invalidation.runAfter();
  }

  // Stream response
  const provider = resolved.provider;
  const startTime = Date.now();
  const abortController = new AbortController();
  // Registered for the SIGTERM drain — deploys wait for this generation (up
  // to ~50s) instead of killing it mid-stream. See lib/stream-registry.ts.
  // Session-keyed so POST /sessions/:sessionId/messages/stop can abort it.
  const unregisterStream = registerStream(abortController, sessionId);
  const outputAttempt = new TurnOutputAttempt({ dispatch: turnMemory.dispatch, userId: currentUser.id, sessionId: sessionId, targetId: userMsg?.id ?? historyRows.at(-1)?.id ?? "", path: "send", world: worldDef, baseline: effectiveGameState, model, apiKeyTier: resolved.apiKeyTier, startedAt: startTime, worldVersion: context.worldVersion, pendingVersion: context.pendingVersion, signal: abortController.signal, worldId: context.session.worldId, checkPending: viewerSeesWorkingCopy(context.worldStatus, context.worldCreatorId, currentUser.id) });

  // Signal to reverse proxies that this is a long-lived LLM stream
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    // A dropped SSE connection (mobile tab suspend, flaky network) does NOT
    // abort generation: the turn finishes and persists server-side, and the
    // client's connection-loss recovery poll finds it. Explicit stops go
    // through the stop endpoint (stream-registry), which aborts with
    // USER_STOP_ABORT_REASON. (2026-08-06 "互动内容丢失" fix.)
    let clientGone = false;
    stream.onAbort(() => { clientGone = true; });
    // After a disconnect every write would reject and bounce the handler into
    // the catch block — which must stay reserved for real generation failures,
    // or the finished reply never persists. Funnel all writes through here.
    const sse = async (message: Parameters<SSEStreamingApi["writeSSE"]>[0]): Promise<void> => {
      if (clientGone) return;
      try {
        await stream.writeSSE(message);
      } catch {
        clientGone = true;
      }
    };

    let fullContent = "";
    let chunkCount = 0;
    // Guards the trial refund in the catch below: once the assistant reply is
    // persisted the user got their turn, so a later failure must not refund.
    let replyPersisted = false;
    const structuredParser = new StructuredResponseParser();
    const segmentExtractor = new IncrementalSegmentExtractor();
    const thinkingFilter = new ThinkingTagFilter();
    const receiptFilter = new StateReceiptFilter();

    // Mid-stream credit tracking: estimate cost as tokens stream in,
    // abort if balance is exceeded. Zero DB queries during streaming.
    const creditStartBalance = walletCheck?.balance ?? Infinity;
    const isUnlimitedPlan = planConfig.unlimited;
    // Count prompt characters for cost estimation (actual chars, NOT estimated tokens)
    const promptChars = imagePromptChars(providerMessages);
    const costRates = (!isUnlimitedPlan && useProtections)
      ? await getModelCostRates(model, estimateTokensFromChars(promptChars))
      : null;
    let streamedOutputChars = 0;

    const stopKeepalive = startKeepalive(stream);
    let actualModel = model;
    // OpenRouter generation id seen on streamed chunks — lets an explicit stop
    // be settled against the provider's billed cost (lib/stopped-generation.ts).
    let observedProviderRequestId: string | undefined;
    let pendingFallbackError: ReturnType<typeof modelFallbackError> = null;
    let correctionModel = model;
    // Set when Yumina Free's pool was exhausted upstream and the provider
    // re-ran this turn on the paid fallback. It keeps the turn billed at
    // Free's zero rate — see FREE_ROUTER_FALLBACK_MODEL.
    let freeRouterFallbackServed = false;

    try {
      // Pre-flight affordability gate. A low-but-nonzero balance (e.g. 2 mushies)
      // clears the earlier walletCheck.ok gate but can't cover a long prompt, so
      // the mid-stream guard below would abort on the very first chunk into a
      // blank reply. Catch it here BEFORE spending an LLM call and surface the
      // translated "out of mushies" message + credits popup (code NO_CREDITS).
      // Uses prompt-only cost, so it rejects exactly the turns the mid-stream
      // guard already would — no new users affected, just handled cleanly.
      // (Low-balance / empty-reply investigation 2026-05-31.)
      if (costRates && !isUnlimitedPlan && useProtections && !grokTrialBypass) {
        const promptOnlyCost = estimateCreditsFromChars(costRates, promptChars, 0);
        if (promptOnlyCost >= creditStartBalance) {
          recordWallHit({ userId: currentUser.id, plan: userPlan, planVersion: walletCheck?.wallet.planVersion, balance: creditStartBalance, model, endpoint: "send", stage: "prompt_too_long" });
          await sse({
            event: "error",
            data: JSON.stringify({
              error: "Not enough mushies for this message — the conversation is too long for your remaining balance.",
              code: "NO_CREDITS",
              balance: creditStartBalance,
            }),
          });
          return;
        }
      }

      await outputAttempt.begin();
      if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });
      for await (const chunk of provider.generateStream({
        conversationId: `play:${sessionId}`,
        model,
        messages: providerMessages,
        maxTokens: clamp(body.overrides?.maxTokens ?? worldDef.settings?.maxTokens ?? 4096, 256, 32768),
        temperature: clamp(body.overrides?.temperature ?? worldDef.settings?.temperature ?? 1.0, 0, 2),
        topP: body.overrides?.topP ?? worldDef.settings?.topP,
        frequencyPenalty: body.overrides?.frequencyPenalty ?? worldDef.settings?.frequencyPenalty,
        presencePenalty: body.overrides?.presencePenalty ?? worldDef.settings?.presencePenalty,
        repetitionPenalty: antiRepetitionInstruction
          ? body.overrides?.repetitionPenalty
          : undefined,
        topK: body.overrides?.topK ?? worldDef.settings?.topK,
        minP: body.overrides?.minP ?? worldDef.settings?.minP,
        reasoningEffort: body.overrides?.reasoningEffort,
        // When the user disables streaming in settings, body.overrides.streaming === false.
        // Undefined/true falls through to the provider's default streaming path.
        stream: body.overrides?.streaming,
        ...(worldDef.settings?.structuredOutput && { responseFormat: { type: "json_object" as const } }),
        ...(breakpoints.length > 0 && { cacheBreakpoints: breakpoints }),
        // The Kimi-only prompt and output gate must never ride along when an
        // OpenRouter policy fallback switches the request to another family.
        fallbackModels: antiRepetitionInstruction
          ? undefined
          : getOfficialProviderFallbackModels(
              model,
              resolved.isByok,
              turnNeedsVision(providerMessages),
            ),
        fallbackOnTransientErrors: allowsTransientFallback(model, resolved.isByok),
        signal: abortController.signal,
      })) {
        chunkCount++;
        if (chunk.model) {
          correctionModel = chunk.model;
          if (isFreeRouterFallback(model, chunk.model)) {
            // Deliberately do NOT promote chunk.model here: leaving actualModel
            // as openrouter/free is what keeps the turn free (0/0 pricing) and
            // labelled "Yumina Free" in the UI, so the player never sees — or
            // pays for — the downgrade.
            if (!freeRouterFallbackServed) {
              freeRouterFallbackServed = true;
              captureServerEvent(currentUser.id, "free_pool_fallback", {
                requested_model: model,
                served_model: chunk.model,
              });
            }
          } else {
            actualModel = chunk.model;
          }
        }

        if (chunk.type === "reasoning") {
          await sse({
            event: "reasoning",
            data: JSON.stringify({ content: chunk.content }),
          });
        }

        if (chunk.type === "text") {
          if (chunk.providerRequestId) observedProviderRequestId = chunk.providerRequestId;
          fullContent += chunk.content;
          streamedOutputChars += chunk.content.length;

          // Mid-stream credit check: stop if estimated cost exceeds balance.
          // Trial turns are exempt (same as the pre-flight gate): the trial pays
          // for this turn, so a 0-mushie balance must not abort it mid-reply.
          if (costRates && !isUnlimitedPlan && !grokTrialBypass && streamedOutputChars % 500 < chunk.content.length) {
            const estCost = estimateCreditsFromChars(costRates, promptChars, streamedOutputChars);
            if (estCost >= creditStartBalance) {
              // Ran dry mid-reply. End cleanly with a credits error (code
              // NO_CREDITS → "out of mushies" toast + popup) instead of the old
              // `break`, which fell out of the loop WITHOUT reaching the catch
              // handler — so it never recorded usage and surfaced to the client
              // as a silent "connection lost". Don't charge for an unusable
              // partial (consistent with the empty-reply no-charge policy); log
              // usage for visibility only.
              abortController.abort();
              await recordUsageLog({
              ...usageObservation(undefined),
              analyticsWorldId: context.session.worldId,
                id: crypto.randomUUID(), userId: currentUser.id, sessionId, model,
                promptTokens: estimateTokensFromChars(promptChars),
                completionTokens: estimateTokensFromChars(streamedOutputChars),
                totalTokens: estimateTokensFromChars(promptChars) + estimateTokensFromChars(streamedOutputChars),
                endpoint: "send_empty", apiKeyTier: resolved.apiKeyTier, generationTimeMs: Date.now() - startTime,
              });
              recordWallHit({ userId: currentUser.id, plan: userPlan, planVersion: walletCheck?.wallet.planVersion, balance: 0, model: actualModel, endpoint: "send", stage: "mid_stream" });
              await sse({
                event: "error",
                data: JSON.stringify({
                  error: "You ran out of mushies partway through this reply. Top up or check in for more.",
                  code: "NO_CREDITS",
                  balance: 0,
                }),
              });
              return;
            }
          }

          // Filter out leaked thinking blocks (e.g. Gemini Flash Lite <fiction-mode> reasoning)
          const filtered = receiptFilter.push(thinkingFilter.push(chunk.content));
          if (filtered) {
            await sse({
              event: "text",
              data: JSON.stringify({ content: filtered }),
            });
          }

          // Emit segment/bg events during streaming
          const extraction = segmentExtractor.extract(fullContent);
          for (const segment of extraction.newSegments) {
            await sse({
              event: "segment",
              data: JSON.stringify({ segment }),
            });
          }
          if (extraction.bg) {
            await sse({
              event: "bg",
              data: JSON.stringify({ bg: extraction.bg }),
            });
          }
        }

        if (chunk.type === "error") {
          const fallbackError = modelFallbackError(chunk, model, fullContent, resolved.isByok, userMsg?.id);
          if (fallbackError) {
            await markTurnFailed(userMsg?.id, fallbackError.error, FAILURE_CODE.MODEL_FALLBACK_REQUIRED);
            await refundTrialIfClaimed();
            pendingFallbackError = fallbackError;
            return;
          }
          console.warn(`[Messages] Stream error after ${chunkCount} chunks (${fullContent.length} chars): ${chunk.content}`);
          captureServerEvent(currentUser.id, "llm_error", {
            model,
            endpoint: "send",
            error_message: chunk.content,
            chunks_before_error: chunkCount,
            chars_before_error: fullContent.length,
            generation_time_ms: Date.now() - startTime,
            session_id: sessionId,
          });
          // Record the failure on the user row. Before this, a failed turn left
          // zero trace in the DB: the player saw silence and we could only find
          // failures by hunting for orphaned user messages. See lib/turn-failure.ts.
          const failure = classifyGenerationFailure(chunk.content);
          await markTurnFailed(userMsg?.id, failure.message, failure.code);
          await sse({
            event: "error",
            data: JSON.stringify({
              error: failure.message,
              code: failure.code ?? undefined,
              userMessageId: userMsg?.id ?? null,
            }),
          });
          return;
        }

        if (chunk.type === "done") {
          if (replyPersisted) break;
          // Only an EXPLICIT user stop aborts the controller now (disconnects
          // just set clientGone and generation keeps going) — so reaching done
          // with an aborted signal means the user hit stop right as the reply
          // finished. Honor the stop: discard the turn, keep retry available.
          if (isClientAbort(abortController.signal)) {
            console.log("[Messages] Stream completed after user stop; skipping persistence");
            void settleStoppedGeneration({
              userId: currentUser.id, sessionId: sessionId, worldId: context.session.worldId, endpoint: "send",
              model: actualModel, apiKeyTier: resolved.apiKeyTier,
              providerRequestId: chunk.usage?.providerRequestId ?? observedProviderRequestId,
              promptChars: promptChars, outputChars: streamedOutputChars, generationTimeMs: Date.now() - startTime,
              chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
              knownUsage: chunk.usage,
            });
            await markTurnFailed(
              userMsg?.id,
              "Generation was stopped. Tap retry to generate it again.",
              FAILURE_CODE.INTERRUPTED,
            );
            return;
          }

          console.log(`[Messages] Stream done: ${chunkCount} chunks, ${fullContent.length} chars, model=${model}`);
          const generationTimeMs = Date.now() - startTime;

          // Parse response — use structured parser for JSON responses, regex for others
          const legacyParsed = structuredParser.isStructuredResponse(fullContent)
            ? structuredParser.parse(fullContent)
            : responseParser.parse(fullContent);
          const { parsed: parseResult } = await outputAttempt.validate({
            world: worldDef, state: stateManager.getSnapshot(), raw: fullContent, parsed: legacyParsed,
            provider: provider, model: correctionModel, maxContext: maxContext, signal: abortController.signal,
            stopReason: chunk.stopReason, history: providerMessages,
            cacheEnabled: breakpoints.length > 0, stream: body.overrides?.streaming,
          }, async (audit) => { await sse({ event: "state-validation", data: JSON.stringify(audit) }); });
          let cleanText = parseResult.cleanText;
          const effects = parseResult.effects;
          const choices: string[] = [];
          const parserAudioEffects = filterAiAudioEffects(worldDef.audioTracks ?? [], parseResult.audioEffects);

          // Fallback: if no effects but content looks like it has segments, use incremental extractor
          if (!outputAttempt.enabled && effects.length === 0 && fullContent.includes('"segments"')) {
            console.warn("[Messages] No effects from parser — attempting fallback segment extraction");
            const fallbackExtractor = new IncrementalSegmentExtractor();
            const stripped = fullContent.replace(/^```(?:json|JSON)?\s*\n?/, "").replace(/\n?\s*```\s*$/, "");
            const result = fallbackExtractor.extract(stripped);
            if (result.newSegments.length > 0) {
              effects.push({ variableId: "segments", operation: "set" as const, value: result.newSegments as Effect["value"] });
              console.warn(`[Messages] Fallback extracted ${result.newSegments.length} segments`);
            }
            if (result.bg) {
              effects.push({ variableId: "currentBg", operation: "set", value: result.bg });
            }
            // Try to extract narrative from truncated content
            const narrativeMatch = stripped.match(/"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
            if (narrativeMatch) {
              try { cleanText = JSON.parse('"' + narrativeMatch[1] + '"'); } catch { /* keep raw */ }
            }
          }

          // Whether anything reached the user. Used below to (a) tag the usage_log
          // so we can monitor empty-response rates per model, and (b) skip credit
          // deduction — see the comment on the deduction `if` for the rationale.
          const hasVisibleContent = fullContent.trim().length > 0;

          // AI directives may only touch AI-writable variables (aiAccess
          // "write" + currently active). Behavior/UI writes use other paths.
          const aiWriteFilter = filterAiEffects(worldDef, stateManager.getSnapshot(), effects);
          if (aiWriteFilter.dropped.length > 0) {
            console.log(`[Messages] Dropped ${aiWriteFilter.dropped.length} AI directive(s) to non-AI-writable vars: ${aiWriteFilter.dropped.map((e) => e.variableId).join(", ")}`);
          }
          const changes = stateManager.applyEffects(aiWriteFilter.kept);
          // A refused write is a model fumbling JSON syntax over a whole list
          // (`[items: set delete 1, delete 0]`). The engine keeps the old value;
          // say so, because the failure is otherwise invisible until a player
          // notices their inventory is gone.
          const rejectedWrites = stateManager.drainRejectedWrites();
          if (rejectedWrites.length > 0) {
            console.log(`[Messages] Refused ${rejectedWrites.length} malformed JSON write(s): ${rejectedWrites.map((w) => w.variableId).join(", ")}`);
          }

          // Evaluate reactions via event-based dispatch
          // Emit all relevant events for this turn, evaluate reactions for each
          const turnEvents: GameEvent[] = [
            buildMessageUserEvent(userContent),
            buildMessageAIEvent(cleanText),
            buildTurnCompleteEvent(stateManager.getSnapshot().turnCount),
          ];
          // session:start fires once per session, on the first turn. incrementTurn()
          // was called above before any reaction evaluation, so turnCount === 1 means
          // this is the user's very first message in the session.
          if (stateManager.getSnapshot().turnCount === 1) {
            turnEvents.push(buildSessionStartEvent());
          }
          // Add state:changed events for each variable that changed from AI effects
          for (const change of changes) {
            turnEvents.push({ type: "state:changed", variableId: change.variableId, oldValue: change.oldValue, newValue: change.newValue });
          }

          // Evaluate reactions, then follow chains: emitted events + state:changed
          // cascades feed back into the evaluator (bounded; each reaction fires once).
          const systemResult = runReactionChain(
            reactionEvaluator,
            stateManager,
            turnEvents,
            worldDef.reactions ?? [],
            worldDef.rules ?? [],
          );
          const ruleChanges = systemResult.changes;
          const allChanges = [...seedChanges, ...changes, ...ruleChanges];
          outputAttempt.recordChanges(changes, ruleChanges);

          // Collect all audio effects (from parser + from @ system effects)
          const allAudioEffects = [...parserAudioEffects, ...systemResult.audioEffects];
          // The whole list still streams to the client — the SFX should fire on
          // THIS turn. Only the looping subset is persisted: `activeAudio` is
          // the resume snapshot, and a one-shot SFX left in it replays on every
          // later session load. A turn whose audio was all one-shot leaves the
          // previous snapshot alone, so BGM stays sticky across quiet turns.
          const resumableAudio = filterResumableAudioEffects(worldDef.audioTracks ?? [], allAudioEffects);
          if (resumableAudio.length > 0) {
            stateManager.setMetadata("activeAudio", resumableAudio);
          }

          // Store pending context messages for next turn (from @ai.context / @prompt.context)
          if (systemResult.contextMessages.length > 0) {
            stateManager.setMetadata("pendingContext", systemResult.contextMessages);
          }

          const finalState = stateManager.getSnapshot();

          // ── Empty-reply guard ────────────────────────────────────────────
          // Some models (esp. DeepSeek reasoners) finish "successfully" but
          // produce no visible text — the provider already retried once. If
          // there's STILL nothing to show AND no state/audio side-effects,
          // don't persist a blank "旁白" bubble: log it for metrics, skip the
          // charge, and tell the client to surface a retry. State-bearing turns
          // (e.g. a stat-only update) are kept — a custom UI renders those even
          // with empty text. See empty-reply investigation 2026-05-31.
          const isTrulyEmpty =
            cleanText.trim().length === 0 &&
            allChanges.length === 0 &&
            allAudioEffects.length === 0 &&
            choices.length === 0;
          if (isTrulyEmpty) {
            await recordUsageLog({
              ...usageObservation(chunk.usage),
              analyticsWorldId: context.session.worldId,
              id: crypto.randomUUID(),
              userId: currentUser.id,
              sessionId,
              model,
              promptTokens: chunk.usage?.promptTokens ?? 0,
              completionTokens: chunk.usage?.completionTokens ?? 0,
              totalTokens: chunk.usage?.totalTokens ?? 0,
              endpoint: "send_empty",
              apiKeyTier: resolved.apiKeyTier,
              generationTimeMs,
            });
            await markTurnFailed(
              userMsg?.id,
              "The model returned an empty reply. Tap retry to generate it again.",
              null,
            );
            await sse({
              event: "error",
              data: JSON.stringify({
                error: "The model returned an empty reply. Please tap regenerate or send again.",
                code: "EMPTY_REPLY",
                userMessageId: userMsg?.id ?? null,
              }),
            });
            return;
          }

          const repetition = antiRepetitionInstruction
            ? detectDegenerateRepetitionForModel(
                model,
                cleanText,
                currentRunHistory
                  .filter((message) => message.role === "assistant")
                  .slice(-3)
                  .map((message) => message.content),
              )
            : null;
          if (repetition) {
            console.warn(
              `[Messages] Rejected repetitive ${model} output (${repetition.reason}, ${repetition.occurrences}x, ${cleanText.length} chars)`,
            );
            captureServerEvent(currentUser.id, "llm_repetitive_output", {
              model,
              endpoint: "send",
              reason: repetition.reason,
              occurrences: repetition.occurrences,
              chars: cleanText.length,
              session_id: sessionId,
            });
            await recordUsageLog({
              ...usageObservation(chunk.usage),
              analyticsWorldId: context.session.worldId,
              id: crypto.randomUUID(),
              userId: currentUser.id,
              sessionId,
              model: actualModel,
              promptTokens: chunk.usage?.promptTokens ?? 0,
              completionTokens: chunk.usage?.completionTokens ?? 0,
              totalTokens: chunk.usage?.totalTokens ?? 0,
              endpoint: "send_repetitive",
              apiKeyTier: resolved.apiKeyTier,
              generationTimeMs,
            });
            await markTurnFailed(
              userMsg?.id,
              "The model fell into a repetition loop. Tap retry to generate it again.",
              null,
            );
            await sse({
              event: "error",
              data: JSON.stringify({
                error: "The model fell into a repetition loop. The reply was discarded and no Yumina mushies were charged. Please regenerate or try another model.",
                code: "REPETITIVE_REPLY",
                userMessageId: userMsg?.id ?? null,
              }),
            });
            return;
          }

          // Explicit user stop during the parse/effects work above — same as
          // the check at the top of the done handler.
          if (isClientAbort(abortController.signal)) {
            console.log("[Messages] User stopped before save; skipping assistant persistence");
            void settleStoppedGeneration({
              userId: currentUser.id, sessionId: sessionId, worldId: context.session.worldId, endpoint: "send",
              model: actualModel, apiKeyTier: resolved.apiKeyTier,
              providerRequestId: chunk.usage?.providerRequestId ?? observedProviderRequestId,
              promptChars: promptChars, outputChars: streamedOutputChars, generationTimeMs: Date.now() - startTime,
              chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
              knownUsage: chunk.usage,
            });
            await markTurnFailed(
              userMsg?.id,
              "Generation was stopped. Tap retry to generate it again.",
              FAILURE_CODE.INTERRUPTED,
            );
            return;
          }

          // Save assistant message + update session state atomically
          outputAttempt.audit.appliedCount = changes.length;
          if (useProtections && !planConfig.unlimited && hasVisibleContent && !(grokTrialBypass && actualModel === GROK_TRIAL_MODEL)
            && ((chunk.usage?.promptTokens ?? 0) > 0 || (chunk.usage?.completionTokens ?? 0) > 0)
            && chunk.stopReason !== "content_filter" && chunk.stopReason !== "SAFETY") {
            await outputAttempt.prepareStoryCharge({ model: actualModel, promptTokens: chunk.usage?.promptTokens ?? 0,
              completionTokens: chunk.usage?.completionTokens ?? 0, providerCostUsd: freeRouterFallbackServed ? undefined : chunk.usage?.providerCostUsd });
          }
          const { assistantMsg, persistedState } = await db.transaction(async (tx) => {
            // Lock + re-read the session row BEFORE writing. A card's custom UI
            // patches state through PATCH /:id/state while this turn streams
            // (every api.setVariable); the blind `set state = finalState` below
            // used to destroy every one of those writes. Reconcile instead:
            // this turn only owns the keys it actually changed.
            const lockedSession = await tx.execute(
              sql`SELECT state FROM play_sessions WHERE id = ${sessionId} FOR UPDATE`,
            );
            const liveState = (lockedSession.rows[0] as { state: Record<string, unknown> } | undefined)?.state;
            await outputAttempt.checkCommit(tx, liveState, finalState);
            const turnState = reconcileTurnState(worldDef, liveState, effectiveGameState, finalState);
            const generationSnapshot = thinSnapshotForStorage(
              generationBaseline(worldDef, liveState, effectiveGameState, snapshot, finalState) as unknown as Record<string, unknown>,
            );
            const turnSnapshot = thinSnapshotForStorage(
              turnState as unknown as Record<string, unknown>,
            );

            const assistantMsgResult = await tx
              .insert(messages)
              .values({
                sessionId,
                role: "assistant",
                content: cleanText,
                stateValidation: outputAttempt.enabled ? outputAttempt.audit : null,
                stateChanges:
                  allChanges.length > 0
                    ? (allChanges as unknown as Record<string, unknown>)
                    : null,
                stateSnapshot: turnSnapshot,
                model: actualModel,
                tokenCount: chunk.usage?.totalTokens ?? null,
                generationTimeMs,
                swipes: [
                  {
                    content: cleanText,
                    rawContent: fullContent,
                    stateValidation: outputAttempt.enabled ? outputAttempt.audit : undefined,
                    stateChanges:
                      allChanges.length > 0
                        ? (allChanges as unknown as Record<string, unknown>)
                        : undefined,
                    stateSnapshot: turnSnapshot,
                    generationState: generationSnapshot,
                    createdAt: new Date().toISOString(),
                    modelFallback: parseModelFallbackRecord(body.modelFallback, model),
                    model: actualModel,
                    tokenCount: chunk.usage?.totalTokens,
                  },
                ] satisfies SwipeWithUsage[],
                activeSwipeIndex: 0,
              })
              .returning();

            await tx
              .update(playSessions)
              .set({
                state: turnState as unknown as Record<string, unknown>,
                updatedAt: new Date(),
              })
              .where(eq(playSessions.id, sessionId));

            return { assistantMsg: assistantMsgResult[0]!, persistedState: turnState };
          });
          replyPersisted = true;
          outputAttempt.markCommitted();
          if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });

          // The mix-mode retry path reuses a dangling user row instead of
          // inserting a duplicate, so a row that failed earlier can succeed
          // now. Without this reset it would keep its retry button forever.
          await clearTurnFailure(userMsg?.id);

          // Bump the cached world message_count OUTSIDE the transaction above.
          // Held inside it, this UPDATE kept the play_sessions row lock across a
          // hot-row convoy on worlds.message_count. Now batched via Redis
          // (see world-message-counter.ts) so the convoy is gone entirely.
          bumpWorldMessageCount(context.session.worldId);

          // Cap stored snapshots to the most recent N per session. A send adds
          // a user+assistant pair, so this is the only path that grows the
          // count past the window. Fire-and-forget: it's a cheap UPDATE and must
          // not add latency to the stream or fail the turn.
          pruneSessionSnapshots(sessionId).catch((err) => {
            console.error("[Snapshot] prune failed:", err instanceof Error ? err.message : err);
          });

          // Always log usage (including BYOK) for admin visibility
          const usageLogId = outputAttempt.trackNarrativeUsage();
          const pTokens = chunk.usage?.promptTokens ?? 0;
          const cTokens = chunk.usage?.completionTokens ?? 0;
          await recordUsageLog({
              ...usageObservation(chunk.usage),
              analyticsWorldId: context.session.worldId,
            id: usageLogId,
            userId: currentUser.id,
            sessionId,
            model: actualModel,
            promptTokens: pTokens,
            completionTokens: cTokens,
            totalTokens: chunk.usage?.totalTokens ?? 0,
            endpoint: hasVisibleContent ? "send" : "send_empty",
            apiKeyTier: resolved.apiKeyTier,
            generationTimeMs,
          });

          // Achievement engine: re-check message and model-family achievements
          // after the turn persists (老朋友 / 急急国王 / model families).
          // Fire-and-forget — must never add latency to the stream or fail the turn.
          // REGRESSION GUARD: this block was silently dropped in the 2026-06-10
          // session-memory refactor (b0c7ece3). Do not remove without moving the
          // hooks elsewhere.
          void onMessageSent(currentUser.id, { sessionId, worldId: context.session.worldId }).catch(() => {});
          void onUsageLogged(currentUser.id, { model: actualModel, apiKeyTier: resolved.apiKeyTier }).catch(() => {});

          // Deduct credits only for complete generations. Skip when:
          //   - user aborted mid-stream
          //   - upstream signaled content_filter/SAFETY
          //   - no token usage at all
          //   - fullContent is empty after streaming (DeepSeek V4 + reasoningEffort=high
          //     can burn the entire max_tokens budget on reasoning_content with the
          //     final `content` field coming back empty — see investigation 2026-05-16:
          //     6.23% of deepseek-v4-flash calls produced empty fullContent while still
          //     consuming completion_tokens. Charging for invisible work was the source
          //     of the "白吃蘑菇" complaint thread).
          let creditsCost: number | undefined;
          let creditsBalance: number | undefined;
          let grokTrialUsed = false;
          const wasFiltered = chunk.stopReason === "content_filter" || chunk.stopReason === "SAFETY";
          if (outputAttempt.storyCharge) {
            await refundTrialIfClaimed();
            creditsCost = outputAttempt.storyCharge.cost;
            creditsBalance = outputAttempt.storyCharge.balance;
          } else if (useProtections && !planConfig.unlimited && !isClientAbort(abortController.signal) && !wasFiltered && (pTokens > 0 || cTokens > 0) && hasVisibleContent) {
            if (grokTrialBypass && actualModel === GROK_TRIAL_MODEL) {
              try {
                const wallet = await db.select({ id: creditWallets.id, balance: creditWallets.balance })
                  .from(creditWallets).where(eq(creditWallets.userId, currentUser.id)).then((r) => r[0]);
                if (wallet) {
                  await insertHashedTransaction({
                    walletId: wallet.id,
                    amount: 0,
                    type: "usage",
                    balanceAfter: wallet.balance,
                    description: "Free trial — Claude Sonnet 4.6",
                    referenceId: usageLogId,
                  });
                  creditsCost = 0;
                  creditsBalance = wallet.balance;
                  grokTrialUsed = true;
                }
              } catch (err) {
                console.error("[GrokTrial] Failed to log trial:", err instanceof Error ? err.message : err);
              }
            }
            if (!grokTrialUsed) {
              // A trial was claimed but a non-trial model served the reply
              // (provider fallback, e.g. gemini-2.5-flash) — hand the trial use
              // back; the normal deduction below charges for the fallback model.
              await refundTrialIfClaimed();
              try {
                const cost = await calculateCost(actualModel, pTokens, cTokens, {
                  // On a free-pool fallback the upstream cost is real (the
                  // fallback is a paid model) and would override Free's 0/0
                  // table price, silently charging for a turn the player asked
                  // for as free. Drop it so the 0/0 rate is what applies.
                  providerCostUsd: freeRouterFallbackServed ? undefined : chunk.usage?.providerCostUsd,
                });
                const result = await deductCredits(
                  currentUser.id, cost, usageLogId,
                  `${actualModel} — ${pTokens + cTokens} tokens`,
                );
                creditsCost = cost;
                creditsBalance = result.newBalance;
              } catch (err) {
                console.error("[Credit] Deduction failed:", err instanceof Error ? err.message : err);
              }
            }
          }
          if (creditsCost == null && (!useProtections || planConfig.unlimited || isClientAbort(abortController.signal) || wasFiltered || (pTokens <= 0 && cTokens <= 0) || !hasVisibleContent)) {
            creditsCost = 0;
            creditsBalance = walletCheck?.balance;
          }
          // A paid correction can use Yumina while the story uses BYOK/free.
          creditsBalance = creditsCost ? creditsBalance ?? outputAttempt.correctionBalance : outputAttempt.correctionBalance ?? creditsBalance;
          if (creditsCost != null) {
            await persistSwipeCredits(assistantMsg.id, 0, creditsCost, creditsBalance, "set");
          }

          scheduleTurnMemoryUpdates({
            turn: turnMemory,
            sessionId,
            userId: currentUser.id,
            userMessage: userContent,
            assistantMessage: cleanText,
            state: persistedState,
            fallbackModel: actualModel,
            assistantMessageId: assistantMsg.id,
            contextTokenLimit: maxContext,
          });

          await sse({
            event: "done",
            data: JSON.stringify({
              messageId: assistantMsg.id,
              userMessageId: userMsg?.id ?? null,
              content: cleanText,
              // Raw pre-parse LLM output. The client mirrors the swipe the
              // server just persisted so the "view raw" toggle works without
              // a page refresh (it reads swipes[active].rawContent).
              rawContent: fullContent,
              generationState: thinSnapshotForStorage(snapshot as unknown as Record<string, unknown>),
              stateValidation: outputAttempt.enabled ? outputAttempt.audit : undefined,
              stateChanges: allChanges,
              state: persistedState,
              model: actualModel,
              modelFallback: parseModelFallbackRecord(body.modelFallback, model),
              tokenCount: chunk.usage?.totalTokens ?? null,
              generationTimeMs,
              choices,
              audioEffects: allAudioEffects.length > 0 ? allAudioEffects : undefined,
              notifications: systemResult.notifications.length > 0 ? systemResult.notifications : undefined,
              credits: creditsPayload(creditsCost, creditsBalance),
            }),
          });
        }
      }
    } catch (err) {
      // Mid-stream credit exhaustion is now handled inline above (emits a clean
      // NO_CREDITS error and returns), so it never reaches this catch.
      // Explicit user stop (stop endpoint aborted the provider mid-stream).
      // Disconnects no longer land here — they don't abort generation.
      if (isClientAbort(abortController.signal)) {
        // The provider billed the prompt and every token streamed before the
        // stop. Settle it from OpenRouter's generation record (never a
        // list-price estimate) and log it; see lib/stopped-generation.ts.
        void settleStoppedGeneration({
          userId: currentUser.id, sessionId: sessionId, worldId: context.session.worldId, endpoint: "send",
          model: actualModel, apiKeyTier: resolved.apiKeyTier,
          providerRequestId: observedProviderRequestId,
          promptChars: promptChars, outputChars: streamedOutputChars, generationTimeMs: Date.now() - startTime,
          chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
          knownUsage: undefined,
        });
        if (!replyPersisted) {
          await markTurnFailed(
            userMsg?.id,
            "Generation was stopped. Tap retry to generate it again.",
            FAILURE_CODE.INTERRUPTED,
          );
        }
        return;
      }
      // No reply was delivered for this turn — hand back a claimed Sonnet trial.
      if (!replyPersisted) await refundTrialIfClaimed();
      // A shutdown abort (deploy drain) falls through: log the partial usage
      // and tell the client cleanly instead of leaving a dead connection.
      const isShutdown = isShutdownAbort(abortController.signal);
      // Upstream error or network failure mid-stream. Policy (2026-05-14):
      // do NOT charge — we'd rather eat the rare partial-stream cost than
      // charge users for "卡住" experiences. Still log usage for visibility
      // so we can spot regressions in the failure rate.
      if (streamedOutputChars > 0) {
        const usageLogId = outputAttempt.trackNarrativeUsage();
        await recordUsageLog({
              ...usageObservation(undefined),
              analyticsWorldId: context.session.worldId,
          id: usageLogId, userId: currentUser.id, sessionId, model,
          promptTokens: estimateTokensFromChars(promptChars),
          completionTokens: estimateTokensFromChars(streamedOutputChars),
          totalTokens: estimateTokensFromChars(promptChars) + estimateTokensFromChars(streamedOutputChars),
          endpoint: "send", apiKeyTier: resolved.apiKeyTier, generationTimeMs: Date.now() - startTime,
        });
      }
      const catchErrorMsg = isShutdown
        ? "Server is restarting — your reply was interrupted. Please resend."
        : err instanceof Error ? err.message : "Generation failed";
      captureServerEvent(currentUser.id, "llm_error", {
        model,
        endpoint: "send",
        error_message: catchErrorMsg,
        chunks_before_error: chunkCount,
        chars_before_error: fullContent.length,
        generation_time_ms: Date.now() - startTime,
        session_id: sessionId,
      });
      const catchFailure = isShutdown
        ? { code: FAILURE_CODE.INTERRUPTED, message: catchErrorMsg }
        : classifyGenerationFailure(catchErrorMsg);
      if (!replyPersisted) {
        await markTurnFailed(userMsg?.id, catchFailure.message, catchFailure.code);
      }
      try {
        await sse({
          event: "error",
          data: JSON.stringify({
            error: catchFailure.message,
            code: catchFailure.code ?? undefined,
            userMessageId: userMsg?.id ?? null,
          }),
        });
      } catch { /* client disconnected */ }
    } finally {
      await outputAttempt.finish(abortController.signal).catch((error) => console.warn("[StateGuard] Failed to persist final audit", error instanceof Error ? error.name : "error"));
      if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });
      if (!replyPersisted) await refundTrialIfClaimed();
      unregisterStream();
      stopKeepalive();
      if (useProtections) await releaseConcurrency(currentUser.id);
      if (pendingFallbackError) {
        await sse({ event: "error", data: JSON.stringify(pendingFallbackError) });
      }
    }
  });
  } catch (err) {
    // Only fires if pre-stream setup threw before entering streamSSE
    if (useProtections) await releaseConcurrency(currentUser.id);
    await refundTrialIfClaimed();
    if (err instanceof Error && err.name === "ImageModelError") {
      if (insertedUserMessageId) {
        await db.delete(messages).where(and(eq(messages.id, insertedUserMessageId), eq(messages.sessionId, sessionId)));
      }
      return c.json({ error: err.message, code: "IMAGE_MODEL_REQUIRED" }, 400);
    }
    throw err;
  }
});

// PATCH /api/messages/:id — edit a message
messageRoutes.patch("/messages/:id", async (c) => {
  const currentUser = c.get("user");
  const messageId = c.req.param("id");
  const body = await c.req.json<{ content: string }>();

  // Verify ownership via session
  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId));

  if (msgRows.length === 0) {
    return c.json({ error: "Message not found" }, 404);
  }

  const msg = msgRows[0]!;
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.id, msg.sessionId),
        eq(playSessions.userId, currentUser.id)
      )
    );

  if (sessionRows.length === 0) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const result = await db
    .update(messages)
    .set({ ...messageContentUpdate(body.content), stateValidation: null })
    .where(eq(messages.id, messageId))
    .returning();

  // Use the post-write row: compaction may have marked this message compacted
  // between the ownership read and this update. The fresh flag ensures the
  // following invalidation cannot miss a just-committed summary.
  await runExtensionInvalidation({
    reason: "message-edited",
    sessionId: msg.sessionId,
    messageFlags: result[0] ?? msg,
  });

  return c.json({ data: result[0] });
});

// DELETE /api/messages/:id
messageRoutes.delete("/messages/:id", async (c) => {
  const currentUser = c.get("user");
  const messageId = c.req.param("id");

  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId));

  if (msgRows.length === 0) {
    return c.json({ error: "Message not found" }, 404);
  }

  const msg = msgRows[0]!;
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.id, msg.sessionId),
        eq(playSessions.userId, currentUser.id)
      )
    );

  if (sessionRows.length === 0) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const deleted = await db.delete(messages).where(eq(messages.id, messageId)).returning();

  await runExtensionInvalidation({
    reason: "message-deleted",
    sessionId: msg.sessionId,
    messageFlags: deleted[0] ?? msg,
  });

  return c.json({ data: { deleted: true } });
});

// POST /api/messages/:id/regenerate — regenerate AI response (new swipe replaces current)
messageRoutes.post("/messages/:id/regenerate", async (c) => {
  const currentUser = c.get("user");
  const messageId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    model?: string;
    modelFallback?: unknown;
    overrides?: {
      maxTokens?: number;
      maxContext?: number;
      storyMemory?: number;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      repetitionPenalty?: number;
      topK?: number;
      minP?: number;
      reasoningEffort?: string;
      streaming?: boolean;
    };
  };

  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId));

  if (msgRows.length === 0 || msgRows[0]!.role !== "assistant") {
    return c.json({ error: "Assistant message not found" }, 404);
  }

  const msg = msgRows[0]!;
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.id, msg.sessionId),
        eq(playSessions.userId, currentUser.id)
      )
    );

  if (sessionRows.length === 0) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const latestMessageRows = await db
    .select({
      id: messages.id,
      role: messages.role,
    })
    .from(messages)
    .where(eq(messages.sessionId, msg.sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const latestMessage = latestMessageRows[0] ?? null;
  if (!latestMessage || latestMessage.id !== messageId) {
    return c.json({
      error: "Regeneration is only supported for the latest assistant message. Revert first if you want to branch from an older point.",
    }, 400);
  }

  const context = await loadSessionContext(msg.sessionId, currentUser.id);
  if (!context) {
    return c.json({ error: "Session context not found" }, 404);
  }

  // Block message generation if world is unpublished and user is not creator
  if (context.worldStatus === "unpublished" && context.worldCreatorId !== currentUser.id) {
    return c.json(
      { error: "This world is no longer available. The creator has unpublished it." },
      403
    );
  }

  // A fork goes dark once its source card was pulled after being live (see
  // lib/fork-orphan.ts). A never-published source — a DM-shared draft — does not.
  if (context.sourceWorldTakenDown) {
    return c.json(
      { error: "The original world has been unpublished by its creator. This fork is no longer accessible." },
      403
    );
  }

  const { worldDef, gameState } = context;
  const model = await resolveModel(body.model);
  const [activeUserPrompts] = await Promise.all([
    loadUserPrompts(currentUser.id),
  ]);

  const isProtectedWorld = context.worldAllowCustomApi === false && context.worldCreatorId !== currentUser.id;
  const resolved = await resolveProviderForModel(currentUser.id, model, { forceOfficial: isProtectedWorld, allowRetiredForAccessCheck: true });
  if (!resolved) {
    if (isProtectedWorld) {
      return c.json({ error: "This world requires an official model. The creator has restricted this world to protect its content.", code: "PROTECTED_WORLD" }, 403);
    }
    return c.json({ error: "No API key configured for this provider" }, 400);
  }

  if (!resolved.isByok && RETIRED_PLAY_MODEL_IDS.has(model)) {
    return c.json({ error: "This model is unavailable. Please select another model.", code: "MODEL_UNAVAILABLE" }, 403);
  }
  const useProtections = !resolved.isByok;
  const walletCheck = useProtections ? await checkBalance(currentUser.id) : null;
  const userPlan = walletCheck?.wallet.plan ?? "free";
  const planConfig = PLANS[userPlan] ?? PLANS.free;
  const GROK_TRIAL_MODEL = "anthropic/claude-sonnet-4.6";
  let grokTrialBypass = false;
  if (useProtections && model === GROK_TRIAL_MODEL) {
    const [claimed] = await db.update(creditWallets)
      .set({ grokTrialRemaining: sql`GREATEST(grok_trial_remaining - 1, 0)` })
      .where(and(eq(creditWallets.userId, currentUser.id), gt(creditWallets.grokTrialRemaining, 0)))
      .returning();
    if (claimed) grokTrialBypass = true;
  }
  // Same claim/refund contract as the send path — see the comment there.
  let grokTrialRefunded = false;
  const refundTrialIfClaimed = async () => {
    if (!grokTrialBypass || grokTrialRefunded) return;
    grokTrialRefunded = true;
    try {
      await db.update(creditWallets)
        .set({ grokTrialRemaining: sql`grok_trial_remaining + 1` })
        .where(eq(creditWallets.userId, currentUser.id));
    } catch (err) {
      console.error("[GrokTrial] refund failed:", err instanceof Error ? err.message : err);
    }
  };
  if (useProtections) {
    if (checkSuspended(currentUser)) {
      await refundTrialIfClaimed();
      return c.json({ error: "Your account has been temporarily suspended from AI generation. If you believe this is a mistake, please contact support.", code: "SUSPENDED" }, 403);
    }
    if (!walletCheck!.ok && !grokTrialBypass) {
      recordWallHit({ userId: currentUser.id, plan: userPlan, planVersion: walletCheck?.wallet.planVersion, balance: 0, model, endpoint: "regenerate", stage: "preflight" });
      return c.json({ error: "You've used all your credits for this period. Purchase additional credits or upgrade your plan.", code: "NO_CREDITS", balance: 0 }, 402);
    }
    const [modelAccess, rateLimitError] = await Promise.all([
      grokTrialBypass ? Promise.resolve({ allowed: true, reason: "" }) : validateModelAccess(userPlan, model),
      checkRateLimit(currentUser.id, planConfig.rateLimit),
    ]);
    if (!modelAccess.allowed) {
      await refundTrialIfClaimed();
      return c.json({ error: modelAccess.reason, code: "MODEL_NOT_ALLOWED" }, 403);
    }
    if (rateLimitError) {
      await refundTrialIfClaimed();
      c.header("Retry-After", String(rateLimitError.retryAfter));
      return c.json(rateLimitError, 429);
    }
    if (!(await acquireConcurrency(currentUser.id, planConfig.maxConcurrent))) {
      await refundTrialIfClaimed();
      return c.json({ error: "You already have a response being generated. Please wait for it to finish.", code: "CONCURRENT_LIMIT", retryAfter: 5 }, 429);
    }
  }

  try {

  const activeSwipe = msg.swipes?.[msg.activeSwipeIndex ?? 0];
  const previousRows = !activeSwipe?.generationState && msg.createdAt
    ? await db.select({ stateSnapshot: messages.stateSnapshot }).from(messages)
      .where(and(eq(messages.sessionId, msg.sessionId), eq(messages.role, "assistant"), lt(messages.createdAt, msg.createdAt)))
      .orderBy(desc(messages.createdAt)).limit(1)
    : [];
  const regenBase = regenerationState(worldDef, gameState, {
    generationState: activeSwipe?.generationState,
    stateSnapshot: activeSwipe?.stateSnapshot ?? msg.stateSnapshot,
    stateChanges: activeSwipe?.stateChanges ?? msg.stateChanges,
  }, previousRows[0]?.stateSnapshot);
  const stateManager = new GameStateManager(worldDef, regenBase);
  const regenTurnMemory = await loadTurnMemoryBlocks({
    ownerUserId: context.session.userId,
    sessionId: msg.sessionId,
    session: context.session,
  });

  const outputContract = guardPrompt(regenTurnMemory.dispatch);

  // Get non-compacted messages up to (but not including) the one being
  // regenerated. Bounded window — `upTo` anchors it at the target message's
  // timestamp so the target is always inside the window even on mega sessions.
  const historyRows = await loadBoundedRawHistory(msg.sessionId, regenTurnMemory, {
    upTo: msg.createdAt ?? undefined,
  });

  const msgIndex = historyRows.findIndex((m) => m.id === messageId);
  // findIndex === -1 would make slice(0, -1) silently drop the tail row; with
  // the upTo anchor the target is present, but guard anyway.
  const priorMessages = limitHistoryToCurrentRun(
    msgIndex >= 0 ? historyRows.slice(0, msgIndex) : historyRows,
  );

  // Populate macro context from prior messages
  populateMacroContext(stateManager, priorMessages, model);

  // Inject the resolved persona into macro context (fallback to Yumina display name so {{user}} is never blank).
  // Unlocked sessions follow the current account persona; locked sessions keep their selection.
  // Centralized in applyPersonaMetadata so the branching rule matches every other endpoint
  // exactly — previous bugs came from different subsets of fields being set at different sites.
  const activePersona = await resolvePersonaForSession(context.session);
  applyPersonaMetadata(stateManager, activePersona, {
    username: currentUser.username,
    displayUsername: currentUser.displayUsername,
    name: currentUser.name,
    image: currentUser.image,
  });

  const snapshot = stateManager.getSnapshot();

  // Deterministic entry retrieval (engine-level matching)
  const regenClamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const scanDepth = worldDef.settings?.lorebookScanDepth ?? 2;
  const rawRegenMaxContext = regenClamp(body.overrides?.maxContext ?? worldDef.settings?.maxContext ?? 200000, 4096, 2000000);
  const userRegenMaxContext = (useProtections && walletCheck?.wallet.memoryCap) ? Math.min(rawRegenMaxContext, walletCheck.wallet.memoryCap) : rawRegenMaxContext;
  // Clamp to the model's real window (see send path) — DeepSeek 163,840 etc.
  const regenMaxContext = clampMaxContextToModel(
    userRegenMaxContext,
    model,
    regenClamp(body.overrides?.maxTokens ?? worldDef.settings?.maxTokens ?? 4096, 256, 32768),
    body.overrides?.reasoningEffort,
    await resolved.provider.getContextWindow?.(),
  );
  const regenStoryMemory = turnStoryMemory({
    override: body.overrides?.storyMemory,
    maxContext: regenMaxContext,
    accountCreatedAt: currentUser?.createdAt,
  });
  const regenBudgetPercent = worldDef.settings?.lorebookBudgetPercent ?? 100;
  const regenBudgetCap = worldDef.settings?.lorebookBudgetCap ?? 0;
  const tokenBudget = resolveLorebookBudget({
    maxContext: regenMaxContext,
    outputReserve: outputContract.reserve,
    storyMemory: regenStoryMemory.tokens,
    storyMemorySource: regenStoryMemory.source,
    budgetPercent: regenBudgetPercent,
    budgetCap: regenBudgetCap,
    reserveStoryMemory: env.LOREBOOK_RESERVES_STORY_MEMORY,
  });
  const recentTexts = priorMessages.slice(-scanDepth).map((m) => m.content);
  const lorebookResult = retrieveLorebookEntries({
    entries: worldDef.entries,
    recentMessages: recentTexts,
    state: snapshot,
    tokenBudget,
    settings: { lorebookRecursionDepth: worldDef.settings?.lorebookRecursionDepth },
    modelId: model,
    loreUiBindings: worldDef.loreUiBindings,
    worldbooks: worldDef.worldbooks,
  });
  const matchedEntries = [...lorebookResult.alwaysSend, ...lorebookResult.triggered];

  // Build context messages — mirrors send path with caching optimization
  const regenContextMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  // 1. System messages — only alwaysSend entries (stable prefix for caching)
  const regenSystemMessages = promptBuilder.buildSystemMessages(worldDef, snapshot, undefined, activeUserPrompts, snapshot.ruleState?.activeDirectives ?? [], snapshot.ruleState?.toggledEntries ?? {});
  regenContextMessages.push(...regenSystemMessages);

  // 1.5. Auto-inject active persona description into prompt
  appendPersonaSystemMessage(regenContextMessages, activePersona);

  // 2. Static format reference — behavior rules, directive syntax, audio (cacheable)
  const regenStaticFormatBlock = promptBuilder.buildStaticFormatBlock(worldDef);
  if (regenStaticFormatBlock) {
    regenContextMessages.push({ role: "system", content: regenStaticFormatBlock });
  }

  // 3. Example dialogue
  const regenExampleMessages = promptBuilder.buildExampleMessages(worldDef, snapshot, undefined, activeUserPrompts, snapshot.ruleState?.toggledEntries ?? {});
  if (regenExampleMessages.length > 0) {
    regenContextMessages.push(...regenExampleMessages);
  }

  // Mark stable prefix boundary for caching (keyword-triggered entries go after this point).
  const regenStablePrefixEnd = regenContextMessages.length - 1;

  // 3.2. Triggered system-block entries (keyword-matched, section !== chat-history/post-history).
  const regenTriggeredSystem = promptBuilder.buildTriggeredSystemMessages(worldDef, snapshot, lorebookResult.triggered, snapshot.ruleState?.toggledEntries ?? {});
  if (regenTriggeredSystem.length > 0) {
    regenContextMessages.push(...regenTriggeredSystem);
  }

  // 3. [Start a new Chat] + history with depth entries
  if (priorMessages.length > 0) {
    regenContextMessages.push({ role: "system", content: "[Start a new Chat]" });
  }

  // Inject memory blocks (story summary / summaryception / session memory)
  const regenMemoryIndices = injectMemoryPromptBlocks(regenContextMessages, regenTurnMemory);

  const regenDepthEntries = promptBuilder.buildDepthEntries(worldDef, snapshot, matchedEntries, activeUserPrompts, snapshot.ruleState?.toggledEntries ?? {});
  const regenHistoryMessages: PromptMessage[] = priorMessages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
    sourceMessageId: m.id,
    imageTokens: m.imageTokens,
  }));

  for (const de of regenDepthEntries) {
    const insertIdx = Math.max(0, regenHistoryMessages.length - de.depth);
    regenHistoryMessages.splice(insertIdx, 0, {
      role: "system" as const,
      content: de.content,
    });
  }

  let regenHistoryStart = regenContextMessages.length;
  regenContextMessages.push(...regenHistoryMessages);

  // 6. Triggered lorebook entries now flow through buildDepthEntries (injected at depth 0 by default).
  // No separate lorebook message block needed — they're already in the history above.

  // Reuse the queued context that shaped the original reply, then consume it.
  const regenPendingContext = (snapshot.metadata?.pendingContext as Array<{ message: string; role: string }>) ?? [];
  for (const ctx of regenPendingContext) {
    regenContextMessages.push({ role: (ctx.role as "system" | "user") ?? "system", content: ctx.message });
  }
  if (regenPendingContext.length) stateManager.setMetadata("pendingContext", undefined);

  // 7. Format instructions (only if variables/audio). Last-turn changes come
  // from priorMessages (history EXCLUDES the message being regenerated), so
  // they describe the turn before it — matching the reverted state.
  const regenLastTurnChanges = await loadLastTurnChanges(priorMessages);
  const regenFormatBlock = promptBuilder.buildFormatBlock(worldDef, snapshot, regenLastTurnChanges);
  if (regenFormatBlock) {
    regenContextMessages.push({ role: "system", content: regenFormatBlock });
  }

  // 8. Post-history entries
  const regenPostHistory = promptBuilder.buildPostHistoryEntries(worldDef, snapshot, matchedEntries, activeUserPrompts);
  for (const entry of regenPostHistory) {
    regenContextMessages.push({ role: entry.apiRole, content: entry.content });
  }

  const regenAntiRepetitionInstruction = antiRepetitionInstructionForModel(model);
  if (regenAntiRepetitionInstruction) {
    regenContextMessages.push({ role: "system", content: regenAntiRepetitionInstruction });
  }

  const regenSuffixCount = regenPostHistory.length + (regenFormatBlock ? 1 : 0) + (regenAntiRepetitionInstruction ? 1 : 0);
  // Depth entries and pending context live INSIDE the trim window but are not
  // conversation. Story memory is a budget for what the player said and the
  // AI replied; a world that injects a lot of keyword-triggered lore must not
  // silently shrink it. Measured once and added to the allowance, so the
  // effective cap on real history stays exactly storyMemory.
  const regenNonRawHistoryMessages = [
    ...regenDepthEntries.map((entry) => ({ role: entry.apiRole, content: entry.content })),
    ...regenPendingContext.map((ctx) => ({ role: (ctx.role as "system" | "user") ?? "system", content: ctx.message })),
  ];
  const regenHistoryWindowBudget = regenStoryMemory.tokens + estimatePromptMessagesTokens(regenNonRawHistoryMessages, model);

  regenHistoryStart = await compactTurnOverflowIfNeeded({
    pathLabel: "regenerate",
    turn: regenTurnMemory,
    userId: currentUser.id,
    model,
    maxContext: regenMaxContext,
    storyMemory: regenStoryMemory.tokens,
    contextMessages: regenContextMessages,
    historyStart: regenHistoryStart,
    suffixCount: regenSuffixCount,
    nonRawHistoryMessages: regenNonRawHistoryMessages,
    indices: regenMemoryIndices,
  });
  const chatMessages = await promptBuilder.buildMessageHistoryAsync(
    regenContextMessages,
    yieldForIO,
    regenMaxContext - outputContract.reserve,
    regenHistoryStart,
    regenSuffixCount,
    model,
    regenHistoryWindowBudget,
  );

  // Two-breakpoint caching (see send path for rationale): stable prefix + depth-resilient floor.
  if (outputContract.content) chatMessages.push({ role: "system", content: outputContract.content });
  const regenCacheDepthOffset = computeCacheDepthOffset(worldDef);
  const regenCacheBreakpointIndex = chatMessages.length - 1 - regenSuffixCount - (outputContract.content ? 1 : 0) - regenCacheDepthOffset;
  const regenBreakpoints = Array.from(new Set([regenStablePrefixEnd, regenCacheBreakpointIndex].filter((i) => i >= 0))).sort((a, b) => a - b);

  const providerMessages = await restoreChatImages(msg.sessionId, chatMessages);
  if (turnNeedsVision(providerMessages)) await assertImageModel(resolved, model);

  const regenProvider = resolved.provider;
  const startTime = Date.now();
  const abortController = new AbortController();
  // Registered for the SIGTERM drain — deploys wait for this generation (up
  // to ~50s) instead of killing it mid-stream. See lib/stream-registry.ts.
  // Session-keyed so the stop endpoint can abort it.
  const unregisterStream = registerStream(abortController, msg.sessionId);
  const outputAttempt = new TurnOutputAttempt({ dispatch: regenTurnMemory.dispatch, userId: currentUser.id, sessionId: msg.sessionId, targetId: msg.id, path: "regenerate", world: worldDef, baseline: gameState, model, apiKeyTier: resolved.apiKeyTier, startedAt: startTime, worldVersion: context.worldVersion, pendingVersion: context.pendingVersion, signal: abortController.signal, worldId: context.session.worldId, checkPending: viewerSeesWorkingCopy(context.worldStatus, context.worldCreatorId, currentUser.id) });

  // Mid-stream credit tracking for regenerate (mirrors send path)
  const regenPromptChars = imagePromptChars(providerMessages);
  const regenTracker = useProtections && !planConfig.unlimited
    ? await MidStreamTracker.create({
        ctx: { wallet: { ...walletCheck!.wallet, balance: walletCheck!.balance }, plan: userPlan, planConfig, protected: true, concurrencyHeld: true },
        model,
        promptChars: regenPromptChars,
      })
    : null;

  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    // Disconnects don't abort generation — see the send path. Explicit stops
    // arrive via the stop endpoint (USER_STOP_ABORT_REASON).
    let clientGone = false;
    stream.onAbort(() => { clientGone = true; });
    const sse = async (message: Parameters<SSEStreamingApi["writeSSE"]>[0]): Promise<void> => {
      if (clientGone) return;
      try {
        await stream.writeSSE(message);
      } catch {
        clientGone = true;
      }
    };
    let fullContent = "";
    // Guards the trial refund in the catch below — see the send path.
    let replyPersisted = false;
    const structuredParser = new StructuredResponseParser();
    const segmentExtractor = new IncrementalSegmentExtractor();
    const thinkingFilter = new ThinkingTagFilter();
    const receiptFilter = new StateReceiptFilter();

    const stopKeepalive = startKeepalive(stream);
    let actualModel = model;
    // OpenRouter generation id seen on streamed chunks — lets an explicit stop
    // be settled against the provider's billed cost (lib/stopped-generation.ts).
    let observedProviderRequestId: string | undefined;
    let pendingFallbackError: ReturnType<typeof modelFallbackError> = null;
    let correctionModel = model;
    // Set when Yumina Free's pool was exhausted upstream and the provider
    // re-ran this turn on the paid fallback. It keeps the turn billed at
    // Free's zero rate — see FREE_ROUTER_FALLBACK_MODEL.
    let freeRouterFallbackServed = false;

    try {
      // Pre-flight affordability gate (see send path): reject before spending an
      // LLM call when the prompt alone exceeds the balance, with a clean
      // NO_CREDITS ("out of mushies") instead of a mid-stream abort into a blank.
      // Trial turns are exempt — the trial pays regardless of wallet balance.
      if (!grokTrialBypass && regenTracker?.exceedsAtStart()) {
        recordWallHit({ userId: currentUser.id, plan: userPlan, planVersion: walletCheck?.wallet.planVersion, balance: regenTracker.balance, model, endpoint: "regenerate", stage: "prompt_too_long" });
        await sse({
          event: "error",
          data: JSON.stringify({
            error: "Not enough mushies to regenerate — the conversation is too long for your remaining balance.",
            code: "NO_CREDITS",
            balance: regenTracker.balance,
          }),
        });
        return;
      }
      await outputAttempt.begin();
      if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });
      for await (const chunk of regenProvider.generateStream({
        conversationId: `play:${msg.sessionId}`,
        model,
        messages: providerMessages,
        maxTokens: regenClamp(body.overrides?.maxTokens ?? worldDef.settings?.maxTokens ?? 4096, 256, 32768),
        temperature: regenClamp(body.overrides?.temperature ?? worldDef.settings?.temperature ?? 1.0, 0, 2),
        topP: body.overrides?.topP ?? worldDef.settings?.topP,
        frequencyPenalty: body.overrides?.frequencyPenalty ?? worldDef.settings?.frequencyPenalty,
        presencePenalty: body.overrides?.presencePenalty ?? worldDef.settings?.presencePenalty,
        repetitionPenalty: regenAntiRepetitionInstruction
          ? body.overrides?.repetitionPenalty
          : undefined,
        topK: body.overrides?.topK ?? worldDef.settings?.topK,
        minP: body.overrides?.minP ?? worldDef.settings?.minP,
        reasoningEffort: body.overrides?.reasoningEffort,
        stream: body.overrides?.streaming,
        ...(worldDef.settings?.structuredOutput && { responseFormat: { type: "json_object" as const } }),
        ...(regenBreakpoints.length > 0 && { cacheBreakpoints: regenBreakpoints }),
        fallbackModels: regenAntiRepetitionInstruction
          ? undefined
          : getOfficialProviderFallbackModels(
              model,
              resolved.isByok,
              turnNeedsVision(providerMessages),
            ),
        fallbackOnTransientErrors: allowsTransientFallback(model, resolved.isByok),
        signal: abortController.signal,
      })) {
        if (chunk.model) {
          correctionModel = chunk.model;
          if (isFreeRouterFallback(model, chunk.model)) {
            // Deliberately do NOT promote chunk.model here: leaving actualModel
            // as openrouter/free is what keeps the turn free (0/0 pricing) and
            // labelled "Yumina Free" in the UI, so the player never sees — or
            // pays for — the downgrade.
            if (!freeRouterFallbackServed) {
              freeRouterFallbackServed = true;
              captureServerEvent(currentUser.id, "free_pool_fallback", {
                requested_model: model,
                served_model: chunk.model,
              });
            }
          } else {
            actualModel = chunk.model;
          }
        }
        if (chunk.type === "reasoning") {
          await sse({
            event: "reasoning",
            data: JSON.stringify({ content: chunk.content }),
          });
        }

        if (chunk.type === "text") {
          if (chunk.providerRequestId) observedProviderRequestId = chunk.providerRequestId;
          fullContent += chunk.content;

          // Mid-stream credit check: ran dry mid-reply. End cleanly with a
          // NO_CREDITS error (out-of-mushies toast + popup) instead of the old
          // `break`, which skipped the catch handler and surfaced as a silent
          // "connection lost". Don't charge for an unusable partial; log only.
          // track() still runs on trial turns (the catch path logs its char
          // count) but a trial-paid turn must never abort on wallet balance.
          if (regenTracker?.track(chunk.content.length) && !grokTrialBypass) {
            abortController.abort();
            await recordUsageLog({
              ...usageObservation(undefined),
              analyticsWorldId: context.session.worldId,
              id: crypto.randomUUID(), userId: currentUser.id, sessionId: msg.sessionId, model,
              promptTokens: estimateTokensFromChars(regenPromptChars),
              completionTokens: estimateTokensFromChars(regenTracker.streamedChars),
              totalTokens: estimateTokensFromChars(regenPromptChars) + estimateTokensFromChars(regenTracker.streamedChars),
              endpoint: "regenerate", apiKeyTier: resolved.apiKeyTier, generationTimeMs: Date.now() - startTime,
            });
            recordWallHit({ userId: currentUser.id, plan: userPlan, planVersion: walletCheck?.wallet.planVersion, balance: 0, model: actualModel, endpoint: "regenerate", stage: "mid_stream" });
            await sse({
              event: "error",
              data: JSON.stringify({
                error: "You ran out of mushies partway through this reply. Top up or check in for more.",
                code: "NO_CREDITS",
                balance: 0,
              }),
            });
            return;
          }

          const filtered = receiptFilter.push(thinkingFilter.push(chunk.content));
          if (filtered) {
            await sse({
              event: "text",
              data: JSON.stringify({ content: filtered }),
            });
          }

          // Emit segment/bg events during streaming
          const extraction = segmentExtractor.extract(fullContent);
          for (const segment of extraction.newSegments) {
            await sse({
              event: "segment",
              data: JSON.stringify({ segment }),
            });
          }
          if (extraction.bg) {
            await sse({
              event: "bg",
              data: JSON.stringify({ bg: extraction.bg }),
            });
          }
        }

        if (chunk.type === "error") {
          const fallbackError = modelFallbackError(chunk, model, fullContent, resolved.isByok);
          if (fallbackError) {
            await refundTrialIfClaimed();
            pendingFallbackError = fallbackError;
            return;
          }
          await sse({
            event: "error",
            data: JSON.stringify({ error: chunk.content }),
          });
          return;
        }

        if (chunk.type === "done") {
          if (replyPersisted) break;
          // Explicit user stop only — disconnects keep generating and persist.
          if (isClientAbort(abortController.signal)) {
            console.log("[Messages] Regenerate completed after user stop; skipping persistence");
            void settleStoppedGeneration({
              userId: currentUser.id, sessionId: msg.sessionId, worldId: context.session.worldId, endpoint: "regenerate",
              model: actualModel, apiKeyTier: resolved.apiKeyTier,
              providerRequestId: chunk.usage?.providerRequestId ?? observedProviderRequestId,
              promptChars: regenPromptChars, outputChars: fullContent.length, generationTimeMs: Date.now() - startTime,
              chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
              knownUsage: chunk.usage,
            });
            return;
          }

          const generationTimeMs = Date.now() - startTime;

          // Parse response — use structured parser for JSON responses, regex for others
          const legacyParsed = structuredParser.isStructuredResponse(fullContent)
            ? structuredParser.parse(fullContent)
            : responseParser.parse(fullContent);
          const { parsed: regenParseResult } = await outputAttempt.validate({
            world: worldDef, state: stateManager.getSnapshot(), raw: fullContent, parsed: legacyParsed,
            provider: regenProvider, model: correctionModel, maxContext: regenMaxContext, signal: abortController.signal,
            stopReason: chunk.stopReason, history: providerMessages,
            cacheEnabled: regenBreakpoints.length > 0, stream: body.overrides?.streaming,
          }, async (audit) => { await sse({ event: "state-validation", data: JSON.stringify(audit) }); });
          const cleanText = regenParseResult.cleanText;
          const effects = regenParseResult.effects;
          const choices: string[] = [];
          const regenParserAudioEffects = filterAiAudioEffects(worldDef.audioTracks ?? [], regenParseResult.audioEffects);

          // See main send path: don't charge for invisible work.
          const hasVisibleContent = fullContent.trim().length > 0;

          // See main send path: AI directives only touch AI-writable vars.
          const regenWriteFilter = filterAiEffects(worldDef, stateManager.getSnapshot(), effects);
          if (regenWriteFilter.dropped.length > 0) {
            console.log(`[Messages] Dropped ${regenWriteFilter.dropped.length} AI directive(s) to non-AI-writable vars: ${regenWriteFilter.dropped.map((e) => e.variableId).join(", ")}`);
          }
          const changes = stateManager.applyEffects(regenWriteFilter.kept);
          // A refused write is a model fumbling JSON syntax over a whole list
          // (`[items: set delete 1, delete 0]`). The engine keeps the old value;
          // say so, because the failure is otherwise invisible until a player
          // notices their inventory is gone.
          const rejectedWrites = stateManager.drainRejectedWrites();
          if (rejectedWrites.length > 0) {
            console.log(`[Messages] Refused ${rejectedWrites.length} malformed JSON write(s): ${rejectedWrites.map((w) => w.variableId).join(", ")}`);
          }
          outputAttempt.audit.appliedCount = changes.length;

          // Replace the whole turn, including user/start reactions undone by the rewind.
          const regenEvents: GameEvent[] = [
            buildMessageAIEvent(cleanText),
            buildTurnCompleteEvent(stateManager.getSnapshot().turnCount),
          ];
          const precedingMessage = priorMessages[priorMessages.length - 1];
          regenEvents.unshift(buildMessageUserEvent(precedingMessage?.role === "user" ? precedingMessage.content : ""));
          if (stateManager.getSnapshot().turnCount === 1) regenEvents.push(buildSessionStartEvent());
          for (const change of changes) {
            regenEvents.push({ type: "state:changed", variableId: change.variableId, oldValue: change.oldValue, newValue: change.newValue });
          }
          const regenSystemResult = runReactionChain(
            reactionEvaluator,
            stateManager,
            regenEvents,
            worldDef.reactions ?? [],
            worldDef.rules ?? [],
          );
          const ruleChanges = regenSystemResult.changes;
          const allChanges = [...changes, ...ruleChanges];
          outputAttempt.recordChanges(changes, ruleChanges);

          const allRegenAudioEffects = [...regenParserAudioEffects, ...regenSystemResult.audioEffects];
          // Persist the looping subset only — see the send path for why.
          const resumableRegenAudio = filterResumableAudioEffects(worldDef.audioTracks ?? [], allRegenAudioEffects);
          if (resumableRegenAudio.length > 0) {
            stateManager.setMetadata("activeAudio", resumableRegenAudio);
          }
          if (regenSystemResult.contextMessages.length > 0) {
            stateManager.setMetadata("pendingContext", regenSystemResult.contextMessages);
          }

          const finalState = stateManager.getSnapshot();

          const repetition = regenAntiRepetitionInstruction
            ? detectDegenerateRepetitionForModel(
                model,
                cleanText,
                [
                  ...priorMessages
                    .filter((message) => message.role === "assistant")
                    .slice(-3)
                    .map((message) => message.content),
                  msg.content,
                  ...((msg.swipes ?? []) as SwipeWithUsage[]).map((swipe) => swipe.content),
                ],
              )
            : null;
          if (repetition) {
            console.warn(
              `[Messages] Rejected repetitive ${model} regeneration (${repetition.reason}, ${repetition.occurrences}x, ${cleanText.length} chars)`,
            );
            captureServerEvent(currentUser.id, "llm_repetitive_output", {
              model,
              endpoint: "regenerate",
              reason: repetition.reason,
              occurrences: repetition.occurrences,
              chars: cleanText.length,
              session_id: msg.sessionId,
            });
            await recordUsageLog({
              ...usageObservation(chunk.usage),
              analyticsWorldId: context.session.worldId,
              id: crypto.randomUUID(), userId: currentUser.id, sessionId: msg.sessionId, model: actualModel,
              promptTokens: chunk.usage?.promptTokens ?? 0,
              completionTokens: chunk.usage?.completionTokens ?? 0,
              totalTokens: chunk.usage?.totalTokens ?? 0,
              endpoint: "regenerate_repetitive", apiKeyTier: resolved.apiKeyTier, generationTimeMs,
            });
            await sse({
              event: "error",
              data: JSON.stringify({
                error: "The model fell into a repetition loop. The reply was discarded and no Yumina mushies were charged. Please regenerate or try another model.",
                code: "REPETITIVE_REPLY",
              }),
            });
            return;
          }

          // Add as new swipe
          const existingSwipes = (msg.swipes ?? []) as SwipeWithUsage[];
          const newSwipe = {
            content: cleanText,
            rawContent: fullContent,
            generationState: thinSnapshotForStorage(snapshot as unknown as Record<string, unknown>),
            stateValidation: outputAttempt.enabled ? outputAttempt.audit : undefined,
            stateChanges:
              allChanges.length > 0
                ? (allChanges as unknown as Record<string, unknown>)
                : undefined,
            stateSnapshot: thinSnapshotForStorage(finalState as unknown as Record<string, unknown>),
            createdAt: new Date().toISOString(),
            modelFallback: parseModelFallbackRecord(body.modelFallback, model),
            model: actualModel,
            tokenCount: chunk.usage?.totalTokens,
          } satisfies SwipeWithUsage;
          const updatedSwipes = [...existingSwipes, newSwipe];

          if (isClientAbort(abortController.signal)) {
            console.log("[Messages] User stopped before regenerate save; skipping persistence");
            void settleStoppedGeneration({
              userId: currentUser.id, sessionId: msg.sessionId, worldId: context.session.worldId, endpoint: "regenerate",
              model: actualModel, apiKeyTier: resolved.apiKeyTier,
              providerRequestId: chunk.usage?.providerRequestId ?? observedProviderRequestId,
              promptChars: regenPromptChars, outputChars: fullContent.length, generationTimeMs: Date.now() - startTime,
              chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
              knownUsage: chunk.usage,
            });
            return;
          }

          if (useProtections && !planConfig.unlimited && hasVisibleContent && !(grokTrialBypass && actualModel === GROK_TRIAL_MODEL)
            && ((chunk.usage?.promptTokens ?? 0) > 0 || (chunk.usage?.completionTokens ?? 0) > 0)
            && chunk.stopReason !== "content_filter" && chunk.stopReason !== "SAFETY") {
            await outputAttempt.prepareStoryCharge({ model: actualModel, promptTokens: chunk.usage?.promptTokens ?? 0,
              completionTokens: chunk.usage?.completionTokens ?? 0, providerCostUsd: freeRouterFallbackServed ? undefined : chunk.usage?.providerCostUsd });
          }
          // Save updated message + session state atomically
          const persistedState = await db.transaction(async (tx) => {
            // Same lost-update guard as the send path: reconcile against
            // whatever PATCH /:id/state committed while this regeneration
            // streamed instead of overwriting it.
            const lockedSession = await tx.execute(
              sql`SELECT state FROM play_sessions WHERE id = ${msg.sessionId} FOR UPDATE`,
            );
            const liveState = (lockedSession.rows[0] as { state: Record<string, unknown> } | undefined)?.state;
            await outputAttempt.checkCommit(tx, liveState, finalState);
            const turnState = reconcileTurnState(worldDef, liveState, gameState, finalState);
            // Preserve concurrent UI writes in this swipe's baseline, too.
            const generationSnapshot = thinSnapshotForStorage(
              generationBaseline(worldDef, liveState, gameState, snapshot, finalState) as unknown as Record<string, unknown>,
            );
            const turnSnapshot = thinSnapshotForStorage(
              turnState as unknown as Record<string, unknown>,
            );
            await tx
              .update(messages)
              .set({
                content: cleanText,
                stateValidation: outputAttempt.enabled ? outputAttempt.audit : null,
                stateChanges:
                  allChanges.length > 0
                    ? (allChanges as unknown as Record<string, unknown>)
                    : null,
                stateSnapshot: turnSnapshot,
                swipes: updatedSwipes.map((swipe, index) =>
                  index === updatedSwipes.length - 1
                    ? { ...swipe, stateSnapshot: turnSnapshot, generationState: generationSnapshot }
                    : swipe,
                ),
                activeSwipeIndex: updatedSwipes.length - 1,
                model: actualModel,
                tokenCount: chunk.usage?.totalTokens ?? null,
                generationTimeMs,
              })
              .where(eq(messages.id, messageId));

            // Update session state
            await tx
              .update(playSessions)
              .set({
                state: turnState as unknown as Record<string, unknown>,
                updatedAt: new Date(),
              })
              .where(eq(playSessions.id, msg.sessionId));
            return turnState;
          });
          replyPersisted = true;
          outputAttempt.markCommitted();
          if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });

          // Always log usage (including BYOK) for admin visibility
          const usageLogId = outputAttempt.trackNarrativeUsage();
          const pTokens = chunk.usage?.promptTokens ?? 0;
          const cTokens = chunk.usage?.completionTokens ?? 0;
          await recordUsageLog({
              ...usageObservation(chunk.usage),
              analyticsWorldId: context.session.worldId,
            id: usageLogId,
            userId: currentUser.id,
            sessionId: msg.sessionId,
            model: actualModel,
            promptTokens: pTokens,
            completionTokens: cTokens,
            totalTokens: chunk.usage?.totalTokens ?? 0,
            endpoint: hasVisibleContent ? "regenerate" : "regenerate_empty",
            apiKeyTier: resolved.apiKeyTier,
            generationTimeMs,
          });

          // Achievement engine: a regeneration was saved — re-check 再来一口 / 不满意
          // + model-family achievements. Fire-and-forget (see send-path note above;
          // also dropped in b0c7ece3 2026-06-10).
          void onRegenerate(currentUser.id, updatedSwipes.length).catch(() => {});
          void onUsageLogged(currentUser.id, { model: actualModel, apiKeyTier: resolved.apiKeyTier }).catch(() => {});

          let creditsCost: number | undefined;
          let creditsBalance: number | undefined;
          let grokTrialUsed = false;
          const wasFiltered = chunk.stopReason === "content_filter" || chunk.stopReason === "SAFETY";
          if (outputAttempt.storyCharge) {
            await refundTrialIfClaimed();
            creditsCost = outputAttempt.storyCharge.cost;
            creditsBalance = outputAttempt.storyCharge.balance;
          } else if (useProtections && !planConfig.unlimited && !isClientAbort(abortController.signal) && !wasFiltered && (pTokens > 0 || cTokens > 0) && hasVisibleContent) {
            if (grokTrialBypass && actualModel === GROK_TRIAL_MODEL) {
              try {
                const wallet = await db.select({ id: creditWallets.id, balance: creditWallets.balance })
                  .from(creditWallets).where(eq(creditWallets.userId, currentUser.id)).then((r) => r[0]);
                if (wallet) {
                  await insertHashedTransaction({ walletId: wallet.id, amount: 0, type: "usage", balanceAfter: wallet.balance, description: "Free trial — Claude Sonnet 4.6", referenceId: usageLogId });
                  creditsCost = 0; creditsBalance = wallet.balance; grokTrialUsed = true;
                }
              } catch (err) { console.error("[GrokTrial] Failed to log trial:", err instanceof Error ? err.message : err); }
            }
            if (!grokTrialUsed) {
              // A trial was claimed but a non-trial model served the reply
              // (provider fallback, e.g. gemini-2.5-flash) — hand the trial use
              // back; the normal deduction below charges for the fallback model.
              await refundTrialIfClaimed();
              try {
                const cost = await calculateCost(actualModel, pTokens, cTokens, {
                  // On a free-pool fallback the upstream cost is real (the
                  // fallback is a paid model) and would override Free's 0/0
                  // table price, silently charging for a turn the player asked
                  // for as free. Drop it so the 0/0 rate is what applies.
                  providerCostUsd: freeRouterFallbackServed ? undefined : chunk.usage?.providerCostUsd,
                });
                const result = await deductCredits(
                  currentUser.id, cost, usageLogId,
                  `${actualModel} — ${pTokens + cTokens} tokens (regenerate)`,
                );
                creditsCost = cost;
                creditsBalance = result.newBalance;
              } catch (err) {
                console.error("[Credit] Deduction failed:", err instanceof Error ? err.message : err);
              }
            }
          }
          if (creditsCost == null && (!useProtections || planConfig.unlimited || isClientAbort(abortController.signal) || wasFiltered || (pTokens <= 0 && cTokens <= 0) || !hasVisibleContent)) {
            creditsCost = 0;
            creditsBalance = walletCheck?.balance;
          }
          // A paid correction can use Yumina while the story uses BYOK/free.
          creditsBalance = creditsCost ? creditsBalance ?? outputAttempt.correctionBalance : outputAttempt.correctionBalance ?? creditsBalance;
          if (creditsCost != null) {
            await persistSwipeCredits(messageId, updatedSwipes.length - 1, creditsCost, creditsBalance, "set");
          }

          scheduleTurnMemoryUpdates({
            turn: regenTurnMemory,
            sessionId: msg.sessionId,
            userId: currentUser.id,
            userMessage: priorMessages.slice().reverse().find((m) => m.role === "user")?.content ?? "",
            assistantMessage: cleanText,
            state: persistedState,
            fallbackModel: actualModel,
            assistantMessageId: messageId,
            contextTokenLimit: regenMaxContext,
          });

          await sse({
            event: "done",
            data: JSON.stringify({
              messageId,
              content: cleanText,
              // Raw pre-parse LLM output — lets the client append the new
              // swipe locally (count + "view raw") without a refresh.
              rawContent: fullContent,
              generationState: thinSnapshotForStorage(snapshot as unknown as Record<string, unknown>),
              stateValidation: outputAttempt.enabled ? outputAttempt.audit : undefined,
              stateChanges: allChanges,
              state: persistedState,
              model: actualModel,
              modelFallback: parseModelFallbackRecord(body.modelFallback, model),
              swipeIndex: updatedSwipes.length - 1,
              totalSwipes: updatedSwipes.length,
              tokenCount: chunk.usage?.totalTokens ?? null,
              generationTimeMs,
              choices,
              audioEffects: allRegenAudioEffects.length > 0 ? allRegenAudioEffects : undefined,
              notifications: regenSystemResult.notifications.length > 0 ? regenSystemResult.notifications : undefined,
              credits: creditsPayload(creditsCost, creditsBalance),
            }),
          });
        }
      }
    } catch (err) {
      // Mid-stream credit exhaustion is handled inline above (clean NO_CREDITS
      // + return), so it never reaches this catch.
      if (isClientAbort(abortController.signal)) {
        void settleStoppedGeneration({
          userId: currentUser.id, sessionId: msg.sessionId, worldId: context.session.worldId, endpoint: "regenerate",
          model: actualModel, apiKeyTier: resolved.apiKeyTier,
          providerRequestId: observedProviderRequestId,
          promptChars: regenPromptChars, outputChars: fullContent.length, generationTimeMs: Date.now() - startTime,
          chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
          knownUsage: undefined,
        });
        return;
      }
      // No reply was delivered for this turn — hand back a claimed Sonnet trial.
      if (!replyPersisted) await refundTrialIfClaimed();
      // A shutdown abort (deploy drain) falls through: log the partial usage
      // and tell the client cleanly instead of leaving a dead connection.
      const isShutdown = isShutdownAbort(abortController.signal);
      // Upstream error or network failure mid-stream. Policy (2026-05-14):
      // do NOT charge — log usage for failure-rate tracking, but eat the cost.
      if (regenTracker?.active && regenTracker.streamedChars > 0) {
        const usageLogId = outputAttempt.trackNarrativeUsage();
        await recordUsageLog({
              ...usageObservation(undefined),
              analyticsWorldId: context.session.worldId,
          id: usageLogId, userId: currentUser.id, sessionId: msg.sessionId, model,
          promptTokens: estimateTokensFromChars(regenPromptChars),
          completionTokens: estimateTokensFromChars(regenTracker.streamedChars),
          totalTokens: estimateTokensFromChars(regenPromptChars) + estimateTokensFromChars(regenTracker.streamedChars),
          endpoint: "regenerate", apiKeyTier: resolved.apiKeyTier, generationTimeMs: Date.now() - startTime,
        });
      }
      try {
        await sse({
          event: "error",
          data: JSON.stringify({
            error: isShutdown
              ? "Server is restarting — your reply was interrupted. Please resend."
              : err instanceof Error ? err.message : "Regeneration failed",
            ...(isShutdown && { code: "SERVER_RESTART" }),
          }),
        });
      } catch { /* client disconnected */ }
    } finally {
      await outputAttempt.finish(abortController.signal).catch((error) => console.warn("[StateGuard] Failed to persist final audit", error instanceof Error ? error.name : "error"));
      if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });
      if (!replyPersisted) await refundTrialIfClaimed();
      unregisterStream();
      stopKeepalive();
      if (useProtections) await releaseConcurrency(currentUser.id);
      if (pendingFallbackError) {
        await sse({ event: "error", data: JSON.stringify(pendingFallbackError) });
      }
    }
  });
  } catch (err) {
    if (useProtections) await releaseConcurrency(currentUser.id);
    await refundTrialIfClaimed();
    if (err instanceof Error && err.name === "ImageModelError") return c.json({ error: err.message, code: "IMAGE_MODEL_REQUIRED" }, 400);
    throw err;
  }
});

// POST /api/sessions/:sessionId/continue — continue/extend the last assistant message
messageRoutes.post("/sessions/:sessionId/continue", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const body = (await c.req.json().catch(() => ({}))) as {
    model?: string;
    modelFallback?: unknown;
    overrides?: {
      maxTokens?: number;
      maxContext?: number;
      storyMemory?: number;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      repetitionPenalty?: number;
      topK?: number;
      minP?: number;
      reasoningEffort?: string;
      streaming?: boolean;
    };
  };

  const context = await loadSessionContext(sessionId, currentUser.id);
  if (!context) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Block message generation if world is unpublished and user is not creator
  if (context.worldStatus === "unpublished" && context.worldCreatorId !== currentUser.id) {
    return c.json(
      { error: "This world is no longer available. The creator has unpublished it." },
      403
    );
  }

  // A fork goes dark once its source card was pulled after being live (see
  // lib/fork-orphan.ts). A never-published source — a DM-shared draft — does not.
  if (context.sourceWorldTakenDown) {
    return c.json(
      { error: "The original world has been unpublished by its creator. This fork is no longer accessible." },
      403
    );
  }

  const { worldDef, gameState } = context;
  if (worldDef.systems?.includes("kochuu-survival-v1")) {
    const status = new GameStateManager(worldDef, gameState).get("game-status");
    if (status === "dead" || status === "won") return c.json({ error: "本局已结束。可查看记录、回退或重新开局。", code: "GAME_ENDED" }, 409);
  }
  const model = await resolveModel(body.model);
  const [activeUserPrompts] = await Promise.all([
    loadUserPrompts(currentUser.id),
  ]);

  const isProtectedWorld = context.worldAllowCustomApi === false && context.worldCreatorId !== currentUser.id;
  const resolved = await resolveProviderForModel(currentUser.id, model, { forceOfficial: isProtectedWorld, allowRetiredForAccessCheck: true });
  if (!resolved) {
    if (isProtectedWorld) {
      return c.json({ error: "This world requires an official model. The creator has restricted this world to protect its content.", code: "PROTECTED_WORLD" }, 403);
    }
    return c.json({ error: "No API key configured for this provider. Add one in Settings." }, 400);
  }

  if (!resolved.isByok && RETIRED_PLAY_MODEL_IDS.has(model)) {
    return c.json({ error: "This model is unavailable. Please select another model.", code: "MODEL_UNAVAILABLE" }, 403);
  }
  const useProtections = !resolved.isByok;
  const walletCheck = useProtections ? await checkBalance(currentUser.id) : null;
  const userPlan = walletCheck?.wallet.plan ?? "free";
  const planConfig = PLANS[userPlan] ?? PLANS.free;
  const GROK_TRIAL_MODEL = "anthropic/claude-sonnet-4.6";
  let grokTrialBypass = false;
  if (useProtections && model === GROK_TRIAL_MODEL) {
    const [claimed] = await db.update(creditWallets)
      .set({ grokTrialRemaining: sql`GREATEST(grok_trial_remaining - 1, 0)` })
      .where(and(eq(creditWallets.userId, currentUser.id), gt(creditWallets.grokTrialRemaining, 0)))
      .returning();
    if (claimed) grokTrialBypass = true;
  }
  // Same claim/refund contract as the send path — see the comment there.
  let grokTrialRefunded = false;
  const refundTrialIfClaimed = async () => {
    if (!grokTrialBypass || grokTrialRefunded) return;
    grokTrialRefunded = true;
    try {
      await db.update(creditWallets)
        .set({ grokTrialRemaining: sql`grok_trial_remaining + 1` })
        .where(eq(creditWallets.userId, currentUser.id));
    } catch (err) {
      console.error("[GrokTrial] refund failed:", err instanceof Error ? err.message : err);
    }
  };
  const contClamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const rawContMaxContext = contClamp(body.overrides?.maxContext ?? worldDef.settings?.maxContext ?? 200000, 4096, 2000000);
  const userContMaxContext = (useProtections && walletCheck?.wallet.memoryCap) ? Math.min(rawContMaxContext, walletCheck.wallet.memoryCap) : rawContMaxContext;
  // Clamp to the model's real window (see send path) — DeepSeek 163,840 etc.
  const maxContext = clampMaxContextToModel(
    userContMaxContext,
    model,
    contClamp(body.overrides?.maxTokens ?? worldDef.settings?.maxTokens ?? 4096, 256, 32768),
    body.overrides?.reasoningEffort,
    await resolved.provider.getContextWindow?.(),
  );
  const storyMemory = turnStoryMemory({
    override: body.overrides?.storyMemory,
    maxContext,
    accountCreatedAt: currentUser?.createdAt,
  });
  if (useProtections) {
    if (checkSuspended(currentUser)) {
      await refundTrialIfClaimed();
      return c.json({ error: "Your account has been temporarily suspended from AI generation. If you believe this is a mistake, please contact support.", code: "SUSPENDED" }, 403);
    }
    if (!walletCheck!.ok && !grokTrialBypass) {
      recordWallHit({ userId: currentUser.id, plan: userPlan, planVersion: walletCheck?.wallet.planVersion, balance: 0, model, endpoint: "continue", stage: "preflight" });
      return c.json({ error: "You've used all your credits for this period. Purchase additional credits or upgrade your plan.", code: "NO_CREDITS", balance: 0 }, 402);
    }
    const [modelAccess, rateLimitError] = await Promise.all([
      grokTrialBypass ? Promise.resolve({ allowed: true, reason: "" }) : validateModelAccess(userPlan, model),
      checkRateLimit(currentUser.id, planConfig.rateLimit),
    ]);
    if (!modelAccess.allowed) {
      await refundTrialIfClaimed();
      return c.json({ error: modelAccess.reason, code: "MODEL_NOT_ALLOWED" }, 403);
    }
    if (rateLimitError) {
      await refundTrialIfClaimed();
      c.header("Retry-After", String(rateLimitError.retryAfter));
      return c.json(rateLimitError, 429);
    }
    if (!(await acquireConcurrency(currentUser.id, planConfig.maxConcurrent))) {
      await refundTrialIfClaimed();
      return c.json({ error: "You already have a response being generated. Please wait for it to finish.", code: "CONCURRENT_LIMIT", retryAfter: 5 }, 429);
    }
  }

  try {

  // Find the last assistant message
  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(messages.createdAt);

  let lastAssistantMsg = null;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i]!.role === "assistant") {
      lastAssistantMsg = allMessages[i]!;
      break;
    }
  }

  if (!lastAssistantMsg) {
    // Early return (not a throw) — the outer catch/finally never run, so
    // release the concurrency slot and hand back a claimed trial here.
    if (useProtections) await releaseConcurrency(currentUser.id);
    await refundTrialIfClaimed();
    return c.json({ error: "No assistant message to continue" }, 400);
  }

  const contTurnMemory = await loadTurnMemoryBlocks({
    ownerUserId: context.session.userId,
    sessionId,
    session: context.session,
  });
  const outputContract = guardPrompt(contTurnMemory.dispatch);
  // No awaited pre-history compaction here — same rationale as the send path:
  // background owns threshold compaction; the final-budget overflow pass below
  // only schedules background compaction (this turn trims).

  // Build prompt with full history, but the last assistant message becomes a partial turn
  const stateManager = new GameStateManager(worldDef, gameState);

  // Bounded window — same rationale as the send path (see loadBoundedRawHistory).
  const historyRows = await loadBoundedRawHistory(sessionId, contTurnMemory);
  const currentRunHistory = limitHistoryToCurrentRun(historyRows);

  // Populate macro context
  populateMacroContext(stateManager, currentRunHistory, model);

  // Inject the resolved persona into macro context (fallback to Yumina display name so {{user}} is never blank).
  // Unlocked sessions follow the current account persona; locked sessions keep their selection.
  // Centralized in applyPersonaMetadata so the branching rule matches every other endpoint
  // exactly — previous bugs came from different subsets of fields being set at different sites.
  const activePersona = await resolvePersonaForSession(context.session);
  applyPersonaMetadata(stateManager, activePersona, {
    username: currentUser.username,
    displayUsername: currentUser.displayUsername,
    name: currentUser.name,
    image: currentUser.image,
  });

  const snapshot = stateManager.getSnapshot();

  // Entry retrieval
  const scanDepth = worldDef.settings?.lorebookScanDepth ?? 2;
  const budgetPercent = worldDef.settings?.lorebookBudgetPercent ?? 100;
  const budgetCap = worldDef.settings?.lorebookBudgetCap ?? 0;
  // Story memory is a reservation, not a leftover: the world trims to leave
  // the conversation its room, rather than the conversation losing turns to
  // a large world. Which entries MATCH is untouched; this only sets how many
  // of the matched ones survive (packages/shared/src/lorebook-budget.ts).
  const tokenBudget = resolveLorebookBudget({
    maxContext,
    outputReserve: outputContract.reserve,
    storyMemory: storyMemory.tokens,
    storyMemorySource: storyMemory.source,
    budgetPercent,
    budgetCap,
    reserveStoryMemory: env.LOREBOOK_RESERVES_STORY_MEMORY,
  });
  const recentTexts = currentRunHistory.slice(-scanDepth).map((m) => m.content);
  const lorebookResult = retrieveLorebookEntries({
    entries: worldDef.entries,
    recentMessages: recentTexts,
    state: snapshot,
    tokenBudget,
    settings: { lorebookRecursionDepth: worldDef.settings?.lorebookRecursionDepth },
    modelId: model,
    loreUiBindings: worldDef.loreUiBindings,
    worldbooks: worldDef.worldbooks,
  });
  const matchedEntries = [...lorebookResult.alwaysSend, ...lorebookResult.triggered];

  // Build context messages — mirrors send path with caching optimization
  const contextMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  // 1. System messages — only alwaysSend entries (stable prefix for caching)
  const contSystemMessages = promptBuilder.buildSystemMessages(worldDef, snapshot, undefined, activeUserPrompts, snapshot.ruleState?.activeDirectives ?? [], snapshot.ruleState?.toggledEntries ?? {});
  contextMessages.push(...contSystemMessages);

  // 1.5. Auto-inject active persona description into prompt
  appendPersonaSystemMessage(contextMessages, activePersona);

  // 2. Static format reference — behavior rules, directive syntax, audio (cacheable)
  const contStaticFormatBlock = promptBuilder.buildStaticFormatBlock(worldDef);
  if (contStaticFormatBlock) {
    contextMessages.push({ role: "system", content: contStaticFormatBlock });
  }

  // Example dialogue
  const contExampleMessages = promptBuilder.buildExampleMessages(worldDef, snapshot, undefined, activeUserPrompts, snapshot.ruleState?.toggledEntries ?? {});
  if (contExampleMessages.length > 0) {
    contextMessages.push(...contExampleMessages);
  }

  // Mark stable prefix boundary for caching (keyword-triggered entries go after this point).
  const contStablePrefixEnd = contextMessages.length - 1;

  // Triggered system-block entries (keyword-matched, section !== chat-history/post-history).
  const contTriggeredSystem = promptBuilder.buildTriggeredSystemMessages(worldDef, snapshot, lorebookResult.triggered, snapshot.ruleState?.toggledEntries ?? {});
  if (contTriggeredSystem.length > 0) {
    contextMessages.push(...contTriggeredSystem);
  }

  // [Start a new Chat] + full history (last assistant message stays as partial turn)
  if (currentRunHistory.length > 0) {
    contextMessages.push({ role: "system", content: "[Start a new Chat]" });
  }

  // Inject memory blocks (story summary / summaryception / session memory)
  const contMemoryIndices = injectMemoryPromptBlocks(contextMessages, contTurnMemory);

  const depthEntries = promptBuilder.buildDepthEntries(worldDef, snapshot, matchedEntries, activeUserPrompts, snapshot.ruleState?.toggledEntries ?? {});
  const historyMessages: PromptMessage[] = currentRunHistory.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
    sourceMessageId: m.id,
    imageTokens: m.imageTokens,
  }));

  for (const de of depthEntries) {
    const insertIdx = Math.max(0, historyMessages.length - de.depth);
    historyMessages.splice(insertIdx, 0, {
      role: de.apiRole,
      content: de.content,
    });
  }

  let contHistoryStart = contextMessages.length;
  contextMessages.push(...historyMessages);

  // Triggered lorebook entries now flow through buildDepthEntries (injected at depth 0 by default).
  // No separate lorebook message block needed — they're already in the history above.

  // Format instructions (only if variables/audio). History INCLUDES the partial
  // assistant message being continued, so its changes read as "already applied
  // this turn" — exactly the trace that stops the continuation re-emitting them.
  const contLastTurnChanges = await loadLastTurnChanges(currentRunHistory);
  const contFormatBlock = promptBuilder.buildFormatBlock(worldDef, snapshot, contLastTurnChanges);
  if (contFormatBlock) {
    contextMessages.push({ role: "system", content: contFormatBlock });
  }

  const contPostHistory = promptBuilder.buildPostHistoryEntries(worldDef, snapshot, matchedEntries, activeUserPrompts);
  for (const entry of contPostHistory) {
    contextMessages.push({ role: entry.apiRole, content: entry.content });
  }

  const contAntiRepetitionInstruction = antiRepetitionInstructionForModel(model);
  if (contAntiRepetitionInstruction) {
    contextMessages.push({ role: "system", content: contAntiRepetitionInstruction });
  }

  const contSuffixCount = contPostHistory.length + (contFormatBlock ? 1 : 0) + (contAntiRepetitionInstruction ? 1 : 0);
  // Depth entries and pending context live INSIDE the trim window but are not
  // conversation. Story memory is a budget for what the player said and the
  // AI replied; a world that injects a lot of keyword-triggered lore must not
  // silently shrink it. Measured once and added to the allowance, so the
  // effective cap on real history stays exactly storyMemory.
  const contNonRawHistoryMessages = depthEntries.map((entry) => ({ role: entry.apiRole, content: entry.content }));
  const contHistoryWindowBudget = storyMemory.tokens + estimatePromptMessagesTokens(contNonRawHistoryMessages, model);

  contHistoryStart = await compactTurnOverflowIfNeeded({
    pathLabel: "continue",
    turn: contTurnMemory,
    userId: currentUser.id,
    model,
    maxContext,
    storyMemory: storyMemory.tokens,
    contextMessages,
    historyStart: contHistoryStart,
    suffixCount: contSuffixCount,
    nonRawHistoryMessages: contNonRawHistoryMessages,
    indices: contMemoryIndices,
  });
  const chatMessages = await promptBuilder.buildMessageHistoryAsync(contextMessages, yieldForIO, maxContext - outputContract.reserve, contHistoryStart, contSuffixCount, model, contHistoryWindowBudget);

  // Two-breakpoint caching (see send path for rationale): stable prefix + depth-resilient floor.
  if (outputContract.content) chatMessages.push({ role: "system", content: outputContract.content });
  const contCacheDepthOffset = computeCacheDepthOffset(worldDef);
  const contCacheBreakpointIndex = chatMessages.length - 1 - contSuffixCount - (outputContract.content ? 1 : 0) - contCacheDepthOffset;
  const contBreakpoints = Array.from(new Set([contStablePrefixEnd, contCacheBreakpointIndex].filter((i) => i >= 0))).sort((a, b) => a - b);

  // The last message in chatMessages should be the assistant's existing content.
  // This signals the AI to continue from that point (partial assistant turn / prefill).

  const provider = resolved.provider;
  const startTime = Date.now();
  const providerMessages = await restoreChatImages(sessionId, chatMessages);
  if (turnNeedsVision(providerMessages)) await assertImageModel(resolved, model);
  const existingContent = lastAssistantMsg.content;
  const abortController = new AbortController();
  // Registered for the SIGTERM drain — deploys wait for this generation (up
  // to ~50s) instead of killing it mid-stream. See lib/stream-registry.ts.
  // Session-keyed so the stop endpoint can abort it.
  const unregisterStream = registerStream(abortController, sessionId);
  const outputAttempt = new TurnOutputAttempt({ dispatch: contTurnMemory.dispatch, userId: currentUser.id, sessionId: sessionId, targetId: lastAssistantMsg.id, path: "continue", world: worldDef, baseline: gameState, model, apiKeyTier: resolved.apiKeyTier, startedAt: startTime, worldVersion: context.worldVersion, pendingVersion: context.pendingVersion, signal: abortController.signal, worldId: context.session.worldId, checkPending: viewerSeesWorkingCopy(context.worldStatus, context.worldCreatorId, currentUser.id) });

  // Mid-stream credit tracking for continue (mirrors send path)
  const contPromptChars = imagePromptChars(providerMessages);
  const contTracker = useProtections && !planConfig.unlimited
    ? await MidStreamTracker.create({
        ctx: { wallet: { ...walletCheck!.wallet, balance: walletCheck!.balance }, plan: userPlan, planConfig, protected: true, concurrencyHeld: true },
        model,
        promptChars: contPromptChars,
      })
    : null;

  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    // Disconnects don't abort generation — see the send path. Explicit stops
    // arrive via the stop endpoint (USER_STOP_ABORT_REASON).
    let clientGone = false;
    stream.onAbort(() => { clientGone = true; });
    const sse = async (message: Parameters<SSEStreamingApi["writeSSE"]>[0]): Promise<void> => {
      if (clientGone) return;
      try {
        await stream.writeSSE(message);
      } catch {
        clientGone = true;
      }
    };

    let continuationContent = "";
    // Guards the trial refund in the catch below — see the send path.
    let replyPersisted = false;
    const structuredParser = new StructuredResponseParser();
    const segmentExtractor = new IncrementalSegmentExtractor();
    const thinkingFilter = new ThinkingTagFilter();
    const receiptFilter = new StateReceiptFilter();

    const stopKeepalive = startKeepalive(stream);
    let actualModel = model;
    // OpenRouter generation id seen on streamed chunks — lets an explicit stop
    // be settled against the provider's billed cost (lib/stopped-generation.ts).
    let observedProviderRequestId: string | undefined;
    let pendingFallbackError: ReturnType<typeof modelFallbackError> = null;
    let correctionModel = model;
    // Set when Yumina Free's pool was exhausted upstream and the provider
    // re-ran this turn on the paid fallback. It keeps the turn billed at
    // Free's zero rate — see FREE_ROUTER_FALLBACK_MODEL.
    let freeRouterFallbackServed = false;

    try {
      await outputAttempt.begin();
      if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });
      for await (const chunk of provider.generateStream({
        conversationId: `play:${sessionId}`,
        model,
        messages: providerMessages,
        maxTokens: contClamp(body.overrides?.maxTokens ?? worldDef.settings?.maxTokens ?? 4096, 256, 32768),
        temperature: contClamp(body.overrides?.temperature ?? worldDef.settings?.temperature ?? 1.0, 0, 2),
        topP: body.overrides?.topP ?? worldDef.settings?.topP,
        frequencyPenalty: body.overrides?.frequencyPenalty ?? worldDef.settings?.frequencyPenalty,
        presencePenalty: body.overrides?.presencePenalty ?? worldDef.settings?.presencePenalty,
        repetitionPenalty: contAntiRepetitionInstruction
          ? body.overrides?.repetitionPenalty
          : undefined,
        topK: body.overrides?.topK ?? worldDef.settings?.topK,
        minP: body.overrides?.minP ?? worldDef.settings?.minP,
        reasoningEffort: body.overrides?.reasoningEffort,
        stream: body.overrides?.streaming,
        ...(worldDef.settings?.structuredOutput && { responseFormat: { type: "json_object" as const } }),
        ...(contBreakpoints.length > 0 && { cacheBreakpoints: contBreakpoints }),
        fallbackModels: contAntiRepetitionInstruction
          ? undefined
          : getOfficialProviderFallbackModels(
              model,
              resolved.isByok,
              turnNeedsVision(providerMessages),
            ),
        fallbackOnTransientErrors: allowsTransientFallback(model, resolved.isByok),
        signal: abortController.signal,
      })) {
        if (chunk.model) {
          correctionModel = chunk.model;
          if (isFreeRouterFallback(model, chunk.model)) {
            // Deliberately do NOT promote chunk.model here: leaving actualModel
            // as openrouter/free is what keeps the turn free (0/0 pricing) and
            // labelled "Yumina Free" in the UI, so the player never sees — or
            // pays for — the downgrade.
            if (!freeRouterFallbackServed) {
              freeRouterFallbackServed = true;
              captureServerEvent(currentUser.id, "free_pool_fallback", {
                requested_model: model,
                served_model: chunk.model,
              });
            }
          } else {
            actualModel = chunk.model;
          }
        }
        if (chunk.type === "reasoning") {
          await sse({
            event: "reasoning",
            data: JSON.stringify({ content: chunk.content }),
          });
        }

        if (chunk.type === "text") {
          if (chunk.providerRequestId) observedProviderRequestId = chunk.providerRequestId;
          continuationContent += chunk.content;

          // Mid-stream credit check: ran dry mid-reply. End cleanly with a
          // NO_CREDITS error (out-of-mushies toast + popup) instead of the old
          // `break`, which skipped the catch handler and surfaced as a silent
          // "connection lost". Don't charge for an unusable partial; log only.
          // track() still runs on trial turns (the catch path logs its char
          // count) but a trial-paid turn must never abort on wallet balance.
          if (contTracker?.track(chunk.content.length) && !grokTrialBypass) {
            abortController.abort();
            await recordUsageLog({
              ...usageObservation(undefined),
              analyticsWorldId: context.session.worldId,
              id: crypto.randomUUID(), userId: currentUser.id, sessionId, model,
              promptTokens: estimateTokensFromChars(contPromptChars),
              completionTokens: estimateTokensFromChars(contTracker.streamedChars),
              totalTokens: estimateTokensFromChars(contPromptChars) + estimateTokensFromChars(contTracker.streamedChars),
              endpoint: "continue", apiKeyTier: resolved.apiKeyTier, generationTimeMs: Date.now() - startTime,
            });
            recordWallHit({ userId: currentUser.id, plan: userPlan, planVersion: walletCheck?.wallet.planVersion, balance: 0, model: actualModel, endpoint: "continue", stage: "mid_stream" });
            await sse({
              event: "error",
              data: JSON.stringify({
                error: "You ran out of mushies partway through this reply. Top up or check in for more.",
                code: "NO_CREDITS",
                balance: 0,
              }),
            });
            return;
          }

          const filtered = receiptFilter.push(thinkingFilter.push(chunk.content));
          if (filtered) {
            await sse({
              event: "text",
              data: JSON.stringify({ content: filtered }),
            });
          }

          // Emit segment/bg events during streaming
          const extraction = segmentExtractor.extract(continuationContent);
          for (const segment of extraction.newSegments) {
            await sse({
              event: "segment",
              data: JSON.stringify({ segment }),
            });
          }
          if (extraction.bg) {
            await sse({
              event: "bg",
              data: JSON.stringify({ bg: extraction.bg }),
            });
          }
        }

        if (chunk.type === "error") {
          const fallbackError = modelFallbackError(chunk, model, continuationContent, resolved.isByok);
          if (fallbackError) {
            await refundTrialIfClaimed();
            pendingFallbackError = fallbackError;
            return;
          }
          await sse({
            event: "error",
            data: JSON.stringify({ error: chunk.content }),
          });
          return;
        }

        if (chunk.type === "done") {
          if (replyPersisted) break;
          // Explicit user stop only — disconnects keep generating and persist.
          if (isClientAbort(abortController.signal)) {
            console.log("[Messages] Continue completed after user stop; skipping persistence");
            void settleStoppedGeneration({
              userId: currentUser.id, sessionId: sessionId, worldId: context.session.worldId, endpoint: "continue",
              model: actualModel, apiKeyTier: resolved.apiKeyTier,
              providerRequestId: chunk.usage?.providerRequestId ?? observedProviderRequestId,
              promptChars: contPromptChars, outputChars: continuationContent.length, generationTimeMs: Date.now() - startTime,
              chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
              knownUsage: chunk.usage,
            });
            return;
          }

          const generationTimeMs = Date.now() - startTime;

          // Parse the continuation — use structured parser for JSON responses, regex for others
          const legacyParsed = structuredParser.isStructuredResponse(continuationContent)
            ? structuredParser.parse(continuationContent)
            : responseParser.parse(continuationContent);
          const { parsed: contParseResult } = await outputAttempt.validate({
            world: worldDef, state: stateManager.getSnapshot(), raw: continuationContent, parsed: legacyParsed,
            provider: provider, model: correctionModel, maxContext: maxContext, signal: abortController.signal,
            stopReason: chunk.stopReason, history: providerMessages,
            cacheEnabled: contBreakpoints.length > 0, stream: body.overrides?.streaming,
          }, async (audit) => { await sse({ event: "state-validation", data: JSON.stringify(audit) }); });
          const cleanContinuation = contParseResult.cleanText;
          const effects = contParseResult.effects;
          const contAudioEffects = filterAiAudioEffects(worldDef.audioTracks ?? [], contParseResult.audioEffects);

          // See main send path: don't charge for invisible work.
          const hasVisibleContent = continuationContent.trim().length > 0;

          // See main send path: AI directives only touch AI-writable vars.
          const contWriteFilter = filterAiEffects(worldDef, stateManager.getSnapshot(), effects);
          if (contWriteFilter.dropped.length > 0) {
            console.log(`[Messages] Dropped ${contWriteFilter.dropped.length} AI directive(s) to non-AI-writable vars: ${contWriteFilter.dropped.map((e) => e.variableId).join(", ")}`);
          }
          const changes = stateManager.applyEffects(contWriteFilter.kept);
          // A refused write is a model fumbling JSON syntax over a whole list
          // (`[items: set delete 1, delete 0]`). The engine keeps the old value;
          // say so, because the failure is otherwise invisible until a player
          // notices their inventory is gone.
          const rejectedWrites = stateManager.drainRejectedWrites();
          if (rejectedWrites.length > 0) {
            console.log(`[Messages] Refused ${rejectedWrites.length} malformed JSON write(s): ${rejectedWrites.map((w) => w.variableId).join(", ")}`);
          }
          outputAttempt.audit.appliedCount = changes.length;

          // Evaluate reactions via event-based dispatch (continue: no user message)
          const contEvents: GameEvent[] = [
            buildMessageAIEvent(cleanContinuation),
            buildTurnCompleteEvent(stateManager.getSnapshot().turnCount),
          ];
          for (const change of changes) {
            contEvents.push({ type: "state:changed", variableId: change.variableId, oldValue: change.oldValue, newValue: change.newValue });
          }
          const contSystemResult = runReactionChain(
            reactionEvaluator,
            stateManager,
            contEvents,
            worldDef.reactions ?? [],
            worldDef.rules ?? [],
          );
          const ruleChanges = contSystemResult.changes;
          const allChanges = [...changes, ...ruleChanges];
          outputAttempt.recordChanges(changes, ruleChanges);

          const allAudioEffects = [...contAudioEffects, ...contSystemResult.audioEffects];
          // Persist the looping subset only — see the send path for why.
          const resumableContAudio = filterResumableAudioEffects(worldDef.audioTracks ?? [], allAudioEffects);
          if (resumableContAudio.length > 0) {
            stateManager.setMetadata("activeAudio", resumableContAudio);
          }
          if (contSystemResult.contextMessages.length > 0) {
            stateManager.setMetadata("pendingContext", contSystemResult.contextMessages);
          }

          const finalState = stateManager.getSnapshot();

          const repetition = contAntiRepetitionInstruction
            ? detectDegenerateRepetitionForModel(model, cleanContinuation, [existingContent])
            : null;
          if (repetition) {
            console.warn(
              `[Messages] Rejected repetitive ${model} continuation (${repetition.reason}, ${repetition.occurrences}x, ${cleanContinuation.length} chars)`,
            );
            captureServerEvent(currentUser.id, "llm_repetitive_output", {
              model,
              endpoint: "continue",
              reason: repetition.reason,
              occurrences: repetition.occurrences,
              chars: cleanContinuation.length,
              session_id: sessionId,
            });
            await recordUsageLog({
              ...usageObservation(chunk.usage),
              analyticsWorldId: context.session.worldId,
              id: crypto.randomUUID(), userId: currentUser.id, sessionId, model: actualModel,
              promptTokens: chunk.usage?.promptTokens ?? 0,
              completionTokens: chunk.usage?.completionTokens ?? 0,
              totalTokens: chunk.usage?.totalTokens ?? 0,
              endpoint: "continue_repetitive", apiKeyTier: resolved.apiKeyTier, generationTimeMs,
            });
            await sse({
              event: "error",
              data: JSON.stringify({
                error: "The model fell into a repetition loop. The continuation was discarded and no Yumina mushies were charged. Please try again or use another model.",
                code: "REPETITIVE_REPLY",
              }),
            });
            return;
          }

          // The final content is existing clean text + clean continuation
          const finalContent = existingContent + cleanContinuation;

          // Re-read message from DB to get current swipe state (user may have switched swipes during streaming)
          const freshMsgRows = await db
            .select()
            .from(messages)
            .where(eq(messages.id, lastAssistantMsg.id));
          const freshMsg = freshMsgRows[0] ?? lastAssistantMsg;

          const existingSwipes = (freshMsg.swipes ?? []) as SwipeWithUsage[];
          const activeSwipeIndex = freshMsg.activeSwipeIndex ?? 0;
          const updatedSwipes =
            existingSwipes.length > 0
              ? existingSwipes.map((swipe, index) =>
                  index === activeSwipeIndex
                    ? {
                        ...swipe,
                        content: finalContent,
                        rawContent: (swipe.rawContent ?? "") + continuationContent,
                        stateValidation: outputAttempt.enabled ? outputAttempt.audit : undefined,
                        stateChanges: appendTurnStateChanges(swipe.stateChanges, allChanges),
                        stateSnapshot: thinSnapshotForStorage(
                          finalState as unknown as Record<string, unknown>,
                        ),
                        tokenCount:
                          (swipe.tokenCount ?? 0) +
                          (chunk.usage?.totalTokens ?? 0),
                        model: actualModel ?? swipe.model,
                        modelFallback: parseModelFallbackRecord(body.modelFallback, model) ?? swipe.modelFallback,
                      }
                    : swipe
                )
              : [
                  {
                    content: finalContent,
                    rawContent: continuationContent,
                    stateValidation: outputAttempt.enabled ? outputAttempt.audit : undefined,
                    stateChanges: appendTurnStateChanges(lastAssistantMsg.stateChanges, allChanges),
                    stateSnapshot: thinSnapshotForStorage(
                      finalState as unknown as Record<string, unknown>,
                    ),
                    createdAt: new Date().toISOString(),
                    modelFallback: parseModelFallbackRecord(body.modelFallback, model),
                    model: actualModel,
                    tokenCount: chunk.usage?.totalTokens,
                  },
                ];

          if (isClientAbort(abortController.signal)) {
            console.log("[Messages] User stopped before continue save; skipping persistence");
            void settleStoppedGeneration({
              userId: currentUser.id, sessionId: sessionId, worldId: context.session.worldId, endpoint: "continue",
              model: actualModel, apiKeyTier: resolved.apiKeyTier,
              providerRequestId: chunk.usage?.providerRequestId ?? observedProviderRequestId,
              promptChars: contPromptChars, outputChars: continuationContent.length, generationTimeMs: Date.now() - startTime,
              chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
              knownUsage: chunk.usage,
            });
            return;
          }

          const originalSwipe = existingSwipes[activeSwipeIndex];
          const previousRows = !originalSwipe?.generationState && lastAssistantMsg.createdAt
            ? await db.select({ stateSnapshot: messages.stateSnapshot }).from(messages)
              .where(and(eq(messages.sessionId, sessionId), eq(messages.role, "assistant"), lt(messages.createdAt, lastAssistantMsg.createdAt)))
              .orderBy(desc(messages.createdAt)).limit(1)
            : [];
          const originalBaseline = regenerationState(worldDef, gameState, {
            generationState: originalSwipe?.generationState,
            stateSnapshot: originalSwipe?.stateSnapshot ?? lastAssistantMsg.stateSnapshot,
            stateChanges: originalSwipe?.stateChanges ?? lastAssistantMsg.stateChanges,
          }, previousRows[0]?.stateSnapshot);

          if (useProtections && !planConfig.unlimited && hasVisibleContent && !(grokTrialBypass && actualModel === GROK_TRIAL_MODEL)
            && ((chunk.usage?.promptTokens ?? 0) > 0 || (chunk.usage?.completionTokens ?? 0) > 0)
            && chunk.stopReason !== "content_filter" && chunk.stopReason !== "SAFETY") {
            await outputAttempt.prepareStoryCharge({ model: actualModel, promptTokens: chunk.usage?.promptTokens ?? 0,
              completionTokens: chunk.usage?.completionTokens ?? 0, providerCostUsd: freeRouterFallbackServed ? undefined : chunk.usage?.providerCostUsd });
          }
          // Update the existing assistant message + session state atomically.
          // Same lost-update guard as the send path: a card's PATCH /:id/state
          // burst can land while this continuation streams, so reconcile
          // against the live row instead of overwriting it.
          const persistedState = await db.transaction(async (tx) => {
            const lockedSession = await tx.execute(
              sql`SELECT state FROM play_sessions WHERE id = ${sessionId} FOR UPDATE`,
            );
            const liveState = (lockedSession.rows[0] as { state: Record<string, unknown> } | undefined)?.state;
            await outputAttempt.checkCommit(tx, liveState, finalState);
            const turnState = reconcileTurnState(worldDef, liveState, gameState, finalState);
            const generationSnapshot = thinSnapshotForStorage(
              generationBaseline(worldDef, liveState, gameState, originalBaseline, finalState) as unknown as Record<string, unknown>,
            );
            const turnSnapshot = thinSnapshotForStorage(
              turnState as unknown as Record<string, unknown>,
            );
            await tx
              .update(messages)
              .set({
                content: finalContent,
                stateValidation: outputAttempt.enabled ? outputAttempt.audit : null,
                stateChanges: appendTurnStateChanges(lastAssistantMsg.stateChanges, allChanges),
                stateSnapshot: turnSnapshot,
                swipes: updatedSwipes.map((swipe, index) =>
                  index === (existingSwipes.length > 0 ? activeSwipeIndex : 0)
                    ? { ...swipe, stateSnapshot: turnSnapshot, generationState: generationSnapshot }
                    : swipe,
                ),
                activeSwipeIndex:
                  existingSwipes.length > 0 ? activeSwipeIndex : 0,
                tokenCount: (lastAssistantMsg.tokenCount ?? 0) + (chunk.usage?.totalTokens ?? 0),
                generationTimeMs: (lastAssistantMsg.generationTimeMs ?? 0) + generationTimeMs,
              })
              .where(eq(messages.id, lastAssistantMsg.id));

            await tx
              .update(playSessions)
              .set({
                state: turnState as unknown as Record<string, unknown>,
                updatedAt: new Date(),
              })
              .where(eq(playSessions.id, sessionId));
            return turnState;
          });
          replyPersisted = true;
          outputAttempt.markCommitted();
          if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });

          // Always log usage (including BYOK) for admin visibility
          const usageLogId = outputAttempt.trackNarrativeUsage();
          const pTokens = chunk.usage?.promptTokens ?? 0;
          const cTokens = chunk.usage?.completionTokens ?? 0;
          await recordUsageLog({
              ...usageObservation(chunk.usage),
              analyticsWorldId: context.session.worldId,
            id: usageLogId,
            userId: currentUser.id,
            sessionId,
            model: actualModel,
            promptTokens: pTokens,
            completionTokens: cTokens,
            totalTokens: chunk.usage?.totalTokens ?? 0,
            endpoint: hasVisibleContent ? "continue" : "continue_empty",
            apiKeyTier: resolved.apiKeyTier,
            generationTimeMs,
          });

          let creditsCost: number | undefined;
          let creditsBalance: number | undefined;
          let grokTrialUsed = false;
          const wasFiltered = chunk.stopReason === "content_filter" || chunk.stopReason === "SAFETY";
          if (outputAttempt.storyCharge) {
            await refundTrialIfClaimed();
            creditsCost = outputAttempt.storyCharge.cost;
            creditsBalance = outputAttempt.storyCharge.balance;
          } else if (useProtections && !planConfig.unlimited && !isClientAbort(abortController.signal) && !wasFiltered && (pTokens > 0 || cTokens > 0) && hasVisibleContent) {
            if (grokTrialBypass && actualModel === GROK_TRIAL_MODEL) {
              try {
                const wallet = await db.select({ id: creditWallets.id, balance: creditWallets.balance })
                  .from(creditWallets).where(eq(creditWallets.userId, currentUser.id)).then((r) => r[0]);
                if (wallet) {
                  await insertHashedTransaction({ walletId: wallet.id, amount: 0, type: "usage", balanceAfter: wallet.balance, description: "Free trial — Claude Sonnet 4.6", referenceId: usageLogId });
                  creditsCost = 0; creditsBalance = wallet.balance; grokTrialUsed = true;
                }
              } catch (err) { console.error("[GrokTrial] Failed to log trial:", err instanceof Error ? err.message : err); }
            }
            if (!grokTrialUsed) {
              // A trial was claimed but a non-trial model served the reply
              // (provider fallback, e.g. gemini-2.5-flash) — hand the trial use
              // back; the normal deduction below charges for the fallback model.
              await refundTrialIfClaimed();
              try {
                const cost = await calculateCost(actualModel, pTokens, cTokens, {
                  // On a free-pool fallback the upstream cost is real (the
                  // fallback is a paid model) and would override Free's 0/0
                  // table price, silently charging for a turn the player asked
                  // for as free. Drop it so the 0/0 rate is what applies.
                  providerCostUsd: freeRouterFallbackServed ? undefined : chunk.usage?.providerCostUsd,
                });
                const result = await deductCredits(
                  currentUser.id, cost, usageLogId,
                  `${actualModel} — ${pTokens + cTokens} tokens (continue)`,
                );
                creditsCost = cost;
                creditsBalance = result.newBalance;
              } catch (err) {
                console.error("[Credit] Deduction failed:", err instanceof Error ? err.message : err);
              }
            }
          }
          if (creditsCost == null && (!useProtections || planConfig.unlimited || isClientAbort(abortController.signal) || wasFiltered || (pTokens <= 0 && cTokens <= 0) || !hasVisibleContent)) {
            creditsCost = 0;
            creditsBalance = walletCheck?.balance;
          }
          // A paid correction can use Yumina while the story uses BYOK/free.
          creditsBalance = creditsCost ? creditsBalance ?? outputAttempt.correctionBalance : outputAttempt.correctionBalance ?? creditsBalance;
          if (creditsCost != null) {
            await persistSwipeCredits(
              lastAssistantMsg.id,
              existingSwipes.length > 0 ? activeSwipeIndex : 0,
              creditsCost,
              creditsBalance,
              "add",
            );
          }

          scheduleTurnMemoryUpdates({
            turn: contTurnMemory,
            sessionId,
            userId: currentUser.id,
            userMessage: currentRunHistory.slice().reverse().find((m) => m.role === "user")?.content ?? "",
            assistantMessage: cleanContinuation,
            state: persistedState,
            fallbackModel: actualModel,
            assistantMessageId: lastAssistantMsg.id,
            contextTokenLimit: maxContext,
          });

          await sse({
            event: "done",
            data: JSON.stringify({
              messageId: lastAssistantMsg.id,
              content: finalContent,
              stateChanges: allChanges,
              state: persistedState,
              model: actualModel,
              modelFallback: parseModelFallbackRecord(body.modelFallback, model),
              tokenCount: chunk.usage?.totalTokens ?? null,
              generationTimeMs,
              audioEffects: allAudioEffects.length > 0 ? allAudioEffects : undefined,
              notifications: contSystemResult.notifications.length > 0 ? contSystemResult.notifications : undefined,
              credits: creditsPayload(creditsCost, creditsBalance),
            }),
          });
        }
      }
    } catch (err) {
      // Mid-stream credit exhaustion is handled inline above (clean NO_CREDITS
      // + return), so it never reaches this catch.
      if (isClientAbort(abortController.signal)) {
        void settleStoppedGeneration({
          userId: currentUser.id, sessionId: sessionId, worldId: context.session.worldId, endpoint: "continue",
          model: actualModel, apiKeyTier: resolved.apiKeyTier,
          providerRequestId: observedProviderRequestId,
          promptChars: contPromptChars, outputChars: continuationContent.length, generationTimeMs: Date.now() - startTime,
          chargeable: useProtections && !planConfig.unlimited && !freeRouterFallbackServed && !grokTrialBypass,
          knownUsage: undefined,
        });
        return;
      }
      // No reply was delivered for this turn — hand back a claimed Sonnet trial.
      if (!replyPersisted) await refundTrialIfClaimed();
      // A shutdown abort (deploy drain) falls through: log the partial usage
      // and tell the client cleanly instead of leaving a dead connection.
      const isShutdown = isShutdownAbort(abortController.signal);
      // Upstream error or network failure mid-stream. Policy (2026-05-14):
      // do NOT charge — log usage for failure-rate tracking, but eat the cost.
      if (contTracker?.active && contTracker.streamedChars > 0) {
        const usageLogId = outputAttempt.trackNarrativeUsage();
        await recordUsageLog({
              ...usageObservation(undefined),
              analyticsWorldId: context.session.worldId,
          id: usageLogId, userId: currentUser.id, sessionId, model,
          promptTokens: estimateTokensFromChars(contPromptChars),
          completionTokens: estimateTokensFromChars(contTracker.streamedChars),
          totalTokens: estimateTokensFromChars(contPromptChars) + estimateTokensFromChars(contTracker.streamedChars),
          endpoint: "continue", apiKeyTier: resolved.apiKeyTier, generationTimeMs: Date.now() - startTime,
        });
      }
      try {
        await sse({
          event: "error",
          data: JSON.stringify({
            error: isShutdown
              ? "Server is restarting — your reply was interrupted. Please resend."
              : err instanceof Error ? err.message : "Continue failed",
            ...(isShutdown && { code: "SERVER_RESTART" }),
          }),
        });
      } catch { /* client disconnected */ }
    } finally {
      await outputAttempt.finish(abortController.signal).catch((error) => console.warn("[StateGuard] Failed to persist final audit", error instanceof Error ? error.name : "error"));
      if (outputAttempt.started) await sse({ event: "state-validation", data: JSON.stringify(outputAttempt.audit) });
      if (!replyPersisted) await refundTrialIfClaimed();
      unregisterStream();
      stopKeepalive();
      if (useProtections) await releaseConcurrency(currentUser.id);
      if (pendingFallbackError) {
        await sse({ event: "error", data: JSON.stringify(pendingFallbackError) });
      }
    }
  });
  } catch (err) {
    if (useProtections) await releaseConcurrency(currentUser.id);
    await refundTrialIfClaimed();
    if (err instanceof Error && err.name === "ImageModelError") return c.json({ error: err.message, code: "IMAGE_MODEL_REQUIRED" }, 400);
    throw err;
  }
});

// POST /api/messages/:id/swipe — switch to a specific swipe index or generate new
messageRoutes.post("/messages/:id/swipe", async (c) => {
  const currentUser = c.get("user");
  const messageId = c.req.param("id");
  const body = await c.req.json<{ direction?: "left" | "right"; index?: number }>();

  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId));

  if (msgRows.length === 0 || msgRows[0]!.role !== "assistant") {
    return c.json({ error: "Assistant message not found" }, 404);
  }

  const msg = msgRows[0]!;
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.id, msg.sessionId),
        eq(playSessions.userId, currentUser.id)
      )
    );

  if (sessionRows.length === 0) {
    return c.json({ error: "Not authorized" }, 403);
  }

  // Index-based swipe: allow jumping to any swipe on any message (used by switchGreeting)
  if (typeof body.index === "number") {
    const swipes = (msg.swipes ?? []) as Array<{
      content: string;
      stateValidation?: StateValidationAudit;
      stateChanges?: Record<string, unknown>;
      stateSnapshot?: Record<string, unknown>;
      createdAt: string;
      model?: string;
      tokenCount?: number;
    }>;
    const targetIndex = body.index;
    if (targetIndex < 0 || targetIndex >= swipes.length) {
      return c.json({ error: `Swipe index out of range (0-${swipes.length - 1})` }, 400);
    }
    const swipe = swipes[targetIndex]!;
    const restoredState = swipe.stateSnapshot ?? null;

    const [updatedMessage] = await db
      .update(messages)
      .set({
        content: swipe.content,
        activeSwipeIndex: targetIndex,
        stateValidation: swipe.stateValidation ?? null,
        stateChanges: swipe.stateChanges ?? null,
        stateSnapshot: restoredState ?? msg.stateSnapshot,
        model: swipe.model ?? null,
        tokenCount: swipe.tokenCount ?? null,
      })
      .where(eq(messages.id, messageId))
      .returning();

    await runExtensionInvalidation(
      { reason: "message-swiped", sessionId: msg.sessionId, messageFlags: updatedMessage ?? msg },
      restoredState ? { state: restoredState } : undefined,
    );

    const currentSessionState = sessionRows[0]!.state as Record<string, unknown>;

    // If this is the session's FIRST message (the greeting), switching openings
    // also adopts that greeting's preset into the live session state, so the
    // chosen route's initialVariables take effect for subsequent turns. Scoped
    // to the first message so mid-conversation swipe-jumps never clobber state.
    let adoptedSessionState: Record<string, unknown> | null = null;
    if (restoredState && msg.createdAt) {
      const earlier = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.sessionId, msg.sessionId), lt(messages.createdAt, msg.createdAt)))
        .limit(1);
      if (earlier.length === 0) {
        // Each opening's snapshot is built from world defaults, so adopting it
        // would wipe setup-scoped choices (e.g. the cast the player picked on a
        // pre-game screen before choosing the opening). Carry those forward —
        // resolving the variable defs from the worldDef THIS viewer plays (the
        // held working copy when the creator playtests their own published card)
        // so a setup-scoped var that exists only in the held draft is still
        // recognised. Reading from live worlds.schema missed it → the K-pop
        // "选X只出X" bug on published cards whose fix was held in draft.
        const worldVariables = (await resolveSessionVariables(
          sessionRows[0]!.worldId,
          currentUser.id,
        )) as Variable[];
        adoptedSessionState = preserveSetupScopedVariables(
          worldVariables,
          currentSessionState as { variables?: Record<string, unknown> },
          restoredState as Record<string, unknown>,
        );
        await db
          .update(playSessions)
          .set({ state: adoptedSessionState })
          .where(eq(playSessions.id, msg.sessionId));
      }
    }

    return c.json({
      data: {
        activeSwipeIndex: targetIndex,
        totalSwipes: swipes.length,
        content: swipe.content,
        stateValidation: swipe.stateValidation ?? null,
        stateChanges: swipe.stateChanges,
        state: adoptedSessionState ?? restoredState ?? currentSessionState,
        stateRestored: !!restoredState,
        model: swipe.model ?? null,
        tokenCount: swipe.tokenCount ?? null,
      },
    });
  }

  // Direction-based swipe: only works on the latest assistant message
  const latestMessageRows = await db
    .select({
      id: messages.id,
      role: messages.role,
    })
    .from(messages)
    .where(eq(messages.sessionId, msg.sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const latestMessage = latestMessageRows[0] ?? null;
  if (!latestMessage || latestMessage.id !== messageId) {
    return c.json({
      error: "Swipe is only supported for the latest assistant message. Revert first if you want to branch from an older point.",
    }, 400);
  }

  const swipes = (msg.swipes ?? []) as Array<{
    content: string;
    stateValidation?: StateValidationAudit;
    stateChanges?: Record<string, unknown>;
    stateSnapshot?: Record<string, unknown>;
    createdAt: string;
    model?: string;
    tokenCount?: number;
  }>;
  const currentIndex = msg.activeSwipeIndex ?? 0;
  const currentSessionState = sessionRows[0]!.state as Record<string, unknown>;

  if (body.direction === "left") {
    if (currentIndex <= 0) {
      return c.json({ error: "Already at first swipe" }, 400);
    }

    const newIndex = currentIndex - 1;
    const swipe = swipes[newIndex]!;
    const restoredState = swipe.stateSnapshot ?? null;

    const [updatedMessage] = await db
      .update(messages)
      .set({
        content: swipe.content,
        activeSwipeIndex: newIndex,
        stateValidation: swipe.stateValidation ?? null,
        stateChanges: swipe.stateChanges ?? null,
        stateSnapshot: restoredState ?? msg.stateSnapshot,
        model: swipe.model ?? null,
        tokenCount: swipe.tokenCount ?? null,
      })
      .where(eq(messages.id, messageId))
      .returning();

    await runExtensionInvalidation(
      { reason: "message-swiped", sessionId: msg.sessionId, messageFlags: updatedMessage ?? msg },
      restoredState ? { state: restoredState } : undefined,
    );

    return c.json({
      data: {
        activeSwipeIndex: newIndex,
        totalSwipes: swipes.length,
        content: swipe.content,
        stateValidation: swipe.stateValidation ?? null,
        stateChanges: swipe.stateChanges,
        state: restoredState ?? currentSessionState,
        stateRestored: !!restoredState,
        model: swipe.model ?? null,
        tokenCount: swipe.tokenCount ?? null,
      },
    });
  }

  // direction === "right"
  if (currentIndex < swipes.length - 1) {
    // Navigate to existing swipe
    const newIndex = currentIndex + 1;
    const swipe = swipes[newIndex]!;
    const restoredState = swipe.stateSnapshot ?? null;

    const [updatedMessage] = await db
      .update(messages)
      .set({
        content: swipe.content,
        activeSwipeIndex: newIndex,
        stateValidation: swipe.stateValidation ?? null,
        stateChanges: swipe.stateChanges ?? null,
        stateSnapshot: restoredState ?? msg.stateSnapshot,
        model: swipe.model ?? null,
        tokenCount: swipe.tokenCount ?? null,
      })
      .where(eq(messages.id, messageId))
      .returning();

    await runExtensionInvalidation(
      { reason: "message-swiped", sessionId: msg.sessionId, messageFlags: updatedMessage ?? msg },
      restoredState ? { state: restoredState } : undefined,
    );

    return c.json({
      data: {
        activeSwipeIndex: newIndex,
        totalSwipes: swipes.length,
        content: swipe.content,
        stateValidation: swipe.stateValidation ?? null,
        stateChanges: swipe.stateChanges,
        state: restoredState ?? currentSessionState,
        stateRestored: !!restoredState,
        model: swipe.model ?? null,
        tokenCount: swipe.tokenCount ?? null,
      },
    });
  }

  // At the end — need to generate a new swipe. Redirect to regenerate.
  // Return a signal that the client should call regenerate instead.
  return c.json({
    data: {
      needsGeneration: true,
      activeSwipeIndex: currentIndex,
      totalSwipes: swipes.length,
    },
  });
});

// ── Model listing with cache and categorization ──

const CURATED_MODEL_IDS = PLAY_MODEL_IDS;

function getProvider(modelId: string): string {
  const prefix = modelId.split("/")[0] ?? "unknown";
  const map: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    "meta-llama": "Meta",
    mistralai: "Mistral",
    deepseek: "DeepSeek",
    cohere: "Cohere",
    "nousresearch": "Nous Research",
    "x-ai": "xAI",
    "z-ai": "Z.ai",
  };
  return map[prefix] ?? prefix;
}

interface CachedModel {
  supportsImages?: boolean;
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  pricing?: { prompt: number; completion: number };
  isCurated: boolean;
  minPlan?: string;
  /** Measured mushies per reply over the last 7 days (lib/model-cost-stats.ts); absent until measured. */
  costStats?: ModelCostStats;
}

// Per-user model cache (in-memory fallback when Redis unavailable)
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const memModelCache = new Map<string, { models: CachedModel[]; expiresAt: number }>();

/** Drop the cached aggregated model list for one user. Call this whenever an
 *  API key (or its model whitelist) changes — otherwise GET /api/models keeps
 *  returning stale data for up to 5 minutes, even after the user just clicked
 *  Connect and pulled a fresh list from upstream. */
export async function invalidateModelCacheForUser(userId: string): Promise<void> {
  memModelCache.delete(userId);
  if (redis) {
    try {
      await redis.del(`models:vision-v1:${userId}`);
    } catch {
      // Cache invalidation is best-effort; the TTL will eventually expire.
    }
  }
}

// Shared cache only; never scan usage logs while opening the picker.
messageRoutes.get("/models/popularity", async (c) => c.json({ data: await getModelPopularity() }));

// GET /api/models — list available models with caching and categorization
messageRoutes.get("/models", async (c) => {
  const currentUser = c.get("user");
  const now = Date.now();
  await ensureOpenRouterCatalog();

  // Check per-user cache (Redis first, then in-memory fallback)
  if (redis) {
    const cached = await redis.get(`models:vision-v1:${currentUser.id}`);
    if (cached) {
      const models: CachedModel[] = JSON.parse(cached);
      const curated = models.filter((m) => m.isCurated);
      return c.json({ data: { curated, all: models } });
    }
  } else {
    const entry = memModelCache.get(currentUser.id);
    if (entry && now < entry.expiresAt) {
      const curated = entry.models.filter((m) => m.isCurated);
      return c.json({ data: { curated, all: entry.models } });
    }
  }

  // Gather keys for all providers the user has
  const rd = await readOwn(currentUser.id);
  const allKeys = await rd
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, currentUser.id));

  if (allKeys.length === 0) {
    // No platform-paid models in this edition: an empty list tells the picker
    // to point the user at Settings -> API keys instead of listing models that
    // could never run.
    if (!edition.info().features.officialModels) {
      return c.json({ data: { curated: [], all: [] } });
    }
    const fallback: CachedModel[] = PLAY_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      provider: getProvider(model.id),
      contextLength: model.contextWindow ?? 0,
      supportsImages: getCatalogImageSupport(model.id),
      minPlan: model.minPlan,
      isCurated: true,
    }));
    const measured = await getModelCostStats();
    for (const m of fallback) { const s = measured.get(m.id); if (s) m.costStats = s; }
    return c.json({ data: { curated: fallback, all: fallback } });
  }

  try {
    const allModels: CachedModel[] = [];

    for (const keyRow of allKeys) {
      try {
        // Custom endpoint: skip calling /models on the proxy — just surface the user's
        // whitelist. The whitelist is what the user actually wants to use, and many
        // proxies either don't expose /models or return inconsistent catalogs.
        if (keyRow.provider === "custom") {
          const metadata = keyRow.metadata as { models?: string[] } | null;
          const whitelist = metadata?.models ?? [];
          for (const modelName of whitelist) {
            const fullId = `custom/${modelName}`;
            allModels.push({
              id: fullId,
              name: modelName,
              provider: "Custom",
              contextLength: 0,
              isCurated: false,
            });
          }
          continue;
        }

        const decrypted = decryptApiKey(keyRow.encryptedKey, keyRow.keyIv, keyRow.keyTag);
        if (!decrypted) continue;
        const llmProvider = createProvider(keyRow.provider as ProviderName, decrypted);
        const rawModels = await llmProvider.listModels();

        for (const m of rawModels) {
          allModels.push({
            id: m.id,
            name: m.name,
            provider: getProvider(m.id),
            contextLength: m.contextLength,
            pricing: m.pricing,
            supportsImages: m.supportsImages ?? (keyRow.provider === "openrouter" ? getCatalogImageSupport(m.id) : undefined),
            isCurated: CURATED_MODEL_IDS.has(m.id),
          });
        }
      } catch {
        // Skip providers that fail to list models
      }
    }

    // Enrich with minPlan from pricing table
    const prices = await getAllModelPrices();
    const priceMap = new Map(prices.map((p) => [p.modelId, p]));
    for (const m of allModels) {
      const price = priceMap.get(m.id);
      if (price) m.minPlan = price.minPlan;
    }
    // Measured per-reply cost (the picker's range). Empty until the first nightly run.
    const measured = await getModelCostStats();
    for (const m of allModels) { const s = measured.get(m.id); if (s) m.costStats = s; }

    // Deduplicate by model ID (prefer the first occurrence)
    const seen = new Set<string>();
    const deduped = allModels.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // Feed any real context windows (direct-BYOK providers report their own;
    // custom proxies report 0 and are skipped) into the shared catalog so the
    // context-budget clamp can use them for this and other users.
    registerContextWindows(deduped);

    // Store in per-user cache
    if (redis) {
      await redis.set(`models:vision-v1:${currentUser.id}`, JSON.stringify(deduped), "EX", Math.ceil(MODEL_CACHE_TTL / 1000));
    } else {
      memModelCache.set(currentUser.id, { models: deduped, expiresAt: now + MODEL_CACHE_TTL });
    }

    const curated = deduped.filter((m) => m.isCurated);
    return c.json({ data: { curated, all: deduped } });
  } catch {
    return c.json({ error: "Failed to fetch models" }, 500);
  }
});

export { messageRoutes };
