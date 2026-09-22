import { IMAGE_MODEL_CAPABILITIES } from "@yumina/shared";
import type { LLMProvider, GenerateParams, StreamChunk, Model, ChatMessage, ToolCall } from "./types.js";
import { parseUnsupportedParam, stripParamFromBody } from "./param-fallback.js";
import { LLM_CONNECTION_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MS, LLM_STREAM_INACTIVITY_TIMEOUT_MS } from "./constants.js";

const OPENAI_BASE = "https://api.openai.com/v1";

/** o-series reasoning models (o1, o3, o4-mini, …) and the gpt-5 family reject
 *  the legacy `max_tokens` parameter outright as well as the sampling params
 *  (temperature, top_p, frequency_penalty, presence_penalty). They expect
 *  `max_completion_tokens` and run with default sampling. */
function isReasoningModel(id: string): boolean {
  return /^o[1-9]/.test(id) || id.startsWith("gpt-5");
}

/** Build the chat-completion request body for OpenAI. Centralizes the rules
 *  that distinguish reasoning models (o-series, gpt-5) from classic chat
 *  models so the streaming and non-streaming paths stay in sync. */
function buildOpenAIBody(model: string, params: GenerateParams, opts: { stream: boolean }): Record<string, unknown> {
  const reasoning = isReasoningModel(model);
  const body: Record<string, unknown> = {
    model,
    messages: params.messages.map(serializeMessage),
    stream: opts.stream,
    ...(opts.stream && { stream_options: { include_usage: true } }),
  };

  // OpenAI deprecated `max_tokens` in favor of `max_completion_tokens` and
  // newer models reject the legacy name with HTTP 400. The new name works
  // on every current chat model, so always emit it (when defined).
  if (params.maxTokens !== undefined) {
    body.max_completion_tokens = params.maxTokens;
  }

  // Reasoning models reject sampling controls — only set them on classic models.
  if (!reasoning) {
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
    if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  }

  if (params.responseFormat) body.response_format = { type: params.responseFormat.type };
  if (params.tools && params.tools.length > 0) body.tools = params.tools;
  if (params.toolChoice !== undefined) body.tool_choice = params.toolChoice;

  return body;
}

export class OpenAIProvider implements LLMProvider {
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

