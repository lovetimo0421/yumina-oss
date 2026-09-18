import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SessionMemoryPayload, SessionMemoryUsageSummary, SessionSummaryCompactionPayload, SessionSummaryMode, SessionSummaryPayload } from "@yumina/shared";
import { db } from "../db/index.js";
import { messages, playSessions, usageLogs } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import { applyModelRedirect, MODEL_ID_PATTERN } from "../lib/llm/model-redirects.js";
import type { AppEnv } from "../lib/types.js";
import { calculateCost } from "../lib/credit-service.js";
import { warmModelPriceCache } from "../lib/model-price-cache.js";
import {
  DEFAULT_SESSION_MEMORY_MODEL,
  MAX_PINNED_MEMORY_CHARS,
  discardQueuedSessionMemoryUpdates,
  emptySessionMemory,
  hasSessionMemory,
  normalizePinnedMemory,
  normalizeSessionMemory,
  regenerateSessionMemoryForSession,
  retrySessionMemoryForSession,
  sessionMemoryProgress,
} from "../lib/session-memory.js";
import {
  DEFAULT_STORY_SUMMARY_MODEL,
  compactStorySummaryForSessionManually,
  discardQueuedStoryCompactions,
  hasStorySummary,
  isStoryCompactionSoftBudgetError,
  normalizeStorySummaryText,
  regenerateStorySummaryForSession,
  resumeStoryCompactionForSession,
} from "../lib/session-compaction.js";
import {
  compactSummaryceptionForSession,
  getSummaryceptionStats,
  updateSummaryceptionSnippet,
} from "../lib/summaryception.js";
import { normalizeSessionSummaryImplementation } from "../lib/summaryception-core.js";
import { resolveMemorySystemSettings } from "../lib/memory-systems.js";
import { isExtensionInstalled } from "../lib/extensions.js";
import { summaryJobs, summaryJobKey } from "../lib/summary-job-store.js";
import { isActiveSummaryJob } from "../lib/summary-job-core.js";
import { SESSION_MEMORY_EXTENSION_KEY, SESSION_SUMMARY_LANGUAGES } from "@yumina/shared";
import { hasUncertainMemoryCoverage } from "../lib/session-memory-core.js";
import { memoryCursorAfterSettingsChange } from "../lib/session-memory-guards.js";
import { normalizeSessionSummaryLanguage } from "../lib/summary-language.js";
import { canRunMemoryQa, memoryQaPage } from "../lib/session-memory-qa.js";
import type { GenerateParams } from "../lib/llm/types.js";
import {
  estimateTextTokens,
  getStoryCompactionProgress,
  normalizeSessionSummaryRecentTailTokens,
  normalizeSessionSummaryTriggerTokens,
  type StoryMessageSizing,
} from "../lib/session-compaction-core.js";

export const sessionMemoryRoutes = new Hono<AppEnv>();

async function requireSessionMemoryExtension(
  c: Context<AppEnv>,
  next: Next,
) {
  const currentUser = c.get("user");
  if (!(await isExtensionInstalled(currentUser.id, SESSION_MEMORY_EXTENSION_KEY))) {
    return c.json({ error: "Extension not installed", code: "EXTENSION_NOT_INSTALLED" }, 403);
  }
  return next();
}

// This router is mounted at /api/sessions, alongside core chat/session routes
// like /:id/messages. Keep the extension entitlement gate scoped to the paths
// this router actually owns; a broad /* gate would intercept normal chat sends
// for users who have not installed the memory extension.
const sessionMemoryRoutePatterns = [
  "/:sessionId/memory",
  "/:sessionId/memory/*",
  "/:sessionId/summary",
  "/:sessionId/summary/*",
  "/:sessionId/summaryception/*",
] as const;

for (const pattern of sessionMemoryRoutePatterns) {
  sessionMemoryRoutes.use(pattern, authMiddleware);
  sessionMemoryRoutes.use(pattern, requireSessionMemoryExtension);
}

// ── Request validation ───────────────────────────────────────────────
// Every body on these routes is zod-validated (the rest of the codebase's
// standard): malformed input becomes a clean 400 instead of runtime type
// coercion, and model ids are charset-checked + deprecated-redirect-resolved
// before they're stored or handed to a paid LLM call.

const modelSchema = z
  .string()
  .trim()
  .regex(MODEL_ID_PATTERN, "Invalid model id")
  .transform(applyModelRedirect);

