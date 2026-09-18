import type { GenerateParams, LLMProvider, StreamChunk } from "../llm/types.js";

function isRetryableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return /\b5\d{2}\b/.test(msg) || lower.includes("timeout") || lower.includes("timed out")
    || lower.includes("econnreset") || lower.includes("econnrefused") || lower.includes("network");
}

function isRetryableException(err: unknown): boolean {
  if (err instanceof Error) return isRetryableError(err.message);
  return false;
}

/** Retry connection failures only before any chunk has reached the agent. */
export async function* generateStreamWithRetry(
  provider: LLMProvider, params: GenerateParams, maxRetries = 2,
): AsyncGenerator<StreamChunk> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (params.signal?.aborted) return;
    if (attempt > 0) {
      console.warn(`[Agent] LLM retry attempt ${attempt}/${maxRetries}`);
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }

    let isFirstChunk = true;
    let shouldRetry = false;

    try {
      for await (const chunk of provider.generateStream(params)) {
        if (isFirstChunk && chunk.type === "error" && isRetryableError(chunk.content) && attempt < maxRetries) {
          shouldRetry = true;
          break;
        }
        isFirstChunk = false;
        yield chunk;
      }
    } catch (err) {
      if (params.signal?.aborted) return;
      // The agent has already accumulated any yielded text or tool calls. A
      // fresh request here would append a second generation to that partial
      // turn, and completed tool calls could then execute twice.
      if (isFirstChunk && attempt < maxRetries && isRetryableException(err)) {
        shouldRetry = true;
      } else {
        throw err;
      }
    }

    if (!shouldRetry) return;
  }
}
