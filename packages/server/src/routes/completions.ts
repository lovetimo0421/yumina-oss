import { bodyLimit } from "hono/body-limit";
import { normalizeImageCompletion, imagePromptChars } from "../lib/chat-images.js";
import { assertImageModel } from "../lib/llm/image-capability.js";
import { turnNeedsVision } from "../lib/llm/fallback-models.js";
import type { ImageCompletionMessage } from "@yumina/shared";
import { recordWallHit } from "../lib/wall-events.js";
import { usageObservation } from "../lib/usage-observation.js";
/**
 * Raw LLM completions endpoint — lightweight proxy for side calls from custom UI.
 *
 * Skips: PromptBuilder, ResponseParser, state effects, message persistence.
 * Reuses: auth, provider resolution, credit check, rate limiting.
 *
 * POST /api/sessions/:sessionId/completions
 */

import { RETIRED_PLAY_MODEL_IDS } from "@yumina/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, worlds } from "../db/schema.js";
import { recordUsageLog } from "../lib/usage-log.js";
import { registerStream } from "../lib/stream-registry.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveProviderForModel } from "../lib/resolve-provider.js";
import {
  checkSideCallRateLimit,
  acquireConcurrency,
  releaseConcurrency,
  SIDE_CALL_MAX_CONCURRENT,
} from "../middleware/rate-limit.js";
import {
  checkBalance,
  deductCredits,
  calculateCost,
  validateModelAccess,
  getModelCostRates,
  estimateCreditsFromChars,
  estimateTokensFromChars,
} from "../lib/credit-service.js";
import { PLANS } from "../lib/plan-config.js";
import type { ChatMessage } from "../lib/llm/types.js";
import { captureServerEvent } from "../lib/analytics.js";
import type { AppEnv } from "../lib/types.js";
import {
  LorebookMatcher,
  filterEntriesByActiveWorldbooks,
  migrateWorldDefinition,
  type WorldDefinition,
  type WorldEntry,
} from "@yumina/engine";
import { DEFAULT_MODEL } from "@yumina/shared";

const completionRoutes = new Hono<AppEnv>();

completionRoutes.use("/*", authMiddleware);

const MAX_MESSAGES = 50;
const MAX_CONTENT_CHARS = 50_000;
const DEFAULT_MAX_TOKENS = 2048;
const MAX_MAX_TOKENS = 8192;

/**
 * `includeLorebook` modes — controls how the world's lorebook is injected as a
 * system message before the caller's `messages`.
 *
 * - `false` / omitted: no injection (raw proxy, lowest token cost — default).
 * - `true` / `"all"`: inject every enabled non-greeting entry, sorted by
 *   `position`. Predictable but can be large for content-heavy worlds.
 * - `"matched"`: run the same keyword matcher the main chat uses against the
 *   LAST user message in `messages`. Always-send entries are always included;
 *   keyword-triggered entries are added only when relevant. Lower token cost,
 *   but content depends on the user's wording.
 */
type IncludeLorebookMode = boolean | "all" | "matched";

