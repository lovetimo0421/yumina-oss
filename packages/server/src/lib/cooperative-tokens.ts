import { setImmediate } from "node:timers/promises";
import { estimateTokens } from "@yumina/engine";

/** Let sockets/timers run between CPU batches; promises alone only yield to
 * microtasks and still starve HTTP. Individual tokenizer pieces are bounded
 * by the engine; this bounds uninterrupted work over many messages. */
export async function forEachCooperatively<T>(items: readonly T[], visit: (item: T) => void): Promise<void> {
  let deadline = performance.now() + 8;
  for (const item of items) {
    visit(item);
    if (performance.now() >= deadline) {
      await setImmediate();
      deadline = performance.now() + 8;
    }
  }
}

/** Exact sum when under budget. For an overflow decision, stop as soon as
 * the threshold is crossed instead of tokenizing thousands of older rows. */
export async function countPromptTokensCooperatively(
  messages: readonly { content: string }[], modelId: string, stopAfter = Infinity,
): Promise<number> {
  let tokens = 0;
  let deadline = performance.now() + 8;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += estimateTokens(messages[i]!.content, modelId);
    if (tokens > stopAfter) break;
    if (performance.now() >= deadline) {
      await setImmediate();
      deadline = performance.now() + 8;
    }
  }
  return tokens;
}
