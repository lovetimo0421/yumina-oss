/**
 * Sandbox-side message types matching the parent's Message type.
 * These are serialized over the postMessage bridge.
 */

export interface SandboxMessageAttachment {
  type: string;
  mimeType: string;
  name: string;
  url: string;
}

export interface SandboxSwipe {
  modelFallback?: import("@yumina/shared").ModelFallbackRecord;
  content: string;
  /** Full pre-parse LLM output (segments + directives + JSON wrappers).
   *  Optional for backwards-compat with messages persisted before 2026-05.
   *  Exposed so the bubble's "view raw" toggle can show the unparsed response
   *  when narrative or directives get eaten by the parser. */
  rawContent?: string;
  stateSnapshot?: Record<string, unknown> | null;
  tokenCount?: number | null;
  creditCost?: number | null;
  creditBalanceAfter?: number | null;
  /** Server refusal-detector flag: this reply is a model policy refusal, not
   *  story text. The UI reads `message.swipes[message.activeSwipeIndex ?? 0].refusal`. */
  refusal?: boolean;
}

export interface SandboxMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "complete" | "streaming" | "failed";
  errorMessage?: string | null;
  stateChanges?: Record<string, unknown> | null;
  stateSnapshot?: Record<string, unknown> | null;
  swipes?: SandboxSwipe[];
  activeSwipeIndex?: number;
  model?: string | null;
  modelFallback?: import("@yumina/shared").ModelFallbackRecord;
  tokenCount?: number | null;
  generationTimeMs?: number | null;
  creditCost?: number | null;
  creditBalanceAfter?: number | null;
  compacted?: boolean;
  attachments?: SandboxMessageAttachment[] | null;
  createdAt: string;
  /** Host-side, not persisted: the per-turn picture is drawing, or why it wasn't drawn. */
  turnImage?: { status: "drawing" } | { status: "failed"; reason: "busy" | "timeout" | "unavailable" | "credits" };
}

export interface SandboxCheckpoint {
  id: string;
  name: string;
  messageCount: number;
  createdAt: string;
}