const tokenBudgetSchema = z.number().int().min(0).max(2_000_000);

// One session-wide setting shared by all three summarizers — the player
// picks it once, not per system. `auto` (the default) means "write in the
// story's own language".
const summaryLanguageSchema = z.enum(SESSION_SUMMARY_LANGUAGES);

const summaryBodySchema = z.object({
  summary: z.unknown().optional(),
  model: modelSchema.optional(),
  implementation: z.string().max(40).optional(),
  mode: z.unknown().optional(), // accepted but ignored — mode is pinned to "threshold"
  included: z.boolean().optional(),
  localdevIncluded: z.boolean().optional(),
  summaryceptionIncluded: z.boolean().optional(),
  summaryceptionModel: modelSchema.optional(),
  triggerTokens: tokenBudgetSchema.nullable().optional(),
  recentTailTokens: tokenBudgetSchema.nullable().optional(),
  language: summaryLanguageSchema.optional(),
});

const memorySettingsSchema = z.object({
  model: modelSchema.optional(),
  included: z.boolean().optional(),
  language: summaryLanguageSchema.optional(),
});

const regenerateSchema = z.object({ model: modelSchema.optional() });

const compactSchema = z.object({
  model: modelSchema.optional(),
  contextTokenLimit: tokenBudgetSchema.optional(),
  implementation: z.string().max(40).optional(),
  force: z.boolean().optional(),
});

const snippetSchema = z.object({ text: z.string().min(1).max(20_000) });

const memoryBodySchema = z.object({
  memory: z.unknown().optional(),
  model: modelSchema.optional(),
});

const memoryPinnedSchema = z.object({
  pinned: z.string().max(MAX_PINNED_MEMORY_CHARS).nullable(),
});

const memoryModelSchema = z.object({ model: modelSchema });

/** Parse + validate a JSON body; missing/empty bodies validate as {}. */
async function parseBody<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

function emptyMemoryUsage(): SessionMemoryUsageSummary {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedMushies: 0,
    last: null,
  };
}

async function loadMemoryUsage(
  sessionId: string,
  userId: string,
  endpoints: string[],
): Promise<SessionMemoryUsageSummary> {
  if (endpoints.length === 0) return emptyMemoryUsage();
  const rows = await db
    .select({
      model: usageLogs.model,
      promptTokens: usageLogs.promptTokens,
      completionTokens: usageLogs.completionTokens,
      totalTokens: usageLogs.totalTokens,
      apiKeyTier: usageLogs.apiKeyTier,
      generationTimeMs: usageLogs.generationTimeMs,
      createdAt: usageLogs.createdAt,
    })
    .from(usageLogs)
    .where(and(
      eq(usageLogs.sessionId, sessionId),
      eq(usageLogs.userId, userId),
      inArray(usageLogs.endpoint, endpoints),
    ))
    .orderBy(desc(usageLogs.createdAt));

  if (rows.length === 0) return emptyMemoryUsage();

  // Cost is computed per row (it rounds up per request, so a grouped SUM would
  // report a different number), but the PRICE lookup is hoisted: this used to
  // be `Promise.all(rows.map(async … await calculateCost …))`, which on a
  // heavy session fans thousands of concurrent lookups into the model-price
  // cache at once. Warming the cache once, serially, keeps that burst from
  // reaching getModelPrice's refresh path at all.
  await warmModelPriceCache();
  const entries = await Promise.all(rows.map(async (row) => {
    const estimatedMushies = row.apiKeyTier === "byok"
      ? 0
      : await calculateCost(row.model, row.promptTokens, row.completionTokens);
    return {
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      estimatedMushies,
      apiKeyTier: row.apiKeyTier,
      generationTimeMs: row.generationTimeMs ?? null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    };
  }));

  return {
    requestCount: entries.length,
    promptTokens: entries.reduce((total, entry) => total + entry.promptTokens, 0),
    completionTokens: entries.reduce((total, entry) => total + entry.completionTokens, 0),
    totalTokens: entries.reduce((total, entry) => total + entry.totalTokens, 0),
    estimatedMushies: Number(entries.reduce((total, entry) => total + entry.estimatedMushies, 0).toFixed(1)),
    last: entries[0] ?? null,
  };
}

