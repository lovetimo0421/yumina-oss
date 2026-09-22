import { MUSIC_MODELS, type MusicLength } from "@yumina/shared";

/**
 * OpenRouter music generation — a thin client for Lyria 3.
 *
 * Kept out of lib/llm on purpose, like the speech client: the LLMProvider
 * contract is a token stream, and this is a request that answers with a song.
 * The song does arrive over the chat-completions SSE, though — the provider
 * refuses a non-streaming call outright ("Audio output requires stream:
 * true") — so this reads the stream and glues the base64 slices back into
 * one mp3. The only text the model writes is `<instrumental>`.
 */
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const GENERATION_TIMEOUT_MS = 180_000;

export class MusicProviderError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "MusicProviderError";
  }
}

export interface GenerateMusicResult {
  audio: Buffer;
  mimeType: string;
  /** What OpenRouter says it charged, USD, when the stream carries usage. */
  costUsd: number | null;
}

interface SsePayload {
  error?: { message?: string; code?: number };
  usage?: { cost?: number };
  choices?: Array<{ delta?: { audio?: { data?: string; format?: string } } }>;
}

/**
 * Pull the audio out of one SSE `data:` payload. Pure, so the shape of the
 * stream can be tested without a provider.
 */
export function readMusicSsePayload(payload: string): { audioBase64: string[]; format: string | null; costUsd: number | null; error: string | null } {
  const out = { audioBase64: [] as string[], format: null as string | null, costUsd: null as number | null, error: null as string | null };
  if (!payload || payload === "[DONE]") return out;
  let ev: SsePayload;
  try { ev = JSON.parse(payload) as SsePayload; } catch { return out; }
  if (ev.error) { out.error = ev.error.message ?? "Music generation failed"; return out; }
  if (typeof ev.usage?.cost === "number") out.costUsd = ev.usage.cost;
  for (const choice of ev.choices ?? []) {
    const audio = choice.delta?.audio;
    if (audio?.data) out.audioBase64.push(audio.data);
    if (audio?.format) out.format = audio.format;
  }
  return out;
}

export async function generateMusic(apiKey: string, params: { length: MusicLength; prompt: string }): Promise<GenerateMusicResult> {
  const model = MUSIC_MODELS[params.length];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yumina.io",
        "X-Title": "Yumina",
      },
      body: JSON.stringify({
        model: model.id,
        stream: true,
        messages: [{ role: "user", content: params.prompt }],
        modalities: ["text", "audio"],
        audio: { format: "mp3" },
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let message = `Music generation failed (${res.status})`;
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* keep the status line */ }
      throw new MusicProviderError(message, res.status === 429 || res.status === 402 ? res.status : 502);
    }
    const chunks: Buffer[] = [];
    let format: string | null = null;
    let costUsd: number | null = null;
    let pending = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const read = readMusicSsePayload(line.slice(5).trim());
        if (read.error) throw new MusicProviderError(read.error, 502);
        for (const b64 of read.audioBase64) chunks.push(Buffer.from(b64, "base64"));
        if (read.format) format = read.format;
        if (read.costUsd !== null) costUsd = read.costUsd;
      }
    }
    const audio = Buffer.concat(chunks);
    if (audio.byteLength === 0) throw new MusicProviderError("The model returned no audio", 502);
    return { audio, mimeType: format === "wav" ? "audio/wav" : "audio/mpeg", costUsd };
  } catch (err) {
    if (err instanceof MusicProviderError) throw err;
    if ((err as Error)?.name === "AbortError") throw new MusicProviderError("Music generation timed out", 504);
    throw new MusicProviderError(`Music request failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}
