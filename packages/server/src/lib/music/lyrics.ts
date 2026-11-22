/**
 * AI 写词: song lyrics from a sentence, for the audio studio's 带人声 songs. Mureka sings from lyrics ($0.15 a song)
 * and charges more than three times that for a song from a prompt alone, so an empty lyrics box is filled here
 * first, in the creator's own language, and lands in the box for them to read and change.
 *
 * Free to the creator, like AI 优化提示词 (lib/generation/enhance.ts): one short call to the internal model, logged
 * as usage. A refusal or a cut-off answer comes back as a failure, never as lyrics.
 */
import { env } from "../env.js";
import { INTERNAL_PRIMARY_MODEL } from "../llm/internal-models.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const TIMEOUT_MS = 30_000;
export const LYRICS_MAX_PROMPT = 600;

const SYSTEM = `You write song lyrics for a creator's story, from their short description of the song.
Write in the same language as the description (Chinese stays Chinese, Japanese stays Japanese) unless it asks for another language.
Shape: section tags on their own lines, in English: [Verse], [Pre-Chorus], [Chorus], [Bridge], [Outro]. Two verses, a chorus that returns, short lines that sing well, about 16 to 24 lines in all.
Make it specific to what they describe: its images, its feeling, the character's voice. No clichés about "the stars above" unless they asked for stars.
Answer with exactly this and nothing else:
TITLE: <a short song title>
<the lyrics>`;

export type LyricsResult = { ok: true; title: string; lyrics: string } | { ok: false; reason: "unavailable" | "failed" | "refused" };

const TITLE_LINE = /^\s*(?:\*\*)?(?:title|标题|歌名|標題|タイトル|título)(?:\*\*)?\s*[:：]\s*(.+)$/i;
const TAG_LINE = /^\s*\[[^\]]{1,30}\]\s*$/;

/** The answer's title line and lyrics; null when it is not shaped like lyrics (a refusal, a chat reply). The title line
 *  may be missing or in the creator's language (标题：/ タイトル：); section tags may be too ([副歌]). */
export function parseLyrics(raw: string): { title: string; lyrics: string } | null {
  const text = raw.replace(/^\s*```[a-z]*\s*\n?|\n?```\s*$/gi, "").trim();
  const lines = text.split(/\r?\n/);
  let title = "";
  const head = TITLE_LINE.exec(lines[0] ?? "");
  if (head) { title = head[1]!.trim(); lines.shift(); }
  title = title.replace(/^["“「『《*]+|["”」』》*]+$/g, "").slice(0, 80);
  const lyrics = lines.join("\n").trim();
  const sung = lyrics.split(/\r?\n/).filter((line) => line.trim() && !TAG_LINE.test(line));
  if (sung.length < 6 || lyrics.length > 3000) return null;
  // A reply about the request rather than lyrics: mostly long prose lines.
  if (sung.filter((line) => line.length > 60).length > sung.length / 2) return null;
  return { title, lyrics: /\[[^\]]{1,30}\]/.test(lyrics) ? lyrics : `[Verse]\n${lyrics}` };
}

export async function writeLyrics(prompt: string, userId: string): Promise<LyricsResult> {
  if (!env.YUMINA_OPENROUTER_KEY) return { ok: false, reason: "unavailable" };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.YUMINA_OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: INTERNAL_PRIMARY_MODEL,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt.slice(0, LYRICS_MAX_PROMPT) }],
        temperature: 0.9,
        reasoning: { effort: "low" },
        max_tokens: 2000,
        provider: { sort: "price" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) { console.warn("[music] lyrics request failed", { userId, status: res.status }); return { ok: false, reason: "failed" }; }
    const data = (await res.json()) as {
      model?: string;
      choices?: { finish_reason?: string | null; message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    if (data.usage) {
      const promptTokens = data.usage.prompt_tokens ?? 0, completionTokens = data.usage.completion_tokens ?? 0;
      try {
        const { recordUsageLog } = await import("../usage-log.js");
        await recordUsageLog({ userId, model: data.model || INTERNAL_PRIMARY_MODEL, promptTokens, completionTokens,
          totalTokens: Math.max(promptTokens + completionTokens, data.usage.total_tokens ?? 0), endpoint: "music-lyrics",
          apiKeyTier: "internal", generationTimeMs: Date.now() - startedAt });
      } catch (error) { console.error("[music] lyrics usage not recorded", error); }
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") return { ok: false, reason: "failed" };
    const content = choice?.message?.content ?? "";
    const parsed = parseLyrics(content);
    if (!parsed) console.warn("[music] lyrics answer not usable", { userId, head: content.slice(0, 160) });
    return parsed ? { ok: true, ...parsed } : { ok: false, reason: "refused" };
  } catch (error) {
    console.warn("[music] lyrics request failed", { userId, error: error instanceof Error ? error.message : error });
    return { ok: false, reason: "failed" };
  } finally {
    clearTimeout(timer);
  }
}
