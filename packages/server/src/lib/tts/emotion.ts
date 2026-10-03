/**
 * Emotion cues for voice readout.
 *
 * Fish S2 reads a bracketed, natural-language delivery cue at the start of a
 * sentence ("[sad, voice trembling] ..."). Chat models don't write those, so
 * readouts came out flat. Before a synth we ask Jev (the decision model the
 * continuity judge already uses) which of eight coarse, far-apart emotions
 * each line carries, and prefix the matching cue. The story text the player
 * reads is never touched — only what gets sent to the voice model.
 *
 * Owner blind test 2026-09-28: tagged readings judged better. Jev judged the
 * hidden-anger line right (0.91); its two misses were both under 0.45, hence
 * EMOTION_MIN_CONFIDENCE. One Jev call covers every line in the text (one
 * question per line), bounded by EMOTION_TIMEOUT_MS — past that the text is
 * read untagged rather than waiting.
 *
 * Runs only when a synth is actually about to happen (a cache miss for a
 * player who is listening). Kill switch: TTS_EMOTION=off.
 */

import type { JevAnswer, JevQuestion } from "@yumina/engine";
import { decide, decisionModelConfigured } from "../continuity/jev-client.js";
import type { PlayerSideKey, SideCallKeySource } from "../side-call-key.js";
import { env } from "../env.js";

export const TTS_EMOTIONS = {
  calm: { criteria: "平静、日常、客观陈述，没有明显情绪起伏", cue: "" },
  happy: { criteria: "开心、愉快、带着笑意、得意", cue: "[happy, bright and warm, smiling]" },
  sad: { criteria: "难过、失落、心碎、强忍眼泪、哽咽", cue: "[sad, voice trembling, holding back tears]" },
  angry: { criteria: "生气、愤怒、质问、斥责，包括压着火的冷淡和阴阳怪气", cue: "[angry, cold and sharp]" },
  afraid: { criteria: "害怕、恐惧、紧张、慌乱", cue: "[scared, nervous, breathless]" },
  tender: { criteria: "害羞、撒娇、暧昧、温柔、深情", cue: "[shy, soft and tender]" },
  whisper: { criteria: "低声耳语、说悄悄话、怕被别人听见", cue: "[whispering, intimate]" },
  excited: { criteria: "激动、兴奋、欢呼、大喊、慷慨激昂", cue: "[excited, loud and energetic]" },
} as const;
export type TtsEmotion = keyof typeof TTS_EMOTIONS;

export const EMOTION_MIN_CONFIDENCE = 0.6;
export const EMOTION_TIMEOUT_MS = 600;
/** Lines past this many are read untagged (one Jev call stays small). */
const MAX_TAGGED_LINES = 16;
const MAX_CONTEXT_CHARS = 1500;

export function emotionTaggingEnabled(): boolean {
  return env.TTS_EMOTION !== "off" && decisionModelConfigured();
}

/** Split into lines, keeping each line's trailing separator so the text
 *  reassembles exactly. */
export function splitLines(text: string): Array<{ line: string; sep: string }> {
  const out: Array<{ line: string; sep: string }> = [];
  const re = /([^\n]*)(\n+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0].length > 0) out.push({ line: m[1]!, sep: m[2]! });
  return out;
}

/** Prefix each confidently-judged line with its cue. Lines that already
 *  open with a bracket (a card's own cue) are left as they are. */
export function applyEmotionCues(
  parts: Array<{ line: string; sep: string }>,
  answers: Record<string, JevAnswer | undefined>,
): { text: string; tagged: number } {
  let tagged = 0;
  const text = parts
    .map((p, i) => {
      const a = answers[`l${i}`];
      const choice = a?.choice as TtsEmotion | undefined;
      const confidence = a?.confidence ?? (choice ? a?.probabilities?.[choice] : undefined) ?? 0;
      const cue = choice && choice in TTS_EMOTIONS ? TTS_EMOTIONS[choice].cue : "";
      const trimmed = p.line.trimStart();
      if (!cue || confidence < EMOTION_MIN_CONFIDENCE || !trimmed || trimmed.startsWith("[")) return p.line + p.sep;
      tagged++;
      const space = /^[A-Za-z0-9"'“]/.test(trimmed) ? " " : "";
      return cue + space + p.line + p.sep;
    })
    .join("");
  return { text, tagged };
}

export async function addEmotionCues(
  text: string,
  context?: string,
  /** The player's own OpenRouter key (BYOK readouts); falls back to the platform's. */
  playerKey?: PlayerSideKey | null,
): Promise<{
  text: string; tagged: number; usage?: { inputTokens: number; outputTokens: number }; model?: string; ms: number;
  keySource?: SideCallKeySource;
}> {
  const started = Date.now();
  const parts = splitLines(text);
  const questions: Record<string, JevQuestion> = {};
  const lines: Record<string, string> = {};
  const criteria = Object.fromEntries(Object.entries(TTS_EMOTIONS).map(([k, v]) => [k, v.criteria]));
  parts.forEach((p, i) => {
    if (!p.line.trim() || i >= MAX_TAGGED_LINES) return;
    lines[`第${i + 1}句`] = p.line.trim();
    questions[`l${i}`] = {
      type: "choice",
      instructions: `第${i + 1}句台词应该用什么情绪念出来？结合场景判断说话人此刻的真实情绪，不要只看字面。`,
      criteria,
    };
  });
  if (Object.keys(questions).length === 0) return { text, tagged: 0, ms: 0 };
  try {
    const res = await decide({
      state: {
        ...(context && context.trim() && context.trim() !== text.trim()
          ? { 场景: context.trim().slice(-MAX_CONTEXT_CHARS) }
          : {}),
        台词: lines,
      },
      questions,
      timeoutMs: EMOTION_TIMEOUT_MS,
      playerKey,
    });
    const applied = applyEmotionCues(parts, res.answers);
    return { ...applied, usage: res.usage, model: res.model, ms: Date.now() - started, keySource: res.keySource };
  } catch (err) {
    // Slow or failed: read it untagged. A readout never waits on this.
    console.warn("[TTS] emotion cues skipped:", err instanceof Error ? err.message.slice(0, 160) : err);
    return { text, tagged: 0, ms: Date.now() - started };
  }
}