    // Strip openai/ prefix from model ID
    const model = params.model.replace(/^openai\//, "");

    const connAbort = new AbortController();
    const connTimer = setTimeout(() => connAbort.abort(new Error("Connection timeout")), LLM_CONNECTION_TIMEOUT_MS);
    const fetchSignal = params.signal
      ? AbortSignal.any([connAbort.signal, params.signal])
      : connAbort.signal;

    const response = await postOpenAIWithRetry(
      this.apiKey,
      buildOpenAIBody(model, params, { stream: true }),
      fetchSignal,
      !params.singleAttempt,
    );

    clearTimeout(connTimer);

    if (!response.ok) {
      const error = await response.text();
      yield { type: "error", content: `OpenAI error (${response.status}): ${error}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", content: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

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
          console.warn(`[OpenAI] Stream inactivity timeout after ${LLM_STREAM_INACTIVITY_TIMEOUT_MS}ms for model ${params.model}`);
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
          if (data === "[DONE]") {
            yield* flushToolCalls(toolCallBuffers);
            yield { type: "done", content: "" };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            if (delta?.content) {
              yield { type: "text", content: delta.content };
            }

            // Tool call deltas
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls as Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>) {
                const idx = tc.index;
                if (!toolCallBuffers.has(idx)) {
                  toolCallBuffers.set(idx, {
                    id: tc.id ?? "",
                    name: tc.function?.name ?? "",
                    args: tc.function?.arguments ?? "",
                  });
                  yield {
                    type: "tool_call_start",
                    content: "",
                    toolCallIndex: idx,
                    toolCallId: tc.id ?? "",
                    toolCallName: tc.function?.name ?? "",
                  };
                  // Emit initial args fragment if present (some models send data in the first chunk)
                  if (tc.function?.arguments) {
                    yield {
                      type: "tool_call_delta",
                      content: tc.function.arguments,
                      toolCallIndex: idx,
                    };
                  }
                } else {
                  const buf = toolCallBuffers.get(idx)!;
                  if (tc.id) buf.id = tc.id;
                  if (tc.function?.name) buf.name = tc.function.name;
                  const argChunk = tc.function?.arguments;
                  if (argChunk != null) {
                    buf.args += argChunk;
                    yield {
                      type: "tool_call_delta",
                      content: argChunk,
                      toolCallIndex: idx,
                    };
                  }
                }
              }
            }

            if (choice?.finish_reason === "tool_calls") {
              yield* flushToolCalls(toolCallBuffers);
            }

            if (parsed.usage) {
              yield* flushToolCalls(toolCallBuffers);
              yield {
                type: "done",
                content: "",
                usage: {
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                  totalTokens: parsed.usage.total_tokens,
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

    yield* flushToolCalls(toolCallBuffers);
    yield { type: "done", content: "" };
  }

  /** Non-streaming path — mirrors generateStream output. See OpenRouter for details. */
  private async *generateNonStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    const model = params.model.replace(/^openai\//, "");

    const connAbort = new AbortController();
    const connTimer = setTimeout(() => connAbort.abort(new Error("Request timeout")), LLM_REQUEST_TIMEOUT_MS);
    const fetchSignal = params.signal
      ? AbortSignal.any([connAbort.signal, params.signal])
      : connAbort.signal;

    let response: Response;
    try {
      response = await postOpenAIWithRetry(
        this.apiKey,
        buildOpenAIBody(model, params, { stream: false }),
        fetchSignal,
        !params.singleAttempt,
      );
    } catch (err) {
      clearTimeout(connTimer);
      if (params.signal?.aborted) return;
      yield { type: "error", content: `OpenAI request failed: ${(err as Error).message}` };
      return;
    }
    clearTimeout(connTimer);

    if (!response.ok) {
      const error = await response.text().catch(() => "");
      yield { type: "error", content: `OpenAI error (${response.status}): ${error}` };
      return;
    }

    let parsed: {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch (err) {
      yield { type: "error", content: `OpenAI: failed to parse response (${(err as Error).message})` };
      return;
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      yield { type: "error", content: "OpenAI: empty response (no choices)" };
      return;
    }

    const message = choice.message ?? {};
    const fr = choice.finish_reason ?? null;

    if (typeof message.content === "string" && message.content.length > 0) {
      yield { type: "text", content: message.content };
    }

    if (message.tool_calls?.length) {
      for (let i = 0; i < message.tool_calls.length; i++) {
        const tc = message.tool_calls[i]!;
        const id = tc.id ?? "";
        const name = tc.function?.name ?? "";
        const args = tc.function?.arguments ?? "";
        yield {
          type: "tool_call_start",
          content: "",
          toolCallIndex: i,
          toolCallId: id,
          toolCallName: name,
        };
        if (args) yield { type: "tool_call_delta", content: args, toolCallIndex: i };
        yield {
          type: "tool_call_end",
          content: "",
          toolCallIndex: i,
          toolCall: { id, type: "function", function: { name, arguments: args } },
        };
      }
    }

    const usage = parsed.usage;
    yield {
      type: "done",
      content: "",
      stopReason: fr === "length" ? "max_tokens" : fr ?? undefined,
      ...(usage && {
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        },
      }),
    };
  }

  async listModels(): Promise<Model[]> {
    const response = await fetch(`${OPENAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }

    const json = (await response.json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };

    // Exclude non-chat models (image gen, audio, embeddings, moderation, etc.)
    const EXCLUDED_PREFIXES = [
      "gpt-image-", "gpt-realtime-", "gpt-audio-", "gpt-oss-",
      "tts-", "whisper-", "dall-e-", "text-embedding-", "text-moderation-",
      "omni-moderation-", "sora-", "codex-",
      "o3-deep-research", "o4-mini-deep-research",
    ];

    const chatModels = json.data
      .filter((m) => {
        if (EXCLUDED_PREFIXES.some((p) => m.id.startsWith(p))) return false;
        // Include gpt-*, chatgpt-*, and o-series reasoning models (o1, o3, o4-mini, etc.)
        return m.id.startsWith("gpt-") || m.id.startsWith("chatgpt-") || /^o[1-9]/.test(m.id);
      })
      .map((m) => ({
        id: `openai/${m.id}`,
        supportsImages: IMAGE_MODEL_CAPABILITIES[`openai/${m.id}`],
        name: m.id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        contextLength: inferOpenAIContext(m.id),
      }));

    return chatModels;
  }

  async verify(): Promise<boolean> {
    try {
      const response = await fetch(`${OPENAI_BASE}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ── Helpers ──

/** Infer context window size from model ID (OpenAI /v1/models doesn't include this). */
function inferOpenAIContext(id: string): number {
  if (id.startsWith("gpt-5.4") || id.startsWith("gpt-4.1")) return 1_048_576;
  if (id.startsWith("gpt-5")) return 400_000;
  if (/^o[1-9]/.test(id)) return 200_000;
  if (id.includes("gpt-4o")) return 128_000;
  return 128_000; // safe default
}

function serializeMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  if (m.role === "assistant" && "tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) {
    return { role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls };
  }
  return { role: m.role, content: m.content };
}

function* flushToolCalls(
  buffers: Map<number, { id: string; name: string; args: string }>
): Generator<StreamChunk> {
  for (const [idx, buf] of buffers) {
    // Default empty args to "{}" (some providers omit arguments for no-param tools)
    const args = buf.args || "{}";
    const toolCall: ToolCall = {
      id: buf.id,
      type: "function",
      function: { name: buf.name, arguments: args },
    };
    yield {
      type: "tool_call_end",
      content: "",
      toolCallIndex: idx,
      toolCall,
    };
  }
  buffers.clear();
}

/** POST to OpenAI chat-completions and, on a recognizable 400 "unsupported
 *  parameter" error, strip that parameter and retry exactly once. Subsequent
 *  failures bubble up unchanged. Mirrors the same logic in CustomProvider. */
async function postOpenAIWithRetry(
  apiKey: string,
  initialBody: Record<string, unknown>,
  signal: AbortSignal,
  allowRetry: boolean,
): Promise<Response> {
  const url = `${OPENAI_BASE}/chat/completions`;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  let body = initialBody;
  let response = await fetch(url, { method: "POST", headers, signal, body: JSON.stringify(body) });
  if (response.ok || response.status !== 400 || !allowRetry) return response;

  const errorText = await response.text().catch(() => "");
  const errorShim = () => new Response(errorText, { status: response.status, statusText: response.statusText });

  const offendingParam = parseUnsupportedParam(errorText);
  if (!offendingParam) return errorShim();
  const retryBody = stripParamFromBody(body, offendingParam);
  if (!retryBody) return errorShim();

  console.warn(`[OpenAI] Upstream rejected param '${offendingParam}'. Retrying once without it. Excerpt: ${errorText.slice(0, 200)}`);
  body = retryBody;
  return fetch(url, { method: "POST", headers, signal, body: JSON.stringify(body) });
}
