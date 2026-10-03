/**
 * Voice readout (TTS) — synthesize speech for a message (or raw card text).
 *
 * POST /api/sessions/:sessionId/tts   — synth for the session's chat
 * POST /api/tts/preview               — voice-picker sample (no session)
 *
 * Skeleton mirrors completions.ts: auth → ownership → rate limit → key
 * resolution → balance gate → provider call → usage log → deduction.
 *
 * Caching: audio is stored in S3 under a deterministic content-addressed key
 * (`tts/{sha256(model|voice|text)}.mp3`) and served through the public CDN
 * proxy (`/cdn/tts/:hash`). A repeat request for the same text+voice is a
 * HEAD hit — no provider call, no charge. No DB table involved, so there is
 * no schema migration to apply.
 */

import { Hono } from "hono";
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, messages, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  checkSideCallRateLimit,
  checkTtsByteBudget,
  acquireConcurrency,
  releaseConcurrency,
  SIDE_CALL_MAX_CONCURRENT,
} from "../middleware/rate-limit.js";
import { recordUsageLog } from "../lib/usage-log.js";
import { resolveOfficialOpenRouterKeyForUser, resolveOpenRouterKeyForUser, type ApiKeyTier } from "../lib/resolve-provider.js";
import { sideCallTier, type PlayerSideKey } from "../lib/side-call-key.js";
import { checkBalance, deductCredits } from "../lib/credit-service.js";
import { providerCostUsdToCredits } from "../lib/provider-cost.js";
import { PLANS } from "../lib/plan-config.js";
import { isS3Configured, headObject, putObject } from "../lib/s3.js";
import { captureServerError } from "../lib/posthog.js";
import { synthesizeSpeech, schedulePricingDriftCheck, TtsProviderError } from "../lib/tts/openrouter-tts.js";
import { prepareTtsText, stripMarkupForTts, truncateAtBoundary } from "../lib/tts/text-prep.js";
import { addEmotionCues, emotionTaggingEnabled } from "../lib/tts/emotion.js";
import { castingEnabled, planReadout, type CastWorld, type ReadoutPlan } from "../lib/tts/cast.js";
import { playerTtsPrefs, ttsOptedIn, TTS_OFF_BODY } from "../lib/tts/opt-in.js";
import {
  TTS_MODEL,
  TTS_PRICE_USD_PER_UTF8_BYTE,
  TTS_MARKUP,
  TTS_MAX_TEXT_CHARS,
  isValidTtsVoice,
  resolveTtsVoiceAlias,
  type TtsReadingMode,
} from "@yumina/shared";
import type { AppEnv } from "../lib/types.js";

const ttsRoutes = new Hono<AppEnv>();

// Scoped to this router's own paths. Mounted on "/api", a "/*" middleware ran
// for EVERY later /api route (studio, assets, personas, social, billing,
// admin), re-authenticating each request: extra Redis reads, and a primary
// user lookup on a session-user cache miss.
ttsRoutes.use("/sessions/:sessionId/tts", authMiddleware);
ttsRoutes.use("/tts/*", authMiddleware);

/** Raw-text synthesis cap for card SDK calls (pre-cleanup). */
const MAX_RAW_TEXT_CHARS = 6000;

function cacheHash(voice: string | undefined, text: string, emotion: boolean): string {
  return createHash("sha256")
    .update(`v1|${TTS_MODEL}|${voice ?? "default"}|${text}${emotion ? "|emo1" : ""}`)
    .digest("hex");
}

function cacheKey(hash: string): string {
  return `tts/${hash}.mp3`;
}

async function cacheHit(hash: string): Promise<boolean> {
  try {
    await headObject(cacheKey(hash));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
    const notFound =
      e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
    if (!notFound) {
      // Permissions or storage trouble. Treating it as a miss keeps the voice
      // working, but every replay then re-synthesizes and re-bills — so it
      // must never be quiet.
      console.error("[TTS] cache lookup failed:", err instanceof Error ? err.message : err);
      captureServerError("tts-cache-lookup-failed", err, { hash });
    }
    return false;
  }
}

