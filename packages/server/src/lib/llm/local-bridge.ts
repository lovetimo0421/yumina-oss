/**
 * Provider that runs a turn on the player's OWN computer.
 *
 * It makes no outbound request. `generateStream` hands the assembled prompt to
 * the local-bridge hub, which routes it through the player's browser to a model
 * running on their machine (Ollama / LM Studio / Jan / llama.cpp — anything
 * speaking the OpenAI chat-completions shape) and streams the tokens back.
 *
 * Being a plain LLMProvider is the whole point: the four turn pipelines in
 * messages.ts (send / regenerate / continue / swipe) already know how to
 * consume one, so none of them need to learn that this model lives somewhere
 * else entirely.
 *
 * Model ids are `local/<runtime-model-id>` — e.g. `local/qwen3.8:27b`.
 */

import type { LLMProvider, GenerateParams, StreamChunk, Model, MessageContent } from "./types.js";
import {
  dispatchJob,
  getAdvertisedModels,
  hasLocalConnection,
  NoLocalBridgeError,
  type BridgeJobPayload,
} from "../local-bridge/registry.js";

/**
 * Context window we ask the local runtime for when we can't learn its real one.
 *
 * Deliberately NOT the model's advertised maximum. A 27B at 4-bit fills a 24GB
 * card at ~18GB, and the KV cache for the remaining headroom is what decides
 * how much context actually fits — asking for 256k on a card that can seat 32k
 * makes the runtime either refuse to load or spill to system RAM and crawl.
 * 32k matches what current Ollama picks for itself and comfortably holds the
 * prompts our cards actually produce (measured p-heavy card: ~19k).
 */
export const DEFAULT_LOCAL_CONTEXT = 32_768;

/**
 * Output reservation for a local turn.
 *
 * The platform default is 12,000 — sized for a 200K hosted window, where it
 * costs 6% of the budget. Against 32K it costs 37%, and on a card whose system
 * prefix is already ~17K that leaves nothing for chat history: the trimmer ate
 * the entire transcript INCLUDING the player's own message, and the runtime
 * refused a prompt with no user turn in it. Measured local replies run 400–900
 * tokens, so 2K is roomy and buys back ~8K of context.
 */
export const LOCAL_MAX_OUTPUT_TOKENS = 2048;

/** Local windows are small; never reserve more of one than a reply can use. */
export function clampLocalMaxTokens(maxTokens: number | undefined): number {
  if (maxTokens === undefined) return LOCAL_MAX_OUTPUT_TOKENS;
  return Math.min(maxTokens, LOCAL_MAX_OUTPUT_TOKENS);
}

/** Strip our routing prefix — the local runtime knows the model by its own name. */
export function toRuntimeModelId(modelId: string): string {
  return modelId.replace(/^local\//, "");
}

/** Content parts survive as-is; the browser hands them to an OpenAI-shaped endpoint. */
function toWireContent(content: MessageContent): unknown {
  return content;
}

function flattenText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * Make the prompt end on a user turn.
 *
 * Our pipeline appends the `<game-state>` block, post-history entries and the
 * anti-repetition note as system messages AFTER the player's message — on
 * purpose, so the "update what changed" nudge sits where the model's recall is
 * strongest. Hosted APIs accept that shape. Local chat templates often don't:
 * Qwen's rejects the whole request with "no user query found in messages"
 * because the conversation, as far as the template can tell, ends on system.
 *
 * So fold that trailing run into the player's message instead of moving it.
 * The obvious alternative — the existing `semi` post-processing — hoists every
 * system message to the front, which would drag the state block thousands of
 * tokens away from the generation point and undo the very thing it was placed
 * there to fix.
 */
export function foldTrailingSystemIntoUser(messages: GenerateParams["messages"]): GenerateParams["messages"] {
  let lastNonSystem = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== "system") {
      lastNonSystem = i;
      break;
    }
  }

  // Already ends on a user/assistant turn — nothing to do.
  if (lastNonSystem === messages.length - 1) return messages;

  const trailing = messages
    .slice(lastNonSystem + 1)
    .map((m) => flattenText(m.content as MessageContent))
    .filter((t) => t.length > 0)
    .join("\n\n");

  const head = messages.slice(0, lastNonSystem + 1);
  const anchor = lastNonSystem >= 0 ? head[lastNonSystem]! : null;

  // Nothing but system messages (a greeting-only turn): the trailing text has
  // to become the user turn itself or the template has nothing to answer.
  if (!anchor) {
    return [{ role: "user", content: trailing }];
  }

  // Append after an assistant turn as its own user message rather than editing
  // the assistant's words — continue-mode replays that reply verbatim.
  if (anchor.role !== "user") {
    return trailing ? [...head, { role: "user", content: trailing }] : head;
  }

  const merged = [...head];
  merged[lastNonSystem] = {
    role: "user",
    content: trailing ? `${flattenText(anchor.content as MessageContent)}\n\n${trailing}` : anchor.content,
  } as GenerateParams["messages"][number];
  return merged;
}

