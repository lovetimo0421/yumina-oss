// The per-turn memory pipeline shared by the three generation paths
// (send / regenerate / continue) in routes/messages.ts. The pipeline itself is
// extension-agnostic: it resolves the turn's hook dispatch once (entitlement +
// capabilities), collects prompt blocks and history filters from the
// registered extensions, runs the overflow pass through the registry, and
// dispatches post-turn work. The session-memory extension's handlers live in
// src/extensions/session-memory/hooks.ts — adding another extension never
// touches this file or routes/messages.ts.

import { eq, and, lte, desc, sql } from "drizzle-orm";
import { estimateTokens } from "@yumina/engine";
import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { countPromptTokensCooperatively } from "./cooperative-tokens.js";
import {
  collectHistoryConditions,
  collectPromptBlocks,
  hasPromptOverflowHandlers,
  resolveTurnHooks,
  runPromptOverflow,
  runTurnComplete,
  PromptBlockController,
  type BlockPosition,
  type HookSessionRow,
  type PromptBlock,
  type TurnHookDispatch,
} from "./extension-hooks.js";

/** Tokens held back from the raw-history budget so the summary block always fits. */
const STORY_SUMMARY_PROMPT_RESERVE_TOKENS = 3_000;

export type TurnPromptMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  sourceMessageId?: string;
  imageTokens?: number;
};

export interface TurnMemory {
  ownerUserId: string;
  sessionId: string;
  dispatch: TurnHookDispatch;
  /** Collected from contributePromptBlocks, sorted in composition order. */
  blocks: PromptBlock[];
  /** Collected raw-history WHERE conditions (e.g. exclude compacted rows). */
  historyConditions: ReturnType<typeof collectHistoryConditions>;
  /** True when this turn resets the story (send path: character-creation). */
  freshStart: boolean;
}

/**
 * Resolve the turn's hook dispatch (entitlement-gated, once per turn) and
 * collect the extensions' prompt blocks + history filters.
 */
export async function loadTurnMemoryBlocks(args: {
  ownerUserId: string;
  sessionId: string;
  session: HookSessionRow;
  suppressSummaryBlocks?: boolean;
}): Promise<TurnMemory> {
  const freshStart = args.suppressSummaryBlocks === true;
  const baseCtx = { ownerUserId: args.ownerUserId, sessionId: args.sessionId, session: args.session };
  const dispatch = await resolveTurnHooks(baseCtx);
  const blockCtx = { ...baseCtx, freshStart };
  const blocks = await collectPromptBlocks(dispatch, blockCtx);
  const historyConditions = collectHistoryConditions(dispatch, blockCtx);
  return {
    ownerUserId: args.ownerUserId,
    sessionId: args.sessionId,
    dispatch,
    blocks,
    historyConditions,
    freshStart,
  };
}

/** Raw-history WHERE: session scope + every extension-contributed condition. */
export function buildRawHistoryWhere(sessionId: string, turn: Pick<TurnMemory, "historyConditions">) {
  return and(eq(messages.sessionId, sessionId), ...turn.historyConditions);
}

/** Hard cap on raw-history rows loaded per generation. The prompt clamp keeps
 *  only the recent tail that fits maxContext anyway, but the LOAD used to be
 *  unbounded — mega sessions (9k-12k uncompacted rows, 8-17MB) turned every
 *  send into a multi-MB fetch + object churn on the event loop and fed the
 *  full-history token estimate in compactTurnOverflowIfNeeded (2026-08-11
 *  outage). 2000 rows comfortably covers the deepest realistic context. */
export const RAW_HISTORY_MAX_ROWS = 2000;

/**
 * Load the newest RAW_HISTORY_MAX_ROWS candidate history rows, ascending.
 * Shared by the send / regenerate / continue prompt paths. `upTo` bounds the
 * window to rows at-or-before a known message timestamp (regenerate loads
 * history up to the message being regenerated — the target row itself is
 * included, callers slice it off by id).
 */
export async function loadBoundedRawHistory(
  sessionId: string,
  turn: Pick<TurnMemory, "historyConditions">,
  opts?: { upTo?: Date },
): Promise<Array<{ id: string; role: string; content: string; imageTokens: number; createdAt: Date | null }>> {
  const where = opts?.upTo
    ? and(buildRawHistoryWhere(sessionId, turn), lte(messages.createdAt, opts.upTo))
    : buildRawHistoryWhere(sessionId, turn);
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      imageTokens: sql<number>`COALESCE(jsonb_array_length(${messages.attachments}), 0) * 1600`,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(RAW_HISTORY_MAX_ROWS);
  return rows.reverse();
}

export interface MemoryBlockIndices {
  positions: Map<string, BlockPosition>;
}

/**
 * Append the collected blocks to the context in composition order, recording
 * each block's position (or reserved insert point when currently empty) so
 * the overflow pass can re-target blocks in place.
 */
export function injectMemoryPromptBlocks(
  contextMessages: TurnPromptMessage[],
  turn: Pick<TurnMemory, "blocks">,
): MemoryBlockIndices {
  const positions = new Map<string, BlockPosition>();
  let rank = 0;
  for (const block of turn.blocks) {
    const insertIndex = contextMessages.length;
    let index: number | null = null;
    if (block.content) {
      index = contextMessages.length;
      contextMessages.push({ role: "system", content: block.content });
    }
    positions.set(block.id, { index, insertIndex, rank });
    rank += 1;
  }
  return { positions };
}

function estimatePromptMessageTokens(message: Pick<TurnPromptMessage, "content" | "imageTokens">, modelId: string): number {
  return estimateTokens(message.content, modelId) + (message.imageTokens ?? 0);
}

