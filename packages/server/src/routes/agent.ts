import { usageObservation } from "../lib/usage-observation.js";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and, asc, desc, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds, agentRuns, worldSnapshots, worldFolderBindings } from "../db/schema.js";
import { recordUsageLog } from "../lib/usage-log.js";
import { isShutdownAbort, registerStream } from "../lib/stream-registry.js";
import { authMiddleware } from "../middleware/auth.js";
import type { LLMProvider, StreamChunk, ChatMessage, ToolCall, ContentPart, ToolDefinition } from "../lib/llm/types.js";
import { resolveProviderForModel, type ApiKeyTier } from "../lib/resolve-provider.js";
import { calculateCost, deductCredits, ensureWallet } from "../lib/credit-service.js";
import { resolveEffectivePlanWithEventEntitlements } from "../lib/event-plan-entitlements.js";
import { guardGeneration } from "../lib/credit-guard.js";
import { getModelPrice } from "../lib/model-price-cache.js";
import { planStudioCreditBudget } from "../lib/studio-credit-budget.js";
import { studioCreditRecoveryEnabled, getAvailableCredits, reserveStudioCredits, renewStudioCreditReservation, releaseStudioCreditReservation } from "../lib/credit-reservations.js";
import { settleStudioCreditReservation } from "../lib/credit-service.js";
import {
  captureStudioCreditWorldRevision, pauseStudioForCredits, claimStudioCreditResume,
  restoreStudioCreditPause, withStudioCreditClaimTransaction, readStudioCreditCheckpoint,
  stageStudioCreditIteration, isStudioCreditResumeEligible, type StudioCreditCheckpoint,
} from "../lib/studio-credit-checkpoint.js";
import { captureServerEvent } from "../lib/analytics.js";
import { PLANS } from "../lib/plan-config.js";
import type { AppEnv } from "../lib/types.js";
import { type SchemaChange, type ToolResult } from "../lib/studio-tools/index.js";
import { buildToolResultMessages } from "../lib/studio-tools/tool-results.js";
import { STUDIO_TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, CONTROL_TOOL_NAMES } from "../lib/studio-tools/tools.js";
import { STUDIO_MODEL_IDS, SMART_IMAGE_MODEL } from "@yumina/shared";
import { isSmartGenerationEnabled, smartImageEstimates, submitSmartGeneration, SmartSubmissionError } from "../lib/generation/smart.js";
import { IMAGE_TOOL_NAME, imageToolMessages, normalizeImageProposal, waitForGeneratedImage } from "../lib/studio-tools/image-proposal.js";
import { resolveContext } from "../lib/studio-tools/context-resolver.js";
import { loadAssetCatalog } from "../lib/studio-tools/asset-catalog.js";
import { executeReadEntities, executeApplyChanges, executeGrepWorld, executeValidateWorld, executeAnalyzeTokenCost, toolCallsToSchemaChanges } from "../lib/studio-tools/tool-executor.js";
import { buildSystemPrompt, type SystemPromptParts } from "../lib/studio-tools/system-prompt.js";
import { getSkillContent } from "../lib/studio-skills/index.js";
import { parseToolArgs } from "../lib/studio-tools/parse-tool-args.js";
import { generateStreamWithRetry } from "../lib/studio-tools/generate-stream-with-retry.js";
import {
  createReadProgressState,
  extractReadTouches,
  recordReadTouches,
  clearReadProgress,
  readSpiralStopMessage,
  readRepeatNudge,
  readWanderNudge,
} from "../lib/studio-tools/read-progress.js";
import { migrateWorldDefinition } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";
import { resolveWorkingSchema, writeStudioWorldSchema } from "../lib/pending-edit.js";
import { loadAgentHistoryForConversation, withStudioUserMessageContext } from "../lib/studio-conversations.js";
// ── Request Routing ──

const MAX_OUTPUT = 64000; // Claude Sonnet max output with streaming
// Cap raised from 10 → 50 now that (a) prompt caching makes subsequent iterations ~10% the cost of the first
// and (b) per-entity re-read detection injects guidance and terminates cleanly before runaway loops.
// Typical flows still finish in 1-2 iterations; this only bites pathological cases we now handle explicitly.
const MAX_ITERATIONS = 50;

type AgentRunRow = typeof agentRuns.$inferSelect;

type ChangeComparePayload = {
  title: string;
  toolName: string;
  original: string;
  changed: string;
  source: "agent-run-snapshot";
};

const NO_ORIGINAL = "No existing version. This is a new item.";
const DELETED_VALUE = "This action deletes the listed item(s).";

function formatCompareValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseCompareToolArgs(toolCall: ToolCall): Record<string, unknown> {
  try {
    const parsed = parseToolArgs(toolCall.function.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getCompareTitle(toolCall: ToolCall): string {
  const args = parseCompareToolArgs(toolCall);
  return formatCompareValue(args.name ?? args.id ?? toolCall.function.name);
}

function getEntityForChange(world: WorldDefinition, change: SchemaChange): unknown {
  const id = change.id;
  if (!id) return undefined;
  const draft = world as unknown as Record<string, unknown>;
  if (change.entityType === "entry") {
    return (draft.entries as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === id);
  }
  if (change.entityType === "variable") {
    return (draft.variables as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === id);
  }
  if (change.entityType === "behavior") {
    return (draft.reactions as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === id);
  }
  if (change.entityType === "rule") {
    return (draft.rules as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === id);
  }
  if (change.entityType === "audio") {
    return (draft.audioTracks as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === id);
  }
  if (change.entityType === "customUI") {
    return ((draft.rootComponent as Record<string, unknown> | undefined)?.files as Record<string, string> | undefined)?.[id];
  }
  if (change.entityType === "settings") {
    return draft;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function compareJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function pickChangedJsonFields(original: unknown, changed: unknown): { original: unknown; changed: unknown } {
  if (!isRecord(original) || !isRecord(changed)) {
    return { original, changed };
  }

  const originalDiff: Record<string, unknown> = {};
  const changedDiff: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(original), ...Object.keys(changed)]);

  for (const key of keys) {
    const oldValue = original[key];
    const newValue = changed[key];
    if (compareJsonValue(oldValue, newValue)) continue;

    if (isRecord(oldValue) && isRecord(newValue)) {
      const nested = pickChangedJsonFields(oldValue, newValue);
      originalDiff[key] = nested.original;
      changedDiff[key] = nested.changed;
    } else {
      originalDiff[key] = oldValue;
      changedDiff[key] = newValue;
    }
  }

  return {
    original: Object.keys(originalDiff).length > 0 ? originalDiff : original,
    changed: Object.keys(changedDiff).length > 0 ? changedDiff : changed,
  };
}

function unwrapPrimaryChangedField(diff: { original: unknown; changed: unknown }) {
  if (!isRecord(diff.original) || !isRecord(diff.changed)) return diff;
  const originalKeys = Object.keys(diff.original);
  const changedKeys = Object.keys(diff.changed);
  if (originalKeys.length !== 1 || changedKeys.length !== 1 || originalKeys[0] !== changedKeys[0]) {
    return diff;
  }

  const key = originalKeys[0]!;
  if (["content", "behaviorRules", "description", "tsxCode"].includes(key)) {
    return {
      original: diff.original[key],
      changed: diff.changed[key],
    };
  }

  return diff;
}

function getComparableValues(
  beforeWorld: WorldDefinition,
  afterWorld: WorldDefinition,
  change: SchemaChange,
): { original: unknown; changed: unknown } {
  const originalEntity = getEntityForChange(beforeWorld, change);
  if (change.action === "delete") {
    return { original: originalEntity, changed: DELETED_VALUE };
  }

  const changedEntity = getEntityForChange(afterWorld, change);
  if (originalEntity === undefined) {
    return { original: NO_ORIGINAL, changed: changedEntity };
  }

  return unwrapPrimaryChangedField(pickChangedJsonFields(originalEntity, changedEntity));
}

function collectRunWriteToolCalls(run: AgentRunRow): ToolCall[] {
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  const addCalls = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const call = item as ToolCall;
      if (!call?.id || !call.function || !WRITE_TOOL_NAMES.has(call.function.name) || seen.has(call.id)) continue;
      calls.push(call);
      seen.add(call.id);
    }
  };

  // The canonical LLM transcript is chronological. Use it first so replaying
  // before/after state cannot compare a later tool against an older snapshot.
  for (const message of (run.messages ?? [])) {
    const record = message as Record<string, unknown>;
    if (record.role === "assistant") addCalls(record.tool_calls);
  }

  for (const turn of [...(run.committedTurns ?? [])].sort((a, b) => a.iteration - b.iteration)) {
    addCalls(turn.writeToolCalls);
  }
  addCalls(run.pendingToolCalls);

  return calls;
}

function buildChangeCompareFromRun(
  snapshotWorld: WorldDefinition,
  writeToolCalls: ToolCall[],
  toolCallId: string,
): ChangeComparePayload | null {
  let simulatedWorld = snapshotWorld;
  const targetToolCall = writeToolCalls.find((tc) => tc.id === toolCallId);
  if (!targetToolCall) return null;

  const parts: Array<{ label: string; original: string; changed: string }> = [];

  for (const toolCall of writeToolCalls) {
    const parsedCalls = toolCallsToSchemaChanges([toolCall], simulatedWorld);
    for (const parsed of parsedCalls) {
      if (!parsed.change) continue;
      const change = parsed.change;
      const isTarget = parsed.toolCallId === toolCallId;
      const result = executeApplyChanges(simulatedWorld, [change]);
      const nextWorld = result.success ? result.world : simulatedWorld;
      const compareValues = getComparableValues(simulatedWorld, nextWorld, change);

      if (isTarget) {
        parts.push({
          label: `${change.action} ${change.entityType}${change.id ? ` ${change.id}` : ""}`,
          original: compareValues.original === undefined ? NO_ORIGINAL : formatCompareValue(compareValues.original),
          changed: compareValues.changed === undefined ? formatCompareValue(parseCompareToolArgs(toolCall)) : formatCompareValue(compareValues.changed),
        });
      }

      simulatedWorld = nextWorld;
    }
  }

  if (parts.length === 0) return null;
  const joinParts = (key: "original" | "changed") => parts
    .map((part) => parts.length === 1 ? part[key] : `### ${part.label}\n${part[key]}`)
    .join("\n\n");

  return {
    title: getCompareTitle(targetToolCall),
    toolName: targetToolCall.function.name,
    original: joinParts("original"),
    changed: joinParts("changed"),
    source: "agent-run-snapshot",
  };
}


// Registry: maps runId → AbortController for the active agent loop.
// Local Map for same-replica stop; Redis pub/sub for cross-replica stop.
const activeAgentRuns = new Map<string, AbortController>();

const AGENT_STOP_CHANNEL = "agent:stop";

// Subscribe to cross-replica stop signals via Redis pub/sub.
// When replica B receives a stop request for a run on replica A,
// it publishes to this channel. Replica A receives it and aborts.
import { redis, redisSub } from "../lib/redis.js";

if (redisSub) {
  const sub = redisSub;
  const initAgentSub = async () => {
    try {
      await sub.subscribe(AGENT_STOP_CHANNEL);
    } catch {
      // Redis not ready yet — subscription will be retried on reconnect
    }
  };
  sub.on("ready", () => { initAgentSub(); });
  if ((sub as any).status === "ready") initAgentSub();

  sub.on("message", (channel: string, message: string) => {
    if (channel !== AGENT_STOP_CHANNEL) return;
    try {
      const { runId } = JSON.parse(message) as { runId: string };
      const controller = activeAgentRuns.get(runId);
      if (controller && !controller.signal.aborted) {
        console.log(`[Agent] Cross-replica stop received for run ${runId}`);
        controller.abort();
      }
    } catch { /* malformed message */ }
  });
}

const agentRoutes = new Hono<AppEnv>();
agentRoutes.use("/*", authMiddleware);


// ── POST /api/studio/:worldId/agent/start — Begin server-side agent run ──

agentRoutes.post("/:worldId/agent/start", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{
    message: string;
    model?: string;
    conversationId?: string;
    context?: {
      activePanel?: string;
      selectedElementId?: string;
      selectedElementType?: string;
    };
    attachments?: Array<{ url: string; key: string; mimeType: string; name: string }>;
    /** Existing conversation messages to continue from */
    existingMessages?: ChatMessage[];
  }>();

  // Verify world ownership
  const worldRows = await db
    .select({ id: worlds.id, schema: worlds.schema, status: worlds.status })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));

  if (worldRows.length === 0) {
    return c.json({ error: "World not found or not authorized" }, 404);
  }

  // World schema comes from DB (client saves draft before starting agent). For a
  // published world with a held edit, operate on the held WORKING copy so Studio
  // edits build on (and write back to) the pending edit instead of the live card.
  const workingSchema = await resolveWorkingSchema(
    worldId,
    worldRows[0]!.status,
    worldRows[0]!.schema as unknown as Record<string, unknown>,
  );
  const world = migrateWorldDefinition(workingSchema as unknown as WorldDefinition);

  // Stop any existing running agent for this world (prevents concurrent mutations).
  // Since agents now survive SSE disconnects, a stale "running" agent may linger.
  const existingRuns = studioCreditRecoveryEnabled() ? [] : await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.worldId, worldId),
        eq(agentRuns.userId, currentUser.id),
        eq(agentRuns.status, "running"),
      )
    );
  for (const run of existingRuns) {
    activeAgentRuns.get(run.id)?.abort();
    await db.update(agentRuns).set({
      status: "completed",
      error: "Superseded by new agent run.",
      updatedAt: new Date(),
    }).where(eq(agentRuns.id, run.id)).catch(() => {});
    activeAgentRuns.delete(run.id);
  }

  // Honor the user's explicit model choice. We used to fall back to a fixed
  // anthropic/claude-3-haiku when the model wasn't in `model_prices`, but
  // (a) that model is deprecated on api.anthropic.com and (b) BYOK users
  // routinely run models we don't sell officially. Gating happens later
  // (resolveProviderForModel returns null if no key handles the model).
  const model = body.model ?? "qwen/qwen3-vl-235b-a22b-instruct";

  // Enforce studio allowlist — users can't request arbitrary models through this endpoint.
  // BYOK users bypass this since they're paying for their own key.
  // allowNonPriced: studio models may not be in modelPrices table, but should still
  // resolve to the official OpenRouter key.
  const isStudioModel = STUDIO_MODEL_IDS.has(model);
  const resolved = await resolveProviderForModel(currentUser.id, model, {
    allowNonPriced: isStudioModel,
  });
  if (!resolved) {
    return c.json({ error: "No API key configured for this provider. Add one in Settings." }, 400);
  }
  if (!resolved.isByok && !STUDIO_MODEL_IDS.has(model)) {
    return c.json({ error: `Model "${model}" is not available for Studio.`, code: "MODEL_NOT_ALLOWED" }, 403);
  }

  // Pre-generation credit/model/rate checks (skip concurrency — agent has its own via agentRuns table).
  // skipModelValidation: studio has its own allowlist above; models may not be in modelPrices table.
  const guard = await guardGeneration(currentUser.id, model, {
    isByok: resolved.isByok,
    isSuspended: !!currentUser.isSuspended,
    skipConcurrency: true,
    skipModelValidation: isStudioModel,
  });
  if (!guard.ok) return c.json(guard.body, guard.status as 400);

  // Build user message (with attachments if any)
  const userContent: ChatMessage = body.attachments?.some((a) => a.mimeType.startsWith("image/"))
    ? {
        role: "user" as const,
        content: [
          { type: "text" as const, text: body.message },
          ...body.attachments
            .filter((a) => a.mimeType.startsWith("image/"))
            .map((a) => ({ type: "image_url" as const, image_url: { url: a.url } })),
        ],
      }
    : { role: "user" as const, content: body.message };

  // Client-supplied existingMessages is kept for API compatibility but is not
  // trusted here; history is loaded server-side to avoid stale cross-world context.
  const history = body.conversationId
    ? await loadAgentHistoryForConversation({
        userId: currentUser.id,
        worldId,
        conversationId: body.conversationId,
      })
    : [];

  if (history === null) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  const conversationMessages: ChatMessage[] = [
    ...history,
    userContent,
  ];

  const tools = STUDIO_TOOLS;
  const maxIter = MAX_ITERATIONS;

  // Create agent run record
  const createRun = async (executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]) => executor
    .insert(agentRuns).values({
      worldId,
      conversationId: body.conversationId ?? null,
      userId: currentUser.id,
      status: "running",
      messages: conversationMessages as unknown as Array<Record<string, unknown>>,
      iteration: 0,
      maxIterations: maxIter,
      model,
      context: withStudioUserMessageContext(body.context as Record<string, unknown> | undefined, userContent),
    })
    .returning();
  // Serialize start and credit-resume against the same world lock. A new task
  // explicitly supersedes the old worker, whose checkpoint writes then fail.
  const [agentRun] = studioCreditRecoveryEnabled() ? await db.transaction(async tx => {
    await tx.select({ id: worlds.id }).from(worlds)
      .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id))).for("update");
    const superseded = await tx.update(agentRuns).set({
      status: "completed", error: "Superseded by new agent run.", updatedAt: new Date(),
    }).where(and(eq(agentRuns.worldId, worldId), eq(agentRuns.userId, currentUser.id), eq(agentRuns.status, "running")))
      .returning();
    for (const prior of superseded) activeAgentRuns.get(prior.id)?.abort();
    return createRun(tx);
  }) : await createRun(db);

  const runId = agentRun!.id;

  // SSE-specific headers: signal to reverse proxies (Railway/nginx, Cloudflare)
  // that this is a long-lived streaming response — not a regular API call.
  c.header("X-Accel-Buffering", "no");
  c.header("X-Agent-Run-Id", runId);

  // Start streaming agent loop
  return streamAgentLoop(c, {
    runId,
    conversationId: agentRun!.conversationId ?? runId,
    worldId,
    userId: currentUser.id,
    world,
    messages: conversationMessages,
    model,
    provider: resolved.provider,
    isByok: resolved.isByok,
    apiKeyTier: resolved.apiKeyTier,
    context: body.context,
    iteration: 0,
    maxIterations: maxIter,
    tools,
    unlimited: guard.ok ? guard.ctx.planConfig.unlimited : false,
  });
});