/** A request's voice field → the id to synthesize with (retired ids map
 *  forward), or undefined for the provider default. */
function parseVoice(raw: unknown): string | undefined {
  return typeof raw === "string" && isValidTtsVoice(raw) ? resolveTtsVoiceAlias(raw) : undefined;
}

/** Provider statuses that mean "this request can't be served as asked" —
 *  with a voice set, overwhelmingly a voice that no longer exists upstream
 *  (fish.audio owners can delete marketplace voices at any time). */
function isVoiceRejection(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

/** The key a readout synthesizes on. `byokWithoutOpenRouter`: a private-key
 *  player whose connection is a custom endpoint or local model, running on the
 *  platform key and billed mushies exactly like official mode. */
interface TtsKey {
  apiKey: string;
  isByok: boolean;
  apiKeyTier: ApiKeyTier;
  byokWithoutOpenRouter?: boolean;
}

async function resolveTtsKey(userId: string): Promise<TtsKey | null> {
  const own = await resolveOpenRouterKeyForUser(userId);
  if (own) return own;
  // Null: private mode without an OpenRouter key (or no platform key at all,
  // which the lookup below also answers null for).
  const platform = await resolveOfficialOpenRouterKeyForUser(userId);
  return platform ? { ...platform, byokWithoutOpenRouter: true } : null;
}

/** The player's key for the readout's side calls (casting, emotion): only when
 *  the synthesis itself runs on it. */
function playerSideKey(userId: string, key: TtsKey | null): PlayerSideKey | null {
  return key?.isByok ? { userId, apiKey: key.apiKey } : null;
}

/**
 * Shared synth pipeline used by both endpoints once the text is resolved.
 * Returns a JSON-able result or an error tuple.
 */
async function synthesizeAndBill(opts: {
  userId: string;
  sessionId: string | null;
  text: string;
  voice: string | undefined;
  /** Used once when the provider rejects `voice` (deleted upstream). Absent →
   *  the rejection is reported as VOICE_UNAVAILABLE instead (voice previews,
   *  where "this voice is broken" is exactly what the player needs to hear). */
  fallbackVoice?: string | undefined;
  /** Internal: this call is already the fallback attempt. */
  isFallback?: boolean;
  /** Add Jev emotion cues before synthesis (readouts, not voice previews).
   *  `context` is the surrounding scene when `text` is dialogue only. */
  emotion?: { context?: string };
  /** Exactly what to send the voice model (casting already added the cues).
   *  Billing still counts `text`. */
  spoken?: string;
  /** Already-resolved key for this request (the session endpoint resolves it
   *  once for casting and every segment). */
  key?: TtsKey | null;
}): Promise<
  | { ok: true; body: { url: string; cached: boolean; credits: number; voiceFallback?: boolean } }
  | { ok: false; status: 400 | 402 | 429 | 502 | 503 | 504; error: string; code?: string; retryAfter?: number }
> {
  const { userId, sessionId, text, voice } = opts;
  const fallbackMark = opts.isFallback ? { voiceFallback: true } : {};

  if (!isS3Configured()) {
    return { ok: false, status: 503, error: "Audio storage not configured" };
  }

  const emotionOn = opts.spoken === undefined && Boolean(opts.emotion) && emotionTaggingEnabled();
  const hash = opts.spoken !== undefined ? cacheHash(voice, opts.spoken, false) : cacheHash(voice, text, emotionOn);
  const url = `/cdn/tts/${hash}`;

  // ── Cache hit: replay is free ──
  if (await cacheHit(hash)) {
    return { ok: true, body: { url, cached: true, credits: 0, ...fallbackMark } };
  }

  // ── Resolve key (BYOK users pay their provider directly) ──
  const resolved = opts.key !== undefined ? opts.key : await resolveTtsKey(userId);
  if (!resolved) {
    return { ok: false, status: 400, error: "No API key available for voice synthesis", code: "NO_API_KEY" };
  }

  // ── Cost preflight ──
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const costUsd = utf8Bytes * TTS_PRICE_USD_PER_UTF8_BYTE;

  // ── Byte budget (per user, per minute) ──
  // Card code can call api.tts.speak with arbitrary text; the call-count
  // window alone would let a runaway or hostile card spend ~16k mushies a
  // minute. Bytes are the unit that costs money, so bytes are what's capped.
  // Cache hits returned above and never count.
  const budget = await checkTtsByteBudget(userId, utf8Bytes);
  if (budget) {
    return { ok: false, status: 429, error: budget.error, code: budget.code, retryAfter: budget.retryAfter };
  }
  // Provider cost times the platform's 1.2, like every chat model.
  const estimatedCredits = providerCostUsdToCredits(costUsd, TTS_MARKUP);

  if (!resolved.isByok) {
    // A BYOK player with no OpenRouter key (custom endpoint / local model)
    // reads on the platform key and mushies; short of those, what they need
    // is either one — say so rather than "not enough mushies".
    const short = resolved.byokWithoutOpenRouter
      ? { error: "Voice readout needs an OpenRouter key or mushies", code: "TTS_NEEDS_KEY_OR_CREDITS" }
      : null;
    const walletCheck = await checkBalance(userId);
    if (!walletCheck.ok) {
      return { ok: false, status: 402, error: short?.error ?? "Insufficient credits", code: short?.code ?? "INSUFFICIENT_CREDITS" };
    }
    const unlimited = (PLANS[walletCheck.wallet.plan] ?? PLANS.free).unlimited;
    if (!unlimited && estimatedCredits > walletCheck.balance) {
      return { ok: false, status: 402, error: short?.error ?? "Insufficient credits for this readout", code: short?.code ?? "INSUFFICIENT_CREDITS" };
    }
  }

  // ── Synthesize ──
  // Guard against silent upstream repricing: billing trusts the local
  // per-byte constant, so a quiet price hike would mean silent platform
  // subsidy. Throttled to ~daily inside; fire-and-forget.
  schedulePricingDriftCheck(resolved.apiKey);

  // ── Emotion cues (cache miss, player is listening, balance checked) ──
  // Only what goes to the voice model changes. The player is billed on the
  // text alone; the cue bytes are the platform's (owner decision 2026-09-28).
  let spoken = opts.spoken ?? text;
  if (emotionOn) {
    const cued = await addEmotionCues(text, opts.emotion?.context, playerSideKey(userId, resolved));
    spoken = cued.text;
    if (cued.usage) {
      void recordUsageLog({
        userId, sessionId, model: cued.model ?? "typesafe/jev", endpoint: "tts-emotion",
        promptTokens: cued.usage.inputTokens, completionTokens: cued.usage.outputTokens,
        totalTokens: cued.usage.inputTokens + cued.usage.outputTokens,
        apiKeyTier: sideCallTier(cued.keySource ?? "platform"), generationTimeMs: cued.ms, tokenMeasurement: "provider",
      }).catch(() => { /* logged inside */ });
    }
  }

  const startTime = Date.now();
  let audio: Buffer;
  let mimeType: string;
  try {
    ({ audio, mimeType } = await synthesizeSpeech(resolved.apiKey, {
      model: TTS_MODEL,
      input: spoken,
      voice,
    }));
  } catch (err) {
    if (err instanceof TtsProviderError) {
      if (voice && isVoiceRejection(err.status)) {
        captureServerError("tts-voice-unavailable", err, { voice, fallback: opts.fallbackVoice ?? null });
        // One retry with the player's own voice (or the provider default).
        // Nothing was billed for the rejected call.
        if (!opts.isFallback && "fallbackVoice" in opts && opts.fallbackVoice !== voice) {
          return synthesizeAndBill({ ...opts, voice: opts.fallbackVoice, fallbackVoice: undefined, isFallback: true });
        }
        return { ok: false, status: 502, error: "This voice is no longer available", code: "VOICE_UNAVAILABLE" };
      }
      if (resolved.isByok && (err.status === 401 || err.status === 403)) {
        return { ok: false, status: 502, error: "Your OpenRouter key was rejected", code: "BYOK_KEY_INVALID" };
      }
      if (resolved.isByok && err.status === 402) {
        // The player's own OpenRouter balance ran out: nothing of ours was
        // spent or billed, and "try again" wouldn't help.
        return { ok: false, status: 402, error: "Your API key has insufficient balance", code: "BYOK_INSUFFICIENT_BALANCE" };
      }
      // Provider detail stays in the server log — it can carry account
      // specifics that don't belong in a client response.
      console.warn("[TTS] provider error:", err.message);
      const status = err.status === 429 ? 429 : err.status === 504 ? 504 : 502;
      return {
        ok: false,
        status,
        error: status === 504 ? "Voice synthesis timed out" : "Voice synthesis failed",
        code: status === 429 ? "PROVIDER_BUSY" : status === 504 ? "TIMEOUT" : "PROVIDER_ERROR",
      };
    }
    return { ok: false, status: 502, error: "Voice synthesis failed", code: "PROVIDER_ERROR" };
  }

  // ── Persist to the content-addressed cache ──
  // Failure here is not fatal to the user (we could still return bytes), but a
  // URL response contract keeps the client simple — so a failed PUT is an error.
  try {
    await putObject(cacheKey(hash), audio, mimeType);
  } catch (err) {
    console.error("[TTS] cache write failed:", err instanceof Error ? err.message : err);
    return { ok: false, status: 502, error: "Failed to store synthesized audio" };
  }

  // ── Usage log + deduction (same funnel as every other LLM spend) ──
  const usageLogId = crypto.randomUUID();
  await recordUsageLog({
    id: usageLogId,
    userId,
    sessionId,
    model: TTS_MODEL,
    // Meter unit is UTF-8 bytes (the provider's own billing unit).
    promptTokens: utf8Bytes,
    completionTokens: 0,
    totalTokens: utf8Bytes,
    endpoint: "tts",
    apiKeyTier: resolved.apiKeyTier,
    generationTimeMs: Date.now() - startTime,
    // Exact provider cost (cue bytes included): the byte meter above can't
    // be priced through model_prices (no row for the voice model, by design).
    providerCostUsd: (Buffer.byteLength(spoken, "utf8") * TTS_PRICE_USD_PER_UTF8_BYTE).toFixed(12),
  });

  let charged = 0;
  if (!resolved.isByok && estimatedCredits > 0) {
    try {
      await deductCredits(userId, estimatedCredits, usageLogId, `Voice readout — ${utf8Bytes} bytes`);
      charged = estimatedCredits;
    } catch (err) {
      // Preflight passed but a concurrent spend shrank the wallet. Clamp the
      // remaining balance to zero (completions.ts pattern) so the next
      // preflight rejects instead of admitting further platform-paid calls.
      // Retry with the balance from each failure — another in-flight deduction
      // can shrink it between attempts.
      const failedBalance = (err instanceof Error && err.message === "INSUFFICIENT_CREDITS")
        ? (err as { balance?: unknown }).balance : null;
      if (typeof failedBalance !== "number") {
        console.error("[TTS] deduction failed:", err instanceof Error ? err.message : err);
      } else {
        let remaining = failedBalance;
        for (let attempt = 0; attempt < 3 && remaining > 0; attempt++) {
          try {
            await deductCredits(userId, remaining, usageLogId, `Voice readout (clamped to balance) — ${utf8Bytes} bytes`);
            charged = remaining;
            remaining = 0;
          } catch (clampErr) {
            const b = (clampErr instanceof Error && clampErr.message === "INSUFFICIENT_CREDITS")
              ? (clampErr as { balance?: unknown }).balance : null;
            if (typeof b !== "number") {
              console.error("[TTS] clamped deduction failed:", clampErr instanceof Error ? clampErr.message : clampErr);
              break;
            }
            remaining = b;
          }
        }
      }
    }
  }

  return { ok: true, body: { url, cached: false, credits: charged, ...fallbackMark } };
}

/** The card's characters, narrator voice and language, for casting. */
async function loadCastWorld(worldId: string | null): Promise<CastWorld & { stamp: string }> {
  if (!worldId) return { entries: [], stamp: "none" };
  const [row] = await db
    .select({ schema: worlds.schema, language: worlds.language, updatedAt: worlds.updatedAt })
    .from(worlds)
    .where(eq(worlds.id, worldId));
  const schema = (row?.schema ?? {}) as { entries?: CastWorld["entries"]; settings?: { narratorVoice?: string } };
  return {
    entries: Array.isArray(schema.entries) ? schema.entries : [],
    narratorVoice: schema.settings?.narratorVoice ?? null,
    language: row?.language ?? null,
    stamp: row?.updatedAt ? new Date(row.updatedAt).getTime().toString(36) : "0",
  };
}

// Same text + same cast in → same plan out, without asking Jev again: a
// replay then hashes to the audio it made the first time (a free cache hit)
// instead of risking a borderline line being cast differently and re-billed.
const PLAN_CACHE_MAX = 500;
const planCache = new Map<string, ReadoutPlan>();
async function planCached(args: Parameters<typeof planReadout>[0], worldKey: string): Promise<ReadoutPlan> {
  // Only the part of the session's cast this text can use goes into the key:
  // the cast keeps growing as new characters speak, and a replay of an older
  // line must still find its plan.
  const scene = `${args.context ?? ""}\n${args.text}`;
  const keyFor = (cast: Record<string, string>) =>
    createHash("sha256")
      .update(JSON.stringify([
        worldKey, args.text, args.context ?? "", args.allDialogue, args.playerVoice ?? "", args.playerPool ?? [],
        Object.entries(cast).filter(([name]) => scene.includes(name)).sort(), args.emotion,
      ]))
      .digest("hex");
  const hit = planCache.get(keyFor(args.cast));
  if (hit) return { ...hit, cast: { ...args.cast, ...hit.cast }, usage: [] };
  const plan = await planReadout(args);
  // Also under the cast as it stands AFTER this plan: the client's next
  // request for the same text carries the voices this one just handed out.
  planCache.set(keyFor(args.cast), plan);
  planCache.set(keyFor(plan.cast), plan);
  while (planCache.size > PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value!);
  return plan;
}

function errorBody(result: { error: string; code?: string; retryAfter?: number }) {
  return {
    error: result.error,
    ...(result.code ? { code: result.code } : {}),
    ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}),
  };
}