export function estimatePromptMessagesTokens(
  messageList: Array<Pick<TurnPromptMessage, "content" | "imageTokens">>,
  modelId: string,
): number {
  return messageList.reduce((total, message) => total + estimatePromptMessageTokens(message, modelId), 0);
}

async function estimateFinalRawHistoryBudget(args: {
  messages: TurnPromptMessage[];
  maxContext: number;
  /** Story-memory ceiling on the raw conversation, when the turn has one. */
  storyMemory?: number;
  historyStart: number;
  suffixCount: number;
  modelId: string;
  nonRawHistoryMessages?: TurnPromptMessage[];
}): Promise<{ budget: number; nonRawHistoryTokens: number }> {
  const suffixStart = args.suffixCount > 0 ? Math.max(args.historyStart, args.messages.length - args.suffixCount) : args.messages.length;
  const prefixTokens = await countPromptTokensCooperatively(args.messages.slice(0, args.historyStart), args.modelId);
  const suffixTokens = args.suffixCount > 0
    ? await countPromptTokensCooperatively(args.messages.slice(suffixStart), args.modelId)
    : 0;
  const nonRawHistoryTokens = await countPromptTokensCooperatively(args.nonRawHistoryMessages ?? [], args.modelId);
  // Compaction has to fire on the SAME number the prompt is trimmed to.
  // Budgeting off maxContext alone while the prompt is cut to story memory
  // means the older scenes are dropped rather than folded into the recap,
  // which is exactly the loss the recap exists to prevent.
  const fromContext = args.maxContext - prefixTokens - suffixTokens - nonRawHistoryTokens - STORY_SUMMARY_PROMPT_RESERVE_TOKENS;
  const ceiling = typeof args.storyMemory === "number" && Number.isFinite(args.storyMemory)
    ? Math.min(fromContext, args.storyMemory)
    : fromContext;
  return { budget: Math.max(1, ceiling), nonRawHistoryTokens };
}

/**
 * Final-budget overflow pass: when this prompt's raw history genuinely exceeds
 * its budget, dispatch the extensions' overflow handlers through a
 * PromptBlockController scoped to the in-flight prompt. Handlers must NOT
 * await LLM work here — they schedule background compaction and return; this
 * turn's prompt is handled by trimming (buildMessageHistory) and the repaired
 * summary lands on the NEXT turn. (Awaited compaction once held sends past
 * Cloudflare's 100s origin limit — the 2026-07-11 524 incident.) Handler
 * failures are logged and swallowed.
 */
export async function compactTurnOverflowIfNeeded(args: {
  pathLabel: "send" | "regenerate" | "continue";
  turn: TurnMemory;
  /** Acting user (the one generating this turn). */
  userId: string;
  model: string;
  maxContext: number;
  /** Story-memory ceiling for this turn; undefined = governed by maxContext alone. */
  storyMemory?: number;
  contextMessages: TurnPromptMessage[];
  historyStart: number;
  suffixCount: number;
  nonRawHistoryMessages: TurnPromptMessage[];
  indices: MemoryBlockIndices;
}): Promise<number> {
  const { turn, contextMessages, nonRawHistoryMessages, model, maxContext, suffixCount } = args;
  if (turn.freshStart) return args.historyStart;
  if (!hasPromptOverflowHandlers(turn.dispatch)) return args.historyStart;

  const { budget: finalRawHistoryBudget, nonRawHistoryTokens } = await estimateFinalRawHistoryBudget({
    messages: contextMessages,
    maxContext,
    storyMemory: args.storyMemory,
    historyStart: args.historyStart,
    suffixCount,
    modelId: model,
    nonRawHistoryMessages,
  });
  // Only dispatch the overflow handlers when this prompt's raw history
  // actually exceeds its budget. Under budget, trimming needs no help and
  // the background path keeps the summary fresh.
  const suffixStart = suffixCount > 0 ? Math.max(args.historyStart, contextMessages.length - suffixCount) : contextMessages.length;
  const promptRawHistoryOverflows =
    await countPromptTokensCooperatively(contextMessages.slice(args.historyStart, suffixStart), model, finalRawHistoryBudget + nonRawHistoryTokens)
      - nonRawHistoryTokens
    > finalRawHistoryBudget;
  if (!promptRawHistoryOverflows) return args.historyStart;

  const controller = new PromptBlockController({
    messages: contextMessages,
    positions: args.indices.positions,
    historyStart: args.historyStart,
  });
  await runPromptOverflow(turn.dispatch, {
    ownerUserId: turn.ownerUserId,
    sessionId: turn.sessionId,
    userId: args.userId,
    model,
    maxContext,
    finalPromptRawTokenLimit: finalRawHistoryBudget,
    pathLabel: args.pathLabel,
    blocks: controller,
  });
  return controller.historyStart;
}

/** Post-turn background work (incremental memory update, threshold compaction, …). */
export function scheduleTurnMemoryUpdates(args: {
  turn: TurnMemory;
  sessionId: string;
  userId: string;
  userMessage: string;
  assistantMessage: string;
  state: unknown;
  fallbackModel: string;
  assistantMessageId: string;
  contextTokenLimit: number;
}): void {
  runTurnComplete(args.turn.dispatch, {
    ownerUserId: args.turn.ownerUserId,
    sessionId: args.sessionId,
    userId: args.userId,
    userMessage: args.userMessage,
    assistantMessage: args.assistantMessage,
    state: args.state,
    fallbackModel: args.fallbackModel,
    assistantMessageId: args.assistantMessageId,
    contextTokenLimit: args.contextTokenLimit,
  });
}