// Resume the stored step only after an explicit user action. The model and
// generated arguments come from the owned run, never from the request body.
agentRoutes.post("/:worldId/agent/resume-credits", async (c) => {
  if (!studioCreditRecoveryEnabled()) return c.json({ error: "Credit recovery is not enabled" }, 404);
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ runId?: string }>();
  if (!body.runId) return c.json({ error: "runId is required" }, 400);
  const scope = { worldId, userId: currentUser.id, runId: body.runId };
  const [run] = await db.select().from(agentRuns).where(and(
    eq(agentRuns.id, scope.runId), eq(agentRuns.worldId, worldId), eq(agentRuns.userId, currentUser.id),
  ));
  if (!run) return c.json({ error: "Run not found" }, 404);
  const storedCheckpoint = readStudioCreditCheckpoint(run.creditCheckpoint);
  if (storedCheckpoint?.phase === "generated" && storedCheckpoint.generated.billingUnavailable) {
    return c.json({ error: "Generation is saved, but its usage could not be confirmed", code: "BILLING_DETAILS_MISSING" }, 409);
  }
  const resolved = await resolveProviderForModel(currentUser.id, run.model, { allowNonPriced: STUDIO_MODEL_IDS.has(run.model) });
  if (!resolved || resolved.isByok || !STUDIO_MODEL_IDS.has(run.model)) {
    return c.json({ error: "The original official provider is unavailable", code: "PROVIDER_CHANGED" }, 409);
  }
  const guard = await guardGeneration(currentUser.id, run.model, {
    isByok: false, isSuspended: !!currentUser.isSuspended, skipConcurrency: true, skipModelValidation: true,
  });
  // A generated step can already be paid (crash after settlement). Its replay
  // must reach idempotent settlement even when the remaining wallet is zero.
  if (!guard.ok && !(storedCheckpoint?.phase === "generated" && guard.body.code === "NO_CREDITS")) {
    return c.json(guard.body, guard.status as 400);
  }
  const claimed = await claimStudioCreditResume(scope);
  if (!claimed.ok) return c.json({ error: claimed.code, code: claimed.code }, claimed.code === "NOT_FOUND" ? 404 : 409);
  const claimedRun = claimed.run;
  c.header("X-Accel-Buffering", "no");
  c.header("X-Agent-Run-Id", claimedRun.id);
  return streamAgentLoop(c, {
    ...scope, conversationId: claimedRun.conversationId ?? claimedRun.id,
    world: migrateWorldDefinition(claimed.workingSchema as unknown as WorldDefinition),
    messages: claimed.checkpoint.messages, model: claimedRun.model, provider: resolved.provider,
    isByok: false, apiKeyTier: resolved.apiKeyTier, context: (claimedRun.context ?? undefined) as AgentLoopParams["context"],
    iteration: claimed.checkpoint.iteration, maxIterations: claimedRun.maxIterations, tools: STUDIO_TOOLS,
    unlimited: guard.ok ? guard.ctx.planConfig.unlimited : false,
    creditResume: { checkpoint: claimed.checkpoint, claimId: claimed.claimId },
    committedTurns: claimedRun.committedTurns,
  });
});

// ── POST /api/studio/:worldId/agent/approve — Approve/reject pending proposal ──

agentRoutes.post("/:worldId/agent/approve", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{
    runId: string;
    approved: boolean;
  }>();

  // Atomically transition status to "running" — only succeeds if currently "awaiting_approval".
  // Prevents two concurrent approve requests from both executing write tools.
  const transitionApproval = (executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]) => executor
    .update(agentRuns)
    .set({ status: "running", updatedAt: new Date() })
    .where(
      and(
        eq(agentRuns.id, body.runId),
        eq(agentRuns.userId, currentUser.id),
        eq(agentRuns.worldId, worldId),
        eq(agentRuns.status, "awaiting_approval"),
      )
    )
    .returning();
  // Legacy approvals can still exist. They share the same world lock as new
  // runs and credit recovery, so two paused tasks cannot both start writing.
  const approval = studioCreditRecoveryEnabled() ? await db.transaction(async tx => {
    const [ownedWorld] = await tx.select({ id: worlds.id }).from(worlds)
      .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id))).for("update");
    if (!ownedWorld) return { run: undefined, blocked: false };
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.worldId, worldId), ne(agentRuns.id, body.runId), eq(agentRuns.status, "running"))).limit(1);
    if (active) return { run: undefined, blocked: true };
    const [run] = await transitionApproval(tx);
    return { run, blocked: false };
  }) : { run: (await transitionApproval(db))[0], blocked: false };
  if (approval.blocked) return c.json({ error: "Another agent run is active", code: "ACTIVE_RUN" }, 409);
  const run = approval.run;

  if (!run) {
    return c.json({ error: "Agent run not found or not awaiting approval" }, 404);
  }

  // Load current world from DB
  const worldRows = await db
    .select({ schema: worlds.schema, status: worlds.status })
    .from(worlds)
    .where(eq(worlds.id, worldId));

  if (worldRows.length === 0) {
    return c.json({ error: "World not found" }, 404);
  }

  const approveWorkingSchema = await resolveWorkingSchema(
    worldId,
    worldRows[0]!.status,
    worldRows[0]!.schema as unknown as Record<string, unknown>,
  );
  let world = migrateWorldDefinition(approveWorkingSchema as unknown as WorldDefinition);

  // Check if user has unlimited plan (skip credit deduction for internal tier)
  const wallet = await ensureWallet(currentUser.id);
  const effectivePlan = await resolveEffectivePlanWithEventEntitlements(currentUser.id, wallet.plan);
  const isUnlimited = PLANS[effectivePlan]?.unlimited ?? false;
  const pendingToolCalls = (run.pendingToolCalls ?? []) as unknown as ToolCall[];
  const readResults = (run.readToolResults ?? []) as unknown as ToolResult[];
  const messages = run.messages as unknown as ChatMessage[];

  let writeResults: ToolResult[];

  if (body.approved) {
    // Snapshot the world BEFORE mutation (enables revert)
    const toolNames = pendingToolCalls.map((tc) => tc.function.name).join(", ");
    await db.insert(worldSnapshots).values({
      worldId,
      userId: currentUser.id,
      agentRunId: body.runId,
      schemaData: world as unknown as Record<string, unknown>,
      label: `Before: ${toolNames}`.slice(0, 200),
    });

    // Auto-cleanup: keep max 50 snapshots per world
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(worldSnapshots)
      .where(eq(worldSnapshots.worldId, worldId));
    if ((countResult?.count ?? 0) > 50) {
      // Delete oldest snapshots beyond 50
      const oldest = await db
        .select({ id: worldSnapshots.id })
        .from(worldSnapshots)
        .where(eq(worldSnapshots.worldId, worldId))
        .orderBy(desc(worldSnapshots.createdAt))
        .offset(50);
      if (oldest.length > 0) {
        for (const row of oldest) {
          await db.delete(worldSnapshots).where(eq(worldSnapshots.id, row.id));
        }
      }
    }

    // Execute write tools — per-tool error handling (one bad tool doesn't block others)
    const parsedApproval = toolCallsToSchemaChanges(pendingToolCalls, world);
    writeResults = [];
    for (const parsed of parsedApproval) {
      const tc = pendingToolCalls.find((t) => t.id === parsed.toolCallId);
      if (!tc) continue;

      if (parsed.error) {
        writeResults.push({ tool_call_id: tc.id, name: tc.function.name, status: "error" as const, result: null, error: parsed.error });
        continue;
      }
      if (!parsed.change) continue;

      const singleResult = executeApplyChanges(world, [parsed.change]);
      if (singleResult.success) {
        world = singleResult.world;
        writeResults.push({ tool_call_id: tc.id, name: tc.function.name, status: "success" as const, result: singleResult.summary });
      } else {
        writeResults.push({ tool_call_id: tc.id, name: tc.function.name, status: "error" as const, result: null, error: singleResult.summary });
      }
    }

    // Save updated world to DB. For a published world a material change is held
    // for re-review (the live card is untouched) instead of going live.
    await writeStudioWorldSchema({
      worldId,
      creatorId: currentUser.id,
      schema: world as unknown as Record<string, unknown>,
    });
  } else {
    // Rejection results
    writeResults = pendingToolCalls.map((tc) => ({
      tool_call_id: tc.id,
      name: tc.function.name,
      status: "error" as const,
      result: null,
      error: "User rejected this change.",
    }));
  }

  // Build tool result messages to add to conversation
  const allResults = [...readResults, ...writeResults];
  // One tool message per tool_call_id — a single delete_entities call expands to
  // many results sharing an id, and Anthropic rejects >1 tool_result per tool_use.
  const toolResultMessages: ChatMessage[] = buildToolResultMessages(allResults);

  // Build complete tool_calls list (read tools reconstructed with original args + write tools)
  const allToolCalls: ToolCall[] = [
    ...readResults.map((r) => ({
      id: r.tool_call_id,
      type: "function" as const,
      function: {
        name: r.name,
        arguments: (r as unknown as Record<string, unknown>)._originalArgs as string ?? "{}",
      },
    })),
    ...pendingToolCalls,
  ];

  const updatedMessages: ChatMessage[] = [
    ...messages,
    { role: "assistant" as const, content: run.textContent ?? "", tool_calls: allToolCalls },
    ...toolResultMessages,
  ];

  const nextIteration = run.iteration + 1;

  // If rejected, do one follow-up turn then stop
  if (!body.approved) {
    // Update run with rejection, continue for one more turn
    await db
      .update(agentRuns)
      .set({
        status: "running",
        messages: updatedMessages as unknown as Array<Record<string, unknown>>,
        pendingToolCalls: null,
        readToolResults: null,
        textContent: null,
        iteration: nextIteration,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, body.runId));

    const rejResolved = await resolveProviderForModel(currentUser.id, run.model);
    if (!rejResolved) return c.json({ error: "No API key" }, 400);

    c.header("X-Accel-Buffering", "no");
    c.header("X-Agent-Run-Id", body.runId);
    return streamAgentLoop(c, {
      runId: body.runId,
      conversationId: run.conversationId ?? run.id,
      worldId,
      userId: currentUser.id,
      world,
      messages: updatedMessages,
      model: run.model,
      provider: rejResolved.provider,
      isByok: rejResolved.isByok,
      apiKeyTier: rejResolved.apiKeyTier,
      context: run.context as { activePanel?: string; selectedElementId?: string; selectedElementType?: string },
      iteration: nextIteration,
      maxIterations: nextIteration + 1,
      tools: STUDIO_TOOLS,
      unlimited: isUnlimited,
    });
  }

  // Approved — update run and continue loop
  await db
    .update(agentRuns)
    .set({
      status: "running",
      messages: updatedMessages as unknown as Array<Record<string, unknown>>,
      pendingToolCalls: null,
      readToolResults: null,
      textContent: null,
      iteration: nextIteration,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, body.runId));

  const appResolved = await resolveProviderForModel(currentUser.id, run.model);
  if (!appResolved) return c.json({ error: "No API key" }, 400);

  c.header("X-Accel-Buffering", "no");
  c.header("X-Agent-Run-Id", body.runId);
  return streamAgentLoop(c, {
    runId: body.runId,
    conversationId: run.conversationId ?? run.id,
    worldId,
    userId: currentUser.id,
    world,
    messages: updatedMessages,
    model: run.model,
    provider: appResolved.provider,
    isByok: appResolved.isByok,
    apiKeyTier: appResolved.apiKeyTier,
    context: run.context as { activePanel?: string; selectedElementId?: string; selectedElementType?: string },
    iteration: nextIteration,
    maxIterations: run.maxIterations,
    tools: STUDIO_TOOLS,
    unlimited: isUnlimited,
  });
});