async function toPayload(row: typeof playSessions.$inferSelect): Promise<SessionMemoryPayload> {
  const memory = normalizeSessionMemory(row.sessionMemory);
  return {
    memory,
    hasMemory: hasSessionMemory(memory),
    pinned: normalizePinnedMemory(row.sessionMemoryPinned),
    model: applyModelRedirect(row.sessionMemoryModel || DEFAULT_SESSION_MEMORY_MODEL),
    included: row.sessionMemoryIncluded ?? true,
    language: normalizeSessionSummaryLanguage(row.summaryLanguage),
    status: row.sessionMemoryStatus || "idle",
    error: row.sessionMemoryError ?? null,
    updatedAt: row.sessionMemoryUpdatedAt ? row.sessionMemoryUpdatedAt.toISOString() : null,
    lastSourceHash: row.sessionMemorySourceHash ?? null,
    lastProcessedMessageId: row.sessionMemoryProcessedMessageId ?? null,
    usage: await loadMemoryUsage(row.id, row.userId, ["session-memory"]),
    ...await sessionMemoryProgress(row),
  };
}

// Mirrors the CJK ranges in engine/prompts/token-utils.ts (estimateCjkAware):
// U+3000-U+9FFF, U+AC00-U+D7AF, U+F900-U+FAFF. Kept in sync with the
// messages_content_metrics trigger in scripts/add-message-content-metrics.sql —
// only used for rows written before that trigger existed.
const CJK_CHAR_CLASS = "[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]";

/**
 * Sizing rows for the memory panel: every uncompacted message, WITHOUT bodies.
 *
 * The panel only ever renders counts and token totals, but this used to select
 * `content` for the whole backlog with no LIMIT. On a 7k-message session that
 * is ~52 MB off disk, ~7k strings materialized on the single Node main thread,
 * and then several string-scanning passes to estimate tokens — 20-46 s of
 * event-loop block per call. Two of those in a row froze both replicas on
 * 2026-08-15; Railway's edge dial-timed out at 5 s and Cloudflare served 502s
 * to everyone, on every card (same bug class as 2026-08-11, fixed then only on
 * the chat-history path).
 *
 * Capping the row count would have been the wrong fix: these totals describe
 * the WHOLE backlog, so a LIMIT silently under-reports for exactly the users
 * with the biggest sessions. Instead we read the two precomputed integers the
 * estimator needs (messages.content_len / content_cjk_len, maintained by the
 * messages_content_metrics trigger) and leave the bodies in the database.
 *
 * COALESCE keeps this correct while the backfill of pre-trigger rows is still
 * running (and if it never completes): Postgres computes the metric in place
 * for rows that lack it, so only integers ever cross the wire either way.
 */
async function loadUncompactedStorySizing(sessionId: string): Promise<StoryMessageSizing[]> {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
      contentLen: sql<number>`COALESCE(${messages.contentLen}, length(COALESCE(${messages.content}, '')))`,
      contentCjkLen: sql<number>`COALESCE(
        ${messages.contentCjkLen},
        length(COALESCE(${messages.content}, ''))
          - length(regexp_replace(COALESCE(${messages.content}, ''), ${CJK_CHAR_CLASS}, '', 'g'))
      )`,
    })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)))
    .orderBy(asc(messages.createdAt));
  // Drizzle hands numeric SQL fragments back as strings on some drivers.
  return rows.map((row) => ({
    ...row,
    contentLen: Number(row.contentLen),
    contentCjkLen: Number(row.contentCjkLen),
  }));
}

