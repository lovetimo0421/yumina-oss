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
import { GameStateManager, type GameState, type WorldDefinition } from "@yumina/engine";
import { randomUUID } from "node:crypto";
import { asc, eq, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions } from "../db/schema.js";
import { getInstalledExtensions, getUninstalledExtensions } from "./extensions.js";
import { invalidateRunMemoryText, rebuildRunMemories, type RunMemories } from "./run-scopes.js";
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
  /**
   * True when this extension runs for the turn because `activeByDefault`
   * said so (the card switched it on), not because the player installed it.
   * A handler can keep such a run to what the card asked for.
   */
  defaultActivated?: boolean;
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

export interface WorldDefinitionTransformContext extends PromptBlockContext {
  /** Current viewer-authorized world. Handlers must return a fresh object. */
  worldDef: WorldDefinition;
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
  /** See ResolveCapabilitiesContext.defaultActivated. */
  defaultActivated?: boolean;
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
  /** See ResolveCapabilitiesContext.defaultActivated. */
  defaultActivated?: boolean;
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
  /** Resolved playable schema, used when a swipe restores a different state. */
  worldDef?: WorldDefinition;
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

/** Turn-level inputs for extensions that are on by default. */
export interface DefaultActivationContext {
  /** The viewer-authorized world for this turn, before extension overlays. */
  world?: WorldDefinition;
}

export interface ExtensionHookHandlers {
  /**
   * On-by-default extensions: true activates the extension for this turn
   * WITHOUT an install row, unless the player explicitly uninstalled it.
   * Default-activated keys are reported in TurnHookDispatch.defaultActivated
   * and get no resolveOutputModel (the default runs on the platform's terms).
   */
  activeByDefault?: (ctx: DefaultActivationContext) => boolean;
  /** Trusted final instructions, reserved outside the trimmable history. */
  turnOutputInstructions?: (ctx: Pick<TurnOutputContext, "world" | "state">) => string;
  /** Awaited, fail-closed, before effects/reactions. Returns data only. */
  validateTurnOutput?: (ctx: TurnOutputContext) => Promise<ValidatedTurnOutput>;
  /** Which of the extension's capabilities are active for this session. */
  /** null disables this extension for this turn (settings snapshot). */
  resolveCapabilities?: (ctx: ResolveCapabilitiesContext) => string[] | null | Promise<string[] | null>;
  resolveOutputModel?: (ctx: ResolveCapabilitiesContext) => string | null;
  /** Session-local, deterministic world overlays resolved before lore matching. */
  transformWorldDefinition?: (
    ctx: WorldDefinitionTransformContext,
  ) => WorldDefinition | Promise<WorldDefinition>;
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
/** Test-only: swap the explicit-uninstall (default opt-out) source. */
let uninstalledLookup: InstalledLookup = getUninstalledExtensions;
export function __setUninstalledLookupForTests(lookup: InstalledLookup | null): void {
  uninstalledLookup = lookup ?? getUninstalledExtensions;
}

export interface TurnHookDispatch {
  /** Extension key → its active capabilities (installed or default-activated). */
  activeExtensions: Map<string, ReadonlySet<string>>;
  outputModels?: Map<string, string>;
  /** Keys active only through activeByDefault (the player never installed them). */
  defaultActivated?: ReadonlySet<string>;
}

export function turnOutputInstructions(dispatch: TurnHookDispatch, ctx: Pick<TurnOutputContext, "world" | "state">): string {
  return [...dispatch.activeExtensions.keys()].map((key) => registeredHooks.get(key)?.turnOutputInstructions?.(ctx) ?? "").filter(Boolean).join("\n\n");
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
export async function resolveTurnHooks(ctx: ResolveCapabilitiesContext & DefaultActivationContext): Promise<TurnHookDispatch> {
  const activeExtensions = new Map<string, ReadonlySet<string>>();
  const outputModels = new Map<string, string>();
  const defaultActivated = new Set<string>();
  if (registeredHooks.size === 0) return { activeExtensions };
  const { world, ...capabilityCtx } = ctx;
  const installed = await installedLookup(ctx.ownerUserId);
  let uninstalled: Set<string> | undefined;
  for (const [key, handlers] of registeredHooks) {
    let viaDefault = false;
    if (!installed.has(key)) {
      if (!handlers.activeByDefault?.({ world })) continue;
      // An explicit uninstall is the player's opt-out; never-installed is not.
      uninstalled ??= await uninstalledLookup(ctx.ownerUserId);
      if (uninstalled.has(key)) continue;
      viaDefault = true;
    }
    const caps = handlers.resolveCapabilities ? await handlers.resolveCapabilities({ ...capabilityCtx, defaultActivated: viaDefault }) : [];
    if (caps === null) continue;
    activeExtensions.set(key, new Set(caps));
    if (viaDefault) { defaultActivated.add(key); continue; }
    const model = handlers.resolveOutputModel?.(capabilityCtx);
    if (model) outputModels.set(key, model);
  }
  return { activeExtensions, outputModels, defaultActivated };
}

export async function collectPromptBlocks(
  dispatch: TurnHookDispatch,
  ctx: Omit<PromptBlockContext, "capabilities">,
): Promise<PromptBlock[]> {
  const blocks: Array<PromptBlock & { extensionKey: string }> = [];
  for (const [key, capabilities] of dispatch.activeExtensions) {
    const handlers = registeredHooks.get(key);
    if (!handlers?.contributePromptBlocks) continue;
    const contributed = await handlers.contributePromptBlocks({ ...ctx, capabilities, defaultActivated: dispatch.defaultActivated?.has(key) ?? false });
    for (const block of contributed) blocks.push({ ...block, extensionKey: key });
  }
  // Deterministic composition: priority, ties broken by extension key.
  blocks.sort((a, b) => a.priority - b.priority || a.extensionKey.localeCompare(b.extensionKey));
  return blocks;
}

/** Apply installed, capability-gated world overlays in registry order. */
export async function transformWorldDefinition(
  dispatch: TurnHookDispatch,
  ctx: Omit<WorldDefinitionTransformContext, "capabilities" | "worldDef">,
  worldDef: WorldDefinition,
): Promise<WorldDefinition> {
  let resolved = worldDef;
  for (const [key, capabilities] of dispatch.activeExtensions) {
    const transform = registeredHooks.get(key)?.transformWorldDefinition;
    if (!transform) continue;
    resolved = await transform({ ...ctx, capabilities, worldDef: resolved });
  }
  return resolved;
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
      await handlers.onPromptOverflow({ ...ctx, capabilities, defaultActivated: dispatch.defaultActivated?.has(key) ?? false });
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
      handlers.onTurnComplete({ ...ctx, capabilities, defaultActivated: dispatch.defaultActivated?.has(key) ?? false });
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
type InvalidationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type MessageMutation = (
  tx: InvalidationTransaction,
  session: Pick<typeof playSessions.$inferSelect, "state" | "runMemories">,
) => Promise<{ messageFlags?: InvalidateContext["messageFlags"]; sessionFields?: Record<string, unknown> }>;

export async function runExtensionInvalidation(
  ctx: InvalidateContext,
  extraSessionFields?: Record<string, unknown>,
  database: Pick<typeof db, "transaction" | "update"> = db,
  /** Message writes run under the same session lock as memory invalidation. */
  mutateMessage?: MessageMutation,
): Promise<void> {
  let plan: InvalidationPlan | undefined;
  if (ctx.reason === "message-edited" || ctx.reason === "message-deleted" || ctx.reason === "message-swiped") {
    await database.transaction(async (tx) => {
      // Summary and worker completion also lock this row. Read derived memory
      // only after acquiring the lock, then rotate its generation in the same
      // write as a swipe's restored state so late jobs cannot repopulate it.
      const [session] = await tx.select({ runMemories: playSessions.runMemories, state: playSessions.state })
        .from(playSessions).where(eq(playSessions.id, ctx.sessionId)).for("update");
      if (!session) return;
      const mutation = await mutateMessage?.(tx, session);
      const freshContext = mutation?.messageFlags ? { ...ctx, messageFlags: mutation.messageFlags } : ctx;
      plan = collectExtensionInvalidation(freshContext);
      const fields = { ...(extraSessionFields ?? {}), ...mutation?.sessionFields, ...plan.sessionFields };
      const changedAt = freshContext.messageFlags?.createdAt?.getTime();
      const boundaryAt = new Date(Number.isFinite(changedAt) ? changedAt! : -8640000000000000).toISOString();
      const generation = randomUUID();
      let runMemories = invalidateRunMemoryText(session.runMemories as RunMemories | null, boundaryAt, generation);
      if (ctx.reason === "message-swiped" && ctx.worldDef && fields.state) {
        // A swipe can change which modules are active. Rebuild spans from the
        // current transcript instead of carrying the previous swipe's opens.
        // This only derives memory; preserve the caller's state byte-for-byte.
        const rows = await tx.select({ role: messages.role, createdAt: messages.createdAt, stateSnapshot: messages.stateSnapshot })
          .from(messages).where(eq(messages.sessionId, ctx.sessionId)).orderBy(asc(messages.createdAt), asc(messages.id));
        const initialState = new GameStateManager(ctx.worldDef).getSnapshot();
        const finalState = new GameStateManager(ctx.worldDef, fields.state as GameState).getSnapshot();
        const lastAt = rows.at(-1)?.createdAt?.toISOString() ?? (Number.isFinite(changedAt) ? boundaryAt : new Date().toISOString());
        runMemories = rebuildRunMemories(ctx.worldDef.worldbooks, rows, initialState, finalState, generation, lastAt);
      }
      await tx.update(playSessions)
        .set({ ...fields, runMemories: runMemories as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(playSessions.id, ctx.sessionId));
    });
  } else {
    plan = collectExtensionInvalidation(ctx);
    const fields = { ...(extraSessionFields ?? {}), ...plan.sessionFields };
    if (Object.keys(fields).length > 0) {
      await database.update(playSessions).set({ ...fields, updatedAt: new Date() }).where(eq(playSessions.id, ctx.sessionId));
    }
  }
  await plan?.runAfter();
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
