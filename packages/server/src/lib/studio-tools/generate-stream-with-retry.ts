import type { ChatMessage, GenerateParams, LLMProvider, StreamChunk } from "../llm/types.js";

function isRetryableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return /\b5\d{2}\b/.test(msg) || lower.includes("timeout") || lower.includes("timed out")
    || lower.includes("econnreset") || lower.includes("econnrefused") || lower.includes("network");
}

function isRetryableException(err: unknown): boolean {
  if (err instanceof Error) return isRetryableError(err.message);
  return false;
}

/** A rate limit (429) is worth one wait-and-retry inside the run, unless it is
 *  a daily quota or asks for a wait longer than a creator would sit through. */
const MAX_RATE_LIMIT_WAIT_MS = 20_000;
function rateLimitWaitMs(chunk: StreamChunk): number | null {
  if (!/\b429\b/.test(chunk.content) || /per-day|daily/i.test(chunk.content)) return null;
  const wait = chunk.retryAfterMs ?? 3000;
  return wait <= MAX_RATE_LIMIT_WAIT_MS ? wait : null;
}

/** Below this an affordable cap is not worth a turn: the reply would be cut off anyway. */
const MIN_AFFORDABLE_TOKENS = 2048;
const IMAGE_OMITTED_NOTE = "[An image was attached here, but the selected model cannot see images, so it was left out. If it matters, tell the creator to switch to a model with image input.]";

/**
 * A request the provider refused for something this call can change, rewritten
 * so the same turn goes through; null when it cannot be. Both refusals arrive
 * before any output, so the retry never mixes two generations.
 *
 *  - A text-only model was sent an image (the creator's attachment, or a
 *    screenshot a tool returned): OpenRouter answers 404 "No endpoints found
 *    that support image input". The images become a note the model can relay.
 *  - A BYOK OpenRouter key whose balance cannot cover the 64K output ceiling:
 *    402 "…can only afford N". The cap drops to what the key can pay for.
 */
export function adjustRefusedRequest(msg: string, params: GenerateParams): GenerateParams | null {
  if (/support image input/i.test(msg) && hasImages(params.messages)) {
    return { ...params, messages: params.messages.map(withoutImages) };
  }
  // Reasoning models that fix sampling ("invalid temperature: only 1 is
  // allowed for this model"): send what they accept.
  if (/temperature/i.test(msg) && /only 1|must be 1|unsupported|not supported/i.test(msg) && params.temperature !== undefined && params.temperature !== 1) {
    return { ...params, temperature: 1 };
  }
  const afford = /can only afford (\d+)/i.exec(msg);
  if (afford) {
    const tokens = Math.floor(Number(afford[1]) * 0.9);
    if (tokens >= MIN_AFFORDABLE_TOKENS && tokens < (params.maxTokens ?? Infinity)) return { ...params, maxTokens: tokens };
  }
  return null;
}

function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
}

function withoutImages(message: ChatMessage): ChatMessage {
  if (!Array.isArray(message.content) || !message.content.some((p) => p.type === "image_url")) return message;
  const content = message.content.filter((p) => p.type !== "image_url");
  content.push({ type: "text", text: IMAGE_OMITTED_NOTE });
  return { ...message, content } as ChatMessage;
}

/** Retry connection failures only before any chunk has reached the agent. */
export async function* generateStreamWithRetry(
  provider: LLMProvider, params: GenerateParams, maxRetries = 2,
): AsyncGenerator<StreamChunk> {
  // One rewrite per call: a second refusal of the rewritten request is final.
  let adjusted = false;
  // One rate-limit wait per call; 429s used to end the run with a provider error.
  let rateLimitWait: number | null = null;
  let waitedForRateLimit = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (params.signal?.aborted) return;
    if (rateLimitWait != null) {
      console.warn(`[Agent] rate limited; retrying in ${rateLimitWait}ms`);
      await new Promise((r) => setTimeout(r, rateLimitWait!));
      rateLimitWait = null;
    } else if (attempt > 0) {
      console.warn(`[Agent] LLM retry attempt ${attempt}/${maxRetries}`);
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }

    let isFirstChunk = true;
    let shouldRetry = false;
    let next: GenerateParams | null = null;

    try {
      for await (const chunk of provider.generateStream(params)) {
        if (isFirstChunk && chunk.type === "error") {
          next = adjusted ? null : adjustRefusedRequest(chunk.content, params);
          if (next) break;
          const wait = waitedForRateLimit ? null : rateLimitWaitMs(chunk);
          if (wait != null) {
            rateLimitWait = wait;
            waitedForRateLimit = true;
            shouldRetry = true;
            break;
          }
          if (isRetryableError(chunk.content) && attempt < maxRetries) {
            shouldRetry = true;
            break;
          }
        }
        isFirstChunk = false;
        yield chunk;
      }
    } catch (err) {
      if (params.signal?.aborted) return;
      // The agent has already accumulated any yielded text or tool calls. A
      // fresh request here would append a second generation to that partial
      // turn, and completed tool calls could then execute twice.
      next = isFirstChunk && !adjusted && err instanceof Error ? adjustRefusedRequest(err.message, params) : null;
      if (next) {
        // handled below
      } else if (isFirstChunk && attempt < maxRetries && isRetryableException(err)) {
        shouldRetry = true;
      } else {
        throw err;
      }
    }

    if (next) {
      console.warn(`[Agent] provider refused the request; retrying it rewritten (${next.maxTokens !== params.maxTokens ? `maxTokens ${next.maxTokens}` : "images left out"})`);
      params = next;
      adjusted = true;
      attempt--; // a rewrite is not a connection retry
      continue;
    }
    if (!shouldRetry) return;
    if (rateLimitWait != null) attempt--; // a rate-limit wait is not a connection retry
  }
}