async function toSummaryPayload(row: typeof playSessions.$inferSelect): Promise<SessionSummaryPayload> {
  const storedJob = await summaryJobs.read(summaryJobKey(row.userId, row.id)).catch(() => null);
  // An incremental compaction may have superseded an older failed regeneration.
  const job = storedJob && !isActiveSummaryJob(storedJob) && row.summaryUpdatedAt
    && storedJob.updatedAt < row.summaryUpdatedAt.getTime() ? null : storedJob;
  const summary = normalizeStorySummaryText(row.summary);
  const model = applyModelRedirect(row.summaryModel || DEFAULT_STORY_SUMMARY_MODEL);
  const implementation = normalizeSessionSummaryImplementation(row.summaryImplementation);
  const memorySystems = await resolveMemorySystemSettings(row.userId, row);
  const mode = "threshold" satisfies SessionSummaryMode;
  const triggerTokens = normalizeSessionSummaryTriggerTokens(row.summaryTriggerTokens);
  const recentTailTokens = normalizeSessionSummaryRecentTailTokens(row.summaryRecentTailTokens);
  const recentTailTokensOverride = row.summaryRecentTailTokens == null ? undefined : recentTailTokens;
  const [storyRows, localdevUsage, summaryceptionUsage, summaryception] = await Promise.all([
    loadUncompactedStorySizing(row.id),
    loadMemoryUsage(row.id, row.userId, ["story-compaction"]),
    loadMemoryUsage(row.id, row.userId, ["summaryception"]),
    getSummaryceptionStats(row),
  ]);
  return {
    summary,
    job,
    hasSummary: hasStorySummary(summary),
    model,
    implementation,
    mode,
    included: memorySystems.localdevSummaryIncluded,
    localdevIncluded: memorySystems.localdevSummaryIncluded,
    language: normalizeSessionSummaryLanguage(row.summaryLanguage),
    summaryceptionIncluded: memorySystems.summaryceptionIncluded,
    triggerTokens,
    recentTailTokens,
    status: isActiveSummaryJob(job) ? "updating" : job?.status === "failed" ? "failed" : row.summaryStatus || "idle",
    error: isActiveSummaryJob(job) ? null : job?.error ?? row.summaryError ?? null,
    autoCompactionPaused: isStoryCompactionSoftBudgetError(row.summaryError),
    autoCompactionCanResume: isStoryCompactionSoftBudgetError(row.summaryError),
    autoCompactionResumePending: row.summaryBudgetResumePending,
    updatedAt: row.summaryUpdatedAt ? row.summaryUpdatedAt.toISOString() : null,
    coversUntilMessageId: row.summaryCoversUntilMessageId ?? null,
    tokenCount: row.summaryTokenCount ?? (summary ? estimateTextTokens(summary, model) : null),
    lastSourceHash: row.summarySourceHash ?? null,
    rawChatProgress: getStoryCompactionProgress(storyRows, {
      mode,
      triggerTokens: mode === "threshold" ? triggerTokens : undefined,
      recentTailTokens: recentTailTokensOverride,
      modelId: model,
    }),
    usage: localdevUsage,
    summaryception: {
      ...summaryception,
      usage: summaryceptionUsage,
    },
  };
}

async function loadOwnedSession(sessionId: string, userId: string) {
  const [row] = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

sessionMemoryRoutes.get("/:sessionId/memory", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const row = await loadOwnedSession(sessionId, currentUser.id);
  if (!row) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: await toPayload(row) });
});

sessionMemoryRoutes.get("/:sessionId/summary", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const row = await loadOwnedSession(sessionId, currentUser.id);
  if (!row) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: await toSummaryPayload(row) });
});

sessionMemoryRoutes.patch("/:sessionId/summary", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, summaryBodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const row = await loadOwnedSession(sessionId, currentUser.id);
  if (!row) return c.json({ error: "Session not found" }, 404);

  const summary = normalizeStorySummaryText(body.summary ?? row.summary ?? "");
  const model = applyModelRedirect(body.model ?? row.summaryModel ?? DEFAULT_STORY_SUMMARY_MODEL);
  const summaryceptionModel = body.summaryceptionModel || row.summaryceptionModel
    ? applyModelRedirect(body.summaryceptionModel ?? row.summaryceptionModel!)
    : null;
  const implementation = body.implementation === undefined
    ? normalizeSessionSummaryImplementation(row.summaryImplementation)
    : normalizeSessionSummaryImplementation(body.implementation);
  const mode = "threshold" satisfies SessionSummaryMode;
  const included = typeof body.localdevIncluded === "boolean"
    ? body.localdevIncluded
    : typeof body.included === "boolean" ? body.included : row.summaryIncluded;
  const summaryceptionIncluded = typeof body.summaryceptionIncluded === "boolean" ? body.summaryceptionIncluded : row.summaryceptionIncluded;
  const triggerTokens = body.triggerTokens === undefined
    ? row.summaryTriggerTokens
    : body.triggerTokens === null ? null : normalizeSessionSummaryTriggerTokens(body.triggerTokens);
  const recentTailTokens = body.recentTailTokens === undefined
    ? row.summaryRecentTailTokens
    : body.recentTailTokens === null ? null : normalizeSessionSummaryRecentTailTokens(body.recentTailTokens);

  discardQueuedStoryCompactions(sessionId);

  const [updated] = await db
    .update(playSessions)
    .set({
      summary,
      summaryModel: model,
      summaryceptionModel,
      summaryImplementation: implementation,
      summaryMode: mode,
      summaryIncluded: included,
      summaryceptionIncluded,
      summaryTriggerTokens: triggerTokens,
      summaryRecentTailTokens: recentTailTokens,
      summaryUpdatedAt: summary ? new Date() : null,
      summaryStatus: "idle",
      summaryError: null,
      summarySourceHash: null,
      summaryTokenCount: summary ? estimateTextTokens(summary, model || DEFAULT_STORY_SUMMARY_MODEL) : null,
      summaryBudgetWindowStartedAt: new Date(),
      summaryBudgetResumePending: false,
      updatedAt: new Date(),
    })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .returning();

  if (!summary) {
    await db.update(messages).set({ compacted: false }).where(eq(messages.sessionId, sessionId));
  }
  return c.json({ data: await toSummaryPayload(updated!) });
});

