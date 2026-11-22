import type { MediaToolOutput } from "@yumina/shared";
import type { StudioChatMessage } from "@/features/studio/lib/types";

/** The assistant's run_media_tool card: one workbench tool, its inputs, its price; then the run and what it made. */
export interface StudioMediaToolProposal {
  runId: string;
  toolCallId: string;
  tool: string;
  inputs: Record<string, unknown>;
  output: MediaToolOutput;
  /** Rough wall time, seconds. */
  seconds: number;
  /** The server's quote for these inputs; null when it could not be had (a reload whose estimate failed). */
  estimatedMushies: number | null;
  status: "pending" | "running" | "done" | "failed" | "stillRunning" | "declined";
  jobId?: string | null;
  elapsed?: number;
  assetIds?: string[];
  costMushies?: number;
  error?: string;
}

declare module "@/features/studio/lib/types" {
  interface StudioChatMessage {
    /** A run_media_tool card attached to this assistant turn. */
    mediaToolProposal?: StudioMediaToolProposal;
  }
}

export const RUN_MEDIA_TOOL_NAME = "run_media_tool";

/** SSE media_tool_proposal. */
export interface MediaToolProposalEvent {
  runId: string; toolCallId: string; textContent: string; tool: string; inputs: Record<string, unknown>;
  output: MediaToolOutput; seconds: number; amount?: number; priceUsd?: number; estimatedMushies: number | null;
}
/** SSE media_tool_progress. */
export interface MediaToolProgressEvent { runId?: string; toolCallId: string; jobId: string; status: string; elapsed: number }
/** SSE media_tool_result. */
export interface MediaToolResultEvent {
  runId?: string; toolCallId: string; jobId?: string | null; status: "done" | "failed" | "pending";
  assetIds?: string[]; costMushies?: number; errorCode?: string;
}

/** Hang the card on the bubble that already holds the assistant's sentence for this run, or add one. */
export function withMediaToolProposal(messages: StudioChatMessage[], data: MediaToolProposalEvent, newId: () => string): StudioChatMessage[] {
  const { textContent, amount: _amount, priceUsd: _priceUsd, ...rest } = data;
  const proposal: StudioMediaToolProposal = { ...rest, status: "pending" };
  const existing = messages.findIndex((m) => m.mediaToolProposal?.toolCallId === data.toolCallId);
  if (existing >= 0) return messages.map((m, i) => (i === existing ? { ...m, mediaToolProposal: proposal } : m));
  const back = [...messages].reverse().findIndex((m) => m.role === "assistant" && m.agentRunId === data.runId
    && !m.mediaToolProposal && !m.imageProposal && !m.imageBatchProposal && m.content === textContent);
  const at = back >= 0 ? messages.length - 1 - back : -1;
  return at >= 0
    ? messages.map((m, i) => (i === at ? { ...m, mediaToolProposal: proposal } : m))
    : [...messages, { id: newId(), role: "assistant" as const, content: textContent, agentRunId: data.runId, mediaToolProposal: proposal }];
}

const patch = (messages: StudioChatMessage[], toolCallId: string, change: (p: StudioMediaToolProposal) => StudioMediaToolProposal) =>
  messages.map((m) => (m.mediaToolProposal?.toolCallId === toolCallId ? { ...m, mediaToolProposal: change(m.mediaToolProposal) } : m));

export function withMediaToolProgress(messages: StudioChatMessage[], data: MediaToolProgressEvent): StudioChatMessage[] {
  return patch(messages, data.toolCallId, (p) => (p.status === "done" || p.status === "failed" ? p
    : { ...p, status: "running", jobId: data.jobId, elapsed: data.elapsed }));
}

export function withMediaToolResult(messages: StudioChatMessage[], data: MediaToolResultEvent): StudioChatMessage[] {
  return patch(messages, data.toolCallId, (p) => ({
    ...p,
    jobId: data.jobId ?? p.jobId ?? null,
    status: data.status === "done" ? "done" : data.status === "failed" ? "failed" : "stillRunning",
    ...(data.assetIds ? { assetIds: data.assetIds } : {}),
    ...(typeof data.costMushies === "number" ? { costMushies: data.costMushies } : {}),
    ...(data.errorCode ? { error: data.errorCode } : {}),
  }));
}

/** The creator answered the card: running with what it now shows, or declined. */
export function withMediaToolAnswer(messages: StudioChatMessage[], toolCallId: string, answer: { approved: true; inputs: Record<string, unknown> } | { approved: false }): StudioChatMessage[] {
  return patch(messages, toolCallId, (p) => (answer.approved
    ? { ...p, inputs: answer.inputs, status: "running", elapsed: 0 }
    : { ...p, status: "declined" }));
}

/** A parked run_media_tool call (a reload): its tool and inputs, or null when it is not one. */
export function parkedMediaTool(call: { function?: { name?: string; arguments?: string } } | undefined): { tool: string; inputs: Record<string, unknown> } | null {
  if (call?.function?.name !== RUN_MEDIA_TOOL_NAME) return null;
  try {
    const args = JSON.parse(call.function.arguments || "{}") as { tool?: unknown; inputs?: unknown };
    if (typeof args.tool !== "string") return null;
    return { tool: args.tool, inputs: args.inputs && typeof args.inputs === "object" ? args.inputs as Record<string, unknown> : {} };
  } catch {
    return null;
  }
}
