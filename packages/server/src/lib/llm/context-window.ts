import { effectiveMaxTokens } from "./openrouter.js";
import { getCatalogContextWindow } from "./model-catalog.js";

/**
 * Real maximum context window (input + output, in tokens) for a model.
 *
 * Source order:
 *   1. Live OpenRouter `/models` catalog (authoritative; auto-updates) — see
 *      model-catalog.ts. This is the proper source; it's what OpenRouter reports.
 *   2. Hardcoded per-family fallback below — only when the catalog is cold
 *      (before the first fetch) or the model isn't on OpenRouter (direct-BYOK).
 *
 * This is the *hard* upstream limit — NOT a budget. Compare with
 * `agent.ts · getContextBudget`, which deliberately returns a much smaller,
 * headroom-baked number tuned for the Studio agent's huge tool schemas. The
 * chat path must NOT reuse that (it would slash every DeepSeek chat user's
 * memory from ~160K to 50K); it needs the true window so we can clamp the
 * prompt to fit and avoid OpenRouter's pre-flight 400:
 *
 *   "This endpoint's maximum context length is 163840 tokens. However, you
 *    requested about 236054 tokens …"
 *
 * Fallback numbers are pinned at or below the smallest commonly-routed window
 * for each family, so a slightly stale value under-fills (safe) rather than
 * overflows. Unknown / custom models return Infinity → the caller treats the
 * clamp as a no-op, preserving existing BYOK behavior. Correctness ultimately
 * rests on the context-compression plugin (openrouter.ts), not these numbers.
 */
export function getModelContextWindow(modelId: string): number {
  const live = getCatalogContextWindow(modelId);
  if (live && live > 0) return live;

  const id = modelId.toLowerCase();

  // Gemini 1.5 / 2.x / 3.x — all ≥ 1M.
  // ── Cold-start fallback only ──────────────────────────────────────────────
  // Reached solely until the live catalog warms (~1s after boot) or for a model
  // the catalog doesn't list. Numbers VERIFIED against OpenRouter /api/v1/models
  // on 2026-06-05; where a family spans sizes we pin the conservative (smaller)
  // one so we under-fill rather than overflow, and the catalog corrects upward
  // once warm. The compression plugin (openrouter.ts) is the real guarantee on
  // the chat path, so these don't need to be exact.
  if (id.includes("gemini")) return 1_000_000; // chat Gemini = 1,048,576
  // Claude Opus/Sonnet 4.x, the whole 5.x line (Sonnet 5, Opus 5, Fable 5) and
  // explicit -1m SKUs = 1M; Claude 3/3.5 + Haiku 4.5 = 200K. Matching the tier
  // + major version generically (rather than listing "sonnet-4"/"opus-4") keeps
  // this correct for the next major — the literal list silently demoted
  // claude-sonnet-5/claude-opus-5 to 200K when they shipped on 2026-07-29.
  if (id.includes("claude")) {
    const bigWindow = /claude-(?:sonnet|opus|fable|mythos)-\d/.test(id) && !/claude-(?:sonnet|opus)-3/.test(id);
    return bigWindow || id.includes("-1m") ? 1_000_000 : 200_000;
  }
  // DeepSeek V4 (incl. the platform default v4-flash) = 1,048,576; V3/V3.2 = 131,072.
  if (id.includes("deepseek")) return id.includes("-v4") ? 1_000_000 : 131_072;
  if (id.includes("kimi")) return 262_144; // Kimi K2 = 262,144
  if (id === "z-ai/glm-4.6") return 198_000; // Smallest OpenRouter endpoint, verified 2026-09-15.
  if (id.includes("qwen")) return 262_144; // floor (Qwen 3.5+ are 1M; catalog corrects up)
  if (id.includes("grok")) return 131_072; // floor (Grok 4.x are 1M+; catalog corrects up)
  if (id.includes("gpt-5")) return 256_000; // floor (GPT-5.5 is 1M+; catalog corrects up)
  if (id.includes("gpt-4o") || id.includes("gpt-4.1") || id.includes("gpt-4")) return 128_000;
  if (id.includes("llama") || id.includes("mistral")) return 131_072;

  // Unknown / custom — don't clamp (no-op). Better to preserve BYOK behavior than
  // to wrongly shrink a model whose real window we don't know; on the chat path
  // the compression plugin still guarantees the request fits.
  return Number.POSITIVE_INFINITY;
}

/**
 * Clamp a requested input-context budget so that
 * `input + output (+ headroom)` fits inside the model's real window.
 *
 * `requestedMaxContext` is the per-world / per-user `maxContext` (already
 * clamped to the user's memoryCap). `maxTokens` + `reasoningEffort` are the
 * same values the provider will send, so the output reserve matches reality
 * (reasoning/thinking models count reasoning_tokens against max_tokens — see
 * `effectiveMaxTokens`).
 *
 * `outputReserve` is subtracted as a hard reservation (it's an exact max_tokens
 * we send, not an estimate). The remaining room for input is then discounted by
 * 0.85 to absorb two estimator errors that would otherwise let an "in-budget"
 * prompt still 400:
 *   1. per-message role/JSON framing the char-based estimator ignores, and
 *   2. token-estimate drift — the real upstream count of a Chinese-heavy prompt
 *      ran ~10% above our estimate in prod (the 219,958-vs-~200,000 gap). 0.85
 *      covers ~17% drift, so we stay inside the window with margin to spare.
 *      The cost is mild under-fill (~8K tokens on DeepSeek), which is invisible;
 *      overflow is a hard 400, so we deliberately err conservative.
 */
export function clampMaxContextToModel(
  requestedMaxContext: number,
  modelId: string,
  maxTokens: number | undefined,
  reasoningEffort: string | undefined,
  providerContextWindow?: number,
): number {
  const providerWindow = typeof providerContextWindow === "number" && Number.isFinite(providerContextWindow) && providerContextWindow > 0
    ? providerContextWindow : Number.POSITIVE_INFINITY;
  const window = Math.min(getModelContextWindow(modelId), providerWindow);
  if (!Number.isFinite(window)) return requestedMaxContext; // unknown/custom — no-op

  const outputReserve = effectiveMaxTokens(maxTokens, reasoningEffort);
  const inputCap = Math.max(4096, Math.floor((window - outputReserve) * 0.85));
  if (requestedMaxContext <= inputCap) return requestedMaxContext;

  console.log(
    `[Context] Clamped maxContext ${requestedMaxContext}→${inputCap} for ${modelId} ` +
      `(window ${window}, output reserve ${outputReserve})`,
  );
  return inputCap;
}
