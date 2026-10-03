/**
 * OpenRouter speech synthesis — thin client for `/api/v1/audio/speech`.
 *
 * Kept OUT of lib/llm on purpose: the LLMProvider contract is a token stream,
 * a TTS call is one request → one audio buffer. This is the first backend of
 * the TTS provider seam; a direct Fish Audio (or self-hosted) backend later
 * implements the same `synthesizeSpeech` shape and slots in behind the route.
 *
 * Billing note: the response itself carries no usage — cost is computed by the
 * caller as utf8ByteLength(input) × TTS_PRICE_USD_PER_UTF8_BYTE (verified
 * against OpenRouter generation records, which lag by minutes).
 */

import { TTS_MODEL, TTS_PRICE_USD_PER_UTF8_BYTE } from "@yumina/shared";
import { captureServerError } from "../posthog.js";

const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
const SYNTHESIS_TIMEOUT_MS = 60_000;

export interface SynthesizeParams {
  model: string;
  input: string;
  /** fish.audio marketplace reference id; omit for the model default voice. */
  voice?: string;
}

export interface SynthesizeResult {
  audio: Buffer;
  mimeType: string;
}

// ── Price-drift guard ───────────────────────────────────────────────
// Billing computes cost from the local TTS_PRICE_USD_PER_UTF8_BYTE constant
// (the provider returns no usage on the speech endpoint, and the generation
// accounting record lags by minutes). If OpenRouter/Fish quietly reprices,
// every synth silently under- or over-charges — the same failure class as the
// model-retirement trap. This throttled check compares the constant against
// the live models listing about once a day per process and alarms loudly on
// mismatch. It never blocks or fails a synthesis.

const PRICING_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRICING_CHECK_RETRY_MS = 60 * 60 * 1000; // transient fetch failure → retry hourly
let _nextPricingCheckAt = 0;

export function schedulePricingDriftCheck(apiKey: string): void {
  const now = Date.now();
  if (now < _nextPricingCheckAt) return;
  _nextPricingCheckAt = now + PRICING_CHECK_INTERVAL_MS;
  void (async () => {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models?output_modalities=speech", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        _nextPricingCheckAt = now + PRICING_CHECK_RETRY_MS;
        return;
      }
      const body = (await res.json()) as { data?: Array<{ id: string; pricing?: { prompt?: string } }> };
      const model = body.data?.find((m) => m.id === TTS_MODEL);
      if (!model) {
        // Model gone from the listing — the retirement trap. Alarm: synthesis
        // is about to start failing (or already has).
        console.error(`[TTS] ${TTS_MODEL} is no longer listed on OpenRouter — voice readout will fail until the model constant is updated.`);
        captureServerError("tts-model-missing", new Error(`tts model missing: ${TTS_MODEL}`), { model: TTS_MODEL });
        return;
      }
      const live = Number(model.pricing?.prompt);
      if (!Number.isFinite(live) || live <= 0) return;
      // >1% divergence means the constant is stale in one direction or the other.
      if (Math.abs(live - TTS_PRICE_USD_PER_UTF8_BYTE) > TTS_PRICE_USD_PER_UTF8_BYTE * 0.01) {
        const direction = live > TTS_PRICE_USD_PER_UTF8_BYTE ? "UNDERCHARGING (platform subsidy)" : "overcharging users";
        console.error(
          `[TTS] price drift: billing constant $${TTS_PRICE_USD_PER_UTF8_BYTE}/byte vs live $${live}/byte — currently ${direction}. Update TTS_PRICE_USD_PER_UTF8_BYTE in @yumina/shared.`,
        );
        captureServerError("tts-price-drift", new Error(`tts price drift: live=${live}`), {
          model: TTS_MODEL,
          livePricePerByte: String(live),
          billingConstant: String(TTS_PRICE_USD_PER_UTF8_BYTE),
        });
      }
    } catch {
      _nextPricingCheckAt = now + PRICING_CHECK_RETRY_MS;
    }
  })();
}

export class TtsProviderError extends Error {
  constructor(
    message: string,
    /** Upstream HTTP status — 429 and 402 are surfaced to the client distinctly. */
    public readonly status: number,
  ) {
    super(message);
    this.name = "TtsProviderError";
  }
}

export async function synthesizeSpeech(
  apiKey: string,
  params: SynthesizeParams,
): Promise<SynthesizeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SYNTHESIS_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yumina.io",
        "X-Title": "Yumina",
      },
      body: JSON.stringify({
        model: params.model,
        input: params.input,
        ...(params.voice ? { voice: params.voice } : {}),
        response_format: "mp3",
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch { /* body unreadable — status alone is enough */ }
      throw new TtsProviderError(
        `TTS provider returned ${res.status}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }

    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) {
      throw new TtsProviderError("TTS provider returned empty audio", 502);
    }
    return {
      audio,
      mimeType: res.headers.get("content-type")?.split(";")[0] || "audio/mpeg",
    };
  } catch (err) {
    if (err instanceof TtsProviderError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new TtsProviderError("TTS synthesis timed out", 504);
    }
    throw new TtsProviderError(
      `TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
