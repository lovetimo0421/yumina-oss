// The server-side extension hook registry — the seams of the message pipeline,
// generalized. First-party extensions register real code handlers here; the
// pipeline (lib/turn-memory.ts) dispatches instead of hardcoding per-feature
// `if` checks, so adding an extension never edits routes/messages.ts.
//
// Contract discipline (see docs/agent-research/extension-system-implementation-plan.md):
// - Hooks RETURN DATA; the trusted dispatcher applies it. The one structured
//   exception is onPromptOverflow, which edits the in-flight prompt only
//   through the narrow PromptBlockController the dispatcher hands it.
// - Entitlement (is the extension installed for this user?) is resolved ONCE
//   per turn by the dispatcher via the Redis-cached gate — handlers never
//   check it themselves.
// - `invalidate` is a DATA-LIFECYCLE seam: it runs even when the extension is
//   uninstalled (matching revert/restart semantics — uninstall keeps data, so
//   stale derived state must still be cleaned when history changes).

import {
  getExtensionDefinition,
  isExtensionApiCompatible,
} from "@yumina/shared";
import { eq, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions } from "../db/schema.js";
import { getInstalledExtensions } from "./extensions.js";
import type { GameState, WorldDefinition } from "@yumina/engine";
import type { StateValidationAudit } from "@yumina/shared";
import type { ParseResult } from "@yumina/engine";
import type { LLMProvider } from "./llm/types.js";

export interface TurnOutputContext {
  world: WorldDefinition;
  state: GameState;
  raw: string;
  parsed: ParseResult;
  provider: LLMProvider;
  model: string;
  maxContext: number;
  /** Preserve the original provider's caching/routing and transport policy. */
  cacheEnabled?: boolean;
  stream?: boolean;
  /** Resolved lazily: valid primary output never needs another provider. */
  resolveCorrection?: () => Promise<{ provider: LLMProvider; model: string; maxContext: number; apiKeyTier: string }>;
  signal: AbortSignal;
  stopReason?: string;
  audit: StateValidationAudit;
  history: Array<{ role: string; content: unknown }>;
  mayCorrect: () => Promise<boolean>;
  progress: (audit: StateValidationAudit) => Promise<void>;
  recordUsage: (usage: { promptTokens: number; completionTokens: number; totalTokens: number; providerCostUsd?: number }, model: string) => Promise<string>;
}

export interface ValidatedTurnOutput { parsed: ParseResult; audit?: StateValidationAudit }

// ─── Contexts ───────────────────────────────────────────────────────

/** Minimal session-row view handlers may read (a subset of playSessions rows). */
export type HookSessionRow = Record<string, unknown>;

export interface ResolveCapabilitiesContext {
  ownerUserId: string;
  sessionId: string;
  session: HookSessionRow;
}

export interface PromptBlockContext extends ResolveCapabilitiesContext {
  /** This extension's active capabilities (its own, not the union). */
  capabilities: ReadonlySet<string>;
  /**
   * True when this turn resets the story (send path: character-creation).
   * Handlers should skip backlog-derived blocks; durable per-session blocks
   * may still contribute.
   */
  freshStart: boolean;
}

export interface PromptBlock {
  /** Stable per-extension block id — the overflow controller re-targets by it. */
  id: string;
  /** Null = nothing to inject now, but the slot position is still reserved. */
  content: string | null;
  /** Composition order across all extensions; lower injects first. */
  priority: number;
}

export interface PromptOverflowContext {
  ownerUserId: string;
  sessionId: string;
  /** Acting user (the one generating this turn). */
  userId: string;
  capabilities: ReadonlySet<string>;
  model: string;
  maxContext: number;
  /** The raw-history token budget this prompt overflowed. */
  finalPromptRawTokenLimit: number;
  pathLabel: "send" | "regenerate" | "continue";
  /** The only sanctioned way to edit the in-flight prompt. */
  blocks: PromptBlockController;
}

export interface TurnCompleteContext {
  ownerUserId: string;
  sessionId: string;
  userId: string;
  capabilities: ReadonlySet<string>;
  userMessage: string;
  assistantMessage: string;
  state: unknown;
  fallbackModel: string;
  assistantMessageId: string;
  contextTokenLimit: number;
}

export type InvalidateReason =
  | "message-edited"
  | "message-deleted"
  | "message-swiped"
  | "character-creation"
  | "session-revert"
  | "session-restart"
  | "checkpoint-restore";