// ── POST /sessions/:sessionId/tts ───────────────────────────────────

ttsRoutes.post("/sessions/:sessionId/tts", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");

  let body: {
    messageId?: string; text?: string; voice?: string; fallbackVoice?: string; mode?: string; context?: string;
    /** Readouts: let Jev cast each line (see lib/tts/cast.ts). */
    casting?: boolean;
    /** The text is already dialogue only (a read-along slice in dialogue mode). */
    dialogueOnly?: boolean;
    /** The player's own voice: narration when the card sets no narrator. */
    playerVoice?: string;
    /** Voices this session has already given to speakers (name → voice id). */
    cast?: Record<string, unknown>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── Opt-in: readout is off until the player turns it on (no synth, no charge) ──
  const playerPrefs = await playerTtsPrefs(currentUser.id);
  if (!playerPrefs.optedIn) {
    return c.json(TTS_OFF_BODY, 403);
  }

  // ── Verify session ownership ──
  const [session] = await db
    .select({ id: playSessions.id, worldId: playSessions.worldId })
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // ── Rate limit (shares the side-call window with api.ai.complete) ──
  const rateLimit = await checkSideCallRateLimit(currentUser.id);
  if (rateLimit) {
    c.header("Retry-After", String(rateLimit.retryAfter));
    return c.json({ error: rateLimit.error, code: rateLimit.code, retryAfter: rateLimit.retryAfter }, 429);
  }

  // ── Resolve the text to speak ──
  const mode: TtsReadingMode = body.mode === "dialogue" ? "dialogue" : "full";
  let text: string;
  // Scene around dialogue-only text, for the emotion judge.
  let context: string | undefined =
    typeof body.context === "string" ? stripMarkupForTts(body.context).slice(-2000) : undefined;
  if (body.messageId) {
    const [message] = await db
      .select({ content: messages.content, sessionId: messages.sessionId })
      .from(messages)
      .where(and(eq(messages.id, body.messageId), eq(messages.sessionId, sessionId)));
    if (!message) {
      return c.json({ error: "Message not found" }, 404);
    }
    text = prepareTtsText(message.content, mode);
    if (mode === "dialogue") context = stripMarkupForTts(message.content).slice(-2000);
  } else if (typeof body.text === "string" && body.text.trim()) {
    if (body.text.length > MAX_RAW_TEXT_CHARS) {
      return c.json({ error: `Text too long (max ${MAX_RAW_TEXT_CHARS} chars)` }, 400);
    }
    // Card SDK text: light cleanup only — the card chose its words on purpose.
    text = truncateAtBoundary(stripMarkupForTts(body.text), TTS_MAX_TEXT_CHARS);
  } else {
    return c.json({ error: "messageId or text is required" }, 400);
  }

  if (!text) {
    return c.json({ error: "Nothing speakable in this message", code: "EMPTY_TEXT" }, 400);
  }

  const voice = parseVoice(body.voice);
  // A card's (or custom) voice can vanish upstream; the client names what to
  // fall back to — normally the player's own voice.
  const fallbackVoice = parseVoice(body.fallbackVoice);

  // ── Concurrency gate (shares the side-call pool with api.ai.complete) ──
  // Credits are deducted only after synthesis, so without this cap the
  // 100/min rate window alone would let a near-empty wallet hold that many
  // paid synths in flight at platform expense (the deduction clamp recovers
  // at most the remaining balance).
  const concurrencyKey = `side:${currentUser.id}`;
  if (!(await acquireConcurrency(concurrencyKey, SIDE_CALL_MAX_CONCURRENT))) {
    c.header("Retry-After", "5");
    return c.json({ error: "Too many voice requests in flight. Please wait.", code: "CONCURRENT_LIMIT", retryAfter: 5 }, 429);
  }

  try {
    if (body.casting === true && castingEnabled()) {
      const cast: Record<string, string> = {};
      if (body.cast && typeof body.cast === "object") {
        for (const [k, v] of Object.entries(body.cast).slice(0, 64)) if (typeof v === "string" && k.length <= 32) cast[k] = v;
      }
      const playerVoice = parseVoice(body.playerVoice) ?? fallbackVoice;
      const world = await loadCastWorld(session.worldId);
      // Casting runs on the player's own OpenRouter key when the readout will.
      const key = await resolveTtsKey(currentUser.id);
      const plan = await planCached({
        text,
        context,
        allDialogue: body.dialogueOnly === true || (Boolean(body.messageId) && mode === "dialogue"),
        world,
        playerVoice,
        playerPool: playerPrefs.pool,
        cast,
        emotion: emotionTaggingEnabled(),
        playerKey: playerSideKey(currentUser.id, key),
      }, `${session.worldId}|${world.stamp}`);
      for (const u of plan.usage) {
        void recordUsageLog({
          userId: currentUser.id, sessionId, model: u.model, endpoint: "tts-cast",
          promptTokens: u.inputTokens, completionTokens: u.outputTokens, totalTokens: u.inputTokens + u.outputTokens,
          apiKeyTier: sideCallTier(u.keySource), generationTimeMs: u.ms, tokenMeasurement: "provider",
        }).catch(() => { /* logged inside */ });
      }
      plan.usage = []; // logged once; a cached plan is free
      const results = await Promise.all(plan.segments.map((seg) =>
        synthesizeAndBill({
          userId: currentUser.id,
          sessionId,
          text: seg.plain.trim(),
          spoken: seg.spoken.trim(),
          voice: seg.voice,
          fallbackVoice: playerVoice,
          key,
        }),
      ));
      const failed = results.find((r) => !r.ok);
      if (failed && !failed.ok) {
        if (failed.retryAfter !== undefined) c.header("Retry-After", String(failed.retryAfter));
        return c.json(errorBody(failed), failed.status);
      }
      const segments = results.map((r) => (r.ok ? r.body : null)).filter((b): b is NonNullable<typeof b> => b !== null);
      if (segments.length === 0) return c.json({ error: "Nothing speakable in this message", code: "EMPTY_TEXT" }, 400);
      return c.json({
        url: segments[0]!.url,
        segments: segments.map((s) => ({ url: s.url })),
        cast: plan.cast,
        cached: segments.every((s) => s.cached),
        credits: Math.round(segments.reduce((sum, s) => sum + s.credits, 0) * 10) / 10,
      });
    }

    const result = await synthesizeAndBill({
      userId: currentUser.id,
      sessionId,
      text,
      voice,
      fallbackVoice,
      emotion: { context },
    });
    if (!result.ok) {
      if (result.retryAfter !== undefined) c.header("Retry-After", String(result.retryAfter));
      return c.json(errorBody(result), result.status);
    }
    return c.json(result.body);
  } finally {
    await releaseConcurrency(concurrencyKey);
  }
});

