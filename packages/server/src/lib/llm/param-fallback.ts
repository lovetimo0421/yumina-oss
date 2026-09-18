/**
 * Reactive parameter stripper for OpenAI-compatible chat-completions endpoints.
 *
 * Different upstream models reject different sampling parameters with HTTP 400
 * (OpenAI o-series rejects `max_tokens`; xAI's `grok-*-reasoning` rejects
 * `presence_penalty`; etc). Hardcoding every (provider × model) combination
 * is hopeless — there are too many proxies and the models keep changing.
 *
 * Instead we send the full request once. If it 400s with a recognizable
 * "this model doesn't take parameter X" error, we strip X and retry exactly
 * once. The original error is returned if the retry also fails or if the
 * error doesn't match any known pattern.
 */

/** Patterns that quote the offending parameter name. Order matters — more
 *  specific patterns first. We accept either snake_case (what we send) or
 *  camelCase (what some upstreams echo back, e.g. xAI returns
 *  "parameter presencePenalty"). */
const PATTERNS: RegExp[] = [
  /Unsupported parameter:?\s*['"`]?([a-zA-Z][a-zA-Z0-9_]*)['"`]?/i,
  /does not support parameter\s+['"`]?([a-zA-Z][a-zA-Z0-9_]*)['"`]?/i,
  /parameter\s+['"`]?([a-zA-Z][a-zA-Z0-9_]*)['"`]?\s+is not supported/i,
  /unrecognized request argument supplied:\s*([a-zA-Z][a-zA-Z0-9_]*)/i,
  /['"`]?([a-zA-Z][a-zA-Z0-9_]*)['"`]?\s+is not a valid parameter/i,
  /invalid parameter:?\s*['"`]?([a-zA-Z][a-zA-Z0-9_]*)['"`]?/i,
];

/** Convert camelCase (presencePenalty) to snake_case (presence_penalty). */
function toSnakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Parse the offending parameter name out of an upstream error body.
 * Returns the snake_case form (the name we actually emit) so the caller can
 * `delete body[name]` directly.
 */
export function parseUnsupportedParam(errorText: string): string | null {
  if (!errorText) return null;
  for (const re of PATTERNS) {
    const m = re.exec(errorText);
    if (m && m[1]) {
      const raw = m[1];
      // Skip false positives like quoted error labels ("error", "type", etc.)
      const reserved = new Set(["error", "message", "type", "code", "param", "true", "false", "null"]);
      if (reserved.has(raw.toLowerCase())) continue;
      return toSnakeCase(raw);
    }
  }
  return null;
}

/**
 * Strip a known-rejected parameter from a body, preserving stream/messages/etc.
 * Returns null if the param wasn't present (so we don't loop on the same error).
 */
export function stripParamFromBody(
  body: Record<string, unknown>,
  paramName: string,
): Record<string, unknown> | null {
  if (!(paramName in body)) return null;
  const next = { ...body };
  delete next[paramName];
  return next;
}

/**
 * Heuristic: is this model name likely a "reasoning" model that rejects the
 * usual sampling params (temperature/top_p/penalty controls)? Used for the
 * proactive pre-strip path on the Custom provider, which can't know the
 * upstream's model conventions.
 *
 * The downstream reactive retry catches anything we miss — false negatives
 * here are recoverable.
 */
export function looksLikeReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    /(^|\/)o[1-9]/.test(id) ||
    id.includes("gpt-5") ||
    id.includes("reasoning") ||
    id.includes("thinking") ||
    id.includes("-r1") ||
    id.endsWith("-r1") ||
    id.includes("deepseek-r")
  );
}