export interface InvalidateContext {
  reason: InvalidateReason;
  sessionId: string;
  /**
   * session-revert only: the acting user, so a handler can eagerly regenerate
   * the tiers it just dropped (from the surviving transcript) rather than
   * leaving them empty until later turns rebuild them.
   */
  userId?: string;
  /** For message-edited/-deleted/-swiped: the changed message's compaction
   *  flags, plus its identity/recency so handlers can scope in-flight-job
   *  aborts to messages a background job could actually cover. Call sites
   *  pass the whole message row, so id/createdAt are present in practice;
   *  handlers must degrade to the conservative path when they're absent. */
  messageFlags?: {
    id?: string;
    createdAt?: Date | null;
    compacted?: boolean | null;
    summaryceptionCompacted?: boolean | null;
  };
  /**
   * session-revert only: the loaded session row, so a coverage-aware handler
   * can read its tier pointers/status (summaryCoversUntilMessageId,
   * sessionMemoryProcessedMessageId, *Status) to decide keep-vs-wipe. Absent
   * elsewhere ⇒ handlers fall back to a full wipe (today's behavior).
   */
  session?: HookSessionRow;
  /**
   * session-revert only: the messages being deleted from the tail. A tier is
   * kept when none of these carry its compaction flag (its stored output
   * covers no removed turn). Absent elsewhere ⇒ full wipe.
   */
  removedMessages?: Array<{ id: string; compacted?: boolean | null; summaryceptionCompacted?: boolean | null }>;
}

/**
 * What an invalidate handler returns. `sessionFields` are merged into the
 * route's own playSessions UPDATE so a state restore + memory reset stays a
 * single atomic write, exactly as the inline code it replaces. `runAfter`
 * runs after that row update (table clears, scoped follow-up updates).
 */
export interface ExtensionInvalidation {
  sessionFields?: Record<string, unknown>;
  runAfter?: () => Promise<void>;
}

export interface ExtensionHookHandlers {
  /** Trusted final instructions, reserved outside the trimmable history. */
  turnOutputInstructions?: () => string;
  /** Awaited, fail-closed, before effects/reactions. Returns data only. */
  validateTurnOutput?: (ctx: TurnOutputContext) => Promise<ValidatedTurnOutput>;
  /** Which of the extension's capabilities are active for this session. */
  /** null disables this extension for this turn (settings snapshot). */
  resolveCapabilities?: (ctx: ResolveCapabilitiesContext) => string[] | null | Promise<string[] | null>;
  resolveOutputModel?: (ctx: ResolveCapabilitiesContext) => string | null;
  contributePromptBlocks?: (ctx: PromptBlockContext) => PromptBlock[] | Promise<PromptBlock[]>;
  /** Extra raw-history WHERE conditions (e.g. exclude compacted messages). */
  filterHistory?: (ctx: PromptBlockContext) => SQL[];
  onPromptOverflow?: (ctx: PromptOverflowContext) => Promise<void>;
  onTurnComplete?: (ctx: TurnCompleteContext) => void;
  invalidate?: (ctx: InvalidateContext) => ExtensionInvalidation;
}

// ─── Registry ───────────────────────────────────────────────────────

const registeredHooks = new Map<string, ExtensionHookHandlers>();

export function registerExtensionHooks(key: string, handlers: ExtensionHookHandlers): void {
  const def = getExtensionDefinition(key);
  if (!def) {
    console.error(`[ExtensionHooks] Refusing to register hooks for unknown extension "${key}"`);
    return;
  }
  if (!isExtensionApiCompatible(def)) {
    console.error(
      `[ExtensionHooks] Refusing to register "${key}" — apiVersion ${def.apiVersion} is outside the supported range`,
    );
    return;
  }
  if (registeredHooks.has(key)) {
    console.warn(`[ExtensionHooks] Hooks for "${key}" registered twice — replacing`);
  }
  registeredHooks.set(key, handlers);
}

/** Test-only: swap the entitlement source. Production always uses the Redis gate. */
type InstalledLookup = (userId: string) => Promise<Set<string>>;
let installedLookup: InstalledLookup = getInstalledExtensions;
export function __setInstalledLookupForTests(lookup: InstalledLookup | null): void {
  installedLookup = lookup ?? getInstalledExtensions;
}

export interface TurnHookDispatch {
  /** Extension key → its active capabilities (installed extensions only). */
  activeExtensions: Map<string, ReadonlySet<string>>;
  outputModels?: Map<string, string>;
}

export function turnOutputInstructions(dispatch: TurnHookDispatch): string {
  return [...dispatch.activeExtensions.keys()].map((key) => registeredHooks.get(key)?.turnOutputInstructions?.() ?? "").filter(Boolean).join("\n\n");
}

export async function validateTurnOutput(dispatch: TurnHookDispatch, ctx: TurnOutputContext): Promise<ValidatedTurnOutput> {
  let result: ValidatedTurnOutput = { parsed: ctx.parsed };
  for (const key of dispatch.activeExtensions.keys()) {
    const validate = registeredHooks.get(key)?.validateTurnOutput;
    if (validate) result = await validate({ ...ctx, parsed: result.parsed });
  }
  return result;
}