// ── POST /tts/preview — voice-picker samples ────────────────────────

/** Fixed per-language sample lines. Fixed text means each voice+lang pair is
 *  synthesized once EVER (content-addressed cache is shared by all users). */
const PREVIEW_LINES: Record<string, string> = {
  zh: "你好，我是你的朗读声音。今晚的故事，由我来讲。",
  "zh-Hant": "你好，我是你的朗讀聲音。今晚的故事，由我來講。",
  ja: "こんにちは、あなたの朗読ボイスです。今夜の物語は、私が読み上げます。",
  es: "Hola, soy tu voz de lectura. La historia de esta noche empieza conmigo.",
  en: "Hi, I'm your reading voice. Tonight's story begins with me.",
};

ttsRoutes.post("/tts/preview", async (c) => {
  const currentUser = c.get("user");

  let body: { voice?: string; lang?: string; purpose?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Players hear samples once they've opted in to readout. A creator picking
  // a character's voice in Studio (purpose "editor") may audition regardless.
  if (body.purpose !== "editor" && !(await ttsOptedIn(currentUser.id))) {
    return c.json(TTS_OFF_BODY, 403);
  }

  const rateLimit = await checkSideCallRateLimit(currentUser.id);
  if (rateLimit) {
    c.header("Retry-After", String(rateLimit.retryAfter));
    return c.json({ error: rateLimit.error, code: rateLimit.code, retryAfter: rateLimit.retryAfter }, 429);
  }

  const voice = parseVoice(body.voice);
  const lang = typeof body.lang === "string" && PREVIEW_LINES[body.lang] ? body.lang : "en";

  // Same concurrency pool as the session endpoint — previews are paid synths.
  const concurrencyKey = `side:${currentUser.id}`;
  if (!(await acquireConcurrency(concurrencyKey, SIDE_CALL_MAX_CONCURRENT))) {
    c.header("Retry-After", "5");
    return c.json({ error: "Too many voice requests in flight. Please wait.", code: "CONCURRENT_LIMIT", retryAfter: 5 }, 429);
  }

  try {
    const result = await synthesizeAndBill({
      userId: currentUser.id,
      sessionId: null,
      text: PREVIEW_LINES[lang]!,
      voice,
    });
    if (!result.ok) {
      if (result.retryAfter !== undefined) c.header("Retry-After", String(result.retryAfter));
      return c.json(errorBody(result), result.status);
    }
    return c.json(result.body);
  } finally {
    await releaseConcurrency(concurrencyKey);
  }
});

export { ttsRoutes };
