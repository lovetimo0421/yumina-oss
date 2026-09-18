/**
 * Anthropic's extended-thinking request shape changed across model generations,
 * and the native provider must send the form each model accepts:
 *
 *  - Claude 4.6+ (Opus 4.6/4.7/4.8, Sonnet 4.6) and the 5.x line (Fable/Mythos)
 *    use `thinking: {type:"adaptive"}` + `output_config.effort`. The legacy
 *    `{type:"enabled", budget_tokens}` shape is REJECTED with a 400 on Opus
 *    4.7/4.8 and Fable 5 ("thinking.type.enabled is not supported for this
 *    model. Use thinking.type.adaptive and output_config.effort…").
 *  - Claude 4.5 and earlier (Opus 4.5/4.1/4.0, Sonnet 4.5/4.0, Haiku 4.5) use
 *    the legacy `{type:"enabled", budget_tokens}` shape and do NOT accept
 *    `output_config.effort`.
 *
 * OpenRouter is unaffected — it sends its own `reasoning:{effort}` and translates
 * per model. This module is native-Anthropic only, kept separate so the
 * request-shaping decision is unit-testable without a live API call.
 */

/** Parse a Claude model id into {major, minor}. Handles dash and dot minor
 *  separators (claude-opus-4-7 / claude-opus-4.7), the Fable/Mythos 5.x line
 *  (single number, no minor), and future major-only ids (claude-opus-5).
 *  Returns null for claude-3.x and unrecognized ids. */
export function parseClaudeVersion(modelId: string): { major: number; minor: number } | null {
  const id = modelId.toLowerCase();
  const fm = id.match(/claude-(?:fable|mythos)-(\d+)/); // 5.x line, no minor
  if (fm) return { major: Number(fm[1]), minor: 0 };
  const m = id.match(/claude-[a-z]+-(\d+)[.-](\d+)/); // claude-opus-4-7 / 4.7
  if (m) return { major: Number(m[1]), minor: Number(m[2]) };
  const single = id.match(/claude-[a-z]+-(\d+)(?![\d.])/); // future major-only (claude-opus-5)
  if (single) return { major: Number(single[1]), minor: 0 };
  return null;
}

/** True when the Claude model uses adaptive thinking + `output_config.effort`
 *  (Claude 4.6+ within the 4.x line, and the entire 5.x line). */
export function supportsAdaptiveThinking(modelId: string): boolean {
  const v = parseClaudeVersion(modelId);
  if (!v) return false; // claude-3.x / unrecognized → legacy budget path
  return v.major > 4 || (v.major === 4 && v.minor >= 6);
}

/** True when the model still accepts the legacy sampling parameters
 *  (`temperature`, `top_p`, `top_k`). Claude Opus 4.7+/4.8 and the 5.x line
 *  (Fable/Mythos) removed them — sending any returns a 400 (e.g.
 *  "`top_p` is deprecated for this model"). Claude 4.6 and earlier still accept
 *  them. Unrecognized ids default to accepting (preserve prior behavior). */
export function acceptsLegacySamplingParams(modelId: string): boolean {
  const v = parseClaudeVersion(modelId);
  if (!v) return true;
  if (v.major > 4) return false; // 5.x line removed sampling params
  if (v.major === 4 && v.minor >= 7) return false; // Opus 4.7+/4.8 removed them
  return true; // Claude 4.6 and earlier still accept them
}

/** Map Yumina's reasoning-effort levels (minimal|low|medium|high) to the
 *  Anthropic `output_config.effort` values accepted on every adaptive-capable
 *  model. Anthropic has no "minimal" — its floor is "low". Returns null for
 *  "none"/undefined/unknown (no thinking requested). */
export function mapEffortToAnthropic(effort: string | undefined): "low" | "medium" | "high" | null {
  switch (effort) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return null;
  }
}

/** Build the thinking-related fields of an Anthropic request body for the given
 *  model + effort. Returns the correct shape per model generation, or an empty
 *  object when no thinking is requested. `legacyBudget` is the pre-computed
 *  `budget_tokens` for the legacy path (ignored on adaptive-capable models). */
export function buildAnthropicThinking(
  modelId: string,
  effort: string | undefined,
  legacyBudget: number,
): Record<string, unknown> {
  const wantsThinking = !!effort && effort !== "none";
  if (!wantsThinking) return {};

  if (supportsAdaptiveThinking(modelId)) {
    const mapped = mapEffortToAnthropic(effort);
    return {
      thinking: { type: "adaptive" },
      ...(mapped && { output_config: { effort: mapped } }),
    };
  }

  if (legacyBudget > 0) {
    return { thinking: { type: "enabled", budget_tokens: legacyBudget } };
  }
  return {};
}
