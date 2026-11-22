/**
 * AI voice design for card authors.
 *
 * GET  /api/voice-design        — is it on, and what it costs (mushies)
 * POST /api/voice-design        — { description, lang } → candidate clips
 * POST /api/voice-design/save   — { token, name } → an unlisted fish.audio voice id, kept as 我的声音
 * POST /api/voice-design/clone  — multipart { audio, name?, text? } → a voice cloned from a recording, kept
 * GET  /api/voice-design/mine   — 我的声音 (lib/tts/my-voices.ts)
 *
 * Off (404 on the POSTs, enabled:false on the GET) unless FISH_API_KEY is
 * set. The flow lives in lib/tts/voice-design-service.ts; this file only
 * wires it to the wallet, S3 and Fish. Candidates sit in S3; a kept voice is a
 * workbench voice element plus an entry in the custom readout voices, so it is
 * in the 声音 studio, the card editor's picker and the readout settings at once.
 */

import { Hono, type Context } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { acquireConcurrency, checkSideCallRateLimit, releaseConcurrency, SIDE_CALL_MAX_CONCURRENT } from "../middleware/rate-limit.js";
import { deductCredits, refundCredits } from "../lib/credit-service.js";
import { recordUsageLog } from "../lib/usage-log.js";
import { captureServerError } from "../lib/posthog.js";
import { getObjectBufferLimited, isS3Configured, putObject } from "../lib/s3.js";
import { createUnlistedVoice, fishApiKey, requestVoiceDesign } from "../lib/tts/fish-voice-design.js";
import { deleteMyVoice, keepVoice, KeepVoiceError, listMyVoices, renameMyVoice, voiceElementName } from "../lib/tts/my-voices.js";
import { CLONE_MAX_BYTES, CLONE_MAX_SECONDS, CLONE_MIN_SECONDS, CloneAudioError, normalizeCloneAudio } from "../lib/tts/voice-clone.js";
import {
  designVoices,
  fishFailure,
  newVoiceDesignToken,
  saveDesignedVoice,
  VOICE_DESIGN_CREDITS,
  VOICE_SAVE_CREDITS,
  type VoiceDesignDeps,
} from "../lib/tts/voice-design-service.js";
import { VOICE_DESIGN_CANDIDATES, VOICE_DESIGN_PROMPT_MAX } from "@yumina/shared";
import type { AppEnv } from "../lib/types.js";

const voiceDesignRoutes = new Hono<AppEnv>();
voiceDesignRoutes.use("*", authMiddleware);

function liveDeps(apiKey: string): VoiceDesignDeps {
  return {
    charge: async (userId, credits, referenceId, description) => {
      await deductCredits(userId, credits, referenceId, description);
    },
    refund: (userId, credits, referenceId, description) => refundCredits(userId, credits, referenceId, description),
    logUsage: (row) => recordUsageLog({
      userId: row.userId,
      sessionId: null,
      model: row.model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      endpoint: row.endpoint,
      apiKeyTier: "regular",
      generationTimeMs: row.ms,
      providerCostUsd: row.costUsd.toFixed(12),
    }),
    design: (params) => requestVoiceDesign(apiKey, params),
    register: (params) => createUnlistedVoice(apiKey, params),
    put: (key, body, contentType) => putObject(key, body, contentType),
    get: async (key, maxBytes) => {
      try {
        return await getObjectBufferLimited(key, maxBytes);
      } catch {
        return null;
      }
    },
    newToken: () => newVoiceDesignToken(),
    reportError: (event, err, extra) => {
      console.warn(`[VoiceDesign] ${event}:`, err instanceof Error ? err.message : err);
      captureServerError(event, err, extra);
    },
  };
}

function enabled(): boolean {
  return Boolean(fishApiKey()) && isS3Configured();
}

voiceDesignRoutes.get("/", (c) => c.json({
  enabled: enabled(),
  designCredits: VOICE_DESIGN_CREDITS,
  saveCredits: VOICE_SAVE_CREDITS,
  candidates: VOICE_DESIGN_CANDIDATES,
  maxDescription: VOICE_DESIGN_PROMPT_MAX,
  cloneCredits: 0,
  cloneSeconds: { min: CLONE_MIN_SECONDS, max: CLONE_MAX_SECONDS },
}));

voiceDesignRoutes.get("/mine", async (c) => c.json({ voices: await listMyVoices(c.get("user").id) }));

voiceDesignRoutes.patch("/mine/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  try {
    const voice = await renameMyVoice(c.get("user").id, c.req.param("id"), body.name);
    return voice ? c.json({ voice }) : c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  } catch (err) {
    if (err instanceof KeepVoiceError) return c.json({ error: err.code, code: err.code }, err.code === "NAME_TAKEN" ? 409 : 400);
    throw err;
  }
});

voiceDesignRoutes.delete("/mine/:id", async (c) => {
  const done = await deleteMyVoice(c.get("user").id, c.req.param("id"));
  return done ? c.json({ ok: true }) : c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
});

