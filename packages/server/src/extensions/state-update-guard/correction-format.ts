import { ThinkingTagFilter } from "@yumina/engine";

function containsOnlyReview(suffix: string): boolean {
  const start = /^,\s*"review"\s*:\s*\[/.exec(suffix);
  if (!start) return false;
  const stack = ["]"];
  let quoted = false;
  for (let i = start[0].length; i < suffix.length; i++) {
    const ch = suffix[i];
    if (quoted && ch === "\\") { i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return false;
      if (!stack.length) return /^\s*}\s*$/.test(suffix.slice(i + 1));
    }
  }
  return false;
}

/** Only negotiate away a specifically rejected JSON-output parameter. Generic
 * 400s, model errors, authentication/rate limits and failures after output must
 * not become hidden retries. The caller enforces the latter and the deadline. */
export function isJsonModeUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message.slice(0, 4000) : "";
  if (/\b(?:401|403|429|5\d\d)\b|unauthori[sz]ed|rate.limit|context.{0,20}(?:limit|length|exceed)/i.test(message)) return false;
  // Routers can reject a requested parameter before choosing an endpoint.
  // A bare "no endpoints" / unavailable-model error is deliberately excluded.
  if (/no endpoints found that support (?:the |your )?requested parameters/i.test(message)) return true;
  return /response[_ -]?format|json[_ -]?(?:object|schema)|responseMimeType|application\/json/i.test(message)
    && /not.support|unsupported|unrecognized|unknown.parameter|invalid.parameter|not.allowed|not.permitted/i.test(message);
}

/** Recover only the observed boundary typo: a COMPLETE stateChanges array
 * followed by one/two extra closing delimiters before a top-level review.
 * No values, operations, keys, commas or missing delimiters are invented.
 * Broken/truncated nested data and arbitrary trailing content stay rejected.
 * This is correction-only: legacy story parsers are deliberately untouched. */
export function normalizeCorrectionJson(raw: string): { text: string; repaired: boolean } {
  const unchanged = { text: raw, repaired: false };
  if (raw.length > 65536) return unchanged;
  const text = ThinkingTagFilter.strip(raw).trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```$/, "");
  try { JSON.parse(text); return unchanged; } catch { /* inspect the boundary */ }
  if (!text.startsWith("{")) return unchanged;
  const stack: string[] = [];
  let key = "";
  let previous = "";
  const keys = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      if (i >= text.length) return unchanged;
      if (stack.length === 1 && (previous === "{" || previous === ",")) {
        try { key = JSON.parse(text.slice(start, i + 1)) as string; } catch { return unchanged; }
        if (keys.has(key)) return unchanged;
        keys.add(key);
      }
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return unchanged;
      if (ch === "]" && stack.length === 1 && key === "stateChanges") {
        if (keys.has("review")) return unchanged;
        const suffix = text.slice(i + 1);
        const extra = /^(\s*[}\]]\s*(?:[}\]]\s*)?)(?=,\s*"review"\s*:)/.exec(suffix);
        if (!extra) return unchanged;
        const candidate = text.slice(0, i + 1) + suffix.slice(extra[0].length);
        try {
          const envelope = JSON.parse(candidate);
          if (typeof envelope.narrative !== "string" || !Array.isArray(envelope.stateChanges) || !Array.isArray(envelope.review)) return unchanged;
          if (envelope.status !== "updated" && envelope.status !== "none") return unchanged;
          // Never discard duplicate review fields or let a suffix override
          // status/stateChanges through JSON.parse's last-key-wins behavior.
          if (!containsOnlyReview(suffix.slice(extra[0].length))) return unchanged;
          return { text: candidate, repaired: true };
        } catch { return unchanged; }
      }
    }
    previous = ch;
  }
  return unchanged;
}
