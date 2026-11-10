/**
 * OpenRouter speech-to-text — thin client for `/api/v1/audio/transcriptions`.
 *
 * Voice input (hold-to-talk in chat) sends one short recorded clip here and
 * gets the words back. `openai/gpt-4o-mini-transcribe` was picked on
 * 2026-09-28 against the Gemini Flash-Lite family and Qwen Omni on a Chinese
 * werewolf line: it was the only model that got every word right (the
 * Flash-Lites heard 预言家 as 冤家 and 狼人 as 男人), took ~0.7 s, and accepts
 * the browsers' own recorder output directly (Chrome webm/opus, Safari mp4).
 */

const OPENROUTER_TRANSCRIBE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
export const STT_MODEL = "openai/gpt-4o-mini-transcribe";
const TRANSCRIBE_TIMEOUT_MS = 30_000;

export class SttProviderError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "SttProviderError";
  }
}

export interface TranscribeResult {
  text: string;
  /** Provider-reported cost in USD (0 when the provider didn't report one). */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export async function transcribeAudio(
  apiKey: string,
  params: { audio: Uint8Array; mimeType: string; filename: string; language?: string; prompt?: string },
): Promise<TranscribeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("file", new Blob([params.audio], { type: params.mimeType }), params.filename);
    form.append("model", STT_MODEL);
    if (params.language) form.append("language", params.language);
    // 词表提示:卡片可以传本场景的专有词(人名、黑话),识别准很多
    if (params.prompt) form.append("prompt", params.prompt);
    const res = await fetch(OPENROUTER_TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://yumina.io",
        "X-Title": "Yumina",
      },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch { /* status alone is enough */ }
      throw new SttProviderError(`STT provider returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    const body = (await res.json()) as {
      text?: string;
      usage?: { cost?: number; input_tokens?: number; output_tokens?: number };
    };
    return {
      text: typeof body.text === "string" ? body.text : "",
      costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : 0,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    if (err instanceof SttProviderError) throw err;
    if ((err as Error)?.name === "AbortError") throw new SttProviderError("Transcription timed out", 504);
    throw new SttProviderError(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  } finally {
    clearTimeout(timeout);
  }
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
