import type { ChatMessage, ToolDefinition } from "./llm/types.js";
import type { ModelPriceEntry } from "./model-price-cache.js";

const MINIMUM_OUTPUT_TOKENS = 1024;
const DEFAULT_OUTPUT_TOKENS = 8192;
const MAXIMUM_OUTPUT_TOKENS = 64000;

export type StudioCreditBudget = {
  estimatedPromptTokens: number;
  minimumRequiredCredits: number;
} & ({
  ok: true;
  maxTokens: number;
  reservationCredits: number;
} | {
  ok: false;
  reason: "pricing_unavailable" | "insufficient_credits" | "output_limit_too_small";
});

/** Estimate serialized text conservatively without a model-specific tokenizer:
 * ASCII uses 3 chars/token, non-ASCII uses 1.5 tokens/code point. Add envelope
 * and tokenizer headroom below. Images get a separate allowance instead of
 * treating a long URL/base64 encoding as prompt text. This is an estimate,
 * not a guarantee against provider-specific image/reasoning/cache charges. */
function textTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) char.codePointAt(0)! < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 3 + other * 1.5);
}

export function estimateStudioPromptTokens(messages: readonly ChatMessage[], tools: readonly ToolDefinition[] = []): number {
  let total = 64;
  for (const message of messages) {
    total += 24;
    if (typeof message.content === "string") total += textTokens(message.content);
    else for (const part of message.content) total += part.type === "text" ? textTokens(part.text) : 4096;
    if ("tool_calls" in message && message.tool_calls) total += textTokens(JSON.stringify(message.tool_calls));
    if ("reasoning_content" in message && message.reasoning_content) total += textTokens(message.reasoning_content);
    if ("tool_call_id" in message) total += textTokens(message.tool_call_id);
  }
  if (tools.length) total += textTokens(JSON.stringify(tools)) + 32;
  return Math.ceil(total * 1.2);
}

/** Per-generation allowance: pay for the actual assembled context/tools and a
 * useful bounded output, not the historical 64K ceiling. Last-turn usage may
 * raise the desired allowance for a larger job. Completion caps include hidden
 * reasoning where the provider honors max_tokens that way; actual usage remains
 * authoritative and any shortfall must pause before applying generated writes. */
export function planStudioCreditBudget(input: {
  messages: readonly ChatMessage[];
  tools?: readonly ToolDefinition[];
  price: ModelPriceEntry | null;
  availableCredits: number;
  maxOutputTokens?: number;
  desiredOutputTokens?: number;
  previousCompletionTokens?: number;
}): StudioCreditBudget {
  const estimatedPromptTokens = estimateStudioPromptTokens(input.messages, input.tools);
  const unavailable: StudioCreditBudget = { ok: false, reason: "pricing_unavailable", estimatedPromptTokens, minimumRequiredCredits: 0 };
  const price = input.price;
  if (!price) return unavailable;
  const aboveThreshold = price.contextThreshold != null && estimatedPromptTokens > price.contextThreshold;
  const inputRate = aboveThreshold ? price.inputPriceAboveThreshold ?? price.inputPricePerM : price.inputPricePerM;
  const outputRate = aboveThreshold ? price.outputPriceAboveThreshold ?? price.outputPricePerM : price.outputPricePerM;
  const markup = price.markupMultiplier ?? 1;
  if (![inputRate, outputRate, markup].every((n) => Number.isFinite(n) && n >= 0)) return unavailable;
  const validLimit = (value: number | undefined, fallback: number) => value === undefined ? fallback
    : Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const ceiling = Math.min(MAXIMUM_OUTPUT_TOKENS, validLimit(input.maxOutputTokens, MAXIMUM_OUTPUT_TOKENS));
  const previous = validLimit(input.previousCompletionTokens, 0);
  const desired = Math.min(ceiling, Math.max(MINIMUM_OUTPUT_TOKENS,
    validLimit(input.desiredOutputTokens, Math.max(DEFAULT_OUTPUT_TOKENS, Math.ceil(previous * 1.35 / 1024) * 1024))));
  // The agent sends Anthropic 1-hour cache writes, whose cold input can cost
  // twice the ordinary input rate. Do not assume a cache hit at preflight.
  const cacheWriteFactor = price.modelId.toLowerCase().includes("claude") ? 2 : 1;
  const inputCredits = estimatedPromptTokens * inputRate * markup * cacheWriteFactor / 1000;
  if (!Number.isFinite(inputCredits) || !Number.isFinite(outputRate * markup * MAXIMUM_OUTPUT_TOKENS)) return unavailable;
  const cost = (outputTokens: number) => Math.ceil((inputCredits + outputTokens * outputRate * markup / 1000) * 10) / 10;
  const minimumRequiredCredits = cost(MINIMUM_OUTPUT_TOKENS);
  if (ceiling < MINIMUM_OUTPUT_TOKENS) return { ok: false, reason: "output_limit_too_small", estimatedPromptTokens, minimumRequiredCredits };
  const available = Number.isFinite(input.availableCredits) ? Math.max(0, input.availableCredits) : 0;
  if (minimumRequiredCredits > available) return { ok: false, reason: "insufficient_credits", estimatedPromptTokens, minimumRequiredCredits };
  // Binary search includes upward currency rounding. It cannot return a cap
  // whose reservation costs more than the spendable balance.
  let low = MINIMUM_OUTPUT_TOKENS;
  let high = desired;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (cost(middle) <= available) low = middle;
    else high = middle - 1;
  }
  return { ok: true, maxTokens: low, reservationCredits: cost(low), estimatedPromptTokens, minimumRequiredCredits };
}
