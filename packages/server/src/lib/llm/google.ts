import { IMAGE_MODEL_CAPABILITIES } from "@yumina/shared";
import { randomUUID } from "node:crypto";
import type { ReadableStreamReadResult } from "node:stream/web";
import type { LLMProvider, GenerateParams, StreamChunk, Model, ChatMessage, ToolCall } from "./types.js";
import { LLM_CONNECTION_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MS, LLM_STREAM_INACTIVITY_TIMEOUT_SHORT_MS } from "./constants.js";

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];

type GooglePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};
type GoogleContent = { role: "user" | "model"; parts: GooglePart[] };
type GoogleResponse = {
  candidates?: Array<{ content?: { parts?: GooglePart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code?: number; message?: string };
};
// Google's OpenAI-compatible metadata shape survives the existing tool-call
// persistence/approval flow without changing the shared provider interface.
type GoogleToolCall = ToolCall & { extra_content?: { google?: { thought_signature?: string } } };

/** Direct Google keys only. Official/OpenRouter Gemini routing is unchanged. */
/**
 * Google returns a multi-line JSON body on failure. Users on their own Gemini key
 * hit the free-tier quota (429) many times a day, and echoing the whole body into
 * the stream error and the server log made it look like an outage. Keep the
 * status in the fixed prefix, add the first sentence of Google's message and, for
 * quota errors, the retry hint — nothing else.
 */
export function summarizeGoogleError(status: number, body: string): string {
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    message = parsed.error?.message ?? "";
  } catch {
    message = body;
  }
  const firstLine = message.split("\n")[0]?.trim().replace(/\s+/g, " ") ?? "";
  const retry = message.match(/retry in (\d+(?:\.\d+)?)s/i);
  const quota = status === 429 && /quota|rate/i.test(message);
  const head = quota ? "Google AI rate limit (429) on this API key" : `Google AI error (${status})`;
  const detail = quota
    ? (retry ? `retry in ${Math.ceil(Number(retry[1]))}s` : "quota exceeded")
    : firstLine.slice(0, 200);
  return detail ? `${head}: ${detail}` : head;
}

export class GoogleProvider implements LLMProvider {
  constructor(private apiKey: string) {}

  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    if (params.signal?.aborted) return;
    const streaming = params.stream !== false;
    const abort = new AbortController();
    const signal = params.signal ? AbortSignal.any([abort.signal, params.signal]) : abort.signal;
    const timer = setTimeout(() => abort.abort(new Error("Request timeout")),
      streaming ? LLM_CONNECTION_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const action = streaming ? "streamGenerateContent?alt=sse" : "generateContent";
      const response = await fetch(`${GOOGLE_BASE}/models/${encodeURIComponent(toGoogleModelId(params.model))}:${action}`, {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" },
        signal,
        body: JSON.stringify(buildGoogleRequest(params)),
      });
      if (streaming) clearTimeout(timer);
      if (!response.ok) {
        yield { type: "error", content: summarizeGoogleError(response.status, await response.text()) };
        return;
      }

      let usage: GoogleResponse["usageMetadata"];
      let finishReason: string | undefined;
      let toolIndex = 0;
      let hasOutput = false;
      function* consume(parsed: GoogleResponse): Generator<StreamChunk> {
        if (parsed.error) throw new Error(parsed.error.message ?? "Upstream generation error");
        const blocked = parsed.promptFeedback?.blockReason;
        const candidate = parsed.candidates?.[0];
        const reason = candidate?.finishReason;
        if ((blocked && blocked !== "BLOCK_REASON_UNSPECIFIED") ||
            (reason && ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"].includes(reason))) {
          throw new Error(`Response blocked by safety/content filter (${blocked ?? reason}). Try regenerating or another model.`);
        }
        if (reason && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(reason)) {
          throw new Error(`Response blocked or stopped by Google (${blocked ?? reason}). Try another prompt or model.`);
        }
        if (reason && reason !== "FINISH_REASON_UNSPECIFIED") finishReason = reason;
        if (parsed.usageMetadata) usage = { ...usage, ...parsed.usageMetadata };
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text) {
            if (!part.thought) hasOutput = true;
            yield { type: part.thought ? "reasoning" : "text", content: part.text };
          }
          if (part.functionCall) {
            const fc = part.functionCall;
            if (!fc.name || (fc.args != null && (typeof fc.args !== "object" || Array.isArray(fc.args)))) {
              throw new Error("Malformed function call in Google response");
            }
            const tc: GoogleToolCall = {
              id: fc.id ?? `google_${randomUUID()}`,
              type: "function",
              function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
              ...(part.thoughtSignature && { extra_content: { google: { thought_signature: part.thoughtSignature } } }),
            };
            hasOutput = true;
            yield { type: "tool_call_start", content: "", toolCallIndex: toolIndex, toolCallId: tc.id, toolCallName: fc.name };
            yield { type: "tool_call_delta", content: tc.function.arguments, toolCallIndex: toolIndex };
            yield { type: "tool_call_end", content: "", toolCallIndex: toolIndex++, toolCall: tc };
          }
        }
      }

