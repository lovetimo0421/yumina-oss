import { jsonrepair } from "jsonrepair";

/**
 * Parse tool call arguments JSON with multi-stage repair.
 *
 * Stage 1: Native JSON.parse (fast path — handles 95% of cases)
 * Stage 2: Code-aware repair for known code fields (tsxCode, content)
 *          — LLMs often generate unescaped newlines/quotes inside code strings
 * Stage 3: Generic jsonrepair (trailing commas, missing quotes, etc.)
 * Stage 4: Error with position snippet for LLM self-correction
 *
 * Returns {} for empty/undefined input (OpenRouter provider edge case).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseToolArgs(raw: string): any {
  // Handle empty/undefined input (OpenRouter omits arguments for no-param tools)
  if (!raw || raw.trim() === "" || raw.trim() === "{}") return {};

  // Stage 1: Fast path — valid JSON
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to repair stages
  }

  // Stage 2: Code-aware repair — target known code fields that break JSON
  // Tool call JSON has a flat structure: { "id": "...", "tsxCode": "...", ... }
  // The tsxCode/content fields contain code with unescaped newlines, quotes, backslashes
  const codeRepaired = tryRepairCodeFields(raw);
  if (codeRepaired !== null) {
    try {
      return JSON.parse(codeRepaired);
    } catch {
      // Code repair produced valid-looking JSON but it still fails — try jsonrepair on it
      try {
        return JSON.parse(jsonrepair(codeRepaired));
      } catch {
        // Fall through
      }
    }
  }

  // Stage 3: Generic jsonrepair (handles trailing commas, missing quotes, etc.)
  try {
    const repaired = jsonrepair(raw);
    return JSON.parse(repaired);
  } catch {
    // Fall through to error
  }

  // Stage 4: Build a helpful error message for the LLM
  let position = -1;
  try {
    JSON.parse(raw);
  } catch (e) {
    const match = String(e).match(/position\s+(\d+)/i);
    if (match) position = Number(match[1]);
  }

  // Try to identify which field caused the issue
  const fieldHint = detectProblematicField(raw, position);

  const snippet =
    position >= 0
      ? `...${raw.slice(Math.max(0, position - 40), position)}👉${raw.slice(position, position + 40)}...`
      : raw.slice(0, 120) + (raw.length > 120 ? "..." : "");

  throw new Error(
    `JSON parse failed${fieldHint}. ` +
      `Check for unescaped quotes, backticks, or newlines inside string values. ` +
      `Near: ${snippet}`,
  );
}

/**
 * Attempt to repair known code fields (tsxCode, content) that contain
 * unescaped characters. Returns repaired JSON string or null if not applicable.
 *
 * Strategy: locate the field's opening quote, walk forward respecting escapes
 * to find the value boundary, re-escape the raw content, reconstruct.
 */
function tryRepairCodeFields(raw: string): string | null {
  // Only attempt if the raw string looks like it contains a code field
  const codeFields = ["tsxCode", "content"];
  let fieldName: string | null = null;
  let fieldKeyStart = -1;

  for (const name of codeFields) {
    // Match "fieldName" : " pattern (with optional whitespace)
    const pattern = new RegExp(`"${name}"\\s*:\\s*"`);
    const match = pattern.exec(raw);
    if (match) {
      fieldName = name;
      fieldKeyStart = match.index;
      break;
    }
  }

  if (!fieldName || fieldKeyStart === -1) return null;

  // Find where the value starts (after the opening quote of the value)
  const valueQuotePattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const valueMatch = valueQuotePattern.exec(raw);
  if (!valueMatch) return null;
  const valueStart = valueMatch.index + valueMatch[0].length;

  // Walk forward to find the closing quote of the value.
  // A proper JSON closing quote is: an unescaped " followed by , or } or whitespace+}
  // We look for " followed by optional whitespace and then , } or end-of-object indicators
  let pos = valueStart;
  let closingQuote = -1;

  while (pos < raw.length) {
    const ch = raw[pos];

    // Skip escaped characters
    if (ch === "\\" && pos + 1 < raw.length) {
      pos += 2;
      continue;
    }

    // Potential closing quote — check what follows
    if (ch === '"') {
      const after = raw.slice(pos + 1).trimStart();
      // Valid JSON continuations after a string value: , } or end of string
      if (after.length === 0 || after[0] === "," || after[0] === "}") {
        closingQuote = pos;
        break;
      }
      // Also accept another field starting: "nextField"
      if (after[0] === '"' && /^"[a-zA-Z]/.test(after)) {
        // Missing comma — this is the end of our value
        closingQuote = pos;
        break;
      }
    }

    pos++;
  }

  if (closingQuote === -1) {
    // Could not find closing quote — field extends to end of string (truncated output)
    // Try to salvage: find the last } in the string and work backwards
    const lastBrace = raw.lastIndexOf("}");
    if (lastBrace > valueStart) {
      // Find the last " before the brace
      let candidateClose = lastBrace - 1;
      while (candidateClose > valueStart && raw[candidateClose] !== '"') candidateClose--;
      if (candidateClose > valueStart && raw[candidateClose] === '"') {
        closingQuote = candidateClose;
      }
    }
    if (closingQuote === -1) return null; // Truly unrecoverable
  }

  // Extract the raw code value (between quotes, may contain unescaped chars)
  const rawValue = raw.slice(valueStart, closingQuote);

  // Re-escape the value properly
  const escaped = rawValue
    .replace(/\\/g, "\\\\")   // backslashes first
    .replace(/"/g, '\\"')      // quotes
    .replace(/\n/g, "\\n")     // newlines
    .replace(/\r/g, "\\r")     // carriage returns
    .replace(/\t/g, "\\t");    // tabs

  // Reconstruct the JSON with the properly escaped value
  const before = raw.slice(0, valueStart);
  const after = raw.slice(closingQuote);
  return before + escaped + after;
}

/**
 * Try to identify which field caused a JSON parse failure.
 * Returns a hint string like " — the 'tsxCode' field likely contains unescaped characters"
 */
function detectProblematicField(raw: string, position: number): string {
  if (position < 0) return "";

  // Walk backwards from position to find the most recent field name
  const beforeError = raw.slice(0, position);
  const fieldMatch = beforeError.match(/"(\w+)"\s*:\s*"[^"]*$/);
  if (fieldMatch) {
    const field = fieldMatch[1];
    if (field === "tsxCode" || field === "content") {
      return ` — the '${field}' field likely contains unescaped characters (newlines, quotes, or backticks)`;
    }
    return ` — error is in or near the '${field}' field`;
  }
  return "";
}
