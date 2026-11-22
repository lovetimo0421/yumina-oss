/**
 * OpenRouter speech-to-text — thin client for `/api/v1/audio/transcriptions`.
 *
 * Voice input (hold-to-talk in chat, cards' microphones, table voice) sends one
 * short recorded clip here and gets the words back.
 *
 * `microsoft/mai-transcribe-2` since 2026-10-28. Benchmarked that day against
 * 12 OpenRouter models on 40 Mandarin clips: 24 real read speech (FLEURS,
 * AISHELL-1) and 16 player-style lines with names, English words, fillers and
 * pauses, in a laptop mic's noise.
 * - With the card's vocabulary as a phrase list, it had 0.0% character errors
 *   on the player lines and 1.3% on the real speech, with every name right.
 *   `gpt-4o-mini-transcribe`, the model before it, had 3.1% / 3.0% and 10 of
 *   16 names. OpenAI is also retiring that model on 2027-02-26, and players
 *   said it dropped and condensed what they said.
 * - A typical clip came back in 0.5 s.
 * - It costs about a third as much.
 *
 * Its documented style is verbatim. It takes WAV and MP3 (not the browsers'
 * webm or Safari's mp4), so the app converts each clip to 16 kHz WAV before
 * upload. Anything else, an older app's webm, a failed conversion, or a MAI
 * error, goes to `openai/gpt-transcribe`: second best with a prompt (0.4% /
 * 3.7%, every name right), and it accepts every recorder format.
 *
 * The vocabulary rides in the JSON request's `provider.options`. The
 * multipart form's `prompt` field, which this client used to send, is
 * accepted and ignored by OpenRouter, so the card's words never reached the
 * model before.
 */

const OPENROUTER_TRANSCRIBE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
export const STT_MODEL = "microsoft/mai-transcribe-2";
export const STT_FALLBACK_MODEL = "openai/gpt-transcribe";
const TRANSCRIBE_TIMEOUT_MS = 30_000;
/** What MAI-Transcribe takes; JSON `input_audio.format` names. */
const MAI_FORMATS: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3" };
const FORMATS: Record<string, string> = {
  ...MAI_FORMATS, "audio/webm": "webm", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg",
};

export class SttProviderError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "SttProviderError";
  }
}

export interface TranscribeResult {
  text: string;
  /** The model that produced the text (the fallback when MAI couldn't). */
  model: string;
  /** Provider-reported cost in USD (0 when the provider didn't report one). */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** A card's vocabulary hint ("牧濑红莉栖、冈部伦太郎, Amadeus") as phrases:
 *  split on list punctuation and line breaks, never on spaces, so
 *  "Steins Gate" stays one phrase. */
export function vocabularyPhrases(hint: string | undefined): string[] {
  if (!hint) return [];
  const out: string[] = [];
  for (const raw of hint.split(/[,，、;；|\n\r\t]+/)) {
    const p = raw.trim();
    if (p && p.length <= 50 && !out.includes(p)) out.push(p);
    if (out.length >= 100) break;
  }
  return out;
}

async function request(apiKey: string, body: Record<string, unknown>): Promise<{ text: string; costUsd: number; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yumina.io",
        "X-Title": "Yumina",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch { /* status alone is enough */ }
      throw new SttProviderError(`STT provider returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    const out = (await res.json()) as {
      text?: string;
      usage?: { cost?: number; input_tokens?: number; output_tokens?: number };
    };
    return {
      text: typeof out.text === "string" ? out.text : "",
      costUsd: typeof out.usage?.cost === "number" ? out.usage.cost : 0,
      inputTokens: out.usage?.input_tokens ?? 0,
      outputTokens: out.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    if (err instanceof SttProviderError) throw err;
    if ((err as Error)?.name === "AbortError") throw new SttProviderError("Transcription timed out", 504);
    throw new SttProviderError(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeAudio(
  apiKey: string,
  params: { audio: Uint8Array; mimeType: string; filename: string; language?: string; prompt?: string },
): Promise<TranscribeResult> {
  const data = Buffer.from(params.audio).toString("base64");
  const phrases = vocabularyPhrases(params.prompt);
  const base = { ...(params.language ? { language: params.language } : {}) };
  const maiFormat = MAI_FORMATS[params.mimeType];
  if (maiFormat) {
    try {
      const r = await request(apiKey, {
        model: STT_MODEL,
        input_audio: { data, format: maiFormat },
        ...base,
        ...(phrases.length ? { provider: { options: { azure: { phraseList: { phrases } } } } } : {}),
      });
      if (r.text.trim()) return { ...r, model: STT_MODEL };
    } catch (err) {
      // A timeout already spent the player's wait; anything else gets one try on the fallback.
      if (err instanceof SttProviderError && err.status === 504) throw err;
      console.warn("[VoiceInput] MAI-Transcribe failed, using the fallback:", (err as Error).message);
    }
  }
  const r = await request(apiKey, {
    model: STT_FALLBACK_MODEL,
    input_audio: { data, format: FORMATS[params.mimeType] ?? "webm" },
    ...base,
    ...(phrases.length ? { provider: { options: { openai: { prompt: "The speaker may use these words and names: " + phrases.join(", ") } } } } : {}),
  });
  return { ...r, model: STT_FALLBACK_MODEL };
}

/** The model answers Chinese with ASCII punctuation ("我是预言家,昨晚…").
 *  In CJK text, swap it for the full-width marks a person would type. */
export function normalizeTranscriptPunctuation(text: string): string {
  const cjk = /[぀-ヿ㐀-鿿]/;
  if (!cjk.test(text)) return text.trim();
  const map: Record<string, string> = { ",": "，", "?": "？", "!": "！", ":": "：", ";": "；" };
  return text
    .trim()
    .replace(/([,?!:;])(\s*)/g, (m, p: string, _ws: string, offset: number, s: string) => {
      // Leave numbers like 3,000 and 12:30 alone.
      const before = s[offset - 1] ?? "";
      const after = s[offset + m.length] ?? "";
      if (/\d/.test(before) && /\d/.test(after)) return m;
      return map[p] ?? m;
    })
    .replace(/\.(\s*)(?=[㐀-鿿]|$)/g, (m, _ws, offset: number, s: string) =>
      /[㐀-鿿！-～]/.test(s[offset - 1] ?? "") ? "。" : m,
    );
}
