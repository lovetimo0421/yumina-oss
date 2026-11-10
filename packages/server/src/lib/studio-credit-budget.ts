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

/** No headroom factor: this feeds a price shown as a minimum, and the raw
 *  char estimate already runs a little above what providers count. */
export function estimateStudioSystemTokens(text: string): number {
  return textTokens(text);
}

/** Claude input multipliers for the agent's cache layout: the static system
 *  block (behind the tools) is a 1h cache — written at 2×, read at 0.1×; the
 *  world block and conversation after it are 5m writes at 1.25×. */
const CACHE_READ = 0.1;
const CACHE_WRITE_1H = 2;
const CACHE_WRITE_5M = 1.25;

/** The least one assistant turn can cost: a single model call over the
 *  current system prompt + history with the minimum output. A turn that uses
 *  tools makes more calls, so this is a floor, never a quote. Claude's static
 *  block is a cache read when a run touched this card within the hour. */
export function estimateStudioTurnFloorCredits(input: {
  /** The static system block (1h cache). */
  systemTokens: number;
  /** The world block (5m cache); 0 when it is counted in systemTokens. */
  worldTokens?: number;
  conversationTokens: number;
  price: ModelPriceEntry | null;
  warmCache: boolean;
}): number | null {
  const price = input.price;
  if (!price) return null;
  const markup = price.markupMultiplier ?? 1;
  const worldTokens = input.worldTokens ?? 0;
  const promptTokens = input.systemTokens + worldTokens + input.conversationTokens;
  const aboveThreshold = price.contextThreshold != null && promptTokens > price.contextThreshold;
  const inputRate = aboveThreshold ? price.inputPriceAboveThreshold ?? price.inputPricePerM : price.inputPricePerM;
  const outputRate = aboveThreshold ? price.outputPriceAboveThreshold ?? price.outputPricePerM : price.outputPricePerM;
  if (![inputRate, outputRate, markup].every((n) => Number.isFinite(n) && n >= 0)) return null;
  const claude = price.modelId.toLowerCase().includes("claude");
  const systemFactor = claude ? (input.warmCache ? CACHE_READ : CACHE_WRITE_1H) : 1;
  const inputTokens = input.systemTokens * systemFactor + worldTokens * (claude ? CACHE_WRITE_5M : 1) + input.conversationTokens;
  return Math.ceil((inputTokens * inputRate + MINIMUM_OUTPUT_TOKENS * outputRate) * markup / 1000);
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
  /** Leading prompt tokens on the 1h cache (tools + static system block). */
  cachePrefixTokens?: number;
  /** Whether that prefix was sent within the hour, so this call reads it. */
  cachePrefixWarm?: boolean;
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
  // Claude input is billed as cache traffic: the 1h prefix is a read inside
  // the hour and a 2× write otherwise; everything after it is a 1.25× 5m write
  // (assumed missed, though a call minutes after the last one mostly reads it).
  // Pricing every token as a cold 1h write paused 167 of 187 Sonnet runs that
  // could afford the next step.
  const claude = price.modelId.toLowerCase().includes("claude");
  const prefix = claude ? Math.min(estimatedPromptTokens, validLimit(input.cachePrefixTokens, 0)) : 0;
  const prefixFactor = input.cachePrefixWarm ? CACHE_READ : CACHE_WRITE_1H;
  const inputCredits = (prefix * prefixFactor + (estimatedPromptTokens - prefix) * (claude ? CACHE_WRITE_5M : 1)) * inputRate * markup / 1000;
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

/** Providers whose prompt caching the agent's calls hit: a job's repeated
 *  prefix costs a fraction of list price there. Measured on approved jobs since
 *  9/30, input cost ran 0.13-0.16 of list on Claude and OpenAI models, 0.25 on
 *  GLM. Anything else is priced uncached. */
const CACHING_PROVIDERS = /^(anthropic|openai|google|deepseek|z-ai|moonshotai|x-ai|minimax|qwen)\//;

/** Roughly what a whole job costs and takes, for the one sentence the creator
 *  sees before starting it. Calibrated on the 53 approved jobs since 9/30 that
 *  had usage: about two model calls per planned step; each call re-reads the
 *  cached prompt (≈15% of list price) plus ~3K new tokens, and writes ~2.3K
 *  tokens on Claude, ~1K elsewhere. The old three-calls-at-list-price model
 *  overestimated by a median 7.5× (Luna 16×, Sonnet 2.6×); this one lands at
 *  1.0× with half the jobs between 0.67× and 1.6×, so the creator sees a range.
 *  A guide, not a quote. */
export function estimateAgentJob(input: {
  steps: number;
  systemTokens: number;
  conversationTokens: number;
  /** null when the creator's own key pays: there is no mushroom cost to show. */
  price: ModelPriceEntry | null;
}): { minutes: number; mushies: number | null; mushiesRange?: [number, number] } {
  const steps = Math.max(1, Math.round(input.steps));
  const minutes = Math.min(120, Math.max(2, Math.round(steps * 1.5)));
  const price = input.price;
  if (!price) return { minutes, mushies: null };
  const id = price.modelId.toLowerCase();
  const claude = id.includes("claude");
  const cached = CACHING_PROVIDERS.test(id);
  const calls = Math.max(2, steps * 2);
  const newTokens = 3_000;
  const replyTokens = claude ? 2_300 : 1_000;
  const markup = price.markupMultiplier ?? 1;
  let credits = 0;
  for (let call = 0; call < calls; call++) {
    const promptTokens = input.systemTokens + input.conversationTokens + call * newTokens;
    const aboveThreshold = price.contextThreshold != null && promptTokens > price.contextThreshold;
    const inputRate = aboveThreshold ? price.inputPriceAboveThreshold ?? price.inputPricePerM : price.inputPricePerM;
    const outputRate = aboveThreshold ? price.outputPriceAboveThreshold ?? price.outputPricePerM : price.outputPricePerM;
    if (![inputRate, outputRate, markup].every((n) => Number.isFinite(n) && n >= 0)) return { minutes, mushies: null };
    const inputTokens = cached ? promptTokens * 0.15 + newTokens * (claude ? 1.25 : 1) : promptTokens;
    credits += (inputTokens * inputRate + replyTokens * outputRate) * markup / 1000;
  }
  // Rounded so it reads as an estimate, not a price.
  const round = (value: number) => value < 20 ? Math.max(1, Math.ceil(value)) : Math.ceil(value / 10) * 10;
  return { minutes, mushies: round(credits), mushiesRange: [round(credits * 0.6), round(credits * 1.7)] };
}