export class LocalBridgeProvider implements LLMProvider {
  constructor(private readonly userId: string) {}

  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    const payload: BridgeJobPayload = {
      model: toRuntimeModelId(params.model),
      messages: foldTrailingSystemIntoUser(params.messages).map((m) => ({
        role: m.role,
        content: toWireContent("content" in m ? (m.content as MessageContent) : ""),
      })),
      num_ctx: DEFAULT_LOCAL_CONTEXT,
      max_tokens: clampLocalMaxTokens(params.maxTokens),
      ...(params.responseFormat && { response_format: params.responseFormat }),
      // Write, don't think. Qwen 3.5 (the 4b/9b we recommend) reasons first and,
      // on a roleplay turn, keeps going: measured on a 24 GB card it spent the
      // whole 2048-token budget thinking (~5,700 chars) and returned no reply at
      // all; given 8192 it thought 8,000 chars and the player waited 33s for the
      // first word. With thinking off the same models answer as soon as they're
      // loaded, and the prose held up. The trade-off: thinking made small models
      // likelier to emit state directives — a reply that never arrives is worse.
      think: false,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.topP !== undefined && { top_p: params.topP }),
      ...(params.topK !== undefined && params.topK > 0 && { top_k: params.topK }),
      ...(params.minP !== undefined && params.minP > 0 && { min_p: params.minP }),
      ...(params.frequencyPenalty !== undefined && { frequency_penalty: params.frequencyPenalty }),
      ...(params.presencePenalty !== undefined && { presence_penalty: params.presencePenalty }),
    };

    let completionChars = 0;

    try {
      for await (const event of dispatchJob(this.userId, payload, params.signal)) {
        if (event.kind === "chunk") {
          completionChars += event.delta.length;
          yield { type: "text", content: event.delta };
        } else if (event.kind === "error") {
          yield { type: "error", content: event.message };
          return;
        } else {
          yield {
            type: "done",
            content: "",
            model: params.model,
            ...(event.stopReason && { stopReason: event.stopReason }),
            // A local turn costs nothing, but the pipeline logs usage for every
            // turn. Report what the runtime told us; fall back to a character
            // estimate so the memory/compaction logic still sees a real number.
            usage: {
              promptTokens: event.usage?.promptTokens ?? 0,
              completionTokens: event.usage?.completionTokens ?? Math.ceil(completionChars / 4),
              totalTokens:
                (event.usage?.promptTokens ?? 0) +
                (event.usage?.completionTokens ?? Math.ceil(completionChars / 4)),
              providerCostUsd: 0,
            },
          };
          return;
        }
      }
    } catch (err) {
      if (err instanceof NoLocalBridgeError) {
        yield { type: "error", content: err.message };
        return;
      }
      throw err;
    }
  }

  async listModels(): Promise<Model[]> {
    const advertised = await getAdvertisedModels(this.userId);
    return advertised.map((m) => ({
      id: `local/${m.id}`,
      name: m.name ?? m.id,
      contextLength: m.contextLength ?? DEFAULT_LOCAL_CONTEXT,
      pricing: { prompt: 0, completion: 0 },
      provider: "local",
    }));
  }

  async verify(): Promise<boolean> {
    return hasLocalConnection(this.userId);
  }
}