completionRoutes.post("/sessions/:sessionId/completions", bodyLimit({ maxSize: 24 * 1024 * 1024 }), async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");

  const body = await c.req.json<{
    messages: ImageCompletionMessage[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
    includeLorebook?: IncludeLorebookMode;
  }>();

  // ── Validate input ──
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }
  if (body.messages.length > MAX_MESSAGES) {
    return c.json({ error: `Too many messages (max ${MAX_MESSAGES})` }, 400);
  }
  let providerMessages: ChatMessage[];
  try { providerMessages = await normalizeImageCompletion(body.messages); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid images" }, 400); }
  const totalChars = providerMessages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0)), 0);
  if (totalChars > MAX_CONTENT_CHARS) {
    return c.json({ error: `Total content too long (max ${MAX_CONTENT_CHARS.toLocaleString()} chars)` }, 400);
  }

  // ── Verify session ownership ──
  // Pull worldId in the same query so a later includeLorebook resolution
  // doesn't need a second round-trip.
  const [session] = await db
    .select({ id: playSessions.id, userId: playSessions.userId, worldId: playSessions.worldId })
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // ── Rate limit (dedicated side-call window, separate from main chat) ──
  const rateLimit = await checkSideCallRateLimit(currentUser.id);
  if (rateLimit) {
    c.header("Retry-After", String(rateLimit.retryAfter));
    return c.json({ error: rateLimit.error, code: rateLimit.code, retryAfter: rateLimit.retryAfter }, 429);
  }

  // ── Resolve provider + API key ──
  // Protected worlds (allowCustomApi=false) must use official keys to prevent
  // prompt leaking via BYOK logging proxy — same enforcement as messages.ts
  const [worldRow] = await db
    .select({ allowCustomApi: worlds.allowCustomApi, creatorId: worlds.creatorId })
    .from(worlds)
    .where(eq(worlds.id, session.worldId));
  const isProtectedWorld = worldRow?.allowCustomApi === false && worldRow.creatorId !== currentUser.id;

  const model = body.model ?? DEFAULT_MODEL;
  const resolved = await resolveProviderForModel(currentUser.id, model, { forceOfficial: isProtectedWorld, allowRetiredForAccessCheck: true });
  if (!resolved) {
    if (isProtectedWorld) {
      return c.json({ error: "This world requires official API keys. Please remove your custom key to play." }, 400);
    }
    return c.json({ error: "No API key available for this model" }, 400);
  }

  if (!resolved.isByok && RETIRED_PLAY_MODEL_IDS.has(model)) {
    return c.json({ error: "This model is unavailable. Please select another model.", code: "MODEL_UNAVAILABLE" }, 403);
  }

  if (turnNeedsVision(providerMessages)) {
    try { await assertImageModel(resolved, model); }
    catch (error) { return c.json({ error: (error as Error).message, code: "IMAGE_MODEL_REQUIRED" }, 400); }
  }

  // ── Credit check + model access (skip for BYOK) ──
  // Side calls have NO Sonnet trial. Without a plan gate, a card could fire
  // premium-model side calls that drain a free user's credits (the model the
  // card picks is billed directly). Gate by the fresh wallet plan the same way
  // the main chat does. Cards should catch MODEL_NOT_ALLOWED and retry with a
  // cheaper model.
  let walletBalance = Infinity; // BYOK and unlimited plans are not credit-gated
  if (!resolved.isByok) {
    const walletCheck = await checkBalance(currentUser.id);
    if (!walletCheck.ok) {
      return c.json({ error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" }, 402);
    }
    const modelAccess = await validateModelAccess(walletCheck.wallet.plan, model);
    if (!modelAccess.allowed) {
      return c.json({ error: modelAccess.reason, code: "MODEL_NOT_ALLOWED" }, 403);
    }
    if (!(PLANS[walletCheck.wallet.plan] ?? PLANS.free).unlimited) {
      walletBalance = walletCheck.balance;
    }
  }

  // ── Optional lorebook injection ──
  // When the caller opts in, pull the world schema and prepend a system message
  // assembled from enabled entries. This mirrors what the main chat's
  // PromptBuilder does, but in stripped-down form (no chat-history depth, no
  // post-history zone) since side calls own their own message list.
  const lorebookSystem = await resolveLorebookSystemMessage(
    body.includeLorebook,
    session.worldId,
    providerMessages.map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join("\n") })),
  );

  // ── Build provider messages ──
  if (lorebookSystem) {
    // Merge with caller's leading system message if present, otherwise prepend.
    // Keeps role count the same and lets caller-supplied instructions sit
    // closer to the user message (lower precedence collision risk).
    if (providerMessages[0]?.role === "system") {
      providerMessages[0] = {
        role: "system",
        content: `${lorebookSystem}\n\n${providerMessages[0].content}`,
      };
    } else {
      providerMessages.unshift({ role: "system", content: lorebookSystem });
    }
  }

  if (providerMessages.length === 0) {
    return c.json({ error: "No valid messages after filtering" }, 400);
  }

  // ── Preflight cost gate (mirrors the main chat's pre-flight affordability gate) ──
  // checkBalance above only asserts balance > 0 and credits are deducted
  // post-stream, so a tiny positive balance would otherwise admit an arbitrarily
  // expensive prompt at platform expense. Prompt-only estimate, same semantics
  // as messages.ts / MidStreamTracker.exceedsAtStart().
  if (walletBalance !== Infinity) {
    const promptChars = imagePromptChars(providerMessages);
    const rates = await getModelCostRates(model, estimateTokensFromChars(promptChars));
    if (estimateCreditsFromChars(rates, promptChars, 0) >= walletBalance) {
      recordWallHit({ userId: currentUser.id, balance: walletBalance, model, endpoint: "side-completion", stage: "prompt_too_long" });
      return c.json({
        error: "Not enough mushies for this call — the prompt is too long for your remaining balance.",
        code: "NO_CREDITS",
        balance: walletBalance,
      }, 402);
    }
  }

  // ── Concurrency gate (side-call pool, separate from main chat's) ──
  // Credits are deducted only after a stream finishes, so without this cap the
  // 100/min rate pool alone would let a near-empty wallet hold that many
  // premium-model streams open in parallel at platform expense.
  const concurrencyKey = `side:${currentUser.id}`;
  if (c.req.raw.signal.aborted) return c.json({ error: "Generation cancelled" }, 408);
  if (!(await acquireConcurrency(concurrencyKey, SIDE_CALL_MAX_CONCURRENT))) {
    c.header("Retry-After", "5");
    return c.json({ error: "Too many side calls in flight. Please wait for some to finish.", code: "CONCURRENT_LIMIT", retryAfter: 5 }, 429);
  }

  // ── Stream ──
  const maxTokens = Math.min(body.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS);
  const temperature = Math.max(0, Math.min(body.temperature ?? 1.0, 2));
  const abortController = new AbortController();
  const abortFromRequest = () => abortController.abort();
  c.req.raw.signal.addEventListener("abort", abortFromRequest, { once: true });
  if (c.req.raw.signal.aborted) abortController.abort();
  // Registered for the SIGTERM drain (see lib/stream-registry.ts).
  const unregisterStream = registerStream(abortController);
  const startTime = Date.now();

  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => { abortController.abort(); });

    let fullContent = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let providerCostUsd: number | undefined;
    let providerRequestId: string | undefined;
    let streamAborted = false;

    try {
      for await (const chunk of resolved.provider.generateStream({
        conversationId: `play:${sessionId}`,
        model,
        messages: providerMessages,
        maxTokens,
        temperature,
        signal: abortController.signal,
      })) {
        if (chunk.type === "text") {
          fullContent += chunk.content;
          await stream.writeSSE({
            event: "text",
            data: JSON.stringify({ content: chunk.content }),
          });
        }

        if (chunk.type === "done") {
          promptTokens = chunk.usage?.promptTokens ?? 0;
          completionTokens = chunk.usage?.completionTokens ?? 0;
          providerCostUsd = chunk.usage?.providerCostUsd;
          providerRequestId = chunk.usage?.providerRequestId;
        }
      }
    } catch (err: any) {
      streamAborted = true;
      if (err?.name !== "AbortError") {
        captureServerEvent(currentUser.id, "llm_error", {
          model,
          error_message: err?.message ?? "Generation failed",
          chars_before_error: fullContent.length,
          generation_time_ms: Date.now() - startTime,
          session_id: sessionId,
          endpoint: "completions",
        });
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: err?.message ?? "Generation failed" }),
        });
      }
    } finally {
      c.req.raw.signal.removeEventListener("abort", abortFromRequest);
      unregisterStream();
      await releaseConcurrency(concurrencyKey);
    }

    // ── Log usage and deduct credits (only for complete generations) ──
    if ((promptTokens || completionTokens) && !streamAborted && !abortController.signal.aborted) {
      const usageLogId = crypto.randomUUID();
      await recordUsageLog({
        ...usageObservation({promptTokens,completionTokens,totalTokens:promptTokens+completionTokens,providerCostUsd,providerRequestId}),
        id: usageLogId,
        userId: currentUser.id,
        sessionId,
        model,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        endpoint: "side-completion",
        apiKeyTier: resolved.apiKeyTier,
        generationTimeMs: Date.now() - startTime,
      });

      // Deduct credits (official key only — BYOK users pay their provider directly)
      if (!resolved.isByok) {
        try {
          const cost = await calculateCost(model, promptTokens, completionTokens, {
            providerCostUsd,
          });
          if (cost > 0) {
            await deductCredits(
              currentUser.id,
              cost,
              usageLogId,
              `Side LLM call: ${model} — ${promptTokens + completionTokens} tokens`,
            );
          }
        } catch (err) {
          const failedBalance = (err instanceof Error && err.message === "INSUFFICIENT_CREDITS")
            ? (err as any).balance : null;
          if (typeof failedBalance !== "number" || failedBalance <= 0) {
            console.error("[Credit] Side completion deduction failed:", err instanceof Error ? err.message : err);
          } else {
            // Cost exceeded balance. deductCredits is all-or-nothing, and swallowing
            // the failure left the wallet positive — checkBalance kept admitting
            // streams the user could never pay for. Clamp instead: drain the
            // remaining balance to 0 so the next preflight rejects. Retry with the
            // balance from each failure, since a concurrent stream's deduction can
            // shrink it between attempts.
            let remaining = failedBalance;
            for (let attempt = 0; attempt < 3 && remaining > 0; attempt++) {
              try {
                await deductCredits(
                  currentUser.id,
                  remaining,
                  usageLogId,
                  `Side LLM call (clamped to balance): ${model} — ${promptTokens + completionTokens} tokens`,
                );
                remaining = 0;
              } catch (clampErr) {
                const b = (clampErr instanceof Error && clampErr.message === "INSUFFICIENT_CREDITS")
                  ? (clampErr as any).balance : null;
                if (typeof b !== "number") {
                  console.error("[Credit] Side completion clamped deduction failed:", clampErr instanceof Error ? clampErr.message : clampErr);
                  break;
                }
                remaining = b;
              }
            }
          }
        }
      }
    }

    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({
        content: fullContent,
        usage: { promptTokens, completionTokens },
      }),
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Tiny per-process cache for migrated world definitions used by lorebook
 *  injection. The main chat has a richer cache in messages.ts; this one is
 *  intentionally separate to avoid cross-route coupling and stays small since
 *  side calls only fire when a card UI is mounted. */
