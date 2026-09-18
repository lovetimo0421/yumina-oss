// Recognized HTML element names. We only strip angle-bracket spans whose tag
// name is a real HTML element, so prose/roleplay text survives (e.g. "<sighs>",
// the "<3" emoticon, "a < b > c"). The old /<\/?[^>]+(>|$)/g deleted all of these.
const HTML_TAG_NAMES =
  "a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|script|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr";
const HTML_TAG_RE = new RegExp(`<\\/?(?:${HTML_TAG_NAMES})(?:\\s[^>]*)?\\/?>`, "gi");

/**
 * Strip HTML from user content while keeping markdown/prose intact.
 * Removes <script>/<style> blocks (tag + payload) and recognized HTML tags,
 * but leaves angle-bracket text that isn't a real HTML element untouched.
 */
export function stripHtml(input: string): string {
  return input
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(HTML_TAG_RE, "");
}

/** Remove control characters and zero-width Unicode from display names. */
export function stripControlChars(input: string): string {
  let result = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    // Skip C0 controls (except tab/newline), DEL, C1 controls
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a) continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    // Skip zero-width characters
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code === 0xfeff || code === 0x2060) continue;
    result += ch;
  }
  return result;
}

/** Trim whitespace and collapse 3+ consecutive newlines down to 2. */
export function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\n{3,}/g, "\n\n");
}

/** Full sanitization pipeline for user-generated content (community posts, reviews, DMs). */
export function sanitizeContent(input: string): string {
  return normalizeWhitespace(stripHtml(input));
}

/** Sanitize a display name: strip control chars, trim, collapse whitespace. */
export function sanitizeDisplayName(input: string): string {
  return stripControlChars(input).trim().replace(/\s+/g, " ");
}

/**
 * Enforce a max-length check. Returns the truncated string.
 * Prefer Zod schema validation when possible — use this for
 * fields validated inline without a Zod schema.
 */
export function clampString(input: string, maxLength: number): string {
  return input.length > maxLength ? input.slice(0, maxLength) : input;
}
