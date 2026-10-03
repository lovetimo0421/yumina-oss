/**
 * Voice input — hold-to-talk transcription for the chat composer.
 *
 * POST /api/voice-input   multipart: file (the recorded clip), lang? (hint)
 *
 * Free for every signed-in player (owner decision 2026-09-28): it runs on the
 * platform key whatever the player's key mode, is never charged, and costs
 * the platform about $0.002 per minute of speech. The limits below are what
 * keep "free" from being "unbounded". The recording is never stored.
 */

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import {
  checkVoiceInputRateLimit,
  acquireConcurrency,
  releaseConcurrency,
  SIDE_CALL_MAX_CONCURRENT,
} from "../middleware/rate-limit.js";
import { recordUsageLog } from "../lib/usage-log.js";
import { env } from "../lib/env.js";
import { STT_MODEL, SttProviderError, normalizeTranscriptPunctuation, transcribeAudio } from "../lib/stt/openrouter-stt.js";
import type { AppEnv } from "../lib/types.js";

const voiceInputRoutes = new Hono<AppEnv>();
voiceInputRoutes.use("/voice-input", authMiddleware);

/** ~60 s of opus/aac at recorder bitrates is well under 1 MB. */
const MAX_CLIP_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav", "audio/x-m4a", "audio/aac"];
const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3",
  "audio/wav": "wav", "audio/x-m4a": "m4a", "audio/aac": "aac",
};
const LANGS = new Set(["zh", "en", "ja", "es", "ko", "fr", "de", "ru", "pt"]);

voiceInputRoutes.post("/voice-input", async (c) => {
  const userId = c.get("user").id;

  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_CLIP_BYTES + 64 * 1024) {
    return c.json({ error: "Recording is too long", code: "TOO_LONG" }, 413);
  }

  const rate = await checkVoiceInputRateLimit(userId);
  if (rate) {
    c.header("Retry-After", String(rate.retryAfter));
    return c.json({ error: rate.error, code: rate.code, retryAfter: rate.retryAfter }, 429);
  }

  let file: File | null = null;
  let lang: string | undefined;
  try {
    const body = await c.req.parseBody();
    if (body.file instanceof File) file = body.file;
    if (typeof body.lang === "string") {
      const l = body.lang.toLowerCase().slice(0, 2);
      if (LANGS.has(l)) lang = l;
    }
  } catch {
    return c.json({ error: "Invalid upload" }, 400);
  }
  if (!file || file.size === 0) return c.json({ error: "No recording", code: "EMPTY" }, 400);
  if (file.size > MAX_CLIP_BYTES) return c.json({ error: "Recording is too long", code: "TOO_LONG" }, 413);
  const mimeType = (file.type || "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(mimeType)) {
    return c.json({ error: "Unsupported audio format", code: "BAD_FORMAT" }, 415);
  }

  const apiKey = env.YUMINA_OPENROUTER_KEY;
  if (!apiKey) return c.json({ error: "Voice input is not configured", code: "UNAVAILABLE" }, 503);

  // Shares the side-call slot pool: one player can't hold more than a
  // handful of provider calls open at once.
  const slot = await acquireConcurrency(`side:${userId}`, SIDE_CALL_MAX_CONCURRENT);
  if (!slot) return c.json({ error: "Too many requests in flight", code: "CONCURRENCY" }, 429);

  const startTime = Date.now();
  try {
    let result;
    try {
      result = await transcribeAudio(apiKey, {
        audio: new Uint8Array(await file.arrayBuffer()),
        mimeType,
        filename: `clip.${EXTENSIONS[mimeType] ?? "webm"}`,
        language: lang,
      });
    } catch (err) {
      if (err instanceof SttProviderError) {
        console.warn("[VoiceInput] provider error:", err.message);
        const status = err.status === 504 ? 504 : err.status === 429 ? 429 : 502;
        return c.json({ error: status === 504 ? "Transcription timed out" : "Transcription failed", code: "PROVIDER_ERROR" }, status);
      }
      throw err;
    }

    await recordUsageLog({
      userId,
      sessionId: null,
      model: STT_MODEL,
      promptTokens: result.inputTokens,
      completionTokens: result.outputTokens,
      totalTokens: result.inputTokens + result.outputTokens,
      endpoint: "voice-input",
      apiKeyTier: "regular",
      generationTimeMs: Date.now() - startTime,
      providerCostUsd: result.costUsd.toFixed(12),
    });

    return c.json({ text: normalizeTranscriptPunctuation(result.text) });
  } finally {
    await releaseConcurrency(`side:${userId}`);
  }
});

export { voiceInputRoutes };
