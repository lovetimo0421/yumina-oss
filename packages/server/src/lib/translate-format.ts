import { createHash } from "node:crypto";

/** Keep code and template syntax out of the model's editable prose. */
export function protectTranslationText(source: string) {
  let prefix = `YUMINA_KEEP_${createHash("sha256").update(source).digest("hex").slice(0, 12)}_`;
  while (source.includes(prefix)) prefix += "X";
  const spans: string[] = [];
  const keep = (text: string) => `${prefix}${spans.push(text) - 1}_END`;
  // Line-based scanning respects longer fences, tilde fences and unclosed code.
  const lines = source.split(/(?<=\n)/);
  let text = "";
  for (let i = 0; i < lines.length; i++) {
    const opener = lines[i]!.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n)?$/);
    if (!opener) {
      text += lines[i]!.replace(/(`+)([^\r\n]*?)\1|\{\{[^}\r\n]+\}\}/g, keep);
      continue;
    }
    const fence = opener[1]!;
    let block = lines[i]!;
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n)?$`);
    while (++i < lines.length) {
      block += lines[i]!;
      if (closing.test(lines[i]!)) break;
    }
    // Keep the separator outside the token so the model sees paragraph layout.
    const newline = block.match(/\r?\n$/)?.[0] ?? "";
    text += keep(block.slice(0, block.length - newline.length)) + newline;
  }
  return { source, text, prefix, spans };
}

export function restoreTranslationText(
  translated: string,
  protectedText: ReturnType<typeof protectTranslationText>,
): string | null {
  const { source, prefix, spans } = protectedText;
  if (!source.trim()) return translated.trim() ? null : source;
  const tokens = translated.match(new RegExp(`${prefix}\\d+_END`, "g")) ?? [];
  const expected = spans.map((_, i) => `${prefix}${i}_END`);
  // Missing, duplicated and reordered tokens all fail closed.
  if (JSON.stringify(tokens) !== JSON.stringify(expected)) return null;
  if (tokens.some((token) => translated.includes("`" + token) || translated.includes(token + "`"))) return null;
  let result = translated.replace(new RegExp(`${prefix}(\\d+)_END`, "g"), (_, i: string) => spans[Number(i)]!);
  if (result.includes(prefix)) return null;
  const layout = (s: string) => s.trim().replace(/\r\n/g, "\n").match(/\n+/g) ?? [];
  if (JSON.stringify(layout(source)) !== JSON.stringify(layout(result))) return null;
  const headings = (s: string) => s.match(/^ {0,3}#{1,6}(?=\s)/gm) ?? [];
  if (JSON.stringify(headings(source)) !== JSON.stringify(headings(result))) return null;
  // A copied, already-target-language line sometimes only gets its smart quotes
  // normalized. Restore that line exactly, without guessing its language or
  // replacing any line whose actual words have changed during translation.
  const typography = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
  const sourceLines = source.trim().split(/\r?\n/);
  result = result.trim().split(/(\r?\n)/).map((part, i) => {
    if (i % 2) return part;
    const original = sourceLines[i / 2];
    return original != null && typography(original) === typography(part) ? original : part;
  }).join("");
  // Preserve outer whitespace too, even though the HTTP client trims answers.
  result = (source.match(/^\s*/)?.[0] ?? "") + result.trim() + (source.match(/\s*$/)?.[0] ?? "");
  return result;
}

type TranslationResult =
  | { ok: true; title: string | null; content: string }
  | { ok: false; reason: "api_error" | "parse_error" | "format_error" };

/** Shared by production and live evaluation; rejects protected-content/layout damage. */
export async function requestFormattedTranslation(options: {
  content: string;
  title?: string;
  systemMessage: string;
  request: (system: string, user: string, json: boolean) => Promise<string | null>;
  isRefusal: (text: string) => boolean;
  userMessage?: (protectedContent: string) => string;
}): Promise<TranslationResult> {
  const body = protectTranslationText(options.content);
  const title = options.title ? protectTranslationText(options.title) : null;
  const user = title
    ? `Source title:\n${title.text}\n\nSource content:\n${body.text}`
    : options.userMessage?.(body.text) ?? body.text;
  const protection = body.spans.length || title?.spans.length
    ? "\nTokens beginning YUMINA_KEEP_ are opaque protected content. Copy each complete token exactly once in its original position. Never translate, expand, remove, reorder, or wrap these tokens in code fences."
    : "";
  let reason: "parse_error" | "format_error" = "format_error";
  for (let attempt = 0; attempt < 2; attempt++) {
    const repair = attempt ? "\nThe previous output failed validation. Return the complete translation again. Preserve every protected token and every source line break and blank line; keep all Markdown headings. For JSON, return both string fields with correctly escaped newlines." : "";
    const raw = await options.request(options.systemMessage + protection + repair, user, !!title);
    if (!raw) return { ok: false, reason: "api_error" };
    // Preserve the existing refusal/fallback path, even for protected sources.
    if (options.isRefusal(raw)) return { ok: true, title: null, content: raw };
    let content = raw;
    let translatedTitle: string | null = null;
    if (title) {
      try {
        const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim());
        if (typeof parsed.content !== "string" || typeof parsed.title !== "string") throw new Error("shape");
        content = parsed.content;
        translatedTitle = parsed.title;
      } catch {
        reason = "parse_error";
        continue;
      }
    }
    if (options.isRefusal(content) || (translatedTitle != null && options.isRefusal(translatedTitle))) {
      return { ok: true, content, title: translatedTitle };
    }
    const restored = restoreTranslationText(content, body);
    const restoredTitle = title ? restoreTranslationText(translatedTitle!, title) : null;
    if (restored != null && (!title || restoredTitle != null)) {
      return { ok: true, content: restored, title: restoredTitle };
    }
    reason = "format_error";
  }
  return { ok: false, reason };
}