const sideCallWorldCache = new Map<string, { worldDef: WorldDefinition; expiresAt: number }>();
const SIDE_CALL_CACHE_TTL = 5 * 60_000; // 5 minutes — same as main chat
const SIDE_CALL_CACHE_MAX = 100;

async function loadWorldDef(worldId: string): Promise<WorldDefinition | null> {
  const cached = sideCallWorldCache.get(worldId);
  if (cached && cached.expiresAt > Date.now()) return cached.worldDef;
  if (cached) sideCallWorldCache.delete(worldId);

  const [row] = await db
    .select({ schema: worlds.schema })
    .from(worlds)
    .where(eq(worlds.id, worldId));
  if (!row?.schema) return null;
  const worldDef = migrateWorldDefinition(row.schema as unknown as WorldDefinition);

  if (sideCallWorldCache.size >= SIDE_CALL_CACHE_MAX) {
    const oldest = sideCallWorldCache.keys().next().value;
    if (oldest) sideCallWorldCache.delete(oldest);
  }
  sideCallWorldCache.set(worldId, { worldDef, expiresAt: Date.now() + SIDE_CALL_CACHE_TTL });
  return worldDef;
}

/** Build the lorebook system message. Returns null when the caller didn't
 *  opt in or no entries qualify. */
async function resolveLorebookSystemMessage(
  mode: IncludeLorebookMode | undefined,
  worldId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string | null> {
  if (!mode) return null;
  const resolvedMode: "all" | "matched" = mode === "matched" ? "matched" : "all";

  const worldDef = await loadWorldDef(worldId);
  if (!worldDef) return null;
  const allEntries = worldDef.entries ?? [];
  if (allEntries.length === 0) return null;

  let chosen: WorldEntry[];
  if (resolvedMode === "matched") {
    // Match against the LAST user message in the caller's payload — that's the
    // text the caller is asking the AI to react to, equivalent to the player's
    // current input in the main chat.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const recent = lastUser ? [lastUser.content] : [];
    const matcher = new LorebookMatcher();
    // Side calls don't get the live game state — pass an empty stub so
    // condition-gated entries that depend on variables simply don't fire.
    const sideState = { worldId, variables: {}, turnCount: 0, metadata: {} };
    const sideEntries = worldDef.worldbooks?.length
      ? filterEntriesByActiveWorldbooks(allEntries, worldDef.worldbooks, sideState)
      : allEntries;
    const result = matcher.matchWithBudget(
      sideEntries,
      recent,
      sideState,
      Infinity,
      worldDef.settings,
      undefined,
      worldDef.loreUiBindings,
    );
    chosen = [...result.alwaysSend, ...result.triggered];
  } else {
    chosen = allEntries
      .filter((e) => e.enabled && e.role !== "greeting")
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  if (chosen.length === 0) return null;

  // Render: name + content per entry, separated by blank lines. Section
  // headers would only confuse a side LLM that's playing one specific role.
  const blocks = chosen
    .map((e) => {
      const heading = e.name ? `【${e.name}】` : "";
      return heading ? `${heading}\n${e.content}` : e.content;
    })
    .filter(Boolean);
  return blocks.join("\n\n");
}

export { completionRoutes };
