import type { LLMProvider, GenerateParams, StreamChunk, Model, MessageContent } from "./types.js";
import { localGenerationTimeoutMs, readLocalStream } from "./local-timeout.js";

const DEFAULT_OLLAMA_BASE = "http://localhost:11434";

/** Validate that a URL is safe to use as an Ollama base (blocks SSRF vectors) */
function validateOllamaUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid Ollama URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama URL must use http or https");
  }

  const hostname = parsed.hostname;

  // Block cloud metadata endpoints
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
    throw new Error("Ollama URL cannot target cloud metadata services");
  }

  // Block common internal/link-local ranges
  if (
    hostname.startsWith("10.") ||
    hostname.startsWith("172.16.") || hostname.startsWith("172.17.") || hostname.startsWith("172.18.") ||
    hostname.startsWith("172.19.") || hostname.startsWith("172.20.") || hostname.startsWith("172.21.") ||
    hostname.startsWith("172.22.") || hostname.startsWith("172.23.") || hostname.startsWith("172.24.") ||
    hostname.startsWith("172.25.") || hostname.startsWith("172.26.") || hostname.startsWith("172.27.") ||
    hostname.startsWith("172.28.") || hostname.startsWith("172.29.") || hostname.startsWith("172.30.") ||
    hostname.startsWith("172.31.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") && hostname !== "localhost"
  ) {
    throw new Error("Ollama URL cannot target internal network addresses");
  }

  return parsed.origin;
}

function isLoopbackOllamaUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

function ollamaFetchFailureMessage(baseUrl: string, err: unknown): string {
  const detail = err instanceof Error && err.name === "AbortError"
    ? "request timed out after 10 seconds"
    : err instanceof Error ? err.message : String(err);
  if (isLoopbackOllamaUrl(baseUrl)) {
    return `Cannot reach Ollama at ${baseUrl}. On hosted Yumina, localhost/127.0.0.1 points to the Yumina server container, not the user's computer. Use a public HTTPS tunnel or reverse proxy URL to your Ollama server, then reconnect. Original error: ${detail}`;
  }
  return `Cannot reach Ollama at ${baseUrl}: ${detail}`;
}

/** Convert message content to Ollama format (text + optional images array) */
function toOllamaMessage(role: string, content: MessageContent): Record<string, unknown> {
  if (typeof content === "string") return { role, content };

  let text = "";
  const images: string[] = [];

  for (const part of content) {
    if (part.type === "text") text += part.text;
    if (part.type === "image_url") {
      const match = part.image_url.url.match(/^data:[^;]+;base64,(.+)$/);
      if (match) images.push(match[1]!);
    }
  }

  return { role, content: text, ...(images.length > 0 && { images }) };
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    const raw = (baseUrl || DEFAULT_OLLAMA_BASE).replace(/\/$/, "");
    // Allow localhost/127.0.0.1 (standard Ollama setup) without validation
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(raw);
    this.baseUrl = isLocalhost ? raw : validateOllamaUrl(raw);
  }

  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    // Non-streaming branch: see OpenRouterProvider for rationale.
    if (params.stream === false) {
      yield* this.generateNonStream(params);
      return;
    }

    // Strip ollama/ prefix from model ID
    const model = params.model.replace(/^ollama\//, "");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: params.signal,
        body: JSON.stringify({
          model,
          messages: params.messages.map((m) => toOllamaMessage(m.role, m.content)),
          stream: true,
          options: {
            num_predict: params.maxTokens,
            temperature: params.temperature,
            ...(params.topP !== undefined && { top_p: params.topP }),
            ...(params.topK !== undefined && params.topK > 0 && { top_k: params.topK }),
            ...(params.minP !== undefined && params.minP > 0 && { min_p: params.minP }),
            ...(params.frequencyPenalty !== undefined && { frequency_penalty: params.frequencyPenalty }),
            ...(params.presencePenalty !== undefined && { presence_penalty: params.presencePenalty }),
          },
          ...(params.responseFormat && { format: "json" }),
        }),
      });
    } catch (err) {
      if (params.signal?.aborted) return;
      yield { type: "error", content: ollamaFetchFailureMessage(this.baseUrl, err) };
      return;
    }

    if (!response.ok) {
      const error = await response.text();
      yield { type: "error", content: `Ollama error (${response.status}): ${error}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", content: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (params.signal?.aborted) return;

        const result = await readLocalStream(reader);
        if (result.timedOut) {
          console.warn(`[Ollama] Stream inactivity timeout after ${localGenerationTimeoutMs()}ms`);
          yield { type: "error", content: "Stream timed out while waiting for the model. The endpoint may still be processing; the request was not automatically resent." };
          return;
        }
        if (result.done) break;

        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);

            if (parsed.message?.content) {
              yield { type: "text", content: parsed.message.content };
            }

            if (parsed.done) {
              yield {
                type: "done",
                content: "",
                usage: parsed.eval_count
                  ? {
                      promptTokens: parsed.prompt_eval_count ?? 0,
                      completionTokens: parsed.eval_count ?? 0,
                      totalTokens:
                        (parsed.prompt_eval_count ?? 0) + (parsed.eval_count ?? 0),
                    }
                  : undefined,
              };
              return;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", content: "" };
  }

  /** Non-streaming path — mirrors generateStream output. See OpenRouter for details. */
  private async *generateNonStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    const model = params.model.replace(/^ollama\//, "");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: params.signal,
        body: JSON.stringify({
          model,
          messages: params.messages.map((m) => toOllamaMessage(m.role, m.content)),
          stream: false,
          options: {
            num_predict: params.maxTokens,
            temperature: params.temperature,
            ...(params.topP !== undefined && { top_p: params.topP }),
            ...(params.topK !== undefined && params.topK > 0 && { top_k: params.topK }),
            ...(params.minP !== undefined && params.minP > 0 && { min_p: params.minP }),
            ...(params.frequencyPenalty !== undefined && { frequency_penalty: params.frequencyPenalty }),
            ...(params.presencePenalty !== undefined && { presence_penalty: params.presencePenalty }),
          },
          ...(params.responseFormat && { format: "json" }),
        }),
      });
    } catch (err) {
      if (params.signal?.aborted) return;
      yield { type: "error", content: ollamaFetchFailureMessage(this.baseUrl, err) };
      return;
    }

    if (!response.ok) {
      const error = await response.text().catch(() => "");
      yield { type: "error", content: `Ollama error (${response.status}): ${error}` };
      return;
    }

    let parsed: {
      message?: { content?: string };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch (err) {
      yield { type: "error", content: `Ollama: failed to parse response (${(err as Error).message})` };
      return;
    }

    const content = parsed.message?.content ?? "";
    if (content.length > 0) {
      yield { type: "text", content };
    }

    const promptTokens = parsed.prompt_eval_count ?? 0;
    const completionTokens = parsed.eval_count ?? 0;
    yield {
      type: "done",
      content: "",
      stopReason: parsed.done_reason ?? undefined,
      ...((promptTokens > 0 || completionTokens > 0) && {
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      }),
    };
  }

  async listModels(): Promise<Model[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
    } catch (err) {
      throw new Error(ollamaFetchFailureMessage(this.baseUrl, err));
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Failed to list Ollama models: ${response.status}`);
    }

    const json = (await response.json()) as {
      models: Array<{
        name: string;
        size: number;
        details?: { parameter_size?: string };
      }>;
    };

    return json.models.map((m) => ({
      id: `ollama/${m.name}`,
      name: m.name,
      contextLength: 8192, // Ollama doesn't expose this; use safe default
    }));
  }

  async verify(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
