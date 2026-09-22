/** A single content block — text or image */
export type ContentPart =
  | { type: "text"; text: string; cache_control?: { type: string; ttl?: string } }
  | { type: "image_url"; image_url: { url: string } };

/** Message content can be a plain string or an array of content parts */
export type MessageContent = string | ContentPart[];

// ── Tool Use Types ──

/** OpenAI-compatible tool definition */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/** A tool call returned by the model */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** A message containing tool results sent back to the model */
export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** An assistant message that may include tool calls */
export interface AssistantMessageWithToolCalls {
  role: "assistant";
  content: MessageContent;
  tool_calls?: ToolCall[];
  /** DeepSeek thinking-mode tool calls require replaying this field verbatim. */
  reasoning_content?: string;
}

/** All possible message types in a conversation */
export type ChatMessage =
  | { role: "user" | "system"; content: MessageContent }
  | AssistantMessageWithToolCalls
  | ToolResultMessage;

// ── Generate Params ──

export interface GenerateParams {
  /** Stable, namespaced conversation identity for upstream routing; never sent in the body. */
  conversationId?: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  topK?: number;
  minP?: number;
  stream?: boolean;
  /** Request JSON structured output from the model */
  responseFormat?: { type: "json_object" };
  /** Tool definitions for function calling */
  tools?: ToolDefinition[];
  /** Controls how the model uses tools */
  toolChoice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  /** Reasoning effort level for thinking models (none/low/medium/high) */
  reasoningEffort?: string;
  /** Disable provider-default reasoning when the selected API exposes a supported opt-out. */
  disableReasoning?: boolean;
  /** Message indices for explicit cache breakpoints (provider-specific optimization) */
  cacheBreakpoints?: number[];
  /** Ordered model IDs the provider may retry with for provider-specific policy failures. */
  fallbackModels?: string[];
  /**
   * Let the fallback chain absorb transient upstream failures (429 / 5xx) too,
   * not just deterministic refusals.
   *
   * Set only for the Yumina Free chain. Its models sit behind one to three
   * provider endpoints, so when the free pool empties and the whole free tier
   * lands on them at once, a throttle is likely — and a free player has no paid
   * model of their own to retreat to. Degrading beats failing there. For a paid
   * model it would be the wrong trade: the player picked and pays for a
   * specific model, so silently serving another one on a blip is not ours to do.
   */
  fallbackOnTransientErrors?: boolean;
  /** Make exactly one upstream request; used by callers with their own shared retry budget. */
  singleAttempt?: boolean;
  /** AbortSignal to cancel the upstream request when client disconnects */
  signal?: AbortSignal;
}

// ── Stream Chunks ──

export interface StreamChunk {
  type: "text" | "reasoning" | "done" | "error" | "tool_call_start" | "tool_call_delta" | "tool_call_end";
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Completion tokens spent on hidden reasoning, when reported upstream. */
    reasoningTokens?: number;
    /** Actual USD-denominated account charge when reported by the provider. */
    providerCostUsd?: number;
    providerRequestId?: string;
  };
  /** Provider generation/request id, surfaced on streamed text chunks as soon
   *  as it is known so a stopped generation can be settled against the
   *  provider's billed cost (see lib/stopped-generation.ts). */
  providerRequestId?: string;
  /** Populated on tool_call_start — the tool call ID */
  toolCallId?: string;
  /** Populated on tool_call_start — the function name */
  toolCallName?: string;
  /** Index of the tool call in the batch (0-based) */
  toolCallIndex?: number;
  /** Populated on tool_call_end — the complete tool call */
  toolCall?: ToolCall;
  /** Why the model stopped: "end_turn" (normal), "max_tokens" (truncated), "stop_sequence", etc. */
  stopReason?: string;
  /** Actual model used when the provider retried with a fallback model. */
  model?: string;
  /** On error chunks: routing slug of the upstream provider that failed, when
   *  identifiable from OpenRouter response metadata. The retry loop excludes
   *  it on the next attempt instead of re-rolling the same broken provider. */
  failedProviderSlug?: string;
  /** The selected model cannot serve this turn. No different paid model was called. */
  fallbackReason?: import("@yumina/shared").ModelFallbackReason;
  /** On done chunks: routing slug of the upstream provider that actually served
   *  this response. A turn can finish with HTTP 200 and still be useless (no
   *  visible text), which never produces an error chunk — this is how the retry
   *  loop learns who to exclude in that case. Best-effort: undefined whenever
   *  the provider can't be identified from the response. */
  servedProviderSlug?: string;
}

// ── Model & Provider ──

export interface Model {
  supportsImages?: boolean;
  id: string;
  name: string;
  contextLength: number;
  pricing?: {
    prompt: number;
    completion: number;
  };
  provider?: string;
}

export interface LLMProvider {
  generateStream(params: GenerateParams): AsyncIterable<StreamChunk>;
  listModels(): Promise<Model[]>;
  /** Account/endpoint context cap, which may be lower than the model's advertised window. */
  getContextWindow?(): Promise<number | undefined>;
  verify?(): Promise<boolean>;
}