// ── POST /api/studio/:worldId/agent/generate-image — the creator answers a generate_image card ──
//
// Mirrors /agent/approve: claim the paused run, turn the creator's click into the
// tool result the model is waiting for, re-enter the loop. On confirm the job is
// created here on the creator's behalf (their wallet, the card's bound folder)
// and the loop's prelude follows it until the picture lands.

agentRoutes.post("/:worldId/agent/generate-image", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{
    runId: string;
    approved: boolean;
    prompt?: string;
    aspectRatio?: string;
    batchSize?: number;
  }>();

  const transitionApproval = (executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]) => executor
    .update(agentRuns)
    .set({ status: "running", updatedAt: new Date() })
    .where(
      and(
        eq(agentRuns.id, body.runId),
        eq(agentRuns.userId, currentUser.id),
        eq(agentRuns.worldId, worldId),
        eq(agentRuns.status, "awaiting_approval"),
      )
    )
    .returning();
  const approval = studioCreditRecoveryEnabled() ? await db.transaction(async tx => {
    const [ownedWorld] = await tx.select({ id: worlds.id }).from(worlds)
      .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id))).for("update");
    if (!ownedWorld) return { run: undefined, blocked: false };
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.worldId, worldId), ne(agentRuns.id, body.runId), eq(agentRuns.status, "running"))).limit(1);
    if (active) return { run: undefined, blocked: true };
    const [run] = await transitionApproval(tx);
    return { run, blocked: false };
  }) : { run: (await transitionApproval(db))[0], blocked: false };
  if (approval.blocked) return c.json({ error: "Another agent run is active", code: "ACTIVE_RUN" }, 409);
  const run = approval.run;
  if (!run) return c.json({ error: "Agent run not found or not awaiting confirmation" }, 404);

  const pending = (run.pendingToolCalls ?? []) as unknown as ToolCall[];
  const call = pending[0];
  if (pending.length !== 1 || !call || call.function.name !== IMAGE_TOOL_NAME) {
    // Give the run back so the ordinary approve route can still handle it.
    await db.update(agentRuns).set({ status: "awaiting_approval", updatedAt: new Date() }).where(eq(agentRuns.id, body.runId));
    return c.json({ error: "This run is not waiting for an image confirmation", code: "NOT_IMAGE_PROPOSAL" }, 409);
  }
  const original = normalizeImageProposal(parseToolArgs(call.function.arguments));
  const proposal = normalizeImageProposal({
    ...original,
    prompt: body.prompt ?? original?.prompt,
    aspectRatio: body.aspectRatio ?? original?.aspectRatio,
    batchSize: body.batchSize ?? original?.batchSize,
  });
  if (!proposal) {
    await db.update(agentRuns).set({ status: "awaiting_approval", updatedAt: new Date() }).where(eq(agentRuns.id, body.runId));
    return c.json({ error: "A prompt is required", code: "INVALID_PROPOSAL" }, 400);
  }

  const worldRows = await db
    .select({ schema: worlds.schema, status: worlds.status })
    .from(worlds)
    .where(eq(worlds.id, worldId));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);
  const workingSchema = await resolveWorkingSchema(
    worldId,
    worldRows[0]!.status,
    worldRows[0]!.schema as unknown as Record<string, unknown>,
  );
  const world = migrateWorldDefinition(workingSchema as unknown as WorldDefinition);

  const wallet = await ensureWallet(currentUser.id);
  const effectivePlan = await resolveEffectivePlanWithEventEntitlements(currentUser.id, wallet.plan);
  const isUnlimited = PLANS[effectivePlan]?.unlimited ?? false;

  const resolved = await resolveProviderForModel(currentUser.id, run.model, { allowNonPriced: STUDIO_MODEL_IDS.has(run.model) });
  if (!resolved) {
    await db.update(agentRuns).set({ status: "awaiting_approval", updatedAt: new Date() }).where(eq(agentRuns.id, body.runId));
    return c.json({ error: "No API key configured for this provider. Add one in Settings." }, 400);
  }

  const messages = run.messages as unknown as ChatMessage[];
  const nextIteration = run.iteration + 1;
  const assistantTurn: ChatMessage = { role: "assistant" as const, content: run.textContent ?? "", tool_calls: [call] };

  const resumeWith = async (extraMessages: ChatMessage[], opts: { prelude?: AgentLoopParams["prelude"]; oneMoreTurn?: boolean }) => {
    const updatedMessages: ChatMessage[] = [...messages, assistantTurn, ...extraMessages];
    await db
      .update(agentRuns)
      .set({
        status: "running",
        messages: updatedMessages as unknown as Array<Record<string, unknown>>,
        pendingToolCalls: null,
        readToolResults: null,
        textContent: null,
        iteration: nextIteration,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, body.runId));
    c.header("X-Accel-Buffering", "no");
    c.header("X-Agent-Run-Id", body.runId);
    return streamAgentLoop(c, {
      runId: body.runId,
      conversationId: run.conversationId ?? run.id,
      worldId,
      userId: currentUser.id,
      world,
      messages: updatedMessages,
      model: run.model,
      provider: resolved.provider,
      isByok: resolved.isByok,
      apiKeyTier: resolved.apiKeyTier,
      context: run.context as { activePanel?: string; selectedElementId?: string; selectedElementType?: string },
      iteration: nextIteration,
      maxIterations: opts.oneMoreTurn ? nextIteration + 1 : run.maxIterations,
      tools: STUDIO_TOOLS,
      unlimited: isUnlimited,
      prelude: opts.prelude,
    });
  };

  if (!body.approved) {
    return resumeWith(imageToolMessages(call, { status: "error", result: null,
      error: "The creator declined generating this image. Do not propose it again unless they ask; continue without it." }), { oneMoreTurn: true });
  }

  // The card's first bound folder is where its pictures live; no binding means
  // the library root, which is where the creator would look anyway.
  const [binding] = await db.select({ folderId: worldFolderBindings.folderId }).from(worldFolderBindings)
    .where(eq(worldFolderBindings.worldId, worldId)).orderBy(asc(worldFolderBindings.createdAt)).limit(1);
  const folderId = binding?.folderId ?? null;

  let jobId: string;
  try {
    // The dispatcher's claim tick shares the admission lock; a momentary BUSY
    // is not worth handing the creator a failure, so give it a few tries.
    const requestId = crypto.randomUUID();
    let submitted: Awaited<ReturnType<typeof submitSmartGeneration>> | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        submitted = await submitSmartGeneration(currentUser.id, {
          prompt: proposal.prompt,
          requestId,
          cloud: { billing: "actual-v1", model: SMART_IMAGE_MODEL, aspectRatio: proposal.aspectRatio,
            ...(proposal.resolution ? { resolution: proposal.resolution as never } : {}), batchSize: proposal.batchSize },
          ...(folderId ? { folderId } : {}),
        });
        break;
      } catch (error) {
        if (error instanceof SmartSubmissionError && error.code === "GENERATION_BUSY" && attempt < 4) {
          await new Promise((r) => setTimeout(r, 1000 + attempt * 500));
          continue;
        }
        throw error;
      }
    }
    jobId = submitted.job.id;
  } catch (error) {
    const code = error instanceof SmartSubmissionError ? error.code : "SUBMIT_FAILED";
    console.error("[Agent] generate_image submission failed:", error);
    return resumeWith(imageToolMessages(call, { status: "error", result: null,
      error: `Image generation could not start (${code}). Nothing was charged. Tell the creator${code === "NO_CREDITS" || code === "INSUFFICIENT_CREDITS" ? " they need more mushies" : ""} and continue without the image.` }), {
      oneMoreTurn: true,
      // The card is already in its "drawing" state; tell it the job never started.
      prelude: async ({ send }) => { await send("image_result", JSON.stringify({ runId: body.runId, toolCallId: call.id, jobId: null, status: "failed", errorCode: code })); return []; },
    });
  }

  return resumeWith([], {
    prelude: ({ send, progress }) => waitForGeneratedImage({ call, jobId, runId: body.runId, folderId, send, progress }),
  });
});

// ── GET /api/studio/:worldId/agent/changes/:runId/:toolCallId — Stable compare payload ──

agentRoutes.get("/:worldId/agent/changes/:runId/:toolCallId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const runId = c.req.param("runId");
  const toolCallId = c.req.param("toolCallId");

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(
      eq(agentRuns.id, runId),
      eq(agentRuns.userId, currentUser.id),
      eq(agentRuns.worldId, worldId),
    ))
    .limit(1);

  if (!run) {
    return c.json({ error: "Agent run not found" }, 404);
  }

  const [snapshot] = await db
    .select({ schemaData: worldSnapshots.schemaData })
    .from(worldSnapshots)
    .where(and(
      eq(worldSnapshots.worldId, worldId),
      eq(worldSnapshots.userId, currentUser.id),
      eq(worldSnapshots.agentRunId, runId),
    ))
    .orderBy(asc(worldSnapshots.createdAt))
    .limit(1);

  if (!snapshot) {
    return c.json({ error: "Original snapshot not found" }, 404);
  }

  const writeToolCalls = collectRunWriteToolCalls(run);
  const compare = buildChangeCompareFromRun(
    migrateWorldDefinition(snapshot.schemaData as unknown as WorldDefinition),
    writeToolCalls,
    toolCallId,
  );

  if (!compare) {
    return c.json({ error: "Change data not found" }, 404);
  }

  return c.json({ data: compare });
});

// ── GET /api/studio/:worldId/agent/status — Poll current agent state ──

agentRoutes.get("/:worldId/agent/status", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const runId = c.req.query("runId");
  const conversationId = c.req.query("conversationId");

  const query = runId
    ? and(eq(agentRuns.id, runId), eq(agentRuns.userId, currentUser.id), eq(agentRuns.worldId, worldId))
    : and(eq(agentRuns.worldId, worldId), eq(agentRuns.userId, currentUser.id),
      conversationId === undefined ? undefined : conversationId
        ? eq(agentRuns.conversationId, conversationId) : sql`${agentRuns.conversationId} IS NULL`);

  const runs = await db
    .select()
    .from(agentRuns)
    .where(query!)
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);

  if (runs.length === 0) {
    return c.json({ data: null });
  }

  const run = runs[0]!;
  const recoveryEnabled = studioCreditRecoveryEnabled();
  const checkpoint = recoveryEnabled ? readStudioCreditCheckpoint(run.creditCheckpoint) : null;
  // Refreshed pages need current spendable funds, not the balance at the time
  // the stream paused. A running checkpoint is a journal, not a paused task;
  // only an eligible paused or abandoned worker may offer recovery.
  const creditPause = checkpoint
    ? { ...publicCreditPause(checkpoint), ...await getAvailableCredits(currentUser.id),
      resumable: isStudioCreditResumeEligible(run, checkpoint) && checkpoint.reason !== "STALE_WORLD"
        && !(checkpoint.phase === "generated" && checkpoint.generated.billingUnavailable) }
    : null;
  return c.json({
    data: {
      id: run.id,
      conversationId: run.conversationId,
      status: run.status,
      iteration: run.iteration,
      maxIterations: run.maxIterations,
      textContent: run.textContent,
      /** Ordered list of committed assistant text bubbles (server-owned source of truth).
       *  The client hydrates chatMessages from this on SSE recovery — previously it used
       *  the single `textContent` field, which could duplicate bubbles already committed
       *  live via assistant_turn_commit events. */
      committedTurns: run.committedTurns,
      pendingToolCalls: run.pendingToolCalls,
      readToolResults: run.readToolResults,
      error: run.error,
      ...(recoveryEnabled ? { creditPause } : {}),
      messages: run.messages,
      updatedAt: run.updatedAt,
    },
  });
});

// ── POST /api/studio/:worldId/agent/stop — Cancel a running agent ──

agentRoutes.post("/:worldId/agent/stop", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ runId: string }>();

  // Try local abort first (same replica)
  const localController = activeAgentRuns.get(body.runId);
  if (localController) {
    localController.abort();
  }

  // Broadcast stop to all replicas via Redis pub/sub.
  // If the run is on a different replica, that replica receives
  // the message and aborts the controller there.
  if (redis) {
    redis.publish(AGENT_STOP_CHANNEL, JSON.stringify({ runId: body.runId })).catch(() => {});
  }

  await db
    .update(agentRuns)
    .set({ status: "completed", error: "Stopped by user.", creditCheckpoint: null, updatedAt: new Date() })
    .where(
      and(
        eq(agentRuns.id, body.runId),
        eq(agentRuns.userId, currentUser.id),
        eq(agentRuns.worldId, worldId),
      )
    );

  return c.json({ ok: true });
});

// ── Dynamic Context Windowing ──

