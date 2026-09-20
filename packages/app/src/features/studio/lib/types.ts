/** A tool call returned by the LLM */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Result of executing a tool on the client */
export interface ToolResult {
  tool_call_id: string;
  name: string;
  status: "success" | "error";
  result: unknown;
  error?: string;
}

export type ProposalStatus = "pending" | "approved" | "rejected";

/** A saved server task awaiting an explicit resume action. */
export interface StudioCreditPause {
  runId: string;
  worldId: string;
  conversationId: string | null;
  phase: "preflight" | "generated";
  requiredCredits: number;
  iteration: number;
  hasSavedResult: boolean;
  billingUnavailable: boolean;
  cost?: number;
  settled?: boolean;
  balance?: number;
  availableCredits?: number;
  reservedCredits?: number;
  reason?: string;
  resumable?: boolean;
}

export type StudioImageProposalStatus = "pending" | "generating" | "done" | "failed" | "declined" | "stillGenerating";

/** The assistant proposed a picture; the creator decides on the card. */
export interface StudioImageProposal {
  runId: string;
  toolCallId: string;
  prompt: string;
  purpose?: string;
  aspectRatio: string;
  batchSize: number;
  model: string;
  /** Estimated mushies for one image (server-side estimate, not the charge). */
  unitMushies: number;
  estimatedMushies: number;
  status: StudioImageProposalStatus;
  jobId?: string;
  elapsed?: number;
  assetIds?: string[];
  costMushies?: number;
  error?: string;
}

/** Attachment stored on a chat message */
export interface ChatAttachment {
  url: string;
  key: string;
  mimeType: string;
  name: string;
}

/** A chat message in the Studio AI panel */
export interface StudioChatMessage {
  /** Unique message identifier for stable React keys and state matching */
  id: string;
  role: "user" | "assistant";
  content: string;
  /** File attachments (images) on this message */
  attachments?: ChatAttachment[];
  /** Tool calls made by the assistant in this turn */
  toolCalls?: ToolCall[];
  /** Auto-applied write tool calls retained for mobile change review */
  mobileReviewToolCalls?: ToolCall[];
  /** Results of executing those tool calls */
  toolResults?: ToolResult[];
  /** Approval state for write tool proposals */
  proposalStatus?: ProposalStatus;
  /** A generate_image card attached to this assistant turn */
  imageProposal?: StudioImageProposal;
  /** Links assistant messages to the agent run that produced them (for undo/rollback) */
  agentRunId?: string;
  /** Server-assigned ID for a committed text turn (`assistant_turn_commit` event).
   *  Used to dedup live commits vs recovery hydration — one bubble per commitId. */
  commitId?: string;
  /** Message was cut short because the user pressed Stop — show a subtle marker. */
  stopped?: boolean;
  /** This bubble is the "connection dropped" card rather than model output. It
   *  carries the run it belongs to so Reconnect can re-attach to THAT run
   *  instead of starting (and charging for) a second one. `dead` means we already
   *  looked and the server has nothing, so only Resend is left.
   *
   *  Deliberately absent from serializeStudioChatMessages: the card is a live
   *  offer, not history. Reloading re-runs the status check on its own, and a
   *  persisted card would sit above the answer that check just recovered. */
  disconnected?: { runId?: string; dead?: boolean };
}

/** Persist only JSON-safe chat fields used to restore Studio conversations. */
export function serializeStudioChatMessages(messages: StudioChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(({
    id,
    role,
    content,
    attachments,
    toolCalls,
    mobileReviewToolCalls,
    toolResults,
    proposalStatus,
    imageProposal,
    agentRunId,
    commitId,
    stopped,
  }) => ({
    id,
    role,
    content,
    ...(attachments && { attachments }),
    ...(toolCalls && { toolCalls }),
    ...(mobileReviewToolCalls && { mobileReviewToolCalls }),
    ...(toolResults && { toolResults }),
    ...(proposalStatus && { proposalStatus }),
    ...(imageProposal && { imageProposal }),
    ...(agentRunId && { agentRunId }),
    ...(commitId && { commitId }),
    ...(stopped && { stopped }),
  }));
}

export interface StudioChatContext {
  activePanel?: string;
  selectedElementId?: string | null;
  selectedElementType?: string | null;
}

/** Content part for multimodal messages */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Messages sent to the LLM via the server */
export type LLMMessage =
  | { role: "user" | "system"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Names of read tools that auto-execute without approval */
export const READ_TOOL_NAMES = new Set([
  "read_entity",
  "compile_tsx",
  "validate_ui_blueprint",
  "list_templates",
  "browse_assets",
  "load_skill",
  // V2 tools
  "read_entities",
]);

export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES.has(name);
}
