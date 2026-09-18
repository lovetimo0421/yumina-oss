/** Regex to detect a user-supplied regex pattern like /pattern/flags */
const USER_REGEX_RE = /^\/(.+)\/([gimsuy]*)$/;

/**
 * Check if a single keyword matches anywhere in the text.
 *
 * Match chain:
 * 1. If keyword looks like `/regex/flags` → try regex match
 * 2. If `wholeWord` → word boundary regex `\bkeyword\b`
 * 3. Else → substring `text.includes(keyword)`
 *
 * All matching is case-insensitive.
 */
export function keywordMatches(
  text: string,
  keyword: string,
  wholeWord: boolean
): boolean {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();

  // 1. User-supplied regex: /pattern/flags
  const regexMatch = USER_REGEX_RE.exec(keyword);
  if (regexMatch) {
    try {
      const flags = regexMatch[2]!.includes("i") ? regexMatch[2]! : regexMatch[2]! + "i";
      const re = new RegExp(regexMatch[1]!, flags);
      if (re.test(text)) return true;
    } catch {
      // Invalid regex — fall through to substring
    }
  }

  // 2. Whole-word matching
  if (wholeWord) {
    try {
      const escaped = lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      if (re.test(text)) return true;
    } catch {
      // Fall through
    }
    return false;
  }

  // 3. Substring matching (default)
  return lowerText.includes(lowerKeyword);
}
