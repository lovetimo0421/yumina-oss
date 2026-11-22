/**
 * fish.audio direct API — voice design and voice registration.
 *
 * Readout itself stays on OpenRouter (routes/tts.ts). OpenRouter has no voice
 * design and can't create voice models, so these two calls go to Fish
 * directly with the platform's FISH_API_KEY:
 *
 *   POST /v1/voice-design  — a description → short candidate clips (WAV, base64)
 *   POST /model            — a kept clip → an UNLISTED voice model id
 *
 * An unlisted model id is usable by anyone who has it, which is what lets the
 * OpenRouter readout (running on OpenRouter's own Fish account) speak with it.
 * A private model would 404 there.
 */

const FISH_API = "https://api.fish.audio";
const DESIGN_TIMEOUT_MS = 120_000;
const CREATE_TIMEOUT_MS = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The platform's Fish key, or undefined when the feature is switched off. */
export function fishApiKey(): string | undefined {
  const key = process.env.FISH_API_KEY?.trim();
  return key ? key : undefined;
}

export class FishApiError extends Error {
  constructor(
    message: string,
    /** Upstream HTTP status (504 for our own timeout, 502 for network/shape). */
    public readonly status: number,
  ) {
    super(message);
    this.name = "FishApiError";
  }
}

export interface FishDesignCandidate {
  audio: Buffer;
  durationMs: number;
  /** Fish may return a signature to stamp the model as voice-designed. */
  signature?: string;
}

/** The language hint Fish takes, from a UI language code. */
export function voiceDesignLanguage(lang: string | undefined): "zh" | "en" | "ja" | "es" {
  const l = (lang ?? "en").toLowerCase();
  if (l.startsWith("zh")) return "zh";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("es")) return "es";
  return "en";
}

/** What every candidate reads, so they can be compared on the same line.
 *  Fish caps reference_text at 150 characters. */
export const VOICE_DESIGN_SAMPLE_LINES: Record<"zh" | "en" | "ja" | "es", string> = {
  zh: "你来了啊。坐吧，今晚还长，我们慢慢说。",
  en: "Oh, you came. Sit down — the night is long, and we have time to talk.",
  ja: "来てくれたんだ。座って。夜は長いから、ゆっくり話そう。",
  es: "Ah, viniste. Siéntate; la noche es larga y tenemos tiempo para hablar.",
};

async function readError(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function wrapNetworkError(err: unknown, what: string): FishApiError {
  if (err instanceof FishApiError) return err;
  if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") {
    return new FishApiError(`${what} timed out`, 504);
  }
  return new FishApiError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, 502);
}

export async function requestVoiceDesign(
  apiKey: string,
  params: { instruction: string; referenceText: string; language: string; n: number },
  fetchImpl: FetchLike = fetch,
): Promise<FishDesignCandidate[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${FISH_API}/v1/voice-design`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model: "voice-design-1",
      },
      // The endpoint rejects unknown fields — send only documented ones.
      body: JSON.stringify({
        instruction: params.instruction,
        reference_text: params.referenceText,
        language: params.language,
        n: params.n,
      }),
      signal: AbortSignal.timeout(DESIGN_TIMEOUT_MS),
    });
  } catch (err) {
    throw wrapNetworkError(err, "Voice design");
  }
  if (!res.ok) {
    const detail = await readError(res);
    throw new FishApiError(`Voice design returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }
  let body: { candidates?: Array<{ index?: number; audio_base64?: unknown; duration_ms?: unknown; signature?: unknown }> };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw wrapNetworkError(err, "Voice design");
  }
  const candidates = (Array.isArray(body.candidates) ? body.candidates : [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((c) => {
      if (typeof c.audio_base64 !== "string" || !c.audio_base64) return [];
      const audio = Buffer.from(c.audio_base64, "base64");
      if (audio.length === 0) return [];
      return [{
        audio,
        durationMs: typeof c.duration_ms === "number" ? c.duration_ms : 0,
        ...(typeof c.signature === "string" && c.signature ? { signature: c.signature } : {}),
      }];
    });
  if (candidates.length === 0) throw new FishApiError("Voice design returned no candidates", 502);
  return candidates;
}

export async function createUnlistedVoice(
  apiKey: string,
  params: {
    title: string; description: string; audio: Buffer;
    /** What the clip says; omitted, Fish transcribes it itself. */
    text?: string;
    signature?: string;
    /** Denoise the clip first: for a recording someone uploaded, not for generated audio. */
    enhance?: boolean;
  },
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const form = new FormData();
  form.append("type", "tts");
  form.append("title", params.title);
  form.append("description", params.description);
  form.append("visibility", "unlist");
  form.append("train_mode", "fast");
  form.append("voices", new Blob([new Uint8Array(params.audio)], { type: "audio/wav" }), "voice.wav");
  if (params.text) form.append("texts", params.text);
  // Generated audio is already clean; denoising only blurs it. A recording is denoised.
  form.append("enhance_audio_quality", params.enhance ? "true" : "false");
  if (params.signature) form.append("voice_design_signatures", params.signature);
  let res: Response;
  try {
    res = await fetchImpl(`${FISH_API}/model`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
  } catch (err) {
    throw wrapNetworkError(err, "Voice registration");
  }
  if (!res.ok) {
    const detail = await readError(res);
    throw new FishApiError(`Voice registration returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }
  let body: { _id?: unknown; state?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw wrapNetworkError(err, "Voice registration");
  }
  const id = typeof body._id === "string" ? body._id.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{32}$/.test(id)) throw new FishApiError("Voice registration returned no usable id", 502);
  if (body.state === "failed") throw new FishApiError("Voice registration failed upstream", 502);
  return id;
}
