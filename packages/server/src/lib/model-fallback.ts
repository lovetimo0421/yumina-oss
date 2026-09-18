import { z } from "zod";
import type { ModelFallbackRecord } from "@yumina/shared";
import type { StreamChunk } from "./llm/types.js";

const recordSchema = z.object({
  requestedModel: z.string().trim().min(1).max(200),
  reason: z.enum(["unavailable", "policy", "capacity"]),
  automatic: z.boolean(),
}).strict();

export function parseModelFallbackRecord(value: unknown, model: string): ModelFallbackRecord | undefined {
  const parsed = recordSchema.safeParse(value);
  return parsed.success && parsed.data.requestedModel !== model ? parsed.data : undefined;
}

export function modelFallbackError(
  chunk: StreamChunk,
  model: string,
  content: string,
  isByok: boolean,
  userMessageId?: string,
) {
  // Never restart after partial output, and never mistake a transport loss for
  // an explicit upstream failure (the original request could still complete).
  if (chunk.type !== "error" || !chunk.fallbackReason || content.length > 0) return null;
  return {
    code: "MODEL_FALLBACK_REQUIRED" as const,
    error: "The selected model could not complete this request. Choose whether to retry or use another model.",
    userMessageId: userMessageId ?? null,
    fallback: {
      requestedModel: model,
      reason: chunk.fallbackReason,
      provider: isByok ? "private" as const : "official" as const,
    },
  };
}

/** A confirmed retry must still target the same unanswered turn, even after a
 * long pause. Reject stale tabs instead of silently inserting another message. */
export function canReuseFallbackMessage(
  latest: { id: string; role: string; content: string } | undefined,
  retryMessageId: string,
  content: string,
): boolean {
  return !!latest && latest.id === retryMessageId && latest.role === "user" && latest.content === content;
}