sessionMemoryRoutes.patch("/:sessionId/summary/settings", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, summaryBodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const row = await loadOwnedSession(sessionId, currentUser.id);
  if (!row) return c.json({ error: "Session not found" }, 404);

  const model = applyModelRedirect(body.model ?? row.summaryModel ?? DEFAULT_STORY_SUMMARY_MODEL);
  const summaryceptionModel = body.summaryceptionModel || row.summaryceptionModel
    ? applyModelRedirect(body.summaryceptionModel ?? row.summaryceptionModel!)
    : null;
  const implementation = body.implementation === undefined
    ? normalizeSessionSummaryImplementation(row.summaryImplementation)
    : normalizeSessionSummaryImplementation(body.implementation);
  const mode = "threshold" satisfies SessionSummaryMode;
  const included = typeof body.localdevIncluded === "boolean"
    ? body.localdevIncluded
    : typeof body.included === "boolean" ? body.included : row.summaryIncluded;
  const summaryceptionIncluded = typeof body.summaryceptionIncluded === "boolean" ? body.summaryceptionIncluded : row.summaryceptionIncluded;
  const triggerTokens = body.triggerTokens === undefined
    ? row.summaryTriggerTokens
    : body.triggerTokens === null ? null : normalizeSessionSummaryTriggerTokens(body.triggerTokens);
  const recentTailTokens = body.recentTailTokens === undefined
    ? row.summaryRecentTailTokens
    : body.recentTailTokens === null ? null : normalizeSessionSummaryRecentTailTokens(body.recentTailTokens);

  const language = body.language ?? normalizeSessionSummaryLanguage(row.summaryLanguage);

  discardQueuedStoryCompactions(sessionId);
  // The language is shared with the session-memory updater, so a queued
  // memory job would otherwise land in the language the player just
  // switched away from.
  if (language !== normalizeSessionSummaryLanguage(row.summaryLanguage)) discardQueuedSessionMemoryUpdates(sessionId);

  const [updated] = await db
    .update(playSessions)
    .set({
      summaryModel: model,
      summaryceptionModel,
      summaryImplementation: implementation,
      summaryMode: mode,
      summaryIncluded: included,
      summaryceptionIncluded,
      summaryTriggerTokens: triggerTokens,
      summaryRecentTailTokens: recentTailTokens,
      summaryLanguage: language,
      summaryError:
        isStoryCompactionSoftBudgetError(row.summaryError)
          ? row.summaryError
          : null,
      ...(language !== normalizeSessionSummaryLanguage(row.summaryLanguage) ? {
        sessionMemoryStatus: "idle" as const, sessionMemorySourceHash: null,
        sessionMemoryClaimedAt: null, sessionMemoryRetryCount: 0,
        sessionMemoryError: null,
        sessionMemoryProcessedMessageId: memoryCursorAfterSettingsChange(),
      } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .returning();

  if (!updated) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: await toSummaryPayload(updated) });
});

