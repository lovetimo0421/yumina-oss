import type { ChatMessage } from "./llm/types.js";

/**
 * Fit a background AI's prompt under the player's plan memory cap. Old
 * history goes first (anything between the leading system message and the
 * final message); if one message is still too long, its oldest text is cut,
 * since the end of a briefing or transcript is what the answer is about.
 * Image parts are kept whole. Returns the prompt unchanged when it fits.
 */
export function fitPromptToChars(prompt: ChatMessage[], maxChars: number): ChatMessage[] {
  const size = (m: ChatMessage) => typeof m.content === "string" ? m.content.length
    : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);
  let total = prompt.reduce((n, m) => n + size(m), 0);
  if (total <= maxChars) return prompt;
  const out = [...prompt];
  const first = out[0]?.role === "system" ? 1 : 0;
  while (total > maxChars && out.length - first > 1) {
    total -= size(out[first]!);
    out.splice(first, 1);
  }
  while (total > maxChars) {
    let longest = -1;
    for (let i = 0; i < out.length; i++) {
      const m = out[i]!;
      if (typeof m.content === "string" && (longest < 0 || size(m) > size(out[longest]!))) longest = i;
    }
    if (longest < 0) break;
    const m = out[longest]!;
    const text = m.content as string;
    const keep = Math.max(0, text.length - (total - maxChars) - 1);
    if (keep >= text.length) break;
    out[longest] = { ...m, content: `…${text.slice(text.length - keep)}` };
    total -= text.length - keep - 1;
    if (keep === 0) break;
  }
  return out;
}
