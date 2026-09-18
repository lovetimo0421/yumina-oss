import type { LLMProvider, GenerateParams, StreamChunk, Model, MessageContent } from "./types.js";
import { LLM_CONNECTION_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MS, LLM_STREAM_INACTIVITY_TIMEOUT_MS } from "./constants.js";
import { clampTemperatureForModel } from "./sampling-limits.js";
import { buildAnthropicThinking, acceptsLegacySamplingParams } from "./anthropic-thinking.js";

const ANTHROPIC_BASE = "https://api.anthropic.com/v1";

/** Legacy Claude 3 SKUs (claude-3-haiku, claude-3-opus, claude-3-sonnet) are
 *  retired on api.anthropic.com direct (and Bedrock/Vertex reject cache_control
 *  for them via OpenRouter). Skip cache annotations to avoid 400s like
 *  `system.N.cache_control: Extra inputs are not permitted`. Matches the bare
 *  Anthropic model ID (with or without date suffix). */
function isLegacyClaude3(bareModel: string): boolean {
  return /^claude-3-(haiku|opus|sonnet)(-\d{8})?$/.test(bareModel);
}

/** Hard cap on `max_tokens` sent to Anthropic. 64K is comfortable for every
 *  current Claude model (Opus/Sonnet/Haiku 4.x), well below their per-request
 *  output ceiling, and matches the OpenRouter path's cap so the two providers
 *  behave consistently for the same user setting. */
const MAX_EFFECTIVE_OUTPUT_TOKENS = 65536;

/** Map reasoning effort to a stand-alone thinking budget. Returns 0 when no
 *  reasoning is requested. Anthropic's `thinking.budget_tokens` must always be
 *  strictly less than `max_tokens`; the caller applies that constraint by
 *  computing `max_tokens = userMax + budget` and trimming the budget down by 1
 *  if needed. */
function reasoningBudget(effort: string | undefined): number {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "medium": return 12288;
    case "high": return 32768;
    case "xhigh": return 65536;
    default: return 0; // unrecognized / undefined / "none"
  }
}

/** Compute the request's max_tokens and thinking.budget_tokens such that the
 *  user-supplied `maxTokens` represents *visible output* and the thinking
 *  budget is added on top (capped by Anthropic's hard limit). Pre-2026-05-16
 *  behavior carved the thinking budget out of the user's `maxTokens`, which on
 *  high-effort runs left almost no room for visible content — the same bug
 *  class as DeepSeek V4 + reasoningEffort=high on the OpenRouter path. */
function resolveTokenBudgets(
  userMax: number | undefined,
  effort: string | undefined,
): { maxTokens: number; thinkingBudget: number } {
  const base = userMax ?? 4096;
  const isThinking = !!effort && effort !== "none";
  const rawBudget = isThinking ? reasoningBudget(effort) : 0;
  const cappedTotal = Math.min(base + rawBudget, MAX_EFFECTIVE_OUTPUT_TOKENS);
  // Preserve `max_tokens > thinking.budget_tokens` per Anthropic's API contract.
  const safeBudget = Math.min(rawBudget, Math.max(0, cappedTotal - 1));
  return { maxTokens: cappedTotal, thinkingBudget: safeBudget };
}

/** Convert OpenAI-format content to Anthropic content blocks */
function toAnthropicContent(content: MessageContent): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;

  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image_url") {
      const url = part.image_url.url;
      // data:image/png;base64,... → extract media_type and data
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return {
          type: "image",
          source: { type: "base64", media_type: match[1], data: match[2] },
        };
      }
      // URL-based image
      return {
        type: "image",
        source: { type: "url", url },
      };
    }
    return { type: "text", text: "" };
  });
}