sessionMemoryRoutes.patch("/:sessionId/memory/settings", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, memorySettingsSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const row = await loadOwnedSession(sessionId, currentUser.id);
  if (!row) return c.json({ error: "Session not found" }, 404);

  const model = applyModelRedirect(body.model ?? row.sessionMemoryModel ?? DEFAULT_SESSION_MEMORY_MODEL);
  const included = typeof body.included === "boolean" ? body.included : row.sessionMemoryIncluded;
  const language = body.language ?? normalizeSessionSummaryLanguage(row.summaryLanguage);

  discardQueuedSessionMemoryUpdates(sessionId);
  if (language !== normalizeSessionSummaryLanguage(row.summaryLanguage)) discardQueuedStoryCompactions(sessionId);

  const [updated] = await db
    .update(playSessions)
    .set({
      sessionMemoryModel: model,
      sessionMemoryIncluded: included,
      summaryLanguage: language,
      sessionMemoryProcessedMessageId: memoryCursorAfterSettingsChange(),
      sessionMemoryStatus: "idle",
      sessionMemorySourceHash: null,
      sessionMemoryClaimedAt: null,
      sessionMemoryRetryCount: 0,
      sessionMemoryError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .returning();

  if (!updated) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: await toPayload(updated) });
});

sessionMemoryRoutes.delete("/:sessionId/summary", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");

  discardQueuedStoryCompactions(sessionId);

  const [updated] = await db
    .update(playSessions)
    .set({
      summary: null,
      summaryUpdatedAt: null,
      summaryStatus: "idle",
      summaryError: null,
      summarySourceHash: null,
      summaryCoversUntilMessageId: null,
      summaryTokenCount: null,
      summaryBudgetWindowStartedAt: new Date(),
      summaryBudgetResumePending: false,
      updatedAt: new Date(),
    })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .returning();

  if (!updated) return c.json({ error: "Session not found" }, 404);
  await db.update(messages).set({ compacted: false }).where(eq(messages.sessionId, sessionId));
  return c.json({ data: await toSummaryPayload(updated) });
});

sessionMemoryRoutes.post("/:sessionId/summary/resume-auto", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const rowBefore = await loadOwnedSession(sessionId, currentUser.id);
  if (!rowBefore) return c.json({ error: "Session not found" }, 404);

  discardQueuedStoryCompactions(sessionId);
  await resumeStoryCompactionForSession({ sessionId, userId: currentUser.id });

  const row = await loadOwnedSession(sessionId, currentUser.id);
  if (!row) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: await toSummaryPayload(row) });
});

// Fires a paid LLM call on demand — shares the ai-generation bucket (6/min)
// so a scripted regenerate loop can't burn provider spend unmetered.
sessionMemoryRoutes.post("/:sessionId/summary/regenerate", rateLimitMiddleware("ai-generation"), async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, regenerateSchema);
  if (!parsed.ok) return parsed.res;
  const model = parsed.data.model ?? null;

  try {
    const row = await loadOwnedSession(sessionId, currentUser.id);
    if (!row) return c.json({ error: "Session not found" }, 404);
    discardQueuedStoryCompactions(sessionId);
    const job = await summaryJobs.start(summaryJobKey(currentUser.id, sessionId), async (run) => {
      await regenerateStorySummaryForSession({ sessionId, userId: currentUser.id, model, run });
    });
    const data = await toSummaryPayload(row);
    return c.json({ data: { ...data, job, status: "updating" as const, error: null } }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to regenerate story summary";
    return c.json({ error: message }, message === "Session not found" ? 404 : 500);
  }
});