/**
 * Resolve entitlement + per-extension capabilities once per turn. The Redis
 * gate is the same one the old inline code consulted, so per-turn latency is
 * unchanged.
 */
export async function resolveTurnHooks(ctx: ResolveCapabilitiesContext): Promise<TurnHookDispatch> {
  const activeExtensions = new Map<string, ReadonlySet<string>>();
  const outputModels = new Map<string, string>();
  if (registeredHooks.size === 0) return { activeExtensions };
  const installed = await installedLookup(ctx.ownerUserId);
  for (const [key, handlers] of registeredHooks) {
    if (!installed.has(key)) continue;
    const caps = handlers.resolveCapabilities ? await handlers.resolveCapabilities(ctx) : [];
    if (caps === null) continue;
    activeExtensions.set(key, new Set(caps));
    const model = handlers.resolveOutputModel?.(ctx);
    if (model) outputModels.set(key, model);
  }
  return { activeExtensions, outputModels };
}

export async function collectPromptBlocks(
  dispatch: TurnHookDispatch,
  ctx: Omit<PromptBlockContext, "capabilities">,
): Promise<PromptBlock[]> {
  const blocks: Array<PromptBlock & { extensionKey: string }> = [];
  for (const [key, capabilities] of dispatch.activeExtensions) {
    const handlers = registeredHooks.get(key);
    if (!handlers?.contributePromptBlocks) continue;
    const contributed = await handlers.contributePromptBlocks({ ...ctx, capabilities });
    for (const block of contributed) blocks.push({ ...block, extensionKey: key });
  }
  // Deterministic composition: priority, ties broken by extension key.
  blocks.sort((a, b) => a.priority - b.priority || a.extensionKey.localeCompare(b.extensionKey));
  return blocks;
}

export function collectHistoryConditions(
  dispatch: TurnHookDispatch,
  ctx: Omit<PromptBlockContext, "capabilities">,
): SQL[] {
  const conditions: SQL[] = [];
  for (const [key, capabilities] of dispatch.activeExtensions) {
    const handlers = registeredHooks.get(key);
    if (!handlers?.filterHistory) continue;
    conditions.push(...handlers.filterHistory({ ...ctx, capabilities }));
  }
  return conditions;
}

export function hasPromptOverflowHandlers(dispatch: TurnHookDispatch): boolean {
  for (const key of dispatch.activeExtensions.keys()) {
    if (registeredHooks.get(key)?.onPromptOverflow) return true;
  }
  return false;
}

/**
 * Run the overflow handlers. Failures are caught per handler and logged —
 * an overflowing prompt still generates (history trimming handles it), it
 * just loses the compaction assist this turn. Matches the old inline
 * try/catch semantics.
 */
