import { PUBLIC_ORIGIN } from "../env.js";
import { createHash, randomUUID } from "node:crypto";
import type { LLMProvider, GenerateParams, StreamChunk, Model, ChatMessage, ToolCall } from "./types.js";
import type { ApiKeyMetadata } from "@yumina/shared";
import { validateCustomEndpointUrl } from "../ssrf.js";
import { applyPromptPostProcessing } from "./post-process.js";
import { parseUnsupportedParam, stripParamFromBody, looksLikeReasoningModel } from "./param-fallback.js";
import { localGenerationTimeoutMs, readLocalStream } from "./local-timeout.js";

// Account caps must never enter the global model catalog: two users can have
// different Featherless plans for the same model. Keys are opaque hashes.
const contextWindows = new Map<string, { expiresAt: number; value: Promise<number | undefined> }>();

/**
 * Provider for user-configured OpenAI-compatible endpoints (third-party proxies,
 * self-hosted LiteLLM gateways, etc). Same request shape as OpenAIProvider but
 * with configurable base URL, permissive /models handling, and a two-step verify
 * fallback. Optional ApiKeyMetadata controls per-profile request shaping
 * (extra body fields, header injection, role-alternation post-processing).
 */
export class CustomProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private metadata: ApiKeyMetadata;

  constructor(apiKey: string, baseUrl: string, metadata?: ApiKeyMetadata | null) {
    this.apiKey = apiKey;
    // SSRF-safe validation; throws on disallowed URLs (metadata endpoints, private IPs, etc.)
    this.baseUrl = validateCustomEndpointUrl(baseUrl);
    this.metadata = metadata ?? {};
  }

  async getContextWindow(): Promise<number | undefined> {
    const endpoint = new URL(this.baseUrl);
    if (endpoint.hostname !== "api.featherless.ai" || endpoint.pathname !== "/v1") return undefined;
    const cacheKey = createHash("sha256").update(`${this.baseUrl}:${this.apiKey}`).digest("hex");
    const cached = contextWindows.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    // Coalesce concurrent requests and bound memory across accounts.
    if (contextWindows.size >= 256) contextWindows.delete(contextWindows.keys().next().value!);
    const entry = { expiresAt: Date.now() + 15_000, value: Promise.resolve<number | undefined>(undefined) };
    entry.value = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/plan`, {
          headers: this.buildHeaders({ contentType: false }),
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return undefined;
        const plan = await response.json() as { max_context_length?: unknown };
        const limit = plan?.max_context_length;
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 512 || limit > 2_000_000) return undefined;
        entry.expiresAt = Date.now() + 5 * 60_000;
        return limit;
      } catch {
        // Discovery failure must not prevent a valid chat request. A subsequent
        // streamed refusal still carries the provider's actual explanation.
        return undefined;
      }
    })();
    contextWindows.set(cacheKey, entry);
    return entry.value;
  }

  /**
   * Public streaming entry. Wraps `streamOnce` with retries mirroring
   * OpenRouterProvider.generateStream: reasoning models routed through
   * user-configured proxies regularly burn the whole completion budget on
   * `reasoning_content` and finish with empty `content` (the "空回" community
   * reports — upstream bills tokens, Yumina shows nothing). A fresh attempt
   * recovers most of these, same as the ~87% manual-regenerate recovery rate
   * measured for OpenRouter reasoners. Retries only fire before any visible
   * output, so they can never duplicate streamed text.
   */
  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    // Allocate once before retrying; chat callers supply a persistent identity.
    params = { ...params, conversationId: params.conversationId || randomUUID() };
    const MAX_RETRIES = params.singleAttempt ? 0 : 2;
    let lastError: StreamChunk | null = null;
    let lastDone: StreamChunk | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (params.signal?.aborted) return;

      let visibleYielded = false;
      let errorChunk: StreamChunk | null = null;
      let doneChunk: StreamChunk | null = null;

      for await (const chunk of this.streamOnce(params)) {
        if (chunk.type === "error") {
          const nonRetryable = !/^Custom endpoint error \((500|502|503)\):/.test(chunk.content);
          if (!visibleYielded && attempt < MAX_RETRIES && !nonRetryable) {
            errorChunk = chunk;
            break;
          }
          yield chunk;
          return;
        }
        // Buffer the terminal chunk so an EMPTY completion can retry BEFORE the
        // consumer finalizes and surfaces a blank reply.
        if (chunk.type === "done") {
          doneChunk = chunk;
          break;
        }
        if (
          chunk.type === "text" ||
          chunk.type === "tool_call_start" ||
          chunk.type === "tool_call_delta" ||
          chunk.type === "tool_call_end"
        ) {
          visibleYielded = true;
        }
        yield chunk;
      }

      if (errorChunk) {
        lastError = errorChunk;
        console.warn(
          `[Custom] Early upstream error on attempt ${attempt + 1}/${MAX_RETRIES + 1} for ${params.model}, retrying: ${errorChunk.content.slice(0, 200)}`,
        );
        continue;
      }

      // Completed via `done` with no visible text or tool calls (all-reasoning
      // turn or truly empty completion) — retry silently.
      if (doneChunk && !visibleYielded && attempt < MAX_RETRIES && !params.signal?.aborted) {
        lastDone = doneChunk;
        console.warn(
          `[Custom] Empty completion (no visible output) on attempt ${attempt + 1}/${MAX_RETRIES + 1} for ${params.model}, retrying.`,
        );
        continue;
      }

      if (doneChunk) {
        yield doneChunk;
        return;
      }
      // streamOnce ended without a terminal chunk (shouldn't happen).
      return;
    }

    // Retries exhausted — surface the last error, or the (still-empty) done so
    // the server-side empty-reply guard produces a clear "try again".
    if (lastError) { yield lastError; return; }
    if (lastDone) { yield lastDone; return; }
  }

  /** Single-attempt pass — see `generateStream` for the retry wrapper. */
  private async *streamOnce(params: GenerateParams): AsyncIterable<StreamChunk> {
    if (params.stream === false) {
      yield* this.generateNonStream(params);
      return;
    }

    const model = params.model.replace(/^custom\//, "");
    const messages = applyPromptPostProcessing(params.messages, this.metadata.promptPostProcessing).map(serializeMessage);

    const connAbort = new AbortController();
    const timeoutMs = localGenerationTimeoutMs();
    const connTimer = timeoutMs > 0
      ? setTimeout(() => connAbort.abort(new Error("Connection timeout")), timeoutMs)
      : undefined;
    const fetchSignal = params.signal
      ? AbortSignal.any([connAbort.signal, params.signal])
      : connAbort.signal;

    const initialBody = this.buildChatBody({ model, messages, params, stream: true });

    let response: Response;
    try {
      response = await this.postChatWithRetry(initialBody, fetchSignal, !params.singleAttempt, params.conversationId);
    } catch (err) {
      clearTimeout(connTimer);
      if (params.signal?.aborted) return;
      yield { type: "error", content: `Custom endpoint request failed: ${(err as Error).message}` };
      return;
    }
    clearTimeout(connTimer);

    if (!response.ok) {
      const error = await response.text();
      yield { type: "error", content: `Custom endpoint error (${response.status}): ${error}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", content: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let lastFinishReason: string | null = null;
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let completionFinished = false;

    try {
      while (true) {
        if (params.signal?.aborted) return;

        const result = await readLocalStream(reader);
        if (result.timedOut) {
          console.warn(`[Custom] Stream inactivity timeout after ${timeoutMs}ms for model ${params.model}`);
          yield { type: "error", content: "Stream timed out while waiting for the model. The endpoint may still be processing; the request was not automatically resent." };
          return;
        }
        buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        // Process the final buffered event even if the provider omits its newline.
        buffer = result.done ? "" : lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trimStart();
          if (data === "[DONE]") {
            yield* flushToolCalls(toolCallBuffers);
            yield {
              type: "done",
              content: "",
              stopReason: lastFinishReason === "length" ? "max_tokens" : lastFinishReason ?? undefined,
            };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              const error = parsed.error;
              const message = typeof error === "string" ? error
                : typeof error.message === "string" ? error.message : "The provider rejected this request.";
              const code = typeof error.code === "string" || typeof error.code === "number" ? ` [${error.code}]` : "";
              // HTTP 200 can contain a failed generation (e.g. Featherless's
              // context_length_exceeded). Never turn it into success or a
              // generic disconnection, and never automatically resend it.
              yield { type: "error", content: `Custom endpoint error (stream):${code} ${message}`.split(this.apiKey).join("[redacted]") };
              return;
            }
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;
            if (choice?.finish_reason) completionFinished = true;

            if (choice?.finish_reason) lastFinishReason = choice.finish_reason;

            if (delta?.content) {
              yield { type: "text", content: delta.content };
            }

            const reasoningContent = typeof delta?.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta?.reasoning === "string"
                ? delta.reasoning
                : "";
            if (reasoningContent) {
              yield { type: "reasoning", content: reasoningContent };
            }

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
                  if (tc.function?.arguments) {
                    yield { type: "tool_call_delta", content: tc.function.arguments, toolCallIndex: idx };
                  }
                } else {
                  const buf = toolCallBuffers.get(idx)!;
                  if (tc.id) buf.id = tc.id;
                  if (tc.function?.name) buf.name = tc.function.name;
                  const argChunk = tc.function?.arguments;
                  if (argChunk != null) {
                    buf.args += argChunk;
                    yield { type: "tool_call_delta", content: argChunk, toolCallIndex: idx };
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
                stopReason: lastFinishReason === "length" ? "max_tokens" : lastFinishReason ?? undefined,
                usage: {
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                  totalTokens: parsed.usage.total_tokens,
                  reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens,
                },
              };
              return;
            }
          } catch {
            // Skip unparseable lines
          }
        }
        if (result.done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    if (!completionFinished) {
      yield { type: "error", content: "The endpoint closed the stream before the reply completed. It may still be processing; the request was not automatically resent." };
      return;
    }
    yield* flushToolCalls(toolCallBuffers);
    yield {
      type: "done",
      content: "",
      stopReason: lastFinishReason === "length" ? "max_tokens" : lastFinishReason ?? undefined,
    };
  }

  /** Non-streaming path. Bypass for proxies that moderate streams differently. */
  private async *generateNonStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    const model = params.model.replace(/^custom\//, "");
    const messages = applyPromptPostProcessing(params.messages, this.metadata.promptPostProcessing).map(serializeMessage);

    const connAbort = new AbortController();
    const timeoutMs = localGenerationTimeoutMs();
    const connTimer = timeoutMs > 0
      ? setTimeout(() => connAbort.abort(new Error("Request timeout")), timeoutMs)
      : undefined;
    const fetchSignal = params.signal
      ? AbortSignal.any([connAbort.signal, params.signal])
      : connAbort.signal;

    const initialBody = this.buildChatBody({ model, messages, params, stream: false });

    let response: Response;
    try {
      response = await this.postChatWithRetry(initialBody, fetchSignal, !params.singleAttempt, params.conversationId);
    } catch (err) {
      clearTimeout(connTimer);
      if (params.signal?.aborted) return;
      yield { type: "error", content: `Custom endpoint request failed: ${(err as Error).message}` };
      return;
    }
    clearTimeout(connTimer);

    if (!response.ok) {
      const error = await response.text().catch(() => "");
      yield { type: "error", content: `Custom endpoint error (${response.status}): ${error}` };
      return;
    }

    let parsed: {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          reasoning_content?: string;
          reasoning?: string;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch (err) {
      yield { type: "error", content: `Custom endpoint: failed to parse response (${(err as Error).message})` };
      return;
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      yield { type: "error", content: "Custom endpoint: empty response (no choices)" };
      return;
    }

    const message = choice.message ?? {};
    const fr = choice.finish_reason ?? null;

    const reasoningContent = typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : typeof message.reasoning === "string"
        ? message.reasoning
        : "";
    if (reasoningContent) {
      yield { type: "reasoning", content: reasoningContent };
    }

    if (typeof message.content === "string" && message.content.length > 0) {
      yield { type: "text", content: message.content };
    }

    if (message.tool_calls?.length) {
      for (let i = 0; i < message.tool_calls.length; i++) {
        const tc = message.tool_calls[i]!;
        const id = tc.id ?? "";
        const name = tc.function?.name ?? "";
        const args = tc.function?.arguments ?? "";
        yield { type: "tool_call_start", content: "", toolCallIndex: i, toolCallId: id, toolCallName: name };
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
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        },
      }),
    };
  }

  /** Fetch available models from the proxy's /models endpoint.
   *  Returns empty array on any failure — the whitelist in api_keys.metadata is the source of truth. */
  async listModels(): Promise<Model[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.buildHeaders({ contentType: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const json = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
      if (!json.data) return [];
      return json.data.map((m) => ({
        id: `custom/${m.id}`,
        name: m.name ?? m.id,
        contextLength: 0,
      }));
    } catch (err) {
      console.warn(`[Custom] listModels failed for ${this.baseUrl}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Detailed listModels for the connection panel — surfaces the upstream HTTP status on failure. */
  async listModelsDetailed(): Promise<{ ok: boolean; status?: number; models: string[]; reason?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.buildHeaders({ contentType: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { ok: false, status: response.status, models: [], reason: body.slice(0, 300) || `HTTP ${response.status}` };
      }
      const json = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
      const ids = (Array.isArray(json?.data) ? json.data : [])
        .map((m) => m?.id).filter((s): s is string => typeof s === "string" && s.length > 0);
      return { ok: true, status: response.status, models: ids };
    } catch (err) {
      return { ok: false, models: [], reason: `Network error: ${(err as Error).message}` };
    }
  }

  /** Send a single non-streaming chat completion. Used by the "Send test message" button. */
  async sendTestMessage(model: string, prompt = "Hi"): Promise<{ ok: boolean; status?: number; reply?: string; reason?: string }> {
    try {
      const probeModel = model.replace(/^custom\//, "");
      const response = await this.postChatWithRetry(
        this.shapeBody({
          model: probeModel,
          messages: [{ role: "user", content: prompt }],
          stream: false,
        }),
        AbortSignal.timeout(60_000),
      );
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        return { ok: false, status: response.status, reason: text.slice(0, 500) || `HTTP ${response.status}` };
      }
      try {
        const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
        const reply = parsed.choices?.[0]?.message?.content;
        if (typeof reply !== "string" || !reply.trim()) {
          return { ok: false, status: response.status, reason: "The model returned no text reply. Try again or choose another model." };
        }
        return { ok: true, status: response.status, reply };
      } catch {
        return { ok: false, status: response.status, reason: "The endpoint did not return a valid chat response. Check the endpoint and model ID." };
      }
    } catch (err) {
      return { ok: false, reason: `Network error: ${(err as Error).message}` };
    }
  }

  /** Fast connectivity check via /models. Returns true on 2xx. */
  async verify(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.buildHeaders({ contentType: false }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Second-step verify used by the API-keys route when /models fails. Requires a known model. */
  async verifyWithModel(model: string): Promise<{ ok: boolean; status?: number; body?: string }> {
    const result = await this.sendTestMessage(model, "hi");
    if (result.ok) return { ok: true };
    return { ok: false, status: result.status, body: result.reason };
  }

  // ── Internal helpers ──

  /** Build the chat-completion request body. Applies, in order:
   *   1. The base OpenAI-compatible shape with current GenerateParams.
   *   2. Proactive sampling-param strip for likely "reasoning" models — these
   *      reject temperature/top_p/presence/frequency penalties (e.g. xAI's
   *      grok-*-reasoning, OpenAI o-series). Detection is heuristic; the
   *      reactive retry in postChatWithRetry catches anything we miss.
   *   3. User-configured excludeBody / includeBody from metadata.
   */
  private buildChatBody(args: {
    model: string;
    messages: Record<string, unknown>[];
    params: GenerateParams;
    stream: boolean;
  }): Record<string, unknown> {
    const { model, messages, params, stream } = args;
    const reasoning = looksLikeReasoningModel(model);

    const body: Record<string, unknown> = {
      model,
      messages,
      stream,
      ...(stream && { stream_options: { include_usage: true } }),
    };

    if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;

    // Sampling controls — proactively skipped on suspected reasoning models.
    if (!reasoning) {
      if (params.temperature !== undefined) body.temperature = params.temperature;
      if (params.topP !== undefined) body.top_p = params.topP;
      if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
      if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
    }

    if (params.responseFormat) body.response_format = { type: params.responseFormat.type };
    if (params.tools && params.tools.length > 0) body.tools = params.tools;
    if (params.toolChoice !== undefined) body.tool_choice = params.toolChoice;

    const shaped = this.shapeBody(body);

    // DeepSeek V4 enables thinking by default. Background callers can request
    // disableReasoning; translate that into DeepSeek's native field
    // only for the official DeepSeek endpoint so generic OpenAI-compatible
    // proxies never receive a vendor-specific parameter. Apply this after
    // metadata shaping so an account-level includeBody cannot accidentally
    // re-enable reasoning for a summary request.
    if (params.disableReasoning && isOfficialDeepSeekEndpoint(this.baseUrl)) {
      shaped.thinking = { type: "disabled" };
    }

    return shaped;
  }

  /** POST the chat body and, on a recognizable 400 "unsupported parameter"
   *  error, strip that parameter and retry exactly once. Subsequent failures
   *  bubble up so the caller can surface the upstream error verbatim. */
  private async postChatWithRetry(
    initialBody: Record<string, unknown>,
    signal: AbortSignal,
    allowRetry = true,
    conversationId?: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = this.buildHeaders({ conversationId });

    let body = initialBody;
    let response = await fetch(url, { method: "POST", headers, signal, body: JSON.stringify(body) });
    if (response.ok || response.status !== 400 || !allowRetry) return response;

    // Drain the error body (Response bodies can only be consumed once). If we
    // decide not to retry, we have to wrap the text back into a fresh Response
    // so the caller's response.text() still works.
    const errorText = await response.text().catch(() => "");
    const errorShim = () => new Response(errorText, { status: response.status, statusText: response.statusText });

    const offendingParam = parseUnsupportedParam(errorText);
    if (!offendingParam) return errorShim();
    const retryBody = stripParamFromBody(body, offendingParam);
    if (!retryBody) return errorShim();

    console.warn(`[Custom] Upstream rejected param '${offendingParam}'. Retrying once without it. Excerpt: ${errorText.slice(0, 200)}`);
    body = retryBody;
    return fetch(url, { method: "POST", headers, signal, body: JSON.stringify(body) });
  }

  /** Compose request headers: Authorization (always ours) + Content-Type + user-supplied includeHeaders.
   *  The Authorization header cannot be overridden by includeHeaders. */
  private buildHeaders(opts?: { contentType?: boolean; conversationId?: string }): Record<string, string> {
    const headers: Record<string, string> = {};
    const endpoint = new URL(this.baseUrl);
    const isOpenCode = endpoint.hostname === "opencode.ai"
      && /^\/zen(?:\/go)?\/v1$/.test(endpoint.pathname);
    if (this.metadata.includeHeaders) {
      for (const [k, v] of Object.entries(this.metadata.includeHeaders)) {
        if (typeof v !== "string") continue;
        // Strip control chars / CRLF to prevent header injection
        if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) continue;
        if (k.toLowerCase() === "authorization") continue;
        // The application owns these for OpenCode. In particular, never forward
        // the email's literal placeholder or a static ID shared by all chats.
        if (isOpenCode && ["x-opencode-session", "user-agent"].includes(k.toLowerCase())) continue;
        headers[k] = v;
      }
    }
    headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (isOpenCode) {
      headers["User-Agent"] = `Yumina (+${PUBLIC_ORIGIN})`;
      headers["x-opencode-session"] = createHash("sha256")
        .update(`yumina:${opts?.conversationId || randomUUID()}`)
        .digest("hex");
    }
    if (opts?.contentType !== false) headers["Content-Type"] = "application/json";
    return headers;
  }

  /** Apply excludeBody (delete listed fields) then includeBody (merge user-supplied fields). */
  private shapeBody(body: Record<string, unknown>): Record<string, unknown> {
    const exclude = this.metadata.excludeBody;
    if (Array.isArray(exclude)) {
      for (const k of exclude) {
        if (typeof k === "string") delete body[k];
      }
    }
    const include = this.metadata.includeBody;
    if (include && typeof include === "object") {
      Object.assign(body, include);
    }
    return body;
  }
}

// ── Helpers ──

function isOfficialDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

function serializeMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  if (m.role === "assistant" && "tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) {
    const message: Record<string, unknown> = { role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls };
    if (typeof m.reasoning_content === "string" && m.reasoning_content.length > 0) {
      message.reasoning_content = m.reasoning_content;
    }
    return message;
  }
  return { role: m.role, content: m.content };
}

function* flushToolCalls(
  buffers: Map<number, { id: string; name: string; args: string }>
): Generator<StreamChunk> {
  for (const [idx, buf] of buffers) {
    const args = buf.args || "{}";
    const toolCall: ToolCall = { id: buf.id, type: "function", function: { name: buf.name, arguments: args } };
    yield { type: "tool_call_end", content: "", toolCallIndex: idx, toolCall };
  }
  buffers.clear();
}