      if (!streaming) {
        yield* consume(await response.json() as GoogleResponse);
      } else {
        reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";
        let data: string[] = [];
        function* line(value: string): Generator<StreamChunk> {
          if (value === "") {
            const payload = data.join("\n");
            data = [];
            if (payload && payload !== "[DONE]") yield* consume(JSON.parse(payload) as GoogleResponse);
          } else if (value.startsWith("data:")) {
            data.push(value.slice(5).replace(/^ /, ""));
          }
        }
        while (true) {
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => {
                idleTimer = setTimeout(() => {
                  const error = new Error("Stream timed out — the model stopped responding. Try regenerating.");
                  abort.abort(error);
                  reject(error);
                }, LLM_STREAM_INACTIVITY_TIMEOUT_SHORT_MS);
              }),
            ]);
          } finally {
            clearTimeout(idleTimer);
          }
          if (params.signal?.aborted) return;
          buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            yield* line(buffer.slice(0, end).replace(/\r$/, ""));
            buffer = buffer.slice(end + 1);
          }
          if (result.done) {
            if (buffer) yield* line(buffer.replace(/\r$/, ""));
            yield* line("");
            break;
          }
        }
      }
      // Usage may appear before the final candidate. Never end a native stream
      // on usage alone, or accept a disconnected partial reply as complete.
      if (!finishReason) throw new Error("Google AI response ended before generation completed. Try regenerating.");
      if (!hasOutput) throw new Error("Google AI returned an empty response. Try regenerating.");
      const promptTokens = usage?.promptTokenCount ?? 0;
      const reasoningTokens = usage?.thoughtsTokenCount ?? 0;
      const completionTokens = (usage?.candidatesTokenCount ?? 0) + reasoningTokens;
      yield {
        type: "done", content: "",
        stopReason: finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
        ...(usage && { usage: {
          promptTokens, completionTokens, reasoningTokens,
          totalTokens: usage.totalTokenCount ?? promptTokens + completionTokens,
        } }),
      };
    } catch (error) {
      if (!params.signal?.aborted) {
        yield { type: "error", content: `Google AI request failed: ${error instanceof Error ? error.message : "Generation failed"}` };
      }
    } finally {
      clearTimeout(timer);
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }

  // Keep model discovery and key verification on their existing working API.
  async listModels(): Promise<Model[]> {
    const response = await fetch(`${GOOGLE_BASE}/openai/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) throw new Error(`Failed to list Google models: ${response.status}`);
    const json = await response.json() as { data?: Array<{ id: string }> };
    return parseGoogleModels(json.data);
  }

  async verify(): Promise<boolean> {
    try {
      const response = await fetch(`${GOOGLE_BASE}/openai/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/** Strip Yumina's routing prefix and Google's model-list prefix. */
export function toGoogleModelId(modelId: string): string {
  return modelId.replace(/^google\//, "").replace(/^models\//, "");
}

/** Preserve the existing Google model picker behavior. */
export function parseGoogleModels(data?: Array<{ id: string }>): Model[] {
  return (data ?? [])
    .map((m) => m.id.replace(/^models\//, ""))
    .filter((id) => id.startsWith("gemini-") && !id.includes("-image-") && !id.includes("-live-") && !id.includes("-embedding"))
    .map((id) => ({
      id: `google/${id}`,
      supportsImages: IMAGE_MODEL_CAPABILITIES[`google/${id}`],
      name: id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      contextLength: 1_048_576,
    }));
}

function messageParts(content: Exclude<ChatMessage, { role: "tool" }>["content"]): GooglePart[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  return content.map((part) => {
    if (part.type === "text") return { text: part.text };
    const url = part.image_url.url;
    const inline = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
    if (inline) return { inlineData: { mimeType: inline[1]!, data: inline[2]! } };
    return { fileData: { fileUri: url } };
  });
}

function buildGoogleRequest(params: GenerateParams): Record<string, unknown> {
  const contents: GoogleContent[] = [];
  const system: GooglePart[] = [];
  const calls = new Map<string, ToolCall>();
  function append(role: GoogleContent["role"], parts: GooglePart[]) {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  for (const message of params.messages) {
    if (message.role === "system") {
      system.push(...messageParts(message.content));
    } else if (message.role === "tool") {
      const call = calls.get(message.tool_call_id);
      if (!call) throw new Error("Google tool response has no matching function call");
      let result: unknown;
      try { result = JSON.parse(message.content); } catch { result = message.content; }
      append("user", [{ functionResponse: {
        id: call.id, name: call.function.name,
        response: result !== null && typeof result === "object" && !Array.isArray(result)
          ? result as Record<string, unknown> : { result },
      } }]);
    } else {
      const parts = messageParts(message.content);
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) {
          calls.set(call.id, call);
          const args: unknown = JSON.parse(call.function.arguments || "{}");
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Google function arguments must be a JSON object");
          const signature = (call as GoogleToolCall).extra_content?.google?.thought_signature;
          parts.push({
            functionCall: { id: call.id, name: call.function.name, args: args as Record<string, unknown> },
            ...(signature && { thoughtSignature: signature }),
          });
        }
      }
      append(message.role === "assistant" ? "model" : "user", parts);
    }
  }
  const generationConfig = {
    maxOutputTokens: params.maxTokens,
    temperature: params.temperature,
    topP: params.topP,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    ...(params.topK !== undefined && params.topK > 0 && { topK: params.topK }),
    ...(params.responseFormat && { responseMimeType: "application/json" }),
  };
  const choice = params.toolChoice;
  return {
    contents,
    ...(system.length && { systemInstruction: { parts: system } }),
    generationConfig,
    safetySettings: GEMINI_SAFETY_SETTINGS,
    ...(params.tools?.length && { tools: [{ functionDeclarations: params.tools.map(({ function: fn }) => ({
      name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters,
    })) }] }),
    ...(params.tools?.length && choice !== undefined && { toolConfig: { functionCallingConfig: {
      mode: choice === "none" ? "NONE" : choice === "auto" ? "AUTO" : "ANY",
      ...(typeof choice === "object" && { allowedFunctionNames: [choice.function.name] }),
    } } }),
  };
}