export class AnthropicProvider implements LLMProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    // Non-streaming branch: see OpenRouterProvider for rationale.
    if (params.stream === false) {
      yield* this.generateNonStream(params);
      return;
    }

    // Strip anthropic/ prefix from model ID
    const model = params.model.replace(/^anthropic\//, "");
    const cacheSupported = !isLegacyClaude3(model);

    // Convert messages: Anthropic uses a single system param (concatenate all system messages)
    const systemParts = params.messages
      .filter((m) => m.role === "system")
      .map((m) => typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("\n"));
    const nonSystemMessages = params.messages.filter((m) => m.role !== "system");

    // Build Anthropic message array with cache breakpoints
    const anthropicMessages = nonSystemMessages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
    if (cacheSupported && params.cacheBreakpoints?.length) {
      // Map breakpoint indices from the full message array to the non-system message array
      const nonSystemIndices = params.messages.reduce<number[]>((acc, m, i) => {
        if (m.role !== "system") acc.push(i);
        return acc;
      }, []);
      for (const bp of params.cacheBreakpoints) {
        const mappedIdx = nonSystemIndices.indexOf(bp);
        if (mappedIdx < 0 || mappedIdx >= anthropicMessages.length) continue;
        const msg = anthropicMessages[mappedIdx]!;
        const content = msg.content;
        if (typeof content === "string") {
          msg.content = [{ type: "text", text: content, cache_control: { type: "ephemeral", ttl: "1h" } }];
        } else if (Array.isArray(content) && content.length > 0) {
          const last = content[content.length - 1] as Record<string, unknown>;
          last.cache_control = { type: "ephemeral", ttl: "1h" };
        }
      }
    }

    const { maxTokens: reqMaxTokens, thinkingBudget } = resolveTokenBudgets(
      params.maxTokens,
      params.reasoningEffort,
    );
    // Claude Opus 4.7+/4.8 and the 5.x line removed the legacy sampling params —
    // sending temperature/top_p/top_k 400s ("`top_p` is deprecated for this
    // model"). Only send them to models that still accept them. See anthropic-thinking.ts.
    const sendSampling = acceptsLegacySamplingParams(model);
    const body: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      max_tokens: reqMaxTokens,
      stream: true,
      ...(sendSampling && {
        temperature: clampTemperatureForModel(params.model, params.temperature),
        ...(params.topP !== undefined && { top_p: params.topP }),
        ...(params.topK !== undefined && params.topK > 0 && { top_k: params.topK }),
      }),
      // Tool use — convert OpenAI-format tool defs to Anthropic format
      ...(params.tools && params.tools.length > 0 && {
        // Tools are static within a session — cache them with a 1h TTL so every iteration
        // after the first gets cache_read pricing on the tool definitions block.
        // Anthropic requires cache_control on the last tool to mark the block boundary.
        tools: params.tools.map((t, i, arr) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
          ...(cacheSupported && i === arr.length - 1 ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
        })),
      }),
      ...(params.toolChoice !== undefined && {
        tool_choice: params.toolChoice === "auto" ? { type: "auto" }
          : params.toolChoice === "required" ? { type: "any" }
          : params.toolChoice === "none" ? { type: "none" }
          : typeof params.toolChoice === "object" ? { type: "tool", name: params.toolChoice.function.name }
          : { type: "auto" },
      }),
      // Reasoning/thinking — model-aware shape: Claude 4.6+/5.x use adaptive +
      // output_config.effort; older models use the legacy enabled+budget_tokens
      // form. Sending the wrong shape 400s. See anthropic-thinking.ts.
      ...buildAnthropicThinking(model, params.reasoningEffort, thinkingBudget),
    };

    if (systemParts.length > 0) {
      // Use content blocks format with cache_control on the last block
      body.system = systemParts.map((text, i) => ({
        type: "text",
        text,
        ...(cacheSupported && i === systemParts.length - 1 && { cache_control: { type: "ephemeral", ttl: "1h" } }),
      }));
    }

    const connAbort = new AbortController();
    const connTimer = setTimeout(() => connAbort.abort(new Error("Connection timeout")), LLM_CONNECTION_TIMEOUT_MS);
    const fetchSignal = params.signal
      ? AbortSignal.any([connAbort.signal, params.signal])
      : connAbort.signal;

    const response = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      signal: fetchSignal,
      body: JSON.stringify(body),
    });

    clearTimeout(connTimer);

    if (!response.ok) {
      const error = await response.text();
      yield { type: "error", content: `Anthropic error (${response.status}): ${error}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", content: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    // Track tool use blocks (Anthropic streams them as content_block_start + input_json_delta)
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>();

    try {
      while (true) {
        if (params.signal?.aborted) return;

        let timeoutId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<{ done: true; value: undefined; timedOut: true }>((resolve) => {
          timeoutId = setTimeout(() => resolve({ done: true, value: undefined, timedOut: true }), LLM_STREAM_INACTIVITY_TIMEOUT_MS);
        });
        const result = await Promise.race([
          reader.read().then((r) => { clearTimeout(timeoutId!); return { ...r, timedOut: false as const }; }),
          timeoutPromise,
        ]);
        if (result.timedOut) {
          console.warn(`[Anthropic] Stream inactivity timeout after ${LLM_STREAM_INACTIVITY_TIMEOUT_MS}ms`);
          yield { type: "error", content: "Stream timed out — the model stopped responding. Try regenerating." };
          return;
        }
        if (result.done) break;

        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          try {
            const parsed = JSON.parse(data);

            // Text content delta
            if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
              yield { type: "text", content: parsed.delta.text };
            }

            // Thinking/reasoning delta
            if (parsed.type === "content_block_delta" && parsed.delta?.type === "thinking_delta") {
              yield { type: "reasoning", content: parsed.delta.thinking };
            }

            // Tool use block start
            if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
              const idx = parsed.index ?? 0;
              toolBlocks.set(idx, {
                id: parsed.content_block.id ?? "",
                name: parsed.content_block.name ?? "",
                args: "",
              });
              yield {
                type: "tool_call_start",
                content: "",
                toolCallIndex: idx,
                toolCallId: parsed.content_block.id ?? "",
                toolCallName: parsed.content_block.name ?? "",
              };
            }

            // Tool use input JSON delta
            if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
              const idx = parsed.index ?? 0;
              const buf = toolBlocks.get(idx);
              if (buf) {
                const partial = parsed.delta.partial_json;
                if (partial != null) buf.args += partial;
                yield {
                  type: "tool_call_delta",
                  content: partial ?? "",
                  toolCallIndex: idx,
                };
              }
            }

            // Content block stop — flush tool call if it was a tool_use block
            if (parsed.type === "content_block_stop") {
              const idx = parsed.index ?? 0;
              const buf = toolBlocks.get(idx);
              if (buf) {
                // Default empty args to "{}" (some providers omit arguments for no-param tools)
                const args = buf.args || "{}";
                yield {
                  type: "tool_call_end",
                  content: "",
                  toolCallIndex: idx,
                  toolCall: {
                    id: buf.id,
                    type: "function",
                    function: { name: buf.name, arguments: args },
                  },
                };
                toolBlocks.delete(idx);
              }
            }

            if (parsed.type === "message_start" && parsed.message?.usage) {
              inputTokens = parsed.message.usage.input_tokens ?? 0;
              // Log cache metrics when available
              const u = parsed.message.usage;
              if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
                console.log(
                  `[Anthropic] Cache: ${u.cache_read_input_tokens ?? 0} read, ${u.cache_creation_input_tokens ?? 0} write, ${u.input_tokens} total prompt tokens (model: ${params.model})`
                );
              }
            }

            if (parsed.type === "message_delta") {
              if (parsed.usage) {
                outputTokens = parsed.usage.output_tokens ?? 0;
              }
              // Capture stop_reason: "end_turn" (normal), "max_tokens" (truncated), "stop_sequence", etc.
              if (parsed.delta?.stop_reason) {
                stopReason = parsed.delta.stop_reason;
              }
            }

            if (parsed.type === "message_stop") {
              yield {
                type: "done",
                content: "",
                stopReason,
                usage: {
                  promptTokens: inputTokens,
                  completionTokens: outputTokens,
                  totalTokens: inputTokens + outputTokens,
                },
              };
              return;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    yield { type: "done", content: "" };
  }

  /** Non-streaming path — mirrors generateStream output. See OpenRouter for details. */
  private async *generateNonStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    const model = params.model.replace(/^anthropic\//, "");
    const cacheSupported = !isLegacyClaude3(model);

    const systemParts = params.messages
      .filter((m) => m.role === "system")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
              .join("\n")
      );
    const nonSystemMessages = params.messages.filter((m) => m.role !== "system");

    const anthropicMessages = nonSystemMessages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
    if (cacheSupported && params.cacheBreakpoints?.length) {
      const nonSystemIndices = params.messages.reduce<number[]>((acc, m, i) => {
        if (m.role !== "system") acc.push(i);
        return acc;
      }, []);
      for (const bp of params.cacheBreakpoints) {
        const mappedIdx = nonSystemIndices.indexOf(bp);
        if (mappedIdx < 0 || mappedIdx >= anthropicMessages.length) continue;
        const msg = anthropicMessages[mappedIdx]!;
        const content = msg.content;
        if (typeof content === "string") {
          msg.content = [{ type: "text", text: content, cache_control: { type: "ephemeral", ttl: "1h" } }];
        } else if (Array.isArray(content) && content.length > 0) {
          const last = content[content.length - 1] as Record<string, unknown>;
          last.cache_control = { type: "ephemeral", ttl: "1h" };
        }
      }
    }

    const { maxTokens: reqMaxTokens, thinkingBudget } = resolveTokenBudgets(
      params.maxTokens,
      params.reasoningEffort,
    );
    // See generateStream — Claude 4.7+/5.x reject legacy sampling params.
    const sendSampling = acceptsLegacySamplingParams(model);
    const body: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      max_tokens: reqMaxTokens,
      stream: false,
      ...(sendSampling && {
        temperature: clampTemperatureForModel(params.model, params.temperature),
        ...(params.topP !== undefined && { top_p: params.topP }),
        ...(params.topK !== undefined && params.topK > 0 && { top_k: params.topK }),
      }),
      ...(params.tools && params.tools.length > 0 && {
        // Tools are static within a session — cache them with a 1h TTL so every iteration
        // after the first gets cache_read pricing on the tool definitions block.
        // Anthropic requires cache_control on the last tool to mark the block boundary.
        tools: params.tools.map((t, i, arr) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
          ...(cacheSupported && i === arr.length - 1 ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
        })),
      }),
      ...(params.toolChoice !== undefined && {
        tool_choice:
          params.toolChoice === "auto" ? { type: "auto" }
          : params.toolChoice === "required" ? { type: "any" }
          : params.toolChoice === "none" ? { type: "none" }
          : typeof params.toolChoice === "object" ? { type: "tool", name: params.toolChoice.function.name }
          : { type: "auto" },
      }),
      // Mirror the streaming path — model-aware thinking shape. See anthropic-thinking.ts.
      ...buildAnthropicThinking(model, params.reasoningEffort, thinkingBudget),
    };

    if (systemParts.length > 0) {
      body.system = systemParts.map((text, i) => ({
        type: "text",
        text,
        ...(cacheSupported && i === systemParts.length - 1 && { cache_control: { type: "ephemeral", ttl: "1h" } }),
      }));
    }

    const connAbort = new AbortController();
    const connTimer = setTimeout(() => connAbort.abort(new Error("Request timeout")), LLM_REQUEST_TIMEOUT_MS);
    const fetchSignal = params.signal
      ? AbortSignal.any([connAbort.signal, params.signal])
      : connAbort.signal;

    let response: Response;
    try {
      response = await fetch(`${ANTHROPIC_BASE}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        signal: fetchSignal,
        body: JSON.stringify(body),
      });
    } catch (err) {
      clearTimeout(connTimer);
      if (params.signal?.aborted) return;
      yield { type: "error", content: `Anthropic request failed: ${(err as Error).message}` };
      return;
    }
    clearTimeout(connTimer);

    if (!response.ok) {
      const error = await response.text().catch(() => "");
      yield { type: "error", content: `Anthropic error (${response.status}): ${error}` };
      return;
    }

    let parsed: {
      content?: Array<
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
      >;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch (err) {
      yield { type: "error", content: `Anthropic: failed to parse response (${(err as Error).message})` };
      return;
    }

    // Log cache metrics
    const u = parsed.usage;
    if (u && (u.cache_read_input_tokens || u.cache_creation_input_tokens)) {
      console.log(
        `[Anthropic] Cache: ${u.cache_read_input_tokens ?? 0} read, ${u.cache_creation_input_tokens ?? 0} write, ${u.input_tokens ?? 0} total prompt tokens (model: ${params.model}, non-stream)`
      );
    }

    // Emit blocks in order: thinking first (reasoning), then text, then tool_use.
    // Anthropic responses can mix these, so walk the array preserving order.
    let toolIdx = 0;
    for (const block of parsed.content ?? []) {
      if (block.type === "text" && block.text.length > 0) {
        yield { type: "text", content: block.text };
      } else if (block.type === "thinking" && block.thinking.length > 0) {
        yield { type: "reasoning", content: block.thinking };
      } else if (block.type === "tool_use") {
        const args = JSON.stringify(block.input ?? {});
        yield {
          type: "tool_call_start",
          content: "",
          toolCallIndex: toolIdx,
          toolCallId: block.id,
          toolCallName: block.name,
        };
        if (args) yield { type: "tool_call_delta", content: args, toolCallIndex: toolIdx };
        yield {
          type: "tool_call_end",
          content: "",
          toolCallIndex: toolIdx,
          toolCall: { id: block.id, type: "function", function: { name: block.name, arguments: args } },
        };
        toolIdx++;
      }
    }

    const inputTokens = u?.input_tokens ?? 0;
    const outputTokens = u?.output_tokens ?? 0;
    yield {
      type: "done",
      content: "",
      stopReason: parsed.stop_reason ?? undefined,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  async listModels(): Promise<Model[]> {
    const response = await fetch(`${ANTHROPIC_BASE}/models?limit=100`, {
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list Anthropic models: ${response.status}`);
    }

    const json = (await response.json()) as {
      data: Array<{
        id: string;
        display_name?: string;
        max_input_tokens?: number;
      }>;
    };

    return json.data
      .filter((m) => m.id.startsWith("claude-"))
      .map((m) => ({
        id: `anthropic/${m.id}`,
        name: m.display_name ?? m.id,
        contextLength: m.max_input_tokens ?? 200_000,
      }));
  }

  async verify(): Promise<boolean> {
    try {
      const response = await fetch(`${ANTHROPIC_BASE}/models`, {
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
