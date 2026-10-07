/** Choice-only side inference. Observations and answers never enter the chat,
 * parser or session state. Official calls are platform-funded like continuity;
 * successful OpenRouter BYOK calls are paid directly by the player's provider. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { aiDecisionRequestSchema, MAX_DECISION_REQUEST_CHARS, parseAiDecisionResponse } from "@yumina/shared";
import { db } from "../db/index.js";
import { playSessions, worlds } from "../db/schema.js";
import { env } from "../lib/env.js";
import { decide, decisionModelConfigured, DecisionError, DEFAULT_DECISION_URL } from "../lib/continuity/jev-client.js";
import { getUserApiKey, resolveProviderForModel } from "../lib/resolve-provider.js";
import { isOpenRouterUrl, playerKeyDenied, sideCallTier } from "../lib/side-call-key.js";
import { registerStream } from "../lib/stream-registry.js";
import type { AppEnv } from "../lib/types.js";
import { recordUsageLog } from "../lib/usage-log.js";
import { authMiddleware } from "../middleware/auth.js";
import { acquireConcurrency, checkDecisionRateLimit, checkSideCallRateLimit, releaseConcurrency, SIDE_CALL_MAX_CONCURRENT } from "../middleware/rate-limit.js";

export const decisionRoutes = new Hono<AppEnv>();
const requestSchema = aiDecisionRequestSchema.extend({
  // Injected by the host, only used to select the account's BYOK connection.
  // The decision model and endpoint are exclusively server configuration.
  narrativeModel: z.string().min(1).max(256),
});

decisionRoutes.post("/sessions/:sessionId/decisions", authMiddleware, bodyLimit({ maxSize: MAX_DECISION_REQUEST_CHARS * 4 }), async c => {
  const signal = c.req.raw.signal;
  if (signal.aborted) return c.json({ error: "Decision cancelled", code: "DECISION_CANCELLED" }, 408);
  let raw: unknown;
  try { raw = await c.req.json(); } catch (error) {
    // Preserve the streaming body limiter's 413 instead of disguising it as
    // malformed JSON when an oversized body has no Content-Length header.
    if (signal.aborted) return c.json({ error: "Decision cancelled", code: "DECISION_CANCELLED" }, 408);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid decision request" }, 400);
    throw error;
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success || JSON.stringify(raw).length > MAX_DECISION_REQUEST_CHARS) return c.json({ error: "Invalid decision request or budget exceeded" }, 400);
  const body = parsed.data;
  const currentUser = c.get("user"), sessionId = c.req.param("sessionId");
  const [session] = await db.select({ worldId: playSessions.worldId }).from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (env.CONTINUITY_DISABLED === "true") return c.json({ error: "Decisions are unavailable", code: "DECISION_UNAVAILABLE" }, 503);

  const limit = await checkDecisionRateLimit(currentUser.id) ?? await checkSideCallRateLimit(currentUser.id);
  if (limit) { c.header("Retry-After", String(limit.retryAfter)); return c.json(limit, 429); }
  const [world] = await db.select({ allowCustomApi: worlds.allowCustomApi, creatorId: worlds.creatorId }).from(worlds).where(eq(worlds.id, session.worldId));
  if (!world) return c.json({ error: "World not found" }, 404);
  const protectedWorld = world.allowCustomApi === false && world.creatorId !== currentUser.id;
  const resolved = await resolveProviderForModel(currentUser.id, body.narrativeModel, { forceOfficial: protectedWorld, allowRetiredForAccessCheck: true });
  if (!resolved) return protectedWorld
    ? c.json({ error: "This world requires the official Yumina API.", code: "PROTECTED_WORLD" }, 403)
    : c.json({ error: "No API key available for the selected narrative model", code: "DECISION_UNAVAILABLE" }, decisionModelConfigured() ? 400 : 503);
  const key = resolved.isByok && resolved.providerName === "openrouter" ? await getUserApiKey(currentUser.id, "openrouter") : null;
  const playerKey = key ? { userId: currentUser.id, apiKey: key } : null;
  // Local/BYOK installations need no platform key. Match the transport's key
  // eligibility so a denied key or a non-OpenRouter endpoint still fails closed.
  const playerKeyAvailable = playerKey && isOpenRouterUrl(env.CONTINUITY_JEV_URL || DEFAULT_DECISION_URL) && !playerKeyDenied(playerKey, "decisions");
  if (!decisionModelConfigured() && !playerKeyAvailable) return c.json({ error: "Decisions are unavailable", code: "DECISION_UNAVAILABLE" }, 503);
  const concurrencyKey = `side:${currentUser.id}`;
  if (signal.aborted) return c.json({ error: "Decision cancelled", code: "DECISION_CANCELLED" }, 408);
  if (!await acquireConcurrency(concurrencyKey, SIDE_CALL_MAX_CONCURRENT)) {
    c.header("Retry-After", "5");
    return c.json({ error: "Too many side calls in flight", code: "CONCURRENT_LIMIT", retryAfter: 5 }, 429);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  const unregister = registerStream(controller);
  try {
    const result = await decide({ state: body.state, questions: body.questions, signal: controller.signal,
      timeoutMs: Math.min(env.CONTINUITY_TIMEOUT_MS, 3000), playerKey });
    // Even malformed answers consumed tokens. Log before validating without
    // exposing upstream text or performing any mushie deduction/retry.
    await recordUsageLog({ userId: currentUser.id, sessionId, analyticsWorldId: session.worldId, model: result.model, endpoint: "side-decision",
      promptTokens: result.usage.inputTokens, completionTokens: result.usage.outputTokens, totalTokens: result.usage.inputTokens + result.usage.outputTokens,
      apiKeyTier: sideCallTier(result.keySource), generationTimeMs: result.ms, tokenMeasurement: "provider" });
    if (controller.signal.aborted) return c.json({ error: "Decision cancelled", code: "DECISION_CANCELLED" }, 408);
    const response = parseAiDecisionResponse(result, body.questions);
    if (!response) return c.json({ error: "Decision provider returned invalid answers", code: "INVALID_DECISION_RESPONSE" }, 502);
    return c.json(response);
  } catch (error) {
    const code = error instanceof DecisionError ? error.code : "unknown";
    if (code === "cancelled") return c.json({ error: "Decision cancelled", code: "DECISION_CANCELLED" }, 408);
    if (code === "timeout") return c.json({ error: "Decision timed out", code: "DECISION_TIMEOUT" }, 504);
    // Do not serialize provider errors: an upstream can echo credentials/state.
    return c.json({ error: "Decision provider is unavailable", code: "DECISION_UNAVAILABLE" }, 502);
  } finally {
    signal.removeEventListener("abort", onAbort);
    unregister();
    await releaseConcurrency(concurrencyKey);
  }
});