// Token estimate: ~4 chars/token for ASCII, ~1 char/token for CJK (Chinese/Japanese/Korean).
// Mixed-content cards (Chinese entries + English code) were undercounted ~4-8x by a flat /4 estimate,
// causing buildWindowedMessages to skip compaction and bust provider context limits (e.g. Gemini 1M).
function estimateTextTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // CJK Unified Ideographs, Hiragana/Katakana, Hangul, CJK punctuation
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) {
      cjk++;
    }
  }
  const ascii = text.length - cjk;
  return Math.ceil(cjk + ascii / 4);
}

function estimateTokens(msg: ChatMessage): number {
  let total = 0;
  if (typeof msg.content === "string") total += estimateTextTokens(msg.content);
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if ("text" in part) total += estimateTextTokens(part.text);
      else total += 200; // image placeholder
    }
  } else total += 50;
  // Tool call arguments live on assistant messages and can carry full tsxCode payloads
  if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTextTokens(tc.function.arguments ?? "");
    }
  }
  return total;
}

// Reserve ~60% of context for history (rest = system prompt + tools + response budget)
const MIN_RECENT_MESSAGES = 6; // Always keep at least 3 user-assistant pairs

/** Derive context budget from model ID. Uses ~60% of the model's known context window. */
function getContextBudget(modelId: string): number {
  const id = modelId.toLowerCase();
  // Gemini models: 1M+ context
  if (id.includes("gemini")) return 600_000;
  // Claude — Sonnet 4.6 (our studio default) has a 1M window; older Sonnets/Opus are 200K.
  // The 60% cap leaves room for the 3-tier system prompt, tools schema, and MAX_OUTPUT=64K.
  if (id.includes("claude")) {
    if (id.includes("sonnet-4.6") || id.includes("sonnet-4-6") || id.includes("-1m")) {
      return 600_000;
    }
    return 120_000;
  }
  // GPT-4o/4.1: 128k context
  if (id.includes("gpt-4o") || id.includes("gpt-4.1")) return 75_000;
  // Grok: 128k-131k context
  if (id.includes("grok")) return 75_000;
  if (id.includes("qwen") || id.includes("kimi")) return 75_000;
  // Llama/Mistral/DeepSeek: varies 32k-128k
  if (id.includes("llama") || id.includes("mistral") || id.includes("deepseek")) return 50_000;
  // Default: conservative 120k (assumes 200k model)
  return 120_000;
}

/**
 * Dynamic context compaction: estimates token usage and compacts
 * when approaching the budget. Short messages use less capacity,
 * long messages get compacted sooner. Like Claude Code's auto-compaction.
 */
function buildWindowedMessages(messages: ChatMessage[], modelId = ""): ChatMessage[] {
  if (messages.length <= MIN_RECENT_MESSAGES) return messages;

  // Calculate total tokens
  let totalTokens = 0;
  const tokenCounts: number[] = messages.map((m) => {
    const t = estimateTokens(m);
    totalTokens += t;
    return t;
  });

  // If within budget, return everything
  const budget = getContextBudget(modelId);
  if (totalTokens <= budget) return messages;

  // Find the split point: keep as many recent messages as fit in budget
  let recentTokens = 0;
  let splitIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    recentTokens += tokenCounts[i]!;
    if (recentTokens > budget * 0.7) {
      // Keep at least MIN_RECENT_MESSAGES
      splitIdx = Math.min(i + 1, messages.length - MIN_RECENT_MESSAGES);
      break;
    }
    splitIdx = i;
  }

  if (splitIdx <= 0) return messages;

  const older = messages.slice(0, splitIdx);
  const recent = messages.slice(splitIdx);

  // Build deterministic summary of older turns (no LLM call)
  const actions: string[] = [];
  for (const msg of older) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content.slice(0, 120)
        : "[multimodal message]";
      actions.push(`- User: "${text}"`);
    } else if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls?.length) {
      const toolNames = msg.tool_calls.map((tc) => tc.function.name).join(", ");
      const text = typeof msg.content === "string" && msg.content.trim()
        ? msg.content.slice(0, 80)
        : "";
      actions.push(`- Agent: ${toolNames}${text ? ` — "${text}"` : ""}`);
    }
    // Skip tool result messages in summary (already compacted)
  }

  if (actions.length === 0) return messages;

  const summary = `[Earlier conversation — ${older.length} messages summarized]\n${actions.join("\n")}`;

  return [
    { role: "user" as const, content: summary },
    { role: "assistant" as const, content: "Understood, I have context from our earlier work." },
    ...recent,
  ];
}

// ── Compress Large Tool Results ──

/**
 * Compress oversized tool results from earlier iterations so they don't
 * bloat the context on every subsequent LLM call.
 *
 * Strategy: keep the most recent N tool results intact (the agent may
 * still be reasoning about them). For older ones, if the JSON content
 * exceeds COMPRESS_THRESHOLD chars, replace with a short summary.
 */
// CoreCoder-inspired compression: lower thresholds, keep fewer recent results,
// first-3/last-3 line format preserves structure while cutting bulk.
const COMPRESS_THRESHOLD = 1500; // chars (~375 tokens) — down from 3000
// Keep 4 recent tool results uncompressed so the model has room to reason across a
// read→search→slice→edit chain without its own inputs being snipped mid-flow.
const KEEP_RECENT_TOOL_RESULTS = 4;

function compressOldToolResults(messages: ChatMessage[]): ChatMessage[] {
  // Find all tool result indices
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "tool") toolIndices.push(i);
  }
  if (toolIndices.length <= KEEP_RECENT_TOOL_RESULTS) return messages;

  // Indices to compress: all except the most recent N
  const toCompress = new Set(toolIndices.slice(0, -KEEP_RECENT_TOOL_RESULTS));

  return messages.map((msg, i) => {
    if (!toCompress.has(i) || msg.role !== "tool") return msg;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length <= COMPRESS_THRESHOLD) return msg;

    // CoreCoder pattern: first 3 + last 3 lines preserves opening (entity id/type) and closing (status)
    const lines = content.split("\n");
    if (lines.length <= 6) return msg; // Short results pass through
    const snipped = [
      ...lines.slice(0, 3),
      `... (${lines.length} lines, ${content.length} chars — use read_entities for full content) ...`,
      ...lines.slice(-3),
    ].join("\n");
    return { ...msg, content: snipped };
  });
}

function assistantToolCallMessage(content: string, toolCalls: ToolCall[], reasoningContent: string): ChatMessage {
  const message: ChatMessage = { role: "assistant", content, tool_calls: toolCalls };
  if (toolCalls.length > 0 && reasoningContent.trim().length > 0) {
    message.reasoning_content = reasoningContent;
  }
  return message;
}

/** Snip oversized tool results inline when first created (prevents bloat before compression kicks in).
 *
 * Threshold sizing rationale:
 * - Most customUI components are 5K-30K chars (~1K-10K tokens) — return in full so the agent can
 *   work normally with edit_custom_ui or full rewrites.
 * - Some worlds embed large base64 images inside tsxCode, producing 500K-1.5MB single files
 *   (~125K-400K tokens). One unsnipped read of these eats half a 600K Gemini budget; two reads
 *   bust the 1M provider limit. These get a useful preview + honest workflow guidance. */
// Raised 30K → 80K → 200K: most real TSX components are 10-50K chars, but some cards
// push 150-190K (rich customUI phone/UI surfaces). With prompt caching, sending a 200K file once
// is far cheaper than the snip→re-read spiral that used to burn through MAX_ITERATIONS.
// Files past 200K (base64-embedded assets, truly huge components) still get the preview + grep_world flow.
const INLINE_SNIP_THRESHOLD = 200000;
const TSX_PREVIEW_CHARS = 60000;

function snipLargeResult(result: unknown): unknown {
  if (typeof result === "object" && result !== null && "tsxCode" in (result as Record<string, unknown>)) {
    const obj = result as Record<string, unknown>;
    const code = String(obj.tsxCode);
    if (code.length <= INLINE_SNIP_THRESHOLD) return result;
    return {
      ...obj,
      tsxCode: code.slice(0, TSX_PREVIEW_CHARS)
        + `\n\n/* —— PREVIEW: showing first ${TSX_PREVIEW_CHARS} of ${code.length} chars ——\n`
        + ` * This component is too large to fit fully in context (likely contains embedded\n`
        + ` * base64 assets or extensive content). To work with it:\n`
        + ` *   1. To find content past the preview: call grep_world({ query, id }) with this\n`
        + ` *      component's ID — it greps the FULL source and returns each match with surrounding\n`
        + ` *      lines you can paste verbatim into edit_custom_ui's old_code.\n`
        + ` *   2. Or call read_entities with offset_lines/limit_lines to slice a specific line range.\n`
        + ` *   3. Then call edit_custom_ui with old_code/new_code snippets — does not require the full file.\n`
        + ` *   4. Re-calling read_entities without pagination returns the same preview (not the next chunk).\n`
        + ` *   5. The full code may also appear in your initial system context under PRELOADED\n`
        + ` *      CUSTOM UI if it fit the Layer 2 budget — check there before assuming missing data.\n`
        + ` * Do NOT report this preview to the user as a tool failure — it is intentional, and\n`
        + ` * do NOT ask the user for code snippets without first trying grep_world. */`,
    };
  }
  const serialized = typeof result === "string" ? result : JSON.stringify(result);
  if (serialized.length <= INLINE_SNIP_THRESHOLD) return result;
  // Generic snip: first 8000 chars + note (non-tsxCode results)
  return serialized.slice(0, 8000) + `\n... (snipped, ${serialized.length} chars total — re-fetching returns the same preview)`;
}

/** Compact, faithful trace of a set of tool calls: op name + target (entity id /
 *  query), never tool output bodies. Stamped on `step` turns so cross-run history
 *  can read "what changed" from structure instead of guessing from text. */
function toolCallActions(calls: ToolCall[]): Array<{ op: string; target?: string }> {
  return calls.map((tc) => {
    let target: string | undefined;
    try {
      const a = parseToolArgs(tc.function.arguments) as Record<string, unknown>;
      const direct = a.name ?? a.id ?? a.entryId ?? a.query;
      if (typeof direct === "string" && direct.trim() !== "") target = direct;
      else if (Array.isArray(a.ids)) target = a.ids.filter((x): x is string => typeof x === "string").join("、");
    } catch { /* unparseable args — record the op without a target */ }
    return target ? { op: tc.function.name, target } : { op: tc.function.name };
  });
}

// ── Core Agent Loop (streams SSE, handles read tools automatically) ──

export interface AgentLoopParams {
  runId: string;
  conversationId: string;
  worldId: string;
  userId: string;
  world: WorldDefinition;
  messages: ChatMessage[];
  model: string;
  provider: LLMProvider;
  isByok: boolean;
  apiKeyTier: ApiKeyTier;
  context?: {
    activePanel?: string;
    selectedElementId?: string;
    selectedElementType?: string;
  };
  iteration: number;
  maxIterations: number;
  tools: ToolDefinition[];
  /** Unlimited plan — skip credit deduction (internal tier) */
  unlimited?: boolean;
  creditResume?: { checkpoint: StudioCreditCheckpoint; claimId: string };
  committedTurns?: AgentRunRow["committedTurns"];
  /** Runs once the stream is open, before the first model call, and returns
   *  messages to append (a resumed tool's result). It may take a while and
   *  narrates to the client through `send`; `progress` feeds the stall watchdog. */
  prelude?: (hooks: { send: (event: string, data: string) => Promise<void>; progress: () => void }) => Promise<ChatMessage[]>;
}

function publicCreditPause(checkpoint: StudioCreditCheckpoint | null) {
  if (!checkpoint) return null;
  const reason = checkpoint.reason === undefined ? undefined
    : new Set(["INSUFFICIENT_CREDITS", "insufficient_credits", "pricing_unavailable", "output_limit_too_small",
      "USAGE_UNAVAILABLE", "BILLING_DETAILS_MISSING", "STALE_WORLD", "GENERATION_FAILED"]).has(checkpoint.reason)
      ? checkpoint.reason : "GENERATION_FAILED";
  return {
    phase: checkpoint.phase, requiredCredits: checkpoint.requiredCredits,
    iteration: checkpoint.iteration, hasSavedResult: checkpoint.phase === "generated",
    billingUnavailable: checkpoint.phase === "generated" && !!checkpoint.generated.billingUnavailable,
    resumable: checkpoint.reason !== "STALE_WORLD"
      && !(checkpoint.phase === "generated" && checkpoint.generated.billingUnavailable),
    ...(reason === undefined ? {} : { reason }),
    ...(checkpoint.phase === "generated" ? { cost: checkpoint.generated.cost, settled: !!checkpoint.generated.settled } : {}),
  };
}

function hasKnownStudioUsage(usage: StreamChunk["usage"]): boolean {
  const finiteNonNegative = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (finiteNonNegative(usage?.providerCostUsd)) return true;
  return finiteNonNegative(usage?.promptTokens) && finiteNonNegative(usage?.completionTokens)
    && usage.promptTokens + usage.completionTokens > 0;
}

/**
 * Extract compact metadata from a just-written entity so the agent
 * doesn't need to call read_entities to see what it just created/updated.
 */
function extractEntityMeta(
  world: WorldDefinition,
  entityType: string,
  id: string,
): Record<string, unknown> | null {
  switch (entityType) {
    case "entry": {
      const e = world.entries.find((x) => x.id === id);
      if (!e) return null;
      return { id: e.id, name: e.name, role: e.role, section: e.section, position: e.position, enabled: e.enabled };
    }
    case "variable": {
      const v = world.variables.find((x) => x.id === id);
      if (!v) return null;
      return { id: v.id, name: v.name, type: v.type, defaultValue: v.defaultValue };
    }
    case "behavior": {
      const b = (world.reactions ?? []).find((x) => x.id === id);
      if (!b) return null;
      return { id: b.id, name: b.name, eventType: b.when?.eventType, priority: b.priority, enabled: b.enabled };
    }
    case "customUI": {
      // Every world has rootComponent after v19→v20 migration. Agent addresses
      // files by filename (e.g. "index.tsx", "bubble.tsx") — legacy customUI[]
      // is always empty, so we don't fall through to it.
      if (world.rootComponent) {
        if (id in world.rootComponent.files || id === world.rootComponent.entryFile) {
          return { id, name: world.rootComponent.name, file: id, entryFile: world.rootComponent.entryFile };
        }
      }
      return null;
    }
    case "audio": {
      const a = (world.audioTracks ?? []).find((x) => x.id === id);
      if (!a) return null;
      return { id: a.id, name: a.name, type: a.type, loop: a.loop };
    }
    case "settings":
      return { id: "settings", updated: true };
    default:
      return null;
  }
}