/** A kept voice → the response. Once Fish has the voice, a failure to keep it still answers with its id. */
async function keepAndAnswer(c: Context<AppEnv>, userId: string, input: Parameters<typeof keepVoice>[1], credits: number) {
  try {
    const voice = await keepVoice(userId, input);
    return c.json({ id: voice.voiceId, name: voice.name, credits, voice });
  } catch (err) {
    // The voice exists on Fish and works as an id (the card editor takes it as one); it just has no place in
    // 我的声音 — the element cap, or a database without the workbench table yet. Never lose a voice already made.
    if (!(err instanceof KeepVoiceError)) captureServerError("voice-keep-failed", err, { userId });
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : voiceElementName("", input.description);
    return c.json({ id: input.voiceId, name, credits, voice: null, code: err instanceof KeepVoiceError ? err.code : "NOT_KEPT" });
  }
}

/** Rate limit + concurrency shared with the other paid voice side calls. */
async function guarded(c: Context<AppEnv>, userId: string, run: () => Promise<Response>): Promise<Response> {
  const limited = await checkSideCallRateLimit(userId);
  if (limited) {
    c.header("Retry-After", String(limited.retryAfter));
    return c.json({ error: limited.error, code: limited.code, retryAfter: limited.retryAfter }, 429);
  }
  const key = `side:${userId}`;
  if (!(await acquireConcurrency(key, SIDE_CALL_MAX_CONCURRENT))) {
    c.header("Retry-After", "5");
    return c.json({ error: "Too many voice requests in flight. Please wait.", code: "CONCURRENT_LIMIT", retryAfter: 5 }, 429);
  }
  try {
    return await run();
  } finally {
    await releaseConcurrency(key);
  }
}

voiceDesignRoutes.post("/", async (c) => {
  const apiKey = fishApiKey();
  if (!apiKey || !isS3Configured()) return c.json({ error: "Voice design is not available", code: "VOICE_DESIGN_OFF" }, 404);
  const user = c.get("user");
  let body: { description?: unknown; lang?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  return guarded(c, user.id, async () => {
    const result = await designVoices({ userId: user.id, description: body.description, lang: body.lang }, liveDeps(apiKey));
    if (!result.ok) return c.json({ error: result.error, code: result.code }, result.status);
    return c.json({ candidates: result.candidates, credits: result.credits });
  });
});

voiceDesignRoutes.post("/save", async (c) => {
  const apiKey = fishApiKey();
  if (!apiKey || !isS3Configured()) return c.json({ error: "Voice design is not available", code: "VOICE_DESIGN_OFF" }, 404);
  const user = c.get("user");
  let body: { token?: unknown; name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  return guarded(c, user.id, async () => {
    const result = await saveDesignedVoice({ userId: user.id, token: body.token, name: body.name }, liveDeps(apiKey));
    if (!result.ok) return c.json({ error: result.error, code: result.code }, result.status);
    return keepAndAnswer(c, user.id, { voiceId: result.id, name: body.name, description: result.description, source: "design" }, result.credits);
  });
});

/**
 * 克隆声音: anyone may clone any voice for their own use (Jason, 2026-11-07); what reaches others is looked at
 * when a card is published. Free, like saving a designed voice: fish.audio does not charge for making a model.
 */
voiceDesignRoutes.post("/clone", async (c) => {
  const apiKey = fishApiKey();
  if (!apiKey || !isS3Configured()) return c.json({ error: "Voice design is not available", code: "VOICE_DESIGN_OFF" }, 404);
  const user = c.get("user");
  if (user.isBanned || user.isSuspended) return c.json({ error: "Your account is restricted.", code: "ACCOUNT_RESTRICTED" }, 403);
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > CLONE_MAX_BYTES + 64 * 1024) return c.json({ error: "The recording is too large", code: "AUDIO_TOO_LARGE" }, 413);
  let form: Record<string, string | File>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json({ error: "Invalid upload", code: "AUDIO_FORMAT" }, 400);
  }
  const file = form.audio;
  if (!(file instanceof File)) return c.json({ error: "Add a recording", code: "AUDIO_MISSING" }, 400);
  const name = typeof form.name === "string" ? form.name : "";
  const text = typeof form.text === "string" ? form.text.replace(/\s+/g, " ").trim().slice(0, 1000) : "";
  return guarded(c, user.id, async () => {
    let wav: Buffer;
    try {
      ({ wav } = await normalizeCloneAudio(Buffer.from(await file.arrayBuffer())));
    } catch (err) {
      if (err instanceof CloneAudioError) {
        const status = err.code === "MEDIA_UNAVAILABLE" ? 503 : err.code === "AUDIO_TOO_LARGE" ? 413 : 400;
        return c.json({ error: err.code, code: err.code }, status);
      }
      throw err;
    }
    const started = Date.now();
    let id: string;
    try {
      id = await createUnlistedVoice(apiKey, { title: name.trim() || "Yumina voice", description: "cloned", audio: wav, ...(text ? { text } : {}), enhance: true });
    } catch (err) {
      captureServerError("voice-clone-failed", err, { userId: user.id });
      const failure = fishFailure(err);
      return c.json({ error: failure.error, code: failure.code }, failure.status);
    }
    await recordUsageLog({ userId: user.id, sessionId: null, model: "fish-audio/model", promptTokens: 0, completionTokens: 0,
      totalTokens: 0, apiKeyTier: "regular", generationTimeMs: Date.now() - started, providerCostUsd: (0).toFixed(12),
      endpoint: "voice-clone" }).catch(() => {});
    return keepAndAnswer(c, user.id, { voiceId: id, name: name || "克隆", description: "", source: "clone" }, 0);
  });
});

export { voiceDesignRoutes };