// Paid LLM call on demand — same ai-generation rate bucket as regenerate.
sessionMemoryRoutes.post("/:sessionId/summary/compact", rateLimitMiddleware("ai-generation"), async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, compactSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const model = body.model ?? null;

  discardQueuedStoryCompactions(sessionId);

  try {
    const rowBefore = await loadOwnedSession(sessionId, currentUser.id);
    if (!rowBefore) return c.json({ error: "Session not found" }, 404);
    const implementation = body.implementation === undefined
      ? normalizeSessionSummaryImplementation(rowBefore.summaryImplementation)
      : normalizeSessionSummaryImplementation(body.implementation);
    const result = implementation === "summaryception"
      ? await compactSummaryceptionForSession({
          sessionId,
          userId: currentUser.id,
          fallbackModel: model || rowBefore.summaryceptionModel || rowBefore.summaryModel || DEFAULT_STORY_SUMMARY_MODEL,
          contextTokenLimit: body.contextTokenLimit,
          force: body.force === true,
        })
      : await compactStorySummaryForSessionManually({
          sessionId,
          userId: currentUser.id,
          model,
          contextTokenLimit: body.contextTokenLimit,
          force: body.force === true,
        });
    const row = await loadOwnedSession(sessionId, currentUser.id);
    if (!row) return c.json({ error: "Session not found" }, 404);
    const payload: SessionSummaryCompactionPayload = {
      summary: await toSummaryPayload(row),
      compaction: {
        compactedCount: result.compactedCount,
        compactedFromMessageId: result.compactedFromMessageId,
        compactedToMessageId: result.compactedToMessageId,
        compactedFromOrdinal: result.compactedFromOrdinal,
        compactedToOrdinal: result.compactedToOrdinal,
        compactedFromPreview: "compactedFromPreview" in result ? result.compactedFromPreview : null,
        compactedToPreview: "compactedToPreview" in result ? result.compactedToPreview : null,
        compactedUntilOneLine: "compactedUntilOneLine" in result ? result.compactedUntilOneLine : null,
        compactedTokenEstimate: result.compactedTokenEstimate,
        retainedCount: result.retainedCount,
        retainedTokenEstimate: result.retainedTokenEstimate,
        noOpReason: result.noOpReason,
        noOpReasonCode: result.noOpReasonCode,
      },
    };
    return c.json({ data: payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compact story context";
    return c.json({ error: message }, message === "Session not found" ? 404 : 500);
  }
});

sessionMemoryRoutes.patch("/:sessionId/summaryception/snippets/:snippetId", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const snippetId = c.req.param("snippetId");
  const parsed = await parseBody(c, snippetSchema);
  if (!parsed.ok) return parsed.res;
  const text = parsed.data.text;
  if (!text.trim()) return c.json({ error: "Snippet text cannot be empty" }, 400);

  try {
    await updateSummaryceptionSnippet({ sessionId, userId: currentUser.id, snippetId, text });
    const row = await loadOwnedSession(sessionId, currentUser.id);
    if (!row) return c.json({ error: "Session not found" }, 404);
    return c.json({ data: await toSummaryPayload(row) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update snippet";
    const notFound = message === "Session not found" || message === "Snippet not found";
    return c.json({ error: message }, notFound ? 404 : 500);
  }
});

sessionMemoryRoutes.patch("/:sessionId/memory", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, memoryBodySchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const row = await loadOwnedSession(sessionId, currentUser.id);
  if (!row) return c.json({ error: "Session not found" }, 404);

  const model = body.model ?? row.sessionMemoryModel;
  const memory = body.memory === undefined
    ? normalizeSessionMemory(row.sessionMemory)
    : normalizeSessionMemory(body.memory);

  discardQueuedSessionMemoryUpdates(sessionId);

  const [updated] = await db
    .update(playSessions)
    .set({
      sessionMemory: memory,
      sessionMemoryModel: model,
      sessionMemoryUpdatedAt: new Date(),
      sessionMemoryStatus: "idle",
      sessionMemoryClaimedAt: null,
      sessionMemoryRetryCount: 0,
      sessionMemoryError: null,
      sessionMemorySourceHash: null,
      sessionMemoryProcessedMessageId: hasUncertainMemoryCoverage(row) ? null : row.sessionMemoryProcessedMessageId,
      // A hand-saved memory reflects whatever edits prompted it — no longer stale.
      sessionMemoryStaleAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .returning();

  return c.json({ data: await toPayload(updated!) });
});

// Player-pinned notes: a separate write path on purpose. The auto-memory PATCH
// above resets the processed pointer / source hash (a hand-edited memory has no
// provenance), and the revert keep-rule needs that pointer — so saving a pinned
// note must never touch the auto memory's bookkeeping. Nothing automatic ever
// clears this column either (see the schema comment).
sessionMemoryRoutes.patch("/:sessionId/memory/pinned", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, memoryPinnedSchema);
  if (!parsed.ok) return parsed.res;

  const [updated] = await db
    .update(playSessions)
    .set({
      sessionMemoryPinned: normalizePinnedMemory(parsed.data.pinned),
      updatedAt: new Date(),
    })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .returning();

  if (!updated) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: await toPayload(updated) });
});

