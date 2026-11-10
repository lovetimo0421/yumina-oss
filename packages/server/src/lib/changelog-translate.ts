/**
 * "Auto-translate" in the update-log editor: zh + en → zh-Hant, es, ja in one
 * call on the platform OpenRouter key. Admin-only; the admin reviews the
 * result in the editor before saving. Usage is logged as
 * "changelog-translate" (free-by-design, see usage-log.ts).
 */
import { env } from "./env.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const CHANGELOG_TRANSLATE_MODEL = "google/gemini-3.5-flash-lite";
const TIMEOUT_MS = 60_000;
const TARGETS = ["zh-Hant", "es", "ja"] as const;
export type TranslateTarget = (typeof TARGETS)[number];

export interface TranslateInput {
  title: { zh: string; en: string };
  body: { zh: string; en: string };
}
export type TranslateOutput = Record<TranslateTarget, { title: string; body: string }>;

export class ChangelogTranslateError extends Error {
  constructor(readonly reason: "unavailable" | "failed", message: string) {
    super(message);
    this.name = "ChangelogTranslateError";
  }
}

const SYSTEM = `You translate release notes ("update log" entries) for Yumina, an AI interactive-fiction and roleplay platform, for its users.
You get each entry's title and markdown body in Simplified Chinese (zh) and English (en). Write:
- "zh-Hant": Traditional Chinese, converted from the zh text with natural Traditional wording (e.g. 帳號, 設定, 連結, 影片).
- "es": Spanish, from the en text (use the zh text only to resolve ambiguity). Neutral Latin American / international Spanish, informal "tú".
- "ja": Japanese, from the en text (use zh to resolve ambiguity). Natural, friendly です・ます style.
Rules: keep the markdown structure exactly — one bullet per bullet, the same bullet markers (· or - or •), **bold**, links (translate the link text, never the URL), line breaks. Keep product, model and feature names that are proper nouns as they are (Yumina, Anima, Mushies). Do not add, drop or explain anything. Translate UI labels the way an app would name them in that language.
Answer with JSON only: {"zh-Hant":{"title":"…","body":"…"},"es":{"title":"…","body":"…"},"ja":{"title":"…","body":"…"}}`;

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export async function translateChangelogEntry(
  input: TranslateInput,
  context: {
    userId: string;
    fetchImpl?: typeof fetch;
    recordUsageLog?: typeof import("./usage-log.js").recordUsageLog;
    apiKey?: string;
  },
): Promise<TranslateOutput> {
  const apiKey = context.apiKey ?? env.YUMINA_OPENROUTER_KEY;
  if (!apiKey) throw new ChangelogTranslateError("unavailable", "Translation is not configured on this server");
  const fetchImpl = context.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CHANGELOG_TRANSLATE_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify({ zh: { title: input.title.zh, body: input.body.zh }, en: { title: input.title.en, body: input.body.en } }) },
        ],
        temperature: 0.2,
        max_tokens: 8000,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new ChangelogTranslateError("failed", `Translation request failed (${res.status})`);
    const data = (await res.json()) as {
      model?: string;
      choices?: { finish_reason?: string | null; message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    if (data.usage) {
      const promptTokens = tokenCount(data.usage.prompt_tokens);
      const completionTokens = tokenCount(data.usage.completion_tokens);
      try {
        const recordUsageLog = context.recordUsageLog ?? (await import("./usage-log.js")).recordUsageLog;
        await recordUsageLog({
          userId: context.userId,
          model: typeof data.model === "string" && data.model.trim() ? data.model : CHANGELOG_TRANSLATE_MODEL,
          promptTokens,
          completionTokens,
          totalTokens: Math.max(promptTokens + completionTokens, tokenCount(data.usage.total_tokens)),
          endpoint: "changelog-translate",
          apiKeyTier: "internal",
          generationTimeMs: Date.now() - startedAt,
        });
      } catch (error) {
        console.error("[changelog] translation usage recording failed", { userId: context.userId, error });
      }
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") throw new ChangelogTranslateError("failed", "The translation was cut off; try a shorter entry");
    const text = (choice?.message?.content ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ChangelogTranslateError("failed", "The translation came back unreadable; try again");
    }
    const out = {} as TranslateOutput;
    for (const lang of TARGETS) {
      const item = (parsed as Record<string, { title?: unknown; body?: unknown }>)?.[lang];
      const title = typeof item?.title === "string" ? item.title.trim() : "";
      const body = typeof item?.body === "string" ? item.body.trim() : "";
      if (!title || !body) throw new ChangelogTranslateError("failed", `The translation is missing ${lang}; try again`);
      out[lang] = { title, body };
    }
    return out;
  } catch (error) {
    if (error instanceof ChangelogTranslateError) throw error;
    throw new ChangelogTranslateError("failed", controller.signal.aborted ? "Translation timed out" : "Translation failed");
  } finally {
    clearTimeout(timer);
  }
}