export function streamAgentLoop(c: Parameters<typeof streamSSE>[0], params: AgentLoopParams) {
  return streamSSE(c, async (stream) => {
    let {
      runId, userId, world, messages, model,
      provider, isByok, apiKeyTier, context, iteration, maxIterations,
      tools,
    } = params;
    const unlimited = params.unlimited ?? false;
    const creditRecovery = studioCreditRecoveryEnabled() && !isByok && (!unlimited || !!params.creditResume);
    const creditScope = { runId, worldId: params.worldId, userId };
    let creditCheckpoint = params.creditResume?.checkpoint ?? null;
    let creditClaimId = params.creditResume?.claimId;
    let replayGenerated = creditCheckpoint?.phase === "generated" ? creditCheckpoint.generated : undefined;
    let previousCompletionTokens = replayGenerated?.usage?.completionTokens;
    let reservationId: string | undefined;
    let lastLeaseRenewal = 0;
    void params.worldId; // Used via runId for DB lookups

    const controller = new AbortController();
    // A reclaimed run may have an old worker in this process. Its fenced writes
    // cannot affect this claim, and its cleanup must not delete our controller.
    activeAgentRuns.get(runId)?.abort();
    activeAgentRuns.set(runId, controller);
    // Registered for the SIGTERM drain — a deploy aborts the run cleanly
    // (status persisted to agent_runs) instead of SIGKILLing it mid-write.
    const unregisterStream = registerStream(controller);

    // Track SSE disconnect separately from agent abort.
    // When the SSE connection drops (e.g. Railway proxy timeout), the agent
    // continues running and saves results to DB. The client recovers via polling.
    // Only user-initiated stop, credit exhaustion, or the 10-min safety timeout abort the agent.
    let sseDisconnected = false;
    stream.onAbort(() => { sseDisconnected = true; });

    // Terminal-status writes are conditional on status still being "running".
    // The watchdog, /agent/stop (own or cross-replica), and supersession all
    // write a terminal status first — the loop's own exit paths must not
    // overwrite it. (Previously the safety-cap fallthrough stamped
    // status="completed" over the watchdog's "error", leaving contradictory
    // completed + "Agent timed out" rows.)
    const ownedRunWhere = () => and(
      eq(agentRuns.id, runId), eq(agentRuns.status, "running"),
      creditRecovery ? (creditClaimId
        ? sql`${agentRuns.creditCheckpoint}->'claim'->>'id' = ${creditClaimId}`
        : sql`${agentRuns.creditCheckpoint}->'claim'->>'id' IS NULL`) : undefined,
    );
    const finishCreditIteration = async (nextMessages: ChatMessage[], nextIteration: number) => {
      if (reservationId) {
        await releaseStudioCreditReservation(userId, reservationId);
        reservationId = undefined;
      }
      if (!creditClaimId) return;
      const saved = await withStudioCreditClaimTransaction(creditScope, creditClaimId, async (_tx, checkpoint) => ({
        // Atomically consume the completed result AND journal the next step.
        // Clearing this between calls left paid progress stranded on deploy.
        value: null, checkpoint: {
          version: 1 as const, phase: "preflight" as const, messages: nextMessages,
          iteration: nextIteration, worldRevision: checkpoint.worldRevision, requiredCredits: 0,
        },
        runUpdates: { messages: nextMessages as unknown as Array<Record<string, unknown>>, iteration: nextIteration },
      }));
      creditCheckpoint = saved.checkpoint;
    };
    const finalizeRun = async (set: Partial<typeof agentRuns.$inferInsert>) => {
      // A deploy is not completion or user cancellation. The finally block
      // restores our saved checkpoint, including any already-settled work.
      if (isShutdownAbort(controller.signal)) return;
      if (creditClaimId && !controller.signal.aborted &&
          (set.status === "completed" || set.status === "awaiting_user" || set.status === "awaiting_approval")) {
        if (reservationId) {
          await releaseStudioCreditReservation(userId, reservationId);
          reservationId = undefined;
        }
        // Consume the checkpoint and publish the terminal state atomically.
        // A deploy must never leave a running row without its recovery record.
        const status = set.status;
        await withStudioCreditClaimTransaction(creditScope, creditClaimId, async () => ({
          value: null, checkpoint: null, status, runUpdates: set,
        }));
        creditCheckpoint = null;
        creditClaimId = undefined;
        return;
      }
      return db.update(agentRuns).set({ ...set, updatedAt: new Date() })
        .where(ownedRunWhere());
    };
    const sendCreditBalance = async (cost?: number) => {
      const balances = await getAvailableCredits(userId);
      await safeSend("credits", JSON.stringify({ ...balances, ...(cost !== undefined ? { cost } : {}) }));
      return balances;
    };
    const pauseForCredits = async (checkpoint: StudioCreditCheckpoint, reason = "INSUFFICIENT_CREDITS") => {
      // Persist the result before any independent hold release. If the worker
      // dies next, the result survives and the abandoned lease expires.
      const paused = await pauseStudioForCredits(creditScope, checkpoint, creditClaimId, reason);
      if (!paused) return;
      creditCheckpoint = { ...checkpoint, reason };
      creditClaimId = undefined;
      if (reservationId) {
        await releaseStudioCreditReservation(userId, reservationId);
        reservationId = undefined;
      }
      const balances = await sendCreditBalance();
      await safeSend("credits_paused", JSON.stringify({ runId, ...publicCreditPause(creditCheckpoint), ...balances }));
    };

    // Progress-aware watchdog (checked from the heartbeat interval below).
    // The old absolute 10-minute timeout killed runs that were healthily
    // streaming: one ~26K-token entry write takes ~10min at observed Sonnet
    // throughput (~45 tok/s on a 100K prompt), so big merge tasks could never
    // finish and every retry died the same way mid-generation. A run is now
    // killed only when it genuinely stalls (no LLM chunk and no applied write
    // for IDLE_TIMEOUT_MS) or hits a generous absolute backstop sized so one
    // maxed-out iteration (MAX_OUTPUT tokens ≈ 24min at 45 tok/s) still fits.
    const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
    const ABSOLUTE_TIMEOUT_MS = 30 * 60 * 1000;
    const runStartedAt = Date.now();
    let lastProgressAt = Date.now();
    const noteProgress = () => { lastProgressAt = Date.now(); };

    let lastSendTime = Date.now();
    const safeSend = async (event: string, data: string) => {
      if (controller.signal.aborted || sseDisconnected) return;
      try {
        await stream.writeSSE({ event, data });
        lastSendTime = Date.now();
      } catch {
        // Write failed — SSE connection likely broken. Mark as disconnected
        // so we stop attempting writes, but don't abort the agent.
        sseDisconnected = true;
      }
    };

    // Triple-purpose heartbeat:
    //   (1) Client-facing SSE keepalive — prevents Railway proxy's ~30s idle timeout
    //       from tearing down healthy streams during long LLM calls. 5s interval +
    //       8s threshold = max gap ~13s, well within the limit.
    //   (2) Liveness signal for `tryRecoverAgentRun` — bumps agent_runs.updated_at
    //       every 5s so recovery polling can distinguish an alive-but-streaming
    //       agent from a dead one. Without this, updatedAt stays frozen during a
    //       long LLM iteration (no DB write fires until a tool executes or a turn
    //       commits), and recovery mistakenly gives up at STALE_MS=2min.
    //   (3) Cross-replica stop reconciliation — every 3 ticks (~15s), SELECT the
    //       run's status. `/agent/stop` on a different Railway replica can't reach
    //       this process's activeAgentRuns map, so its only trace is writing
    //       status != "running" to DB. The agent loop only writes terminal status
    //       on its own exit, so reading a non-"running" value here strictly means
    //       an external request changed it (stop, new run superseding, etc.).
    // The DB bump runs even when SSE is disconnected: recovery only trusts DB state,
    // and an agent that survives a dropped SSE is exactly the case we need to signal.
    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => {
      if (controller.signal.aborted) return;
      const sinceProgress = Date.now() - lastProgressAt;
      const sinceStart = Date.now() - runStartedAt;
      if (sinceProgress > IDLE_TIMEOUT_MS || sinceStart > ABSOLUTE_TIMEOUT_MS) {
        const reason = sinceProgress > IDLE_TIMEOUT_MS
          ? "Agent stalled — no model output for 3 minutes."
          : "Agent timed out after 30 minutes.";
        console.warn(`[Agent] Run ${runId} watchdog: ${reason} Force-aborting.`);
        // Persist the reason BEFORE aborting — abort makes the loop's own
        // error paths race to finalize, and the stall reason must win.
        finalizeRun({ status: "error", error: reason })
          .catch(() => {})
          .finally(() => controller.abort());
        return;
      }
      // `iteration` rides along with the liveness bump. It costs nothing (the
      // UPDATE already fires every 5s) and it is the only way a client whose SSE
      // has dropped can tell "step 7 of 50, still moving" from "hung": until
      // now the column was written only when a run paused for approval, so a
      // recovering client polled a step counter frozen at its starting value.
      db.update(agentRuns)
        .set({ updatedAt: new Date(), iteration })
        .where(ownedRunWhere())
        .catch(() => {});
      heartbeatTicks++;
      if (reservationId && Date.now() - lastLeaseRenewal >= 60_000) {
        lastLeaseRenewal = Date.now();
        renewStudioCreditReservation(userId, reservationId).then(renewed => {
          if (!renewed) controller.abort(new Error("Credit reservation expired"));
        }).catch(() => controller.abort(new Error("Credit reservation renewal failed")));
      }
      if (heartbeatTicks % 3 === 0) {
        const pollingClaimId = creditClaimId;
        db.select({ status: agentRuns.status, creditCheckpoint: agentRuns.creditCheckpoint })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .then((rows) => {
            if (controller.signal.aborted) return;
            const status = rows[0]?.status;
            const persistedClaimId = readStudioCreditCheckpoint(rows[0]?.creditCheckpoint)?.claim?.id;
            const claimChanged = creditRecovery && !!pollingClaimId && pollingClaimId === creditClaimId && persistedClaimId !== creditClaimId;
            if ((status && status !== "running") || claimChanged) {
              console.log(`[Agent] Run ${runId} status=${status} detected via heartbeat poll — aborting local controller (cross-replica stop or supersession).`);
              controller.abort();
            }
          })
          .catch(() => {});
      }
      if (!sseDisconnected && Date.now() - lastSendTime >= 8_000) {
        safeSend("heartbeat", "{}").catch(() => {});
      }
    }, 5_000);

    // Send runId to client immediately so it can cancel the agent
    await safeSend("run_started", JSON.stringify({ runId }));

    let lastTextContent = "";
    // Nudge counter: when the model outputs text without calling ANY tools (i.e. it
    // *describes* the change instead of *making* it), we inject a follow-up pushing it
    // to call tools. Capped at MAX_TEXT_NUDGES per run to avoid infinite loops.
    //
    // We nudge on any non-empty text-only turn. The previous ">200 chars" gate let dense
    // CJK plans slip straight through to "completed" — e.g. "现在直接修复——把" (8 chars) or the
    // 195-char Chinese plan from the reported screenshot — which was the single biggest
    // cause of "the agent said it would do something and then just stopped" (~30% of runs).
    // A genuine short final answer ("validation clean, nothing to change") costs at most
    // MAX_TEXT_NUDGES cheap extra round-trips before the run still completes.
    const MAX_TEXT_NUDGES = 2;
    let textOnlyNudges = 0;

    // Server-owned log of committed assistant text turns. Each entry = one persistent chat
    // bubble on the client. This is the SINGLE source of truth for "has this text been
    // shown to the user as a bubble yet?" — replaces the fragile implicit-commit logic that
    // used to infer boundaries from read_tools_executed vs done.
    const committedTurns: Array<{ iteration: number; textContent: string; createdAt: string; commitId: string; writeToolCalls?: ToolCall[]; lane?: "answer" | "step" | "notice"; actions?: Array<{ op: string; target?: string }>; toolNarration?: boolean }> = [...(params.committedTurns ?? [])];

    /** Commit one assistant text turn as a persistent chat bubble.
     *  Idempotent on (runId, iteration): callers may invoke it even if unsure whether
     *  the current iteration already committed — it no-ops in that case.
     *  `lane` classifies the turn from structural fact: `answer` (the run's real
     *  reply — the ONLY lane re-fed to the model next run), `step` (tool preamble or
     *  mid-task stall), `notice` (server-injected guard/nudge text). `step`/`notice`
     *  are UI-only, so the model is never trained on announcements that never act.
     *  `actions` is the compact tool trace for `step` turns. */
    async function commitTextTurn(iter: number, text: string, opts?: { writeToolCalls?: ToolCall[]; lane?: "answer" | "step" | "notice"; actions?: Array<{ op: string; target?: string }> }) {
      const writeToolCalls = opts?.writeToolCalls;
      const trimmed = text.trim();
      if (!trimmed && !writeToolCalls?.length) return;
      if (committedTurns.some((t) => t.iteration === iter)) return;
      const commitId = crypto.randomUUID();
      const lane = opts?.lane;
      const entry = {
        iteration: iter,
        textContent: text,
        createdAt: new Date().toISOString(),
        commitId,
        ...(writeToolCalls && writeToolCalls.length > 0 ? { writeToolCalls } : {}),
        ...(lane ? { lane } : {}),
        ...(opts?.actions && opts.actions.length > 0 ? { actions: opts.actions } : {}),
        // Back-compat: legacy consumers keyed off `toolNarration`. `lane` is the
        // new source of truth; a `step` turn is exactly the old "tool narration".
        ...(lane === "step" ? { toolNarration: true as const } : {}),
      };
      committedTurns.push(entry);
      // Persist so the recovery path can rebuild the bubble list even if the client
      // missed the live SSE event (mobile tab suspend, edge proxy timeout, etc.).
      const committed = await db.update(agentRuns).set({
        committedTurns,
        updatedAt: new Date(),
      }).where(ownedRunWhere()).returning().catch(error => {
        if (creditRecovery) throw error;
        return undefined;
      });
      if (creditRecovery && !committed?.length) throw new Error("CLAIM_LOST");
      await safeSend("assistant_turn_commit", JSON.stringify({
        runId,
        iteration: iter,
        textContent: text,
        commitId,
        ...(writeToolCalls && writeToolCalls.length > 0 ? { writeToolCalls } : {}),
      }));
    }

    // Read-progress tracker: per entity id, which requests have already been issued.
    // Repetition is judged on the request (slice / grep query), not the id, so paging
    // through a large file isn't mistaken for a loop. Cleared after any write — the
    // world changed, so re-reads from there are legitimate.
    const readProgress = createReadProgressState();
    // Write-retry detector: catches exact-duplicate write batches (e.g. model retrying a failing write
    // with identical args). Separate from readProgress because writes mutate state — repetition
    // semantics differ from reads.
    let lastWriteToolKey = "";
    // Whether ANY tool (read or write) executed earlier in this run. A text-only
    // turn after the model has already acted is a legitimate wrap-up, not a
    // "described but didn't do it" stall — so we don't nudge it (the nudge would
    // otherwise pester every successful run and persist "already done" echo turns).
    let anyToolExecuted = false;

    // Build system prompt once — only read-only iterations happen within this loop,
    // so the world doesn't change and the prompt stays valid. The approve handler
    // creates a new streamAgentLoop invocation with the updated world, getting a fresh prompt.
    let cachedSystemPrompt: SystemPromptParts | null = null;

    async function getSystemPromptParts(): Promise<SystemPromptParts> {
      if (cachedSystemPrompt) return cachedSystemPrompt;

      // Tiered context resolver — Layer 1 (rich inventory) + Layer 2 (pre-loaded matches)
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const requestText = lastUserMsg && typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : "";

      const resolved = await resolveContext(world, requestText, {
        userId,
        worldId: params.worldId,
        selectedEntityId: context?.selectedElementId,
        activePanel: context?.activePanel,
        // Pass the message budget as the resolver's "context window" — it takes 45% of
        // this for Layer 2 preload. For Sonnet 4.6 (1M window, 600K budget) this yields
        // ~270K for preloaded custom UI content, so the agent can skip read_entities for
        // most components. Default 120K budget still maps to ~54K preload (no regression).
        contextWindow: getContextBudget(model),
      });
      cachedSystemPrompt = buildSystemPrompt(resolved, {
        activePanel: context?.activePanel,
        selectedEntity: context?.selectedElementId
          ? { id: context.selectedElementId, type: context.selectedElementType }
          : undefined,
      });
      return cachedSystemPrompt;
    }

    try {
      if (params.prelude) {
        try {
          const extra = await params.prelude({ send: safeSend, progress: noteProgress });
          messages = [...messages, ...extra];
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : "The resumed step failed";
          console.error("[Agent] prelude failed:", error);
          await finalizeRun({ status: "error", error: errMsg, iteration }).catch(() => {});
          await safeSend("error", JSON.stringify({ error: errMsg }));
          return;
        }
      }

      while (iteration < maxIterations) {
        if (controller.signal.aborted) break;
        noteProgress();
        const sourceRevision = creditRecovery ? await captureStudioCreditWorldRevision(creditScope) : null;
        if (sourceRevision && !replayGenerated) {
          world = migrateWorldDefinition(sourceRevision.schema as unknown as WorldDefinition);
          cachedSystemPrompt = null;
        }

        // Compress large tool results from earlier iterations to save context
        const compressedMessages = compressOldToolResults(messages);
        // Sliding window: keep recent messages raw, summarize older ones (budget varies by model)
        const windowedMessages = buildWindowedMessages(compressedMessages, model);

        // Three-tier system prompt for higher cache hit rate, all blocks at 1h TTL
        // so the tool→system→messages chain stays monotonically non-increasing
        // (Anthropic rejects a 1h block appearing after a 5m block — enforced
        // because caches can't outlive their prefix). Cache invalidation still
        // works correctly because a changed world block has a different content
        // hash → new cache entry → no stale read.
        //   Block A (static):  identity + tools-guide + core skills — 1h, never changes within session
        //   Block B (world):   Layer 1 inventory + Layer 2 preloaded content — 1h, rebuilt after writes (cachedSystemPrompt = null)
        //   Block C (dynamic): studio context (active panel / selected entity) — no cache (changes per request)
        const promptParts = await getSystemPromptParts();
        const systemContent: ContentPart[] = [
          { type: "text", text: promptParts.static, cache_control: { type: "ephemeral", ttl: "1h" } },
          ...(promptParts.world ? [{ type: "text" as const, text: promptParts.world, cache_control: { type: "ephemeral", ttl: "1h" } as const }] : []),
          ...(promptParts.dynamic ? [{ type: "text" as const, text: promptParts.dynamic }] : []),
        ];

        const llmMessages: ChatMessage[] = [
          { role: "system", content: systemContent },
          ...windowedMessages,
        ];

        const usageLogId = replayGenerated?.usageLogId ?? crypto.randomUUID();
        let outputBudget = MAX_OUTPUT;
        if (creditRecovery && !replayGenerated && sourceRevision) {
          // Favor a complete small change over an unfinished large replacement.
          llmMessages.push({ role: "user", content: "[System: Work in small complete steps. Prefer targeted edits. For a new UI feature, connect a minimal usable component to the entry and supply initial-state styles before adding polish. Finish each tool's JSON arguments within this response; do not start a whole-file rewrite that cannot fit.]" });
          const balances = await getAvailableCredits(userId);
          const budget = planStudioCreditBudget({ messages: llmMessages, tools, price: await getModelPrice(model),
            availableCredits: balances.availableCredits, previousCompletionTokens });
          const preflight: StudioCreditCheckpoint = {
            version: 1, phase: "preflight", messages, iteration, worldRevision: sourceRevision.revision,
            requiredCredits: budget.minimumRequiredCredits,
          };
          if (!budget.ok) { await pauseForCredits(preflight, budget.reason); return; }
          outputBudget = budget.maxTokens;
          const staged = await stageStudioCreditIteration(creditScope, preflight, creditClaimId);
          if (!staged.ok) {
            await safeSend("error", JSON.stringify({ error: staged.code, code: staged.code }));
            return;
          }
          creditCheckpoint = staged.checkpoint;
          creditClaimId = staged.claimId;
          try {
            const hold = await reserveStudioCredits({ userId, runId, referenceId: usageLogId, credits: budget.reservationCredits });
            reservationId = hold.id;
            lastLeaseRenewal = Date.now();
          } catch (error) {
            if (error instanceof Error && error.message === "INSUFFICIENT_CREDITS") {
              await pauseForCredits(preflight); return;
            }
            throw error;
          }
        }

        // Send iteration event
        await safeSend("iteration", JSON.stringify({ iteration, maxIterations }));

        // Stream one LLM turn
        const replay = replayGenerated;
        replayGenerated = undefined;
        let textContent = replay?.textContent ?? "";
        let reasoningContent = replay?.reasoningContent ?? "";
        const toolCalls: ToolCall[] = [...(replay?.toolCalls ?? [])];
        let iterationUsage: StreamChunk["usage"] = replay?.usage;
        let iterationStopReason: string | undefined = replay?.stopReason;
        let generationFinished = !!replay;

        try {
          if (!replay) for await (const chunk of generateStreamWithRetry(provider, {
            conversationId: `studio:${userId}:${params.worldId}:${params.conversationId}`,
            model,
            messages: llmMessages,
            maxTokens: outputBudget,
            temperature: 0.7,
            tools,
            toolChoice: "auto" as const,
            // No forced reasoning effort — let the model decide how much to think.
            // Simple tasks naturally generate fast. Complex tasks (migrations, large builds) need more thinking.
            // Cache breakpoint at end of prior conversation (everything from previous iterations).
            // System prompt caching is handled via cache_control on the static content block above.
            cacheBreakpoints: [llmMessages.length - 1],
            signal: controller.signal,
          })) {
            if (controller.signal.aborted) break;
            noteProgress();

            if (chunk.type === "reasoning") {
              reasoningContent += chunk.content;
              await safeSend("reasoning", JSON.stringify({ content: chunk.content }));
            }

            if (chunk.type === "text") {
              textContent += chunk.content;
              await safeSend("text", JSON.stringify({ content: chunk.content }));
            }

            if (chunk.type === "tool_call_start") {
              await safeSend("tool_start", JSON.stringify({
                index: chunk.toolCallIndex,
                id: chunk.toolCallId,
                name: chunk.toolCallName,
              }));
            }

            if (chunk.type === "tool_call_delta") {
              await safeSend("tool_delta", JSON.stringify({
                index: chunk.toolCallIndex,
                arguments: chunk.content,
              }));
            }

            if (chunk.type === "tool_call_end" && chunk.toolCall) {
              toolCalls.push(chunk.toolCall);
              await safeSend("tool_end", JSON.stringify({
                index: chunk.toolCallIndex,
                id: chunk.toolCall.id,
                name: chunk.toolCall.function.name,
                arguments: chunk.toolCall.function.arguments,
              }));
            }

            if (chunk.type === "done") {
              generationFinished = true;
              if (chunk.usage) iterationUsage = chunk.usage;
              if (chunk.stopReason) iterationStopReason = chunk.stopReason;
            }

            if (chunk.type === "error") {
              // Studio runs through agent.ts, NOT messages.ts/completions.ts, so this is
              // the only place Studio LLM failures reach analytics. Without it, errors like
              // the OpenRouter→Vertex-EU 400 are invisible to PostHog (only agent_runs.error
              // records them). surface distinguishes Studio from the chat paths.
              captureServerEvent(userId, "llm_error", {
                model,
                endpoint: "studio-agent",
                error_message: chunk.content,
                surface: "studio-agent",
                iteration,
              });
              await safeSend("error", JSON.stringify({ error: chunk.content }));
              // Mark run as error
              await finalizeRun({
                status: "error",
                error: chunk.content,
                textContent,
              });
              return;
            }
          }
        } catch (llmErr) {
          const errMsg = llmErr instanceof Error ? llmErr.message : "LLM call failed";
          if (!controller.signal.aborted) {
            captureServerEvent(userId, "llm_error", {
              model,
              endpoint: "studio-agent",
              error_message: errMsg,
              surface: "studio-agent",
              iteration,
            });
          }
          // Always persist terminal status — client recovery polls DB.
          // Conditional on status="running": an abort triggered by the watchdog,
          // /agent/stop, or supersession already wrote its own terminal status,
          // and "Stopped by user." must not overwrite e.g. the stall reason.
          await finalizeRun({
            status: controller.signal.aborted ? "completed" : "error",
            error: controller.signal.aborted ? "Stopped by user." : errMsg,
            textContent: textContent || lastTextContent || undefined,
          }).catch(() => {});
          if (!controller.signal.aborted) {
            await safeSend("error", JSON.stringify({ error: errMsg }));
          }
          return;
        }

        if (iterationUsage && Number.isFinite(iterationUsage.completionTokens) && iterationUsage.completionTokens >= 0) {
          previousCompletionTokens = iterationUsage.completionTokens;
        }

        // Preserve preflight for an interrupted call, not a billing-blocked
        // generated result. Usage arrives on done; partial tool arguments
        // without that completion boundary must never be replayed.
        if (isShutdownAbort(controller.signal) && !generationFinished) return;

        // A missing usage record is not a free generation. Keep its complete
        // result, but never invent an actual charge or execute it for zero.
        if (creditRecovery && !replay && !hasKnownStudioUsage(iterationUsage) && sourceRevision
          && (!controller.signal.aborted || isShutdownAbort(controller.signal))) {
          const checkpoint: StudioCreditCheckpoint = {
            version: 1, phase: "generated", messages, iteration, worldRevision: sourceRevision.revision, requiredCredits: 0,
            generated: { textContent, reasoningContent, toolCalls, usage: iterationUsage, cost: 0, usageLogId, stopReason: iterationStopReason, billingUnavailable: true },
          };
          await pauseForCredits(checkpoint, "USAGE_UNAVAILABLE");
          return;
        }

        // Observe every provider call; billing exemptions remain separate.
        if (iterationUsage || replay) {
          const observedUsage: Partial<NonNullable<StreamChunk["usage"]>> = iterationUsage ?? {};
          const pTokens = observedUsage.promptTokens ?? 0;
          const cTokens = observedUsage.completionTokens ?? 0;
          if (!replay) await recordUsageLog({
            ...usageObservation(iterationUsage),
            analyticsWorldId: params.worldId,
            id: usageLogId,
            userId,
            model,
            promptTokens: pTokens,
            completionTokens: cTokens,
            totalTokens: observedUsage.totalTokens ?? 0,
            endpoint: "studio-agent",
            apiKeyTier,
          });

          if (!isByok && (creditRecovery || (!unlimited && (pTokens > 0 || cTokens > 0 || (observedUsage.providerCostUsd ?? 0) > 0)) || replay)) {
            try {
              // Studio turns are priced exactly like chat turns: the model's
              // flat platform fee on OpenRouter's reported cost. The former
              // skipMarkup + 0.8× "creator discount" applied to every plan and
              // was 23% of the provider bill at 0.8× cost (audit 2026-09-14);
              // creator support now lives in the internal plan's allowance.
              const cost = replay?.cost ?? await calculateCost(model, pTokens, cTokens, {
                providerCostUsd: observedUsage.providerCostUsd,
              });
              if (creditRecovery && controller.signal.aborted && !isShutdownAbort(controller.signal)) {
                // Cancellation prevents edits; known provider work still uses
                // the existing actual-usage billing policy.
                if (reservationId) await settleStudioCreditReservation(userId, reservationId, cost, usageLogId, `${model} — stopped agent`, db);
                reservationId = undefined;
                return;
              }
              if (creditRecovery && !replay && sourceRevision) {
                const staged = await stageStudioCreditIteration(creditScope, {
                  version: 1, phase: "generated", messages, iteration, worldRevision: sourceRevision.revision, requiredCredits: cost,
                  generated: { textContent, reasoningContent, toolCalls, usage: iterationUsage, cost, usageLogId, stopReason: iterationStopReason },
                }, creditClaimId);
                if (!staged.ok) {
                  await safeSend("error", JSON.stringify({ error: staged.code, code: staged.code }));
                  return;
                }
                creditCheckpoint = staged.checkpoint;
                creditClaimId = staged.claimId;
              }
              if (creditClaimId && creditCheckpoint?.phase === "generated") {
                const settled = await withStudioCreditClaimTransaction(creditScope, creditClaimId, async (tx, checkpoint) => {
                  if (checkpoint.phase !== "generated") throw new Error("Missing generated credit checkpoint");
                  if (reservationId) await settleStudioCreditReservation(userId, reservationId, cost, usageLogId, `${model} — ${pTokens + cTokens} tokens (agent)`, tx);
                  else await deductCredits(userId, cost, usageLogId, `${model} — ${pTokens + cTokens} tokens (agent)`, tx);
                  return { value: null, checkpoint: { ...checkpoint, requiredCredits: 0, generated: { ...checkpoint.generated, settled: true } } };
                });
                creditCheckpoint = settled.checkpoint;
                reservationId = undefined;
                await sendCreditBalance(cost);
              } else {
                await deductCredits(userId, cost, usageLogId, `${model} — ${pTokens + cTokens} tokens (agent)`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error("[Credit] Agent deduction failed:", msg);
              // Stop agent loop if credits exhausted — don't keep burning compute
              if (msg === "INSUFFICIENT_CREDITS") {
                if (creditCheckpoint) { await pauseForCredits(creditCheckpoint); return; }
                await safeSend("error", JSON.stringify({ error: "Credits exhausted. Agent stopped.", code: "NO_CREDITS" }));
                await finalizeRun({
                  status: "error",
                  error: "Credits exhausted",
                  textContent,
                  iteration,
                });
                return;
              }
              // A ledger/DB failure must not fall through and apply unpaid
              // mutations in the recoverable path. Keep the journal intact.
              if (creditRecovery) throw err;
            }
          }
        }

        if (controller.signal.aborted) return;

        // No tool calls — either a planning turn (continue loop) or final response (end)
        console.log(`[Agent] Iteration ${iteration}: LLM finished. ${toolCalls.length} tool calls, ${textContent.length} text chars`);
        if (toolCalls.length === 0) {
          // max_tokens truncation: the LLM was mid-tool-call when output limit hit.
          // Don't treat as "completed" — continue the loop so the model can retry.
          if (iterationStopReason === "max_tokens") {
            console.log(`[Agent] Iteration ${iteration}: max_tokens truncation detected. Continuing with retry prompt.`);
            // Commit the partial text as its own bubble — the retry prompt asks the model
            // to continue without repeating, so subsequent iteration's text is a distinct bubble.
            // lane:"step" — this is a truncated mid-tool-call fragment, not a final answer;
            // UI shows it, history must not replay the half-thought.
            await commitTextTurn(iteration, textContent, { lane: "step" });
            messages = [
              ...messages,
              { role: "assistant" as const, content: textContent },
              { role: "user" as const, content: "[System: Your previous response was cut off by the output token limit before you could complete your tool call. Please continue — call the tool now without repeating your reasoning.]" },
            ];
            await finishCreditIteration(messages, iteration + 1);
            iteration++;
            lastTextContent = textContent;
            continue;
          }

          // Nudge: if the model described changes without calling tools, push it to execute.
          // Fires on ANY non-empty text-only turn (no char gate — CJK plans are short but
          // are still "describe instead of do"). Capped at MAX_TEXT_NUDGES per run. This
          // handles models (Sonnet, Qwen3, DeepSeek, GPT, Gemini) that sometimes "plan" in
          // text instead of calling tools.
          if (
            textOnlyNudges < MAX_TEXT_NUDGES &&
            textContent.trim().length > 0 &&
            iteration < maxIterations - 1 &&
            !anyToolExecuted
          ) {
            textOnlyNudges++;
            console.log(`[Agent] Iter ${iteration}: text-only response (${textContent.length} chars), nudge ${textOnlyNudges}/${MAX_TEXT_NUDGES} to execute tools.`);

            // lane:"answer" — this is the model's own prose to the user (a question,
            // proposal, plan confirmation, or answer) that simply didn't call a tool.
            // It belongs in cross-run history so a multi-turn discussion isn't forgotten.
            // It is NOT a stall: a real "announce but never act" stall repeatedly calls
            // read tools (verified on the prod loop — every stall turn had a read), so it
            // is caught by lane:"step" at the read branch, not here. The nudge below still
            // pushes the model to act this turn if it was mid-task.
            await commitTextTurn(iteration, textContent, { lane: "answer" });
            messages = [
              ...messages,
              { role: "assistant" as const, content: textContent },
              // Softened wording: a model that genuinely has nothing to change (e.g. a
              // pure inspection that concluded "no edits needed") must be able to decline
              // rather than be strong-armed into fabricating an unwanted edit. A model that
              // was mid-task ("now I'll fix it") gets the push it needs.
              { role: "user" as const, content: "[System: You replied with text but didn't call any tools. If you intended to create or change anything, call the tool now (write_entry, write_variable, write_behavior, write_custom_ui, edit_custom_ui, write_audio, update_settings, delete_entities) — don't just describe the change in prose. If you were only answering a question, or there is genuinely nothing to change, say so briefly and stop.]" },
            ];
            await finishCreditIteration(messages, iteration + 1);
            iteration++;
            lastTextContent = textContent;
            continue;
          }

          messages = [
            ...messages,
            { role: "assistant" as const, content: textContent },
          ];

          console.log(`[Agent] Text-only response (no tool calls). Completing. Text: ${textContent.slice(0, 100)}...`);

          // Pure text response — the run's final reply to the user. Always lane:"answer"
          // so it carries into the next run's history, whether the run acted (read/write)
          // or just answered/proposed/asked. A run that ran zero tools is a genuine
          // discussion turn, NOT a stall: a real "announce but never act" stall keeps
          // calling read tools (verified on the prod loop — every stall turn had a read),
          // so it is dropped by lane:"step" at the read branch. Forgetting a no-tool
          // discussion would break multi-turn planning (it was ~9% of all runs). See
          // runCommittedAssistantMessages.
          await commitTextTurn(iteration, textContent, { lane: "answer" });

          await finalizeRun({
            status: "completed",
            messages: messages as unknown as Array<Record<string, unknown>>,
            textContent,
            iteration,
          });

          // done is now a pure run-terminal marker. textContent omitted — clients
          // hydrate bubbles from assistant_turn_commit events / committedTurns column.
          await safeSend("done", JSON.stringify({
            runId,
            status: "completed",
          }));
          return;
        }

        // ── Tool Handling (focused tools, parallel calling) ──
        console.log(`[Agent] Iteration ${iteration}: ${toolCalls.length} tool call(s): ${toolCalls.map((tc) => tc.function.name).join(", ")}`);

        // Step 0: Control tools (ask_user) — yield control to the user.
        // Checked before the read/write split so a stray combined call still yields.
        // The tool's only side effect is ending the run in "awaiting_user" — the user's
        // next chat message resumes the conversation like a normal reply.
        const controlCalls = toolCalls.filter((tc) => CONTROL_TOOL_NAMES.has(tc.function.name));
        const ask = controlCalls.find((tc) => tc.function.name === "ask_user");
        if (ask) {
          const askArgs = parseToolArgs(ask.function.arguments);
          const question = typeof askArgs.question === "string" ? askArgs.question : "";
          const composed = textContent
            ? (question ? `${textContent}\n\n${question}` : textContent)
            : question;

          messages = [
            ...messages,
            assistantToolCallMessage(textContent, toolCalls, reasoningContent),
          ];

          console.log(`[Agent] Iteration ${iteration}: ask_user called — yielding. Question: ${question.slice(0, 120)}`);

          // Commit the composed bubble via the standard path so the client gets one
          // assistant_turn_commit just like a normal turn — no special-casing on the UI.
          // lane:"answer" — asking the user is a real, terminal, user-facing turn; it
          // belongs in cross-run history so the next run sees the question it asked.
          await commitTextTurn(iteration, composed, { lane: "answer" });

          await finalizeRun({
            status: "awaiting_user",
            messages: messages as unknown as Array<Record<string, unknown>>,
            textContent: composed,
            iteration,
          });

          await safeSend("done", JSON.stringify({
            runId,
            status: "awaiting_user",
          }));
          return;
        }

        // generate_image — a paid action the model may only PROPOSE. The run pauses
        // in "awaiting_approval" with the call parked in pendingToolCalls; the
        // creator confirms (or declines) on the card, and /agent/generate-image
        // resumes the loop with the delivered asset refs as the tool result.
        const imageCall = controlCalls.find((tc) => tc.function.name === IMAGE_TOOL_NAME);
        if (imageCall) {
          const proposal = normalizeImageProposal(parseToolArgs(imageCall.function.arguments));
          const unavailable = !isSmartGenerationEnabled();
          if (!proposal || unavailable) {
            // Not a pause: an ordinary error result, and the model carries on.
            messages = [
              ...messages,
              assistantToolCallMessage(textContent, toolCalls, reasoningContent),
              ...imageToolMessages(imageCall, { status: "error", result: null, error: unavailable
                ? "Image generation is not available in this environment. Ask the creator to upload an image instead."
                : "generate_image needs a non-empty prompt; aspectRatio must be one of the listed values and batchSize 1-4." }),
            ];
            await commitTextTurn(iteration, textContent, { lane: "step" });
            await finishCreditIteration(messages, iteration + 1);
            iteration++;
            lastTextContent = textContent;
            continue;
          }
          const estimates = await smartImageEstimates();
          const unitMushies = estimates[SMART_IMAGE_MODEL] ?? 0;
          const estimatedMushies = Math.ceil(unitMushies * proposal.batchSize * 10) / 10;
          console.log(`[Agent] Iteration ${iteration}: generate_image proposed (${proposal.aspectRatio} ×${proposal.batchSize}, est. ${estimatedMushies}) — awaiting creator.`);
          // The assistant's own words stay a real turn; the card renders beneath them.
          await commitTextTurn(iteration, textContent, { lane: "answer" });
          // Hand off to approval and release the claim in the same transaction.
          await finalizeRun({
            status: "awaiting_approval",
            messages: messages as unknown as Array<Record<string, unknown>>,
            pendingToolCalls: [imageCall] as unknown as Array<Record<string, unknown>>,
            readToolResults: [],
            textContent,
            iteration,
          });
          await safeSend("image_proposal", JSON.stringify({
            runId, toolCallId: imageCall.id, textContent, ...proposal, model: SMART_IMAGE_MODEL, unitMushies, estimatedMushies,
          }));
          return;
        }

        // Step 1: Split read vs write tools
        const readCalls = toolCalls.filter((tc) => READ_TOOL_NAMES.has(tc.function.name));
        const writeCalls = toolCalls.filter((tc) => WRITE_TOOL_NAMES.has(tc.function.name));
        if (readCalls.length > 0 || writeCalls.length > 0) anyToolExecuted = true;
        const allResults: ToolResult[] = [];

        // Step 2: Execute all reads immediately
        for (const tc of readCalls) {
          try {
            const args = parseToolArgs(tc.function.arguments);

            if (tc.function.name === "list_assets") {
              allResults.push({ tool_call_id: tc.id, name: tc.function.name, status: "success",
                result: await loadAssetCatalog(userId, params.worldId, args) });
            } else if (tc.function.name === "load_skill") {
              // Load on-demand skill content (tsx, rules, audio, front-ui, lore)
              const skillContent = getSkillContent(args.name);
              allResults.push({
                tool_call_id: tc.id,
                name: tc.function.name,
                status: skillContent ? "success" : "error",
                result: skillContent ?? null,
                error: skillContent ? undefined : `Skill not found: ${args.name}`,
              });
            } else if (tc.function.name === "grep_world") {
              // Unified cross-entity grep: TSX code + entry content + variable behaviorRules
              // + behavior descriptions. Scoped via optional `scope` and `id` args.
              const searchResult = executeGrepWorld(world, {
                query: args.query,
                scope: args.scope,
                id: args.id,
                context_lines: args.context_lines,
              });
              allResults.push({
                tool_call_id: tc.id,
                name: tc.function.name,
                status: searchResult.error ? "error" : "success",
                result: searchResult,
                error: searchResult.error,
              });
            } else if (tc.function.name === "validate_world") {
              // Structural sanity check — undefined refs, unreachable entries,
              // loop risks, duplicate IDs. Pure scan, no mutation.
              const validationResult = executeValidateWorld(world);
              allResults.push({
                tool_call_id: tc.id,
                name: tc.function.name,
                status: "success",
                result: validationResult,
              });
            } else if (tc.function.name === "analyze_token_cost") {
              // On-demand per-turn cost analysis — surfaces the keyword-lore pool
              // the editor footer hides. Pulled only when the creator asks about
              // high per-turn cost (NOT a routine post-write self-check).
              const costReport = executeAnalyzeTokenCost(world);
              allResults.push({
                tool_call_id: tc.id,
                name: tc.function.name,
                status: "success",
                result: costReport,
              });
            } else {
              // read_entities — snip only truly huge results (>INLINE_SNIP_THRESHOLD chars,
              // e.g. base64-embedded TSX). Normal components pass through in full.
              // When the caller explicitly paginated via offset_lines/limit_lines, the
              // executor already returned the exact slice — skip the inline snip so we
              // don't double-truncate the slice the model asked for.
              const offsetLines = typeof args.offset_lines === "number" ? args.offset_lines : undefined;
              const limitLines = typeof args.limit_lines === "number" ? args.limit_lines : undefined;
              const paginated = offsetLines !== undefined || limitLines !== undefined;
              const readResult = executeReadEntities(world, args.ids ?? [], { offset_lines: offsetLines, limit_lines: limitLines });
              const snippedResults: Record<string, unknown> = {};
              for (const [id, entity] of Object.entries(readResult.results)) {
                if (entity == null) { snippedResults[id] = null; continue; }
                snippedResults[id] = paginated ? entity : snipLargeResult(entity);
              }
              allResults.push({
                tool_call_id: tc.id,
                name: tc.function.name,
                status: "success",
                result: snippedResults,
              });
            }
          } catch (e) {
            allResults.push({
              tool_call_id: tc.id,
              name: tc.function.name,
              status: "error",
              result: null,
              error: e instanceof Error ? e.message : "Failed to parse arguments",
            });
          }
        }

        if (readCalls.length > 0) {
          const readStatuses = allResults.map((r) => ({ name: r.name, status: r.status }));
          await safeSend("read_tools_executed", JSON.stringify({ iteration, readResults: readStatuses }));
        }

        // Step 3: If no writes, add results and continue loop
        if (writeCalls.length === 0) {
          messages = [
            ...messages,
            assistantToolCallMessage(textContent, toolCalls, reasoningContent),
            ...buildToolResultMessages(allResults),
          ];

          // Commit this iteration's text as a persistent bubble BEFORE any spiral/continue
          // logic. Previously read_tools_executed carried this as an implicit commit, and
          // the various spiral-exit paths re-emitted textContent via done — producing the
          // duplicate-bubble bug. Now it's committed here once, explicitly.
          // lane:"step" — this text is the preamble to the read tools just executed,
          // so it's UI-only and dropped from cross-run history (the read already
          // happened; reads are means, not durable outcomes). actions records what
          // was read as a faithful, cheap trace.
          await commitTextTurn(iteration, textContent, { lane: "step", actions: toolCallActions(readCalls) });

          // Read-spiral detection, judged per REQUEST rather than per entity id: a new
          // slice or a new grep query returns information the model didn't have, so it
          // counts as progress no matter how often the file has been touched. Only the
          // identical call, re-issued, is a spiral. See lib/studio-tools/read-progress.ts.
          const touches = extractReadTouches(readCalls);
          if (touches.length > 0) {
            const verdict = recordReadTouches(readProgress, touches);

            if (verdict.kind === "stop") {
              const stuckMsg = readSpiralStopMessage(verdict.id);
              console.warn(`[Agent] Read spiral on "${verdict.id}" (identical request 3×) — terminating.`);
              // Commit the stuckMsg as its own bubble so the user understands why we stopped,
              // even if the last iteration had no text of its own. lane:"notice" —
              // server-authored guard text, shown in the UI but NEVER re-fed to the
              // model (replaying "Stopped: …" as an assistant turn is
              // exactly what trained the announce-but-never-act loop).
              await commitTextTurn(iteration, stuckMsg, { lane: "notice" });
              await finalizeRun({
                status: "completed",
                messages: messages as unknown as Array<Record<string, unknown>>,
                textContent: textContent || lastTextContent || stuckMsg,
                iteration,
              });
              await safeSend("done", JSON.stringify({ runId, status: "completed" }));
              return;
            }

            if (verdict.kind === "repeat") {
              console.log(`[Agent] Injecting re-read guidance for "${verdict.id}" (identical request 2×).`);
              messages = [...messages, { role: "user" as const, content: readRepeatNudge(verdict.id) }];
            } else if (verdict.kind === "wandering") {
              console.log(`[Agent] Injecting act-now guidance for "${verdict.id}" (${verdict.turns} slices, no edit).`);
              messages = [...messages, { role: "user" as const, content: readWanderNudge(verdict.id, verdict.turns) }];
            }
          }
          await finishCreditIteration(messages, iteration + 1);
          iteration++;
          lastTextContent = textContent;
          continue;
        }

        // Step 4+5: Parse each write tool individually, apply as-you-go.
        // Per-tool error handling: one bad JSON argument does NOT block the others.
        const parsedCalls = toolCallsToSchemaChanges(writeCalls, world);
        const hasValidChanges = parsedCalls.some((p) => p.change);
        console.log(`[Agent] Parsed ${writeCalls.length} write tools → ${parsedCalls.filter((p) => p.change).length} valid, ${parsedCalls.filter((p) => p.error).length} errors`);

        // Snapshot ONCE before all writes (for batch undo)
        if (hasValidChanges && !(creditCheckpoint?.phase === "generated" && Object.keys(creditCheckpoint.generated.progress ?? {}).length)) {
          if (controller.signal.aborted) break;
          const worldId = params.worldId;
          const toolNames = writeCalls.map((tc) => tc.function.name).join(", ");
          try {
            await db.insert(worldSnapshots).values({
              worldId,
              userId,
              agentRunId: runId,
              schemaData: world as unknown as Record<string, unknown>,
              label: `Before: ${toolNames}`.slice(0, 200),
            });
          } catch (snapshotErr) {
            console.error("[Agent] Snapshot insert failed:", snapshotErr instanceof Error ? snapshotErr.message : snapshotErr);
          }
        }

        // Baseline structural errors BEFORE writes (skipTsx — per-edit compileTsx
        // already gates TSX syntax). Lets us surface only NEW breakage this turn introduces.
        const validationKey = (i: { code: string; entity?: { type?: string; id?: string }; message: string }) =>
          `${i.code}|${i.entity?.type ?? ""}|${i.entity?.id ?? ""}|${i.message}`;
        let baselineErrorKeys = new Set<string>();
        if (hasValidChanges) {
          try {
            baselineErrorKeys = new Set(
              executeValidateWorld(world, { skipTsx: true }).issues
                .filter((i) => i.severity === "error")
                .map(validationKey),
            );
          } catch { /* validation must never block a write */ }
        }

        // Apply each write tool individually for progressive UI updates
        let appliedCount = 0;
        // Map from toolCallId to the corresponding writeCall (for multi-delete expansion)
        const writeCallById = new Map(writeCalls.map((tc) => [tc.id, tc]));

        for (const [parsedIndex, parsed] of parsedCalls.entries()) {
          if (controller.signal.aborted) break;
          const tc = writeCallById.get(parsed.toolCallId);
          if (!tc) continue;
          const progressKey = `${tc.id}:${parsedIndex}`;
          const committedResult = creditCheckpoint?.phase === "generated" ? creditCheckpoint.generated.progress?.[progressKey] : undefined;
          if (committedResult) {
            allResults.push(committedResult);
            if (committedResult.status === "success") appliedCount++;
            continue;
          }

          // Parse error — report on this specific tool, continue with others
          if (parsed.error) {
            allResults.push({
              tool_call_id: tc.id,
              name: tc.function.name,
              status: "error",
              result: null,
              error: parsed.error,
            });
            continue;
          }

          if (!parsed.change) continue;
          const change = parsed.change;

          // Apply this single change
          const singleResult = executeApplyChanges(world, [change]);

          if (singleResult.success) {
            world = singleResult.world;
            appliedCount++;
            noteProgress();
            const note = singleResult.results[0]?.note;

            // Build rich result so the agent doesn't need to re-read the entity
            const resultId = singleResult.results[0]?.id ?? change.id ?? "unknown";
            let richResult: string | Record<string, unknown> = `${change.action} ${change.entityType} "${resultId}": OK${note ? ` (${note})` : ""}`;
            if (change.action !== "delete") {
              const meta = extractEntityMeta(world, change.entityType, resultId);
              if (meta) richResult = { status: "OK", ...meta, ...(note ? { note } : {}) };
            }

            allResults.push({
              tool_call_id: tc.id,
              name: tc.function.name,
              status: "success",
              result: richResult,
            });

            // Save to DB and notify client IMMEDIATELY — editor refreshes progressively.
            // Published worlds route material changes into the held edit instead.
            const worldId = params.worldId;
            try {
              const saveResult = allResults[allResults.length - 1]!;
              if (creditClaimId) {
                const saved = await withStudioCreditClaimTransaction(creditScope, creditClaimId, async (tx, checkpoint) => {
                  if (checkpoint.phase !== "generated") throw new Error("Missing generated credit checkpoint");
                  if (!checkpoint.generated.progress?.[progressKey]) {
                    await writeStudioWorldSchema({ worldId, creatorId: params.userId, schema: world as unknown as Record<string, unknown>, database: tx });
                  }
                  return { value: null, checkpoint: { ...checkpoint, generated: { ...checkpoint.generated, progress: { ...checkpoint.generated.progress, [progressKey]: saveResult } } } };
                });
                creditCheckpoint = saved.checkpoint;
              } else {
                await writeStudioWorldSchema({ worldId, creatorId: params.userId, schema: world as unknown as Record<string, unknown> });
              }
            } catch (saveErr) {
              // The transaction left both the stored world and journal intact.
              // Pause the unfinished step instead of advancing its in-memory copy.
              if (creditClaimId) throw saveErr;
              console.error("[Agent] World save failed:", saveErr instanceof Error ? saveErr.message : saveErr);
              allResults[allResults.length - 1] = {
                ...allResults[allResults.length - 1]!,
                status: "error",
                error: `Applied but failed to save: ${saveErr instanceof Error ? saveErr.message : "DB error"}`,
              };
            }

            await safeSend("applied", JSON.stringify({
              changes: 1,
              autoExecuted: true,
              reason: `${tc.function.name} "${change.id}"`,
              toolNames: tc.function.name,
            }));
          } else {
            // This one failed — report error, continue with remaining writes
            allResults.push({
              tool_call_id: tc.id,
              name: tc.function.name,
              status: "error",
              result: null,
              error: singleResult.summary,
            });
          }
        }

        cachedSystemPrompt = null;

        // Add all results to messages ONCE — collapsed to one tool message per
        // tool_call_id (a single delete_entities call expands to many results
        // sharing an id; Anthropic 400s on >1 tool_result per tool_use).
        messages = [
          ...messages,
          assistantToolCallMessage(textContent, toolCalls, reasoningContent),
          ...buildToolResultMessages(allResults),
        ];

        // Commit this iteration's text as a persistent bubble. Applies to mixed (read+write)
        // and write-only iterations alike — the implicit read_tools_executed commit path
        // never covered write-only turns, which is why their text used to carry over into
        // subsequent iterations' chatStreamContent on the client.
        await commitTextTurn(iteration, textContent, { lane: "step", writeToolCalls: writeCalls, actions: toolCallActions(writeCalls) });

        // Auto-validate after writes (opencode's LSP-diagnostics-after-edit analog): surface
        // only the structural errors THIS change introduced, so the model self-heals on the
        // next iteration instead of leaving silent breakage (orphaned refs, dup IDs, self-loops).
        if (appliedCount > 0) {
          try {
            const newErrors = executeValidateWorld(world, { skipTsx: true }).issues.filter(
              (i) => i.severity === "error" && !baselineErrorKeys.has(validationKey(i)),
            );
            if (newErrors.length > 0) {
              const shown = newErrors.slice(0, 8)
                .map((i) => `- [${i.code}] ${i.message}${i.fix ? ` → ${i.fix}` : ""}`)
                .join("\n");
              const more = newErrors.length > 8 ? `\n(+ ${newErrors.length - 8} more)` : "";
              messages = [
                ...messages,
                { role: "user" as const, content: `[System: validation after your change introduced ${newErrors.length} new error(s). Fix them now by calling the appropriate tool, or briefly say why they are acceptable — do not ignore them:\n${shown}${more}]` },
              ];
            }
          } catch { /* never block the loop on validation */ }
        }

        // Writes mutate the world — subsequent re-reads are legitimate, so drop the request history.
        clearReadProgress(readProgress);

        // Catch duplicate write batches (model retrying a failing write with identical args).
        const toolKey = toolCalls.map((tc) => tc.function.name + ":" + tc.function.arguments).sort().join("|");
        if (toolKey === lastWriteToolKey) {
          await finalizeRun({
            status: "completed",
            messages: messages as unknown as Array<Record<string, unknown>>,
            textContent: textContent || lastTextContent,
            iteration,
          });
          await safeSend("done", JSON.stringify({ runId, status: "completed" }));
          return;
        }
        lastWriteToolKey = toolKey;
        if (controller.signal.aborted) break;
        await finishCreditIteration(messages, iteration + 1);
        iteration++;
        lastTextContent = textContent;
      }

      // Safety cap reached (or aborted mid-loop). Conditional write: when the
      // watchdog or /agent/stop already recorded a terminal status, this
      // fallthrough must NOT restamp it as "completed".
      await finalizeRun({
        status: "completed",
        messages: messages as unknown as Array<Record<string, unknown>>,
        textContent: lastTextContent || undefined,
        iteration,
      }).catch(() => {});

      await safeSend("done", JSON.stringify({
        runId,
        status: "completed",
      }));

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Agent loop failed";
      // A recovered worker owns this run now. Do not finalize it, replace its
      // transcript, or report the old worker's failure as the current result.
      if (errMsg === "CLAIM_LOST") {
        controller.abort();
        return;
      }
      if (creditClaimId && !controller.signal.aborted) {
        const restored = await restoreStudioCreditPause(creditScope, creditClaimId, errMsg).catch(() => false);
        if (restored) {
          if (creditCheckpoint) creditCheckpoint = { ...creditCheckpoint, reason: errMsg };
          const balances = await sendCreditBalance().catch(() => null);
          await safeSend("credits_paused", JSON.stringify({ runId, ...publicCreditPause(creditCheckpoint), ...balances }));
          return;
        }
      }
      // Always persist terminal status — client recovery polls DB
      await finalizeRun({
        status: "error",
        error: errMsg,
        textContent: lastTextContent || undefined,
      }).catch(() => {});
      if (!controller.signal.aborted) {
        await safeSend("error", JSON.stringify({ error: errMsg }));
      }
    } finally {
      if (isShutdownAbort(controller.signal)) {
        if (creditClaimId) {
          // This also covers direct abort returns after billing and breaks
          // between writes. Restore only our claim; never touch a successor.
          await restoreStudioCreditPause(creditScope, creditClaimId, "SERVER_RESTART").catch(() => false);
        } else {
          // No durable result exists to replay. Distinguish an interrupted
          // provider call from an explicit stop instead of claiming success.
          await db.update(agentRuns).set({
            status: "error", error: "Server restarted. Please retry.", updatedAt: new Date(),
          }).where(ownedRunWhere()).catch(() => {});
        }
      }
      if (reservationId) await releaseStudioCreditReservation(userId, reservationId).catch(() => {});
      clearInterval(heartbeat);
      if (activeAgentRuns.get(runId) === controller) activeAgentRuns.delete(runId);
      unregisterStream();
    }
  });
}

export { agentRoutes };