sessionMemoryRoutes.patch("/:sessionId/memory/model", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, memoryModelSchema);
  if (!parsed.ok) return parsed.res;
  const model = applyModelRedirect(parsed.data.model);
  const row = await loadOwnedSession(sessionId, currentUser.id);
  if (!row) return c.json({ error: "Session not found" }, 404);

  discardQueuedSessionMemoryUpdates(sessionId);

  const [updated] = await db
    .update(playSessions)
    .set({
      sessionMemoryModel: model,
      sessionMemoryError: null,
      sessionMemoryProcessedMessageId: memoryCursorAfterSettingsChange(),
      sessionMemoryStatus: "idle",
      sessionMemorySourceHash: null,
      sessionMemoryClaimedAt: null,
      sessionMemoryRetryCount: 0,
      updatedAt: new Date(),
    })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .returning();

  if (!updated) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: await toPayload(updated) });
});

sessionMemoryRoutes.delete("/:sessionId/memory", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");

  discardQueuedSessionMemoryUpdates(sessionId);

  const [updated] = await db
    .update(playSessions)
    .set({
      sessionMemory: emptySessionMemory(),
      sessionMemoryUpdatedAt: null,
      sessionMemoryStatus: "idle",
      sessionMemoryClaimedAt: null,
      sessionMemoryRetryCount: 0,
      sessionMemoryError: null,
      sessionMemorySourceHash: null,
      sessionMemoryProcessedMessageId: null,
      sessionMemoryStaleAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .returning();

  if (!updated) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: await toPayload(updated) });
});

// Paid LLM call on demand — same ai-generation rate bucket as the summary endpoints.
// Explicit testing-only harness: no public production or customer-session access.
sessionMemoryRoutes.get("/:sessionId/memory/qa", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!await canRunMemoryQa(sessionId, c.get("user").id)) return c.notFound();
  c.header("Cache-Control", "no-store");
  return c.html(memoryQaPage(sessionId));
});
sessionMemoryRoutes.post("/:sessionId/memory/qa", rateLimitMiddleware("ai-generation"), async (c) => {
  const userId = c.get("user").id;
  const sessionId = c.req.param("sessionId");
  if (!await canRunMemoryQa(sessionId, userId)) return c.notFound();
  const parsed = await parseBody(c, z.object({scenario: z.enum(["truncated", "oversized", "recovered"])}));
  if (!parsed.ok) return parsed.res;
  const calls: GenerateParams[] = [];
  discardQueuedSessionMemoryUpdates(sessionId);
  try {
    await regenerateSessionMemoryForSession({sessionId, userId, qa: {scenario: parsed.data.scenario, calls}});
    const row = await loadOwnedSession(sessionId, userId);
    if (!row) return c.notFound();
    return c.json({data: await toPayload(row), calls: calls.map(call => ({maxTokens: call.maxTokens})), synthetic: true});
  } catch (err) {
    return c.json({error: err instanceof Error ? err.message : "Memory QA failed"}, 500);
  }
});

sessionMemoryRoutes.post("/:sessionId/memory/retry", rateLimitMiddleware("ai-generation"), async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const before = await loadOwnedSession(sessionId, currentUser.id);
  if (!before) return c.json({ error: "Session not found" }, 404);
  discardQueuedSessionMemoryUpdates(sessionId);
  try {
    await retrySessionMemoryForSession({ sessionId, userId: currentUser.id });
    const row = await loadOwnedSession(sessionId, currentUser.id);
    if (!row) return c.json({ error: "Session not found" }, 404);
    return c.json({ data: await toPayload(row) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Memory retry failed" }, 500);
  }
});

// A full rebuild remains separate from retrying the pending interval.
sessionMemoryRoutes.post("/:sessionId/memory/regenerate", rateLimitMiddleware("ai-generation"), async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");
  const parsed = await parseBody(c, regenerateSchema);
  if (!parsed.ok) return parsed.res;
  const model = parsed.data.model ?? null;

  discardQueuedSessionMemoryUpdates(sessionId);

  try {
    await regenerateSessionMemoryForSession({
      sessionId,
      userId: currentUser.id,
      model,
    });
    const row = await loadOwnedSession(sessionId, currentUser.id);
    if (!row) return c.json({ error: "Session not found" }, 404);
    return c.json({ data: await toPayload(row) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to regenerate session memory";
    return c.json({ error: message }, message === "Session not found" ? 404 : 500);
  }
});