export async function runPromptOverflow(
  dispatch: TurnHookDispatch,
  ctx: Omit<PromptOverflowContext, "capabilities">,
): Promise<void> {
  for (const [key, capabilities] of dispatch.activeExtensions) {
    const handlers = registeredHooks.get(key);
    if (!handlers?.onPromptOverflow) continue;
    try {
      await handlers.onPromptOverflow({ ...ctx, capabilities });
    } catch (err) {
      console.warn(
        `[ExtensionHooks] onPromptOverflow "${key}" failed (${ctx.pathLabel}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Post-turn background work. Handlers are fire-and-forget; failures are caught per handler. */
export function runTurnComplete(
  dispatch: TurnHookDispatch,
  ctx: Omit<TurnCompleteContext, "capabilities">,
): void {
  for (const [key, capabilities] of dispatch.activeExtensions) {
    const handlers = registeredHooks.get(key);
    if (!handlers?.onTurnComplete) continue;
    try {
      handlers.onTurnComplete({ ...ctx, capabilities });
    } catch (err) {
      console.warn(`[ExtensionHooks] onTurnComplete "${key}" failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export interface InvalidationPlan {
  /** Merged fields for the caller's single atomic playSessions UPDATE. */
  sessionFields: Record<string, unknown>;
  /** Run AFTER the row update. */
  runAfter: () => Promise<void>;
}

/**
 * Collect the invalidation plan from EVERY registered extension — deliberately
 * NOT entitlement-gated (uninstall keeps data; derived state must still reset
 * when history changes underneath it). Handlers may do synchronous in-process
 * work during collection (job-queue discards), mirroring the old inline order:
 * discards → row update → table clears.
 */
export function collectExtensionInvalidation(ctx: InvalidateContext): InvalidationPlan {
  const fields: Record<string, unknown> = {};
  const afters: Array<() => Promise<void>> = [];
  for (const [key, handlers] of registeredHooks) {
    if (!handlers.invalidate) continue;
    try {
      const result = handlers.invalidate(ctx);
      Object.assign(fields, result.sessionFields ?? {});
      if (result.runAfter) afters.push(result.runAfter);
    } catch (err) {
      console.warn(`[ExtensionHooks] invalidate "${key}" failed (${ctx.reason}):`, err instanceof Error ? err.message : err);
    }
  }
  return {
    sessionFields: fields,
    runAfter: async () => {
      for (const after of afters) await after();
    },
  };
}

/**
 * Convenience for invalidation sites without a large row update of their own
 * (message edit/delete/swipe): collect, apply the extensions' session fields —
 * merged with any caller fields (e.g. a swipe's restored state) — as ONE
 * atomic update, then run the follow-ups. Sites with bigger updates (state
 * restores in sessions.ts) use collectExtensionInvalidation directly and
 * merge the fields into their own UPDATE.
 */
export async function runExtensionInvalidation(
  ctx: InvalidateContext,
  extraSessionFields?: Record<string, unknown>,
): Promise<void> {
  const plan = collectExtensionInvalidation(ctx);
  const fields = { ...(extraSessionFields ?? {}), ...plan.sessionFields };
  if (Object.keys(fields).length > 0) {
    await db
      .update(playSessions)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(playSessions.id, ctx.sessionId));
  }
  await plan.runAfter();
}

// ─── Prompt block controller ────────────────────────────────────────

export interface BlockPosition {
  /** Index in contextMessages, or null if the block isn't currently present. */
  index: number | null;
  /** Where the block would be inserted if it becomes present. */
  insertIndex: number;
  /**
   * Canonical composition ordinal (injection order). When two absent blocks
   * reserve the SAME insert position, later upserts must land in canonical
   * order, not upsert-call order — the rank disambiguates the shift.
   */
  rank: number;
}

export interface TurnPromptMessageLike {
  role: "user" | "assistant" | "system";
  content: string;
  sourceMessageId?: string;
}

/**
 * The dispatcher-owned view of the in-flight prompt that overflow handlers
 * are allowed to edit: replace/insert their OWN blocks (by id) and drop
 * raw-history messages their compaction just covered. Maintains the
 * index/historyStart invariants centrally so handlers can't corrupt the
 * prompt layout.
 */
export class PromptBlockController {
  private positions: Map<string, BlockPosition>;
  private messages: TurnPromptMessageLike[];
  private historyStartValue: number;

  constructor(args: {
    messages: TurnPromptMessageLike[];
    positions: Map<string, BlockPosition>;
    historyStart: number;
  }) {
    this.messages = args.messages;
    this.positions = args.positions;
    this.historyStartValue = args.historyStart;
  }

  get historyStart(): number {
    return this.historyStartValue;
  }

  /**
   * Replace the block's content in place, or insert it at its reserved
   * position if absent. Null content is a no-op (the existing block, if any,
   * stays — matching the old upsert semantics).
   */
  upsertBlock(id: string, content: string | null): void {
    if (!content) return;
    const position = this.positions.get(id);
    if (!position) {
      console.warn(`[ExtensionHooks] upsertBlock("${id}") — unknown block id, ignoring`);
      return;
    }
    if (position.index !== null) {
      this.messages[position.index] = { role: "system", content };
      return;
    }
    const insertAt = position.insertIndex;
    this.messages.splice(insertAt, 0, { role: "system", content });
    position.index = insertAt;
    // Shift every recorded position the splice displaced. A present block at
    // exactly insertAt was pushed right unconditionally; an ABSENT block
    // reserving exactly insertAt shifts only if it ranks after the inserted
    // one (so same-point blocks still land in canonical order). The history
    // boundary shifts when the insertion landed at/before it.
    for (const [otherId, other] of this.positions) {
      if (otherId === id) continue;
      if (other.index !== null && other.index >= insertAt) other.index += 1;
      if (other.insertIndex > insertAt || (other.insertIndex === insertAt && other.rank > position.rank)) {
        other.insertIndex += 1;
      }
    }
    if (insertAt <= this.historyStartValue) this.historyStartValue += 1;
  }

  /** Drop raw-history prompt messages (by source message id) a compaction just covered. */
  removeHistoryMessagesBySource(sourceMessageIds: string[]): void {
    if (sourceMessageIds.length === 0) return;
    const covered = new Set(sourceMessageIds);
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const sourceMessageId = this.messages[i]?.sourceMessageId;
      if (sourceMessageId && covered.has(sourceMessageId)) {
        this.messages.splice(i, 1);
      }
    }
  }
}
