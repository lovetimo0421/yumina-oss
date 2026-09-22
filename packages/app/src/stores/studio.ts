import { create } from "zustand";
import { useEditorStore } from "./editor";
import { useCreditStore } from "@/edition/slots.state";
import { serializeStudioChatMessages } from "@/features/studio/lib/types";
import type { StudioImageProposal, StudioImageBatchProposal } from "@/features/studio/lib/types";
import { matchingImageBatch, proposalWithImageBatch } from "@/features/studio/lib/image-batch-state";
import { SMART_IMAGE_MODEL } from "@yumina/shared";
import type {
  StudioChatMessage,
  ToolCall,
  ToolResult,
  ChatAttachment,
  StudioCreditPause,
} from "@/features/studio/lib/types";
import { selectScopedStudioHistory, shouldAcceptStudioChatScope } from "@/features/studio/lib/agent-history-scope";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import {
  decideBase,
  parseHealth,
  serializeHealth,
  shouldProbe,
  UNKNOWN_HEALTH,
  type StreamBaseHealth,
} from "@/lib/stream-base-health";
import posthog from "posthog-js";
import { isAnalyticsEnabled } from "@/lib/analytics-enabled";

const apiBase = import.meta.env.VITE_API_URL || "";

// Studio surfaces all render through the `editor` namespace, so it is loaded
// wherever these failures can happen.
const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

// Long-lived AGENT STREAMS bypass Cloudflare here: CF Pro severs proxied
// connections at ~100s, which drops long agent runs (→ the "recovering" banner).
// When VITE_STREAM_URL points at a DNS-only (un-proxied) subdomain (e.g.
// https://stream.yumina.io → same Railway service), the stream connects direct
// to origin and isn't cut. Unset (dev / PR previews) → falls back to apiBase
// (same-origin), so nothing changes until the infra is wired up. The session
// cookie is already Domain=.yumina.io, and CORS already allowlists yumina.io with
// credentials, so cross-subdomain auth Just Works — no auth/CORS change needed.
const streamBase = import.meta.env.VITE_STREAM_URL || apiBase;

// ── Direct-origin stream health (China reachability fallback) ──
// The DNS-only stream base (stream.yumina.io) connects straight to the US
// origin with no Cloudflare edge in front. Some networks — mainland China in
// particular — can reach the CF-proxied apiBase but NOT the bare origin, so
// the agent stream dies at connect time while everything else works. Routing
// those users through apiBase keeps the assistant usable; the CF path's ~100s
// cut is covered by recovery polling ("recovering" banner on long runs).
//
// Reachability is settled by `probeStreamBase()` OUT of the send path — see
// lib/stream-base-health.ts for why. The send path only reads the cached
// reading; the connect deadline below is the safety net for a base that goes
// bad between probes.
const STREAM_BASE_HEALTH_KEY = "yumina:stream-base-health";
// In-memory mirror so storage-blocked contexts (private mode → SecurityError)
// still remember within the page lifetime.
let streamBaseHealth: StreamBaseHealth = UNKNOWN_HEALTH;
function readStreamBaseHealth(): StreamBaseHealth {
  let health = streamBaseHealth;
  try {
    const stored = parseHealth(sessionStorage.getItem(STREAM_BASE_HEALTH_KEY));
    if (stored.checkedAt > health.checkedAt) health = stored;
  } catch {
    /* storage unavailable — the in-memory mirror covers this page */
  }
  return health;
}
function writeStreamBaseHealth(status: "healthy" | "unhealthy"): void {
  streamBaseHealth = { status, checkedAt: Date.now() };
  try {
    sessionStorage.setItem(STREAM_BASE_HEALTH_KEY, serializeHealth(streamBaseHealth));
  } catch {
    /* storage unavailable — the in-memory mirror covers this page */
  }
}

/** Background reachability check. Cheap (a bare /health GET), never blocks a
 *  send, and never throws. Concurrent calls share one in-flight request.
 *
 *  This is what lets a VPN take effect: the old code recorded a failure and
 *  refused the direct base for 15 minutes, so switching networks mid-window
 *  changed nothing. Re-probing on focus/online flips the reading back within
 *  seconds of the network actually improving. */
let inFlightProbe: Promise<void> | null = null;
export function probeStreamBase(opts?: { force?: boolean }): Promise<void> {
  if (streamBase === apiBase) return Promise.resolve();
  if (inFlightProbe) return inFlightProbe;
  if (!opts?.force && !shouldProbe(readStreamBaseHealth(), Date.now())) {
    return Promise.resolve();
  }
  const run = async () => {
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(), STREAM_PROBE_TIMEOUT_MS);
    const startedAt = Date.now();
    let reachable = false;
    try {
      await fetch(`${streamBase}/health`, {
        method: "GET",
        cache: "no-store",
        signal: attempt.signal,
      });
      // Reaching this line is the whole answer: the origin responded. The
      // status code is deliberately ignored — a 5xx from a live origin is a
      // server problem, not a routing one, and routing sends around it would
      // only trade the direct base for the proxy's ~100s cut.
      reachable = true;
    } catch {
      // Reject or deadline — treat as unreachable and route sends via the proxy.
      reachable = false;
    } finally {
      clearTimeout(timer);
      writeStreamBaseHealth(reachable ? "healthy" : "unhealthy");
      inFlightProbe = null;
      // Now that the send path skips the direct base on a known-bad reading,
      // `stream_base_fallback` no longer fires for the users it was added to
      // find. This is the replacement signal for "who is routed around the
      // direct origin, and how long do they wait to find out".
      try {
        if (isAnalyticsEnabled()) posthog.capture("stream_base_probe", {
          reachable,
          duration_ms: Date.now() - startedAt,
          endpoint: "studio-agent",
        });
      } catch {
        /* analytics must never break the probe */
      }
    }
  };
  inFlightProbe = run();
  return inFlightProbe;
}
// Deadline for the background probe. Nothing waits on it, so it only has to be
// long enough to clear a slow-but-working link; a blocked route hangs and is
// cut here instead of costing a send its full connect deadline.
const STREAM_PROBE_TIMEOUT_MS = 5_000;
// Deadline for response HEADERS on the direct-origin attempt. Blocked routes
// usually hang (silent packet drop) rather than reject, so without this the
// user stares at a spinner for minutes instead of falling back in seconds.
// Only applied while a fallback attempt remains — never on the final attempt.
// Reached only when the probe has no fresh reading (see decideBase).
const STREAM_CONNECT_TIMEOUT_MS = 10_000;

// Module-level guard to prevent concurrent undo/regenerate operations
let _isUndoing = false;

// ── Streaming batch buffer ──
// Collect text/reasoning chunks in plain variables and flush to Zustand
// every ~80ms instead of on every single token.  This reduces re-renders
// from 50-100/s down to ~12/s during streaming.
let _textBuf = "";
let _reasoningBuf = "";
let _reasoningCharsBuf = 0;
let _streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
const STREAM_FLUSH_MS = 80;

function _doStreamFlush() {
  _streamFlushTimer = undefined;
  const text = _textBuf;
  const reasoning = _reasoningBuf;
  const chars = _reasoningCharsBuf;
  _textBuf = "";
  _reasoningBuf = "";
  _reasoningCharsBuf = 0;
  if (!text && !reasoning) return;
  useStudioStore.setState((s) => ({
    ...(text ? { chatStreamContent: s.chatStreamContent + text } : {}),
    ...(reasoning ? { reasoningContent: s.reasoningContent + reasoning, reasoningChars: s.reasoningChars + chars } : {}),
  }));
}

function bufferStreamText(text: string) {
  _textBuf += text;
  if (!_streamFlushTimer) _streamFlushTimer = setTimeout(_doStreamFlush, STREAM_FLUSH_MS);
}

function bufferStreamReasoning(content: string) {
  _reasoningBuf += content;
  _reasoningCharsBuf += content.length;
  if (!_streamFlushTimer) _streamFlushTimer = setTimeout(_doStreamFlush, STREAM_FLUSH_MS);
}

/** Flush any buffered streaming text/reasoning to store immediately. */
function flushStreamNow() {
  if (_streamFlushTimer) { clearTimeout(_streamFlushTimer); }
  _doStreamFlush();
}

// ── World schema refresh ──
function flushRefresh() {
  useEditorStore.getState().refreshWorldSchema().catch(() => {});
}

function nextMsgId(): string {
  return `msg-${crypto.randomUUID()}`;
}

interface StudioAgentScope {
  worldId: string;
  conversationId: string | null;
}

// Invalidates callbacks even when navigation returns to the same conversation.
let studioAgentEpoch = 0;
let creditRefreshEpoch = 0;

function isCurrentStudioWorld(worldId: string) {
  return useEditorStore.getState().serverWorldId === worldId;
}

function isActiveStudioChatScope(scope: StudioAgentScope) {
  const state = useStudioStore.getState();
  return (
    isCurrentStudioWorld(scope.worldId) &&
    shouldAcceptStudioChatScope(
      { worldId: state.chatWorldId, conversationId: state.chatConversationId },
      scope,
      state.chatMessages.length,
    )
  );
}

function isActiveStudioRunScope(scope: StudioAgentScope, runId: string | null) {
  const state = useStudioStore.getState();
  return isActiveStudioChatScope(scope) && runId !== null && state._currentRunId === runId;
}

function isActiveStudioStreamScope(scope: StudioAgentScope, runId: string | null) {
  return runId === null ? isActiveStudioChatScope(scope) : isActiveStudioRunScope(scope, runId);
}

// Re-export types for backward compat
export type { StudioChatMessage, ToolCall, ToolResult, StudioCreditPause };

interface StudioState {
  // Chat
  chatMessages: StudioChatMessage[];
  isChatStreaming: boolean;
  chatStreamContent: string;
  chatAttachments: File[];
  chatWorldId: string | null;
  chatConversationId: string | null;

  // Agent (server-side)
  isAgentWorking: boolean;
  agentIteration: number;
  agentMaxIterations: number;
  reasoningChars: number;
  /** Accumulated reasoning/thinking text for display */
  reasoningContent: string;
  /** Number of entities applied so far in this iteration */
  appliedCount: number;
  /** Tool argument generation progress (bytes received via tool_delta events) */
  toolGenChars: number;
  /** Name of the tool currently being generated (e.g., "apply_changes") */
  toolGenName: string | null;
  /** SSE stream was interrupted and tryRecoverAgentRun is polling for server-side
   *  liveness. UI shows a "reconnecting" banner instead of a terminal error until
   *  recovery succeeds (cleared by onDone/onProposal) or definitively fails
   *  (cleared by onError, which then shows the real error). */
  isRecovering: boolean;
  _agentAbortController: AbortController | null;
  _currentRunId: string | null;
  creditPause: StudioCreditPause | null;
  isResumingCredits: boolean;
  isRefreshingCreditPause: boolean;
  /** A manual Reconnect is in flight. Distinct from isRefreshingCreditPause,
   *  which also fires on mount and tab focus and must stay silent. */
  isReconnecting: boolean;
  creditPauseError: string | null;

  // Approval (server-side — pending proposal from server)
  _pendingApproval: {
    runId: string;
    toolCalls: ToolCall[];
  } | null;
  /** A generate_image card waiting for the creator's answer */
  _pendingImage: { runId: string; toolCallId: string } | null;
  _pendingImageBatch: { runId: string; toolCallId: string } | null;

  // Selection
  selectedElementId: string | null;
  selectedElementType: string | null;

  // Mode
  mode: "edit" | "playtest";
  activePanel: string;

  // Actions
  sendChatMessage: (worldId: string, content: string, model: string, conversationId?: string | null) => Promise<void>;
  resumeCreditPause: () => Promise<void>;
  refreshCreditPause: (worldId: string, conversationId?: string | null, runId?: string) => Promise<void>;
  /** Re-attach to a run whose stream died, from the "connection dropped" card.
   *  Read-only: it never starts a model, so it costs nothing to press. */
  reconnectAgent: (worldId: string, conversationId?: string | null, runId?: string) => Promise<void>;
  /** Same button, but while the recovery banner is still up and a poller is
   *  already attached: poll now and reset the give-up budget. */
  nudgeRecovery: () => void;
  stopAgent: () => void;
  approveProposal: () => void;
  rejectProposal: () => void;
  confirmImageProposal: (edits: { prompt: string; aspectRatio: string; batchSize: number }) => void;
  declineImageProposal: () => void;
  updateImageBatchProposal: (worldId: string, conversationId: string | null, proposal: StudioImageBatchProposal) => void;
  setSelectedElement: (id: string | null, type?: string | null) => void;
  setMode: (mode: "edit" | "playtest") => void;
  setActivePanel: (panel: string) => void;
  clearChat: () => void;
  undoLastTurn: (worldId: string, conversationId?: string | null) => Promise<void>;
  regenerateLastTurn: (worldId: string, model: string, conversationId?: string | null) => Promise<void>;
  /** The only honest exit from a stuck pause (a paid result the editor outran):
   *  discard that step server-side and start a fresh request that continues
   *  from the card as it is now. Never undoes anything — the creator's own
   *  edits are exactly what made the old step stale. */
  restartFromPause: (worldId: string, model: string, conversationId?: string | null) => Promise<void>;
  addChatAttachment: (file: File) => void;
  removeChatAttachment: (index: number) => void;
}

// ── Agent SSE Stream Parser ──

interface AgentStreamCallbacks {
  scope?: StudioAgentScope;
  isActive?: () => boolean;
  onRunStarted?: (runId: string) => void;
  onReasoning?: (content: string) => void;
  onText: (content: string) => void;
  onIteration: (iteration: number, max: number) => void;
  onToolStart: (data: { index: number; id: string; name: string }) => void;
  onToolDelta?: (data: { index: number; arguments: string }) => void;
  onToolEnd: (data: { index: number; id: string; name: string; arguments: string }) => void;
  onProposal: (data: { runId: string; textContent: string; writeToolCalls: ToolCall[]; readResults: ToolResult[]; approvalReason?: string }) => void;
  /** The assistant proposed a picture (generate_image). Terminal like a proposal:
   *  the run waits in awaiting_approval until the creator answers the card. */
  onImageProposal?: (data: Omit<StudioImageProposal, "status"> & { textContent: string }) => void;
  onImageBatchProposal?: (data: Omit<StudioImageBatchProposal, "status"> & { textContent: string; status?: StudioImageBatchProposal["status"] }) => void;
  onImageProgress?: (data: { runId: string; toolCallId: string; jobId: string; status: string; elapsed: number }) => void;
  onImageResult?: (data: { runId: string; toolCallId: string; jobId: string; status: "done" | "failed" | "pending"; assetIds?: string[]; costMushies?: number; errorCode?: string }) => void;
  /** Server has committed one assistant text turn as a persistent chat bubble.
   *  The ONLY code path that appends an assistant message to chatMessages during a run —
   *  replaces the old split where onReadToolsExecuted and onDone both tried to commit. */
  onAssistantTurnCommit: (data: { runId: string; iteration: number; textContent: string; commitId: string; writeToolCalls?: ToolCall[] }) => void;
  /** Run terminated. Payload is intentionally tiny — all bubble content arrives via
   *  assistant_turn_commit, and the client just cleans up streaming/working state here. */
  onDone: (data: { runId: string }) => void;
  onReadToolsExecuted: (data: { iteration: number }) => void;
  /** V2: Changes were auto-executed (safe creates/updates) */
  onApplied?: (data: { changes: number; autoExecuted: boolean; reason: string }) => void;
  /** SSE stream dropped — recovery polling is starting. UI should switch to a
   *  transient "reconnecting" state instead of immediately showing a terminal
   *  error. Follow-up callback (onDone / onProposal / onError) clears it. */
  onStreamInterrupted?: () => void;
  /** One recovery poll came back and the run is still alive server-side. Carries
   *  the server's own progress so the disconnected UI can show what the agent is
   *  actually doing instead of an indefinite spinner. Fires on every successful
   *  poll (~5s), so the banner ticks even though no SSE bytes are arriving. */
  onRecoveryProgress?: (data: { runId: string; iteration: number; maxIterations: number; committedTurns: number }) => void;
  onCredits?: (data: Record<string, unknown>) => void;
  onCreditsPaused?: (data: Record<string, unknown>) => void;
  /** The server threw away what this step streamed so far (an editor save
   *  landed while the model was generating) and is generating it again. The
   *  retry streams fresh; whatever the dropped attempt showed must not be
   *  prepended to it. */
  onStepRestarted?: (data: { runId: string; iteration: number; reason: string }) => void;
  onError: (error: string, code?: string) => void;
}

/**
 * Try to recover a disconnected agent run by polling the server status.
 *
 * SSE disconnects happen for routine reasons on long agent runs:
 *  - Cloudflare edge closes connections at ~100s (free tier hard limit)
 *  - Railway/network hiccups
 *  - Mobile/VPN transitions
 * Meanwhile the server-side agent keeps iterating and writes terminal
 * status to the `agent_runs` table. This poller waits it out.
 *
 * Strategy: poll adaptively. Keep polling as long as the server shows
 * progress (status=running with a recent `updatedAt`). Only give up if
 * the server record has been stale for >2 min (agent process died).
 *
 * Returns true if recovery succeeded (callback already dispatched), false otherwise.
 */
async function tryRecoverAgentRun(
  runId: string | undefined,
  callbacks: AgentStreamCallbacks,
): Promise<boolean> {
  const worldId = callbacks.scope?.worldId ?? useEditorStore.getState().serverWorldId;
  if (!worldId) return false;

  const STALE_MS = 120_000;     // give up if updatedAt hasn't moved in 2 min
  // Absolute ceiling. MUST outlast the server's own ABSOLUTE_TIMEOUT_MS
  // (routes/agent.ts) — the agent keeps iterating and writing to the world long
  // after the SSE drops, so a client cap SHORTER than the server's reports a
  // healthy long run as a connection failure while it is still editing the card.
  // This was 15 min while the server allowed 30 (raised 2026-07-17 for single
  // 24-min iterations), so every run past 15 min was a guaranteed fake error.
  // Server budget + 2 min for the terminal write to land.
  const HARD_CAP_MS = 1_920_000; // 32 min
  const POLL_INTERVAL_MS = 5_000;

  // Resolve the runId: if we don't have one (SSE died before run_started event),
  // query the server for the latest running agent on this world. The status
  // endpoint already supports runId-less lookups.
  let effectiveRunId = runId;

  const start = Date.now();
  let lastUpdatedAt = 0;
  let lastProgressAt = Date.now();
  let consecutiveNetErrs = 0;

  // Bubbles already handed to the store during THIS recovery. The server keeps
  // committing turns while we are disconnected, and every poll returns the whole
  // list, so without a local guard a 10-minute recovery would re-dispatch the
  // same turn ~120 times. onAssistantTurnCommit is idempotent by commitId, so
  // this is about churn, not correctness.
  const emittedCommitIds = new Set<string>();
  const emitTurns = (turns: unknown, recoveredRunId: string) => {
    if (!Array.isArray(turns)) return 0;
    for (const turn of turns) {
      const commitId = (turn as { commitId?: unknown })?.commitId;
      if (typeof commitId !== "string" || emittedCommitIds.has(commitId)) continue;
      emittedCommitIds.add(commitId);
      const t = turn as { iteration?: number; textContent?: string; writeToolCalls?: unknown };
      callbacks.onAssistantTurnCommit({
        runId: recoveredRunId,
        iteration: t.iteration ?? 0,
        textContent: t.textContent ?? "",
        commitId,
        writeToolCalls: Array.isArray(t.writeToolCalls) ? (t.writeToolCalls as ToolCall[]) : undefined,
      });
    }
    return turns.length;
  };

  // Wake the poll sleep immediately when the user returns to the tab or when the
  // network comes back online. Without this we'd wait up to POLL_INTERVAL_MS
  // after reconnect before trying again — and mobile Safari often produces a
  // burst of initial connection failures right as the radio re-engages, so
  // getting the first successful poll in as early as possible materially cuts
  // the window where recovery could falsely give up.
  let wakeResolve: (() => void) | null = null;
  const poke = () => {
    if (!wakeResolve) return;
    const r = wakeResolve;
    wakeResolve = null;
    r();
  };
  const onOnline = () => poke();
  const onVisibility = () => {
    if (document.visibilityState === "visible") poke();
  };
  const onNudge = () => {
    // An explicit press is a statement that the creator is still waiting, so
    // reset every clock that could cut the run short and poll immediately.
    lastProgressAt = Date.now();
    consecutiveNetErrs = 0;
    poke();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener(AGENT_RECOVERY_NUDGE, onNudge);
  document.addEventListener("visibilitychange", onVisibility);

  try {
    while (Date.now() - start < HARD_CAP_MS) {
      if (callbacks.isActive && !callbacks.isActive()) return true;
      await new Promise<void>((resolve) => {
        wakeResolve = resolve;
        setTimeout(() => {
          if (wakeResolve) {
            wakeResolve = null;
            resolve();
          }
        }, POLL_INTERVAL_MS);
      });

      if (callbacks.isActive && !callbacks.isActive()) return true;

      try {
        const statusUrl = effectiveRunId
          ? `${apiBase}/api/studio/${worldId}/agent/status?runId=${effectiveRunId}`
          : `${apiBase}/api/studio/${worldId}/agent/status${callbacks.scope ? `?conversationId=${encodeURIComponent(callbacks.scope.conversationId ?? "")}` : ""}`;
        const res = await fetch(statusUrl, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data } = await res.json();
        if (callbacks.isActive && !callbacks.isActive()) return true;
        consecutiveNetErrs = 0;

        if (!data) {
          // No record at all — agent never started or was cleared. Give up.
          return false;
        }
        if (effectiveRunId && data.id !== effectiveRunId) return false;
        if (callbacks.scope && data.conversationId !== undefined && data.conversationId !== callbacks.scope.conversationId) return false;

        // Latch the runId from the server response so subsequent polls use it
        if (!effectiveRunId && data.id) {
          effectiveRunId = data.id;
        }

        // Guard against stale runs: if we didn't have a runId to begin with
        // (SSE died before run_started), verify the server-returned run is
        // recent. An old completed run from hours ago should not trigger recovery.
        if (!runId && data.updatedAt) {
          const age = Date.now() - new Date(data.updatedAt).getTime();
          if (age > 5 * 60_000 && data.status !== "running") {
            return false;
          }
        }

        const recoveredRunId = effectiveRunId ?? data.id ?? runId ?? "";
        callbacks.onRunStarted?.(recoveredRunId);

        if (data.status === "awaiting_credits" || data.creditPause?.resumable === true || data.status === "error") {
          emitTurns(data.committedTurns, recoveredRunId);
          if (data.creditPause && (data.status === "awaiting_credits" || data.creditPause.resumable === true)) {
            callbacks.onCreditsPaused?.({ ...data.creditPause, runId: recoveredRunId,
              reason: data.creditPause.reason ?? (data.error === "STALE_WORLD" ? data.error : undefined) });
            return true;
          }
        }

        if (data.status === "awaiting_approval" && data.imageBatchProposal) {
          emitTurns(data.committedTurns, recoveredRunId);
          callbacks.onImageBatchProposal?.({ ...data.imageBatchProposal, runId: recoveredRunId });
          return true;
        }
        if (data.status === "completed") {
          // Hydrate any committed turns the client missed while disconnected.
          // onAssistantTurnCommit is idempotent by commitId, so live and recovery
          // paths can safely emit for the same turn without duplicating bubbles.
          emitTurns(data.committedTurns, recoveredRunId);
          if (data.imageBatchProposal) {
            const proposal = { ...data.imageBatchProposal, runId: recoveredRunId } as StudioImageBatchProposal;
            const batch = matchingImageBatch(proposal, worldId, data.imageBatches ?? []);
            callbacks.onImageBatchProposal?.({ ...proposal, textContent: data.imageBatchProposal.textContent ?? "", ...(batch ? { batch } : {}) });
            return true;
          }
          callbacks.onDone({ runId: recoveredRunId });
          return true;
        }
        if (data.status === "awaiting_approval" && data.pendingToolCalls?.[0]?.function?.name === "generate_image" && data.pendingToolCalls.length === 1) {
          const call = data.pendingToolCalls[0];
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* unusable args: still show the card */ }
          let unitMushies = 0;
          try {
            const res = await fetch(`${apiBase}/api/generation/templates`, { credentials: "include" });
            const body = await res.json();
            unitMushies = Number(body?.smartEstimates?.[SMART_IMAGE_MODEL] ?? 0) || 0;
          } catch { /* estimate unknown after a reload; the card says so */ }
          const batchSize = Math.min(4, Math.max(1, Math.round(Number(args.batchSize ?? 1)) || 1));
          callbacks.onImageProposal?.({
            runId: recoveredRunId, toolCallId: call.id, textContent: data.textContent ?? "",
            prompt: typeof args.prompt === "string" ? args.prompt : "", purpose: typeof args.purpose === "string" ? args.purpose : undefined,
            aspectRatio: typeof args.aspectRatio === "string" ? args.aspectRatio : "1:1", batchSize,
            model: SMART_IMAGE_MODEL, unitMushies, estimatedMushies: Math.ceil(unitMushies * batchSize * 10) / 10,
          });
          return true;
        }
        if (data.status === "awaiting_approval" && data.pendingToolCalls) {
          callbacks.onProposal({
            runId: recoveredRunId,
            textContent: data.textContent ?? "",
            writeToolCalls: data.pendingToolCalls,
            readResults: data.readToolResults ?? [],
          });
          return true;
        }
        // ask_user yields control — the run is done from the agent's perspective
        if (data.status === "awaiting_user") {
          emitTurns(data.committedTurns, recoveredRunId);
          callbacks.onDone({ runId: recoveredRunId });
          return true;
        }
        const waitingForClaimRecovery = !!data.creditPause && data.creditPause.resumable === false
          && !data.creditPause.billingUnavailable && data.creditPause.reason !== "STALE_WORLD"
          && !/stopped by user|superseded/i.test(String(data.error ?? ""));
        if (data.status === "error" && !waitingForClaimRecovery) {
          callbacks.onError(data.error ?? "Agent failed while disconnected");
          return true;
        }

        // Still running. Two things happen on every poll, both of which used to
        // wait until the run finished:
        //   1. Bubbles the agent has committed since the disconnect are handed to
        //      the store NOW, so the conversation keeps growing on screen.
        //   2. The server's own step counter is reported, so the UI can say what
        //      the agent is doing rather than spin indefinitely. Users were
        //      killing healthy runs at step 7/50 because nothing on screen moved.
        emitTurns(data.committedTurns, recoveredRunId);
        callbacks.onRecoveryProgress?.({
          runId: recoveredRunId,
          iteration: typeof data.iteration === "number" ? data.iteration : 0,
          maxIterations: typeof data.maxIterations === "number" ? data.maxIterations : 0,
          committedTurns: emittedCommitIds.size,
        });

        // Track liveness via the updatedAt timestamp. The server heartbeat bumps
        // it every 5s while the agent loop is alive, so a 2-min gap now reliably
        // means the Node process has actually died.
        const updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
        if (updatedAt > lastUpdatedAt) {
          lastUpdatedAt = updatedAt;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > (data.creditPause ? 6 * 60_000 : STALE_MS)) {
          return false;
        }
      } catch {
        // Network error on the poll itself — back off but keep trying much
        // longer than before. The visibility/online poke above means the user
        // experiences near-zero recovery latency when their connection actually
        // returns, so this budget only governs how long we keep hoping during
        // an outage — ~2.5 min of back-to-back poll failures before we give up.
        consecutiveNetErrs++;
        if (consecutiveNetErrs >= 30) return false;
      }
    }
    return false;
  } finally {
    window.removeEventListener("online", onOnline);
    window.removeEventListener(AGENT_RECOVERY_NUDGE, onNudge);
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

/** Fired when the creator presses Reconnect while the recovery poller is already
 *  running. The poller listens for it exactly like "online" and "visibilitychange":
 *  wake up now instead of sleeping out the interval. It also clears the give-up
 *  budget, so a press always buys the run a fresh 2 minutes. */
const AGENT_RECOVERY_NUDGE = "yumina:agent-recovery-nudge";

// ── Abandoned-run ledger ────────────────────────────────────────────────────
// "The conversation ends on an unanswered question" is NOT enough to justify
// replaying a finished run's bubbles: a creator who removed an assistant turn
// leaves the same shape, and resurrecting it on every tab focus would be worse
// than the bug being fixed (studio-credit-recovery.test.ts pins that).
//
// So record the unambiguous fact instead: THIS browser watched the run, lost the
// stream, polled until it gave up, and showed an error. A turn the user deleted
// was never abandoned, so it can never be revived through this path.
const ABANDONED_RUNS_KEY = "yumina:studio-abandoned-runs";
const ABANDONED_TTL_MS = 24 * 60 * 60_000;
const ABANDONED_MAX = 20;

type AbandonedEntry = { runId: string; at: number };

function readAbandonedRuns(): AbandonedEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ABANDONED_RUNS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const cutoff = Date.now() - ABANDONED_TTL_MS;
    return raw.filter((entry): entry is AbandonedEntry =>
      !!entry && typeof entry.runId === "string" && typeof entry.at === "number" && entry.at > cutoff);
  } catch {
    return []; // private mode / blocked storage — the rescue path just stays off
  }
}

function rememberAbandonedRun(runId: string | undefined): void {
  if (!runId) return;
  try {
    const next = [{ runId, at: Date.now() }, ...readAbandonedRuns().filter(e => e.runId !== runId)]
      .slice(0, ABANDONED_MAX);
    localStorage.setItem(ABANDONED_RUNS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable; nothing to rescue later, which is the safe direction */
  }
}

function forgetAbandonedRun(runId: string): void {
  try {
    localStorage.setItem(ABANDONED_RUNS_KEY,
      JSON.stringify(readAbandonedRuns().filter(e => e.runId !== runId)));
  } catch {
    /* see above */
  }
}

function wasAbandonedHere(runId: unknown): boolean {
  return typeof runId === "string" && readAbandonedRuns().some(e => e.runId === runId);
}

/** Translate raw browser network errors (Safari "Load failed", Chrome
 *  "Failed to fetch", Firefox "NetworkError…") into a single actionable
 *  message. This fires after recovery polling has already been attempted and
 *  failed, so the wording tells the user to retry rather than implying
 *  an auto-reconnect is in progress. */
function friendlyNetworkError(raw: string): string {
  if (/load failed|failed to fetch|network\s?error|network request failed|network connection was lost/i.test(raw)) {
    return "Connection lost — please check your network and try again.";
  }
  return raw;
}

/**
 * Connect to a server-side agent SSE stream and dispatch events.
 * Returns an AbortController for cancellation.
 *
 * `path` is the API path (e.g. `/api/studio/:id/agent/start`); the base is
 * chosen internally. With `opts.preferStreamBase` the direct-origin
 * streamBase is tried first (skips CF's ~100s cut), falling back once to the
 * CF-proxied apiBase when the direct origin is unreachable (mainland China).
 */
function connectAgentSSE(
  path: string,
  body: Record<string, unknown>,
  callbacks: AgentStreamCallbacks,
  signal?: AbortSignal,
  opts?: { preferStreamBase?: boolean },
): AbortController {
  const controller = new AbortController();
  const startedAt = Date.now();

  // Record a Studio-agent stream failure (only at genuine give-up points, after
  // recovery polling has failed) so it shows up alongside the chat stream's
  // `llm_stream_failed` events. Mirrors sse.ts; never let analytics throw.
  const captureFailure = (errorType: string, rawMessage: string) => {
    try {
      if (typeof window === "undefined") return;
      if (isAnalyticsEnabled()) posthog.capture("llm_stream_failed", {
        error_type: errorType,
        raw_message: rawMessage.slice(0, 300),
        duration_ms: Date.now() - startedAt,
        visibility_state:
          typeof document !== "undefined" ? document.visibilityState : "unknown",
        endpoint: "studio-agent",
        model: typeof body.model === "string" ? body.model : undefined,
      });
    } catch {
      /* analytics must never break streaming */
    }
  };

  // Track runId from two sources: the SSE `run_started` event (authoritative),
  // and the `X-Agent-Run-Id` response header (available immediately, before any
  // SSE events are parsed). The header fallback ensures recovery works even if
  // the stream dies before the first event arrives.
  let runId: string | undefined = typeof body.runId === "string" ? body.runId : undefined;

  // Chain with external signal
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // Resolve the connection: try the direct stream base first when preferred
  // (with a header deadline), fall back ONCE to the CF-proxied apiBase. An
  // HTTP error status never triggers fallback (origin reachable → surfaced
  // normally below). Outright rejections re-send immediately; header TIMEOUTS
  // first probe for an already-started run to avoid duplicating work (see the
  // timedOut branch in connectFetch).
  const doFetch = (base: string, timeoutMs?: number) => {
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    controller.signal.addEventListener("abort", abortAttempt, { once: true });
    const timer = timeoutMs !== undefined ? setTimeout(abortAttempt, timeoutMs) : undefined;
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
      signal: attempt.signal,
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  const connectFetch = async (): Promise<Response> => {
    const eligible = (opts?.preferStreamBase ?? false) && streamBase !== apiBase;
    // A fresh probe reading decides without costing this send anything. Only an
    // absent/stale one falls through to the old inline race, so a network we
    // know nothing about still gets the direct base's CF-cut bypass.
    const decision = eligible ? decideBase(readStreamBaseHealth(), Date.now()) : "proxy";
    if (decision === "proxy") {
      // Known-unreachable (or not eligible): skip the deadline entirely. This
      // is the 10s-per-message tax that made the assistant feel broken.
      if (eligible) void probeStreamBase(); // refresh in the background for next time
      return doFetch(apiBase);
    }
    try {
      // Keep the deadline even on a "healthy" reading: it can be up to a TTL
      // old, and a network that went bad since hangs silently rather than
      // rejecting. On a genuinely reachable origin headers land in well under
      // a second, so this costs nothing.
      return await doFetch(streamBase, STREAM_CONNECT_TIMEOUT_MS);
    } catch (err) {
      if (controller.signal.aborted) throw err;
      writeStreamBaseHealth("unhealthy");
      const timedOut = err instanceof DOMException && err.name === "AbortError";
      // Distinct event (NOT llm_stream_failed — the send usually SUCCEEDS via
      // the fallback; this is a routing decision, and llm_stream_failed
      // baselines are used for triage).
      try {
        if (isAnalyticsEnabled()) posthog.capture("stream_base_fallback", {
          raw_message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          timed_out: timedOut,
          duration_ms: Date.now() - startedAt,
          endpoint: "studio-agent",
          model: typeof body.model === "string" ? body.model : undefined,
        });
      } catch {
        /* analytics must never break streaming */
      }
      console.warn(
        "[AgentSSE] direct stream base unreachable — falling back to the proxied API base",
        err,
      );

      // A TIMEOUT abort (unlike an outright rejection) does NOT prove the
      // request never reached the server: the request path may have gotten
      // through while the response path is blocked, or the origin's DB
      // preflight may be crawling. Re-sending would then start a DUPLICATE
      // run (double credit burn + supersede races). Probe the status endpoint
      // once through the proxied base: a fresh RUNNING run means the original
      // request landed — attach to it via the recovery poller instead of
      // re-sending. Completed/stale runs never match (a just-finished
      // previous run must not be replayed as this message's answer).
      if (timedOut) {
        let attachRunId: string | undefined;
        try {
          const worldId = callbacks.scope?.worldId ?? useEditorStore.getState().serverWorldId;
          if (worldId) {
            const query = runId ? `?runId=${encodeURIComponent(runId)}`
              : callbacks.scope ? `?conversationId=${encodeURIComponent(callbacks.scope.conversationId ?? "")}` : "";
            const res = await fetch(`${apiBase}/api/studio/${worldId}/agent/status${query}`, {
              credentials: "include",
            });
            const { data } = await res.json();
            const age = data?.updatedAt
              ? Date.now() - new Date(data.updatedAt).getTime()
              : Number.POSITIVE_INFINITY;
            if (data?.status === "running" && typeof data.id === "string" && age < 30_000
              && (!runId || data.id === runId)
              && (!callbacks.scope || data.conversationId === undefined || data.conversationId === callbacks.scope.conversationId)) {
              attachRunId = data.id;
            }
          }
        } catch {
          /* probe failed — no evidence a run exists; fall through to re-send */
        }
        if (attachRunId) {
          runId = attachRunId;
          throw err; // outer .catch → tryRecoverAgentRun(runId) attaches to the live run
        }
      }
      return doFetch(apiBase);
    }
  };

  connectFetch()
    .then(async (response) => {
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Request failed" }));
        captureFailure(`http_${response.status}`, String(err.error ?? response.status));
        callbacks.onError(err.error || `HTTP ${response.status}`, typeof err.code === "string" ? err.code : undefined);
        return;
      }

      // Grab runId from response header immediately — before reading the
      // stream body. Even if the SSE connection dies before the run_started
      // event, recovery can proceed because it already knows the runId.
      const headerRunId = response.headers.get("X-Agent-Run-Id");
      if (headerRunId) {
        runId = headerRunId;
        callbacks.onRunStarted?.(headerRunId);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        callbacks.onError("No response body");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let receivedTerminalEvent = false;
      let currentEvent = "";

      while (true) {
        if (controller.signal.aborted || (callbacks.isActive && !callbacks.isActive())) return;
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (readErr) {
          if (readErr instanceof DOMException && readErr.name === "AbortError") return;
          // Stream read failed — try recovery before giving up
          console.warn("[AgentSSE] Stream read failed — attempting recovery", readErr);
          callbacks.onStreamInterrupted?.();
          const recovered = await tryRecoverAgentRun(runId, callbacks);
          if (recovered) return;
          // Give-up is on the record: the agent may still land a result we can
          // rescue the next time this conversation loads.
          rememberAbandonedRun(runId);
          captureFailure("read_error", readErr instanceof Error ? readErr.message : "Stream read failed");
          callbacks.onError(friendlyNetworkError(
            readErr instanceof Error ? readErr.message : "Stream read failed",
          ), "DISCONNECTED");
          return;
        }
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.slice(6));
              switch (currentEvent) {
                case "reasoning":
                  if (parsed.content) callbacks.onReasoning?.(parsed.content);
                  break;
                case "text":
                  if (parsed.content) callbacks.onText(parsed.content);
                  break;
                case "iteration":
                  callbacks.onIteration(parsed.iteration, parsed.maxIterations);
                  break;
                case "tool_start":
                  callbacks.onToolStart(parsed);
                  break;
                case "tool_delta":
                  callbacks.onToolDelta?.(parsed);
                  break;
                case "tool_end":
                  callbacks.onToolEnd(parsed);
                  break;
                case "proposal":
                  receivedTerminalEvent = true; // V1: server closes stream after proposal
                  callbacks.onProposal(parsed);
                  break;
                case "image_proposal":
                  receivedTerminalEvent = true; // the run waits for the creator's answer
                  callbacks.onImageProposal?.(parsed);
                  break;
                case "image_batch_proposal":
                  receivedTerminalEvent = true;
                  callbacks.onImageBatchProposal?.(parsed);
                  break;
                case "image_progress":
                  callbacks.onImageProgress?.(parsed);
                  break;
                case "image_result":
                  callbacks.onImageResult?.(parsed);
                  break;
                case "done":
                  receivedTerminalEvent = true;
                  callbacks.onDone(parsed);
                  break;
                case "read_tools_executed":
                  callbacks.onReadToolsExecuted(parsed);
                  break;
                case "assistant_turn_commit":
                  if (parsed.commitId) callbacks.onAssistantTurnCommit(parsed);
                  break;
                case "applied":
                  callbacks.onApplied?.(parsed);
                  break;
                case "credits":
                  // A Studio turn can settle many model calls before it ends.
                  // Use the actual wallet total, not the temporary spend hold.
                  callbacks.onCredits?.(parsed);
                  break;
                case "credits_paused":
                  receivedTerminalEvent = true;
                  callbacks.onCreditsPaused?.(parsed);
                  break;
                case "step_restarted":
                  callbacks.onStepRestarted?.(parsed);
                  break;
                case "error":
                  receivedTerminalEvent = true;
                  if (!callbacks.isActive || callbacks.isActive()) void useCreditStore.getState().forceFetchCredits().catch(() => {});
                  callbacks.onError(parsed.error ?? "Unknown error", typeof parsed.code === "string" ? parsed.code : undefined);
                  break;
                case "run_started":
                  if (parsed.runId && parsed.runId !== runId) {
                    runId = parsed.runId;
                    callbacks.onRunStarted?.(parsed.runId);
                  }
                  break;
                case "heartbeat":
                  break; // keepalive — no action needed
              }
            } catch {
              // skip malformed JSON
            }
            currentEvent = "";
            if (receivedTerminalEvent) break;
          }
        }
        if (receivedTerminalEvent) {
          void reader.cancel().catch(() => {});
          return;
        }
      }

      // Safety net: stream closed without done/error event — try to recover from server
      if (!receivedTerminalEvent) {
        console.warn("[AgentSSE] Stream closed without done/error event — attempting recovery");
        callbacks.onStreamInterrupted?.();
        const recovered = await tryRecoverAgentRun(runId, callbacks);
        if (!recovered) {
          rememberAbandonedRun(runId);
          captureFailure("closed_no_terminal", "Stream closed without done/error event");
          callbacks.onError("Connection closed unexpectedly. Try again.", "DISCONNECTED");
        }
      }
    })
    .catch(async (err) => {
      if (controller.signal.aborted) return;

      // SSE disconnect recovery: check if the agent finished server-side
      console.warn("[AgentSSE] fetch pipeline failed — attempting recovery", err);
      callbacks.onStreamInterrupted?.();
      const recovered = await tryRecoverAgentRun(runId, callbacks);
      if (!recovered) {
        rememberAbandonedRun(runId);
        const raw = err instanceof Error ? err.message : "Connection failed";
        const isNetworkError =
          /load failed|failed to fetch|networkerror|network request failed|network connection was lost/i.test(raw);
        captureFailure(isNetworkError ? "network" : "fetch_other", raw);
        callbacks.onError(friendlyNetworkError(raw), "DISCONNECTED");
      }
    });

  return controller;
}

// (old streamSingleTurn removed — agent loop now runs server-side)

// ── File Upload Helper ──

async function uploadAttachments(files: File[]): Promise<ChatAttachment[]> {
  const results: ChatAttachment[] = [];

  for (const file of files) {
    // 1. Get presigned upload URL
    const urlRes = await fetch(`${apiBase}/api/studio/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        fileSize: file.size,
      }),
    });

    if (!urlRes.ok) {
      const err = await urlRes.json().catch(() => ({ error: "Upload failed" }));
      throw new Error(err.error || "Failed to get upload URL");
    }

    const { data } = await urlRes.json();

    // 2. Upload file directly to S3
    const putRes = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });

    if (!putRes.ok) {
      throw new Error(`Failed to upload ${file.name}`);
    }

    // 3. Get download URL for the uploaded file
    const dlRes = await fetch(`${apiBase}/api/studio/download-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ key: data.key }),
    });

    if (!dlRes.ok) {
      throw new Error(`Failed to get download URL for ${file.name}`);
    }

    const dlData = await dlRes.json();

    results.push({
      url: dlData.data.url,
      key: data.key,
      mimeType: file.type,
      name: file.name,
    });
  }

  return results;
}

function parseCreditPause(value: Record<string, unknown>, scope: StudioAgentScope, runId: string): StudioCreditPause | null {
  if ((value.phase !== "preflight" && value.phase !== "generated") || !runId
    || typeof value.requiredCredits !== "number" || !Number.isFinite(value.requiredCredits) || value.requiredCredits < 0) return null;
  const finite = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : undefined;
  return { ...scope, runId, phase: value.phase, requiredCredits: value.requiredCredits,
    iteration: finite("iteration") ?? 0, hasSavedResult: value.hasSavedResult === true,
    billingUnavailable: value.billingUnavailable === true,
    cost: finite("cost"), settled: typeof value.settled === "boolean" ? value.settled : undefined,
    balance: finite("balance"), availableCredits: finite("availableCredits"), reservedCredits: finite("reservedCredits"),
    reason: typeof value.reason === "string" ? value.reason : undefined,
    resumable: typeof value.resumable === "boolean" ? value.resumable : undefined,
  };
}

function creditPauseFailure(code?: string): string {
  const names: Record<string, [string, string]> = {
    STALE_WORLD: ["errorStale", "This work changed after the task paused. Start a new request with the current version."],
    ACTIVE_RUN: ["errorActive", "Another task is running. Wait for it to finish, then refresh."],
    NOT_PAUSED: ["errorActive", "This task is already running or has finished. Refresh its status."],
    BILLING_DETAILS_MISSING: ["errorBillingMissing", "Your result is saved, but its usage could not be confirmed. Please try again later."],
    USAGE_UNAVAILABLE: ["errorBillingMissing", "Your result is saved, but its usage could not be confirmed. Please try again later."],
    NO_CREDITS: ["errorBalance", "There are not enough available mushrooms to continue yet."],
    INSUFFICIENT_CREDITS: ["errorBalance", "There are not enough available mushrooms to continue yet."],
    SAVE_FAILED: ["errorSave", "Save your latest changes before continuing this task."],
  };
  const [key, fallback] = names[code ?? ""] ?? ["errorFailed", "Could not continue. Your saved task is still available; please try again."];
  return tr(`editor:studio.aiChat.creditPause.${key}`, fallback);
}

function syncStudioCreditBalance(data: Record<string, unknown>) {
  if (typeof data.balance === "number" && Number.isFinite(data.balance)) useCreditStore.getState().setBalance(data.balance);
}

function creditPauseReasonError(pause: StudioCreditPause): string | null {
  // These describe a saved pause, not a failed attempt to resume. The card
  // explains the pause; onError still reports actual resume/save failures.
  if (pause.billingUnavailable || !pause.reason || [
    "INSUFFICIENT_CREDITS", "insufficient_credits", "SERVER_RESTART", "GENERATION_FAILED",
    "pricing_unavailable", "output_limit_too_small",
  ].includes(pause.reason)) return null;
  return creditPauseFailure(pause.reason);
}

/** One lifecycle for fresh, approved, and resumed streams, including recovery. */
function studioAgentCallbacks(scope: StudioAgentScope, initialRunId: string | null = null, rejection = false): AgentStreamCallbacks {
  const epoch = studioAgentEpoch;
  let streamRunId = initialRunId;
  const set = useStudioStore.setState;
  const active = () => epoch === studioAgentEpoch && isActiveStudioChatScope(scope);
  const activeRun = () => active() && isActiveStudioRunScope(scope, streamRunId);
  const activeStream = () => active() && isActiveStudioStreamScope(scope, streamRunId);
  const ended = { isChatStreaming: false, chatStreamContent: "", isAgentWorking: false,
    isRecovering: false, isReconnecting: false, isResumingCredits: false, agentIteration: 0, toolGenName: null,
    toolGenChars: 0, _agentAbortController: null, _currentRunId: null };
  return {
    scope, isActive: active,
    onRunStarted: runId => {
      if (!active() || (initialRunId && runId !== initialRunId)) return;
      streamRunId = runId;
      set({ _currentRunId: runId, creditPause: null, creditPauseError: null, isResumingCredits: false });
    },
    onReasoning: content => { if (activeRun()) bufferStreamReasoning(content); },
    onText: text => { if (activeRun()) bufferStreamText(text); },
    onIteration: (iteration, max) => {
      if (!activeRun()) return;
      flushStreamNow();
      set({ agentIteration: iteration, agentMaxIterations: max, reasoningChars: 0, reasoningContent: "", appliedCount: 0 });
    },
    onStepRestarted: () => {
      if (!activeRun()) return;
      // Drop the dropped attempt: buffered chunks and what already reached the bubble.
      if (_streamFlushTimer) { clearTimeout(_streamFlushTimer); _streamFlushTimer = undefined; }
      _textBuf = ""; _reasoningBuf = ""; _reasoningCharsBuf = 0;
      set({ chatStreamContent: "", reasoningChars: 0, reasoningContent: "", toolGenName: null, toolGenChars: 0 });
    },
    onToolStart: data => { if (activeRun()) set({ toolGenName: data.name, toolGenChars: 0 }); },
    onToolDelta: data => { if (activeRun()) set(s => ({ toolGenChars: s.toolGenChars + (data.arguments?.length ?? 0) })); },
    onToolEnd: () => { if (activeRun()) set({ toolGenName: null, toolGenChars: 0 }); },
    onReadToolsExecuted: data => {
      if (!activeRun()) return;
      flushStreamNow();
      set({ agentIteration: data.iteration, chatStreamContent: "" });
    },
    onAssistantTurnCommit: data => {
      if (!activeRun() || data.runId !== streamRunId) return;
      flushStreamNow();
      set(s => s.chatMessages.some(message => message.commitId === data.commitId) ? {} : {
        chatMessages: [...s.chatMessages, { id: nextMsgId(), role: "assistant" as const, content: data.textContent,
          agentRunId: data.runId, commitId: data.commitId,
          ...(data.writeToolCalls?.length ? { toolCalls: data.writeToolCalls, proposalStatus: "approved" as const } : {}) }],
        chatStreamContent: "",
      });
    },
    onApplied: data => {
      if (activeRun()) set(s => ({ appliedCount: s.appliedCount + (Number.isFinite(data.changes) ? data.changes : 1) }));
    },
    onStreamInterrupted: () => {
      if (activeStream()) set({ isRecovering: true });
    },
    onRecoveryProgress: data => {
      // The run is alive but silent. Feed the server's step counter into the same
      // fields the live banner reads, so a disconnected user sees the agent move.
      if (!activeStream()) return;
      set(s => ({
        // A poll came back, so a pending Reconnect press has been answered.
        isReconnecting: false,
        agentIteration: data.iteration > 0 ? data.iteration : s.agentIteration,
        agentMaxIterations: data.maxIterations > 0 ? data.maxIterations : s.agentMaxIterations,
      }));
    },
    onProposal: data => {
      if (!activeRun()) return;
      flushStreamNow();
      set(s => ({ chatMessages: [...s.chatMessages, { id: nextMsgId(), role: "assistant" as const,
        content: data.textContent, toolCalls: data.writeToolCalls, proposalStatus: "pending" as const, agentRunId: data.runId }],
        isChatStreaming: false, chatStreamContent: "", isRecovering: false, isResumingCredits: false,
        creditPause: null, creditPauseError: null,
        _pendingApproval: { runId: data.runId, toolCalls: data.writeToolCalls }, _currentRunId: data.runId }));
    },
    onImageProposal: data => {
      if (!activeRun()) return;
      flushStreamNow();
      const { textContent, ...rest } = data;
      const proposal: StudioImageProposal = { ...rest, status: "pending" };
      set(s => {
        // commitTextTurn already put the assistant's sentence in a bubble; hang the card on it.
        const idx = [...s.chatMessages].reverse().findIndex(m => m.role === "assistant" && m.agentRunId === data.runId && !m.imageProposal && m.content === textContent);
        const at = idx >= 0 ? s.chatMessages.length - 1 - idx : -1;
        const chatMessages = at >= 0
          ? s.chatMessages.map((m, i) => i === at ? { ...m, imageProposal: proposal } : m)
          : [...s.chatMessages, { id: nextMsgId(), role: "assistant" as const, content: textContent, agentRunId: data.runId, imageProposal: proposal }];
        return { ...ended, chatMessages, creditPause: null, creditPauseError: null,
          _pendingImage: { runId: data.runId, toolCallId: data.toolCallId }, _currentRunId: data.runId };
      });
      flushRefresh();
    },
    onImageBatchProposal: data => {
      if (!activeRun()) return;
      flushStreamNow();
      const { textContent, ...rest } = data;
      const proposal: StudioImageBatchProposal = { ...rest, status: rest.status ?? "pending" };
      set(s => {
        const existing = s.chatMessages.findIndex(message => message.imageBatchProposal?.runId === data.runId
          && message.imageBatchProposal.toolCallId === data.toolCallId);
        const reverseIndex = [...s.chatMessages].reverse().findIndex(message => message.role === "assistant"
          && message.agentRunId === data.runId && !message.imageProposal && !message.imageBatchProposal && message.content === textContent);
        const at = existing >= 0 ? existing : reverseIndex >= 0 ? s.chatMessages.length - 1 - reverseIndex : -1;
        const chatMessages = at >= 0 ? s.chatMessages.map((message, index) => index === at ? { ...message, imageBatchProposal: proposal } : message)
          : [...s.chatMessages, { id: nextMsgId(), role: "assistant" as const, content: textContent, agentRunId: data.runId, imageBatchProposal: proposal }];
        return { ...ended, chatMessages, creditPause: null, creditPauseError: null, _pendingApproval: null, _pendingImage: null,
          _pendingImageBatch: proposal.status === "pending" ? { runId: data.runId, toolCallId: data.toolCallId } : null,
          _currentRunId: proposal.status === "pending" ? data.runId : null };
      });
      flushRefresh();
    },
    onImageProgress: data => {
      if (!activeRun()) return;
      set(s => ({ chatMessages: s.chatMessages.map(m => m.imageProposal?.toolCallId === data.toolCallId
        ? { ...m, imageProposal: { ...m.imageProposal!, status: "generating" as const, jobId: data.jobId, elapsed: data.elapsed } } : m) }));
    },
    onImageResult: data => {
      if (!activeRun()) return;
      set(s => ({ chatMessages: s.chatMessages.map(m => m.imageProposal?.toolCallId === data.toolCallId
        ? { ...m, imageProposal: { ...m.imageProposal!, jobId: data.jobId,
          status: data.status === "done" ? "done" as const : data.status === "failed" ? "failed" as const : "stillGenerating" as const,
          assetIds: data.assetIds, costMushies: data.costMushies, error: data.errorCode } } : m) }));
      if (data.status === "done") void useCreditStore.getState().forceFetchCredits().catch(() => {});
    },
    onDone: () => {
      if (!activeRun()) return;
      flushStreamNow();
      set(s => {
        const last = s.chatMessages[s.chatMessages.length - 1];
        const chatMessages = rejection && !(last?.role === "assistant" && last.commitId)
          ? [...s.chatMessages, { id: nextMsgId(), role: "assistant" as const, content: "Understood. Let me know how you'd like to proceed." }]
          : s.chatMessages;
        return { ...ended, chatMessages, creditPause: null, creditPauseError: null };
      });
      flushRefresh();
    },
    onCredits: data => {
      if (!activeStream()) return;
      syncStudioCreditBalance(data);
      const pause = useStudioStore.getState().creditPause;
      if (pause && pause.runId === streamRunId) {
        const updated = parseCreditPause({ ...pause, ...data }, scope, pause.runId);
        if (updated) set({ creditPause: updated });
      }
    },
    onCreditsPaused: data => {
      if (!activeStream()) return;
      const runId = typeof data.runId === "string" ? data.runId : streamRunId;
      if (!runId || (streamRunId && runId !== streamRunId)) return;
      const pause = parseCreditPause(data, scope, runId);
      if (!pause) return;
      flushStreamNow();
      syncStudioCreditBalance(data);
      set({ ...ended, creditPause: pause, creditPauseError: creditPauseReasonError(pause), _pendingApproval: null });
      flushRefresh();
    },
    onError: (error, code) => {
      if (!activeStream()) return;
      flushStreamNow();
      const current = useStudioStore.getState().creditPause;
      const pause = current && current.worldId === scope.worldId && current.conversationId === scope.conversationId ? current : null;
      const disconnected = code === "DISCONNECTED" || code === "RECOVERY_FAILED";
      set(s => ({ ...ended,
        ...(pause ? { creditPause: { ...pause,
          ...(code === "STALE_WORLD" ? { reason: code, resumable: false } : {}),
          ...(code === "BILLING_DETAILS_MISSING" ? { billingUnavailable: true, resumable: false } : {}),
        }, creditPauseError: creditPauseFailure(code) }
          : { chatMessages: [...s.chatMessages, disconnected
            // A dropped stream is not a failed task. The agent usually finishes
            // server-side, so offer to re-attach to THAT run rather than leaving
            // "Error: network error" whose only exit is a second, billed run.
            ? { id: nextMsgId(), role: "assistant" as const,
                content: tr("editor:studio.aiChat.disconnectedBody",
                  "Connection dropped. The assistant may have finished in the background."),
                // Tagged with the run so Resend (undo + re-send) rolls back whatever
                // that run already applied to the card. Reconnect strips this card
                // before polling, so the tag never blocks the rescue path.
                ...(streamRunId ? { agentRunId: streamRunId } : {}),
                disconnected: { ...(streamRunId ? { runId: streamRunId } : {}) } }
            : { id: nextMsgId(), role: "assistant" as const, content: `Error: ${error}` }] }),
      }));
      flushRefresh();
      // Read-only reconciliation can recover a pause that was committed just
      // before the response failed. It never starts another model request.
      if (streamRunId && !pause && code !== "RECOVERY_FAILED") void useStudioStore.getState().refreshCreditPause(scope.worldId, scope.conversationId, streamRunId);
    },
  };
}

// ── Store ──

export const useStudioStore = create<StudioState>((set, get) => ({
  chatMessages: [],
  isChatStreaming: false,
  chatStreamContent: "",
  chatAttachments: [],
  chatWorldId: null,
  chatConversationId: null,

  // Agent state (server-side)
  isAgentWorking: false,
  agentIteration: 0,
  agentMaxIterations: 10,
  reasoningChars: 0,
  reasoningContent: "",
  appliedCount: 0,
  toolGenChars: 0,
  toolGenName: null,
  isRecovering: false,
  _agentAbortController: null,
  _currentRunId: null,
  creditPause: null,
  isResumingCredits: false,
  isRefreshingCreditPause: false,
  isReconnecting: false,
  creditPauseError: null,

  // Approval state (server-side)
  _pendingApproval: null,
  _pendingImage: null,
  _pendingImageBatch: null,

  selectedElementId: null,
  selectedElementType: null,
  mode: "edit",
  activePanel: "canvas",

  // ── Server-Side Agent ──

  sendChatMessage: async (worldId, content, model, conversationId) => {
    if (get().isAgentWorking) return;
    const preparationEpoch = ++studioAgentEpoch;
    creditRefreshEpoch++;

    const requestedScope = { worldId, conversationId: conversationId ?? null };
    const {
      chatAttachments,
      activePanel,
      selectedElementId,
      selectedElementType,
    } = get();

    // Process attachments: images go to S3, text files get read client-side
    let attachments: ChatAttachment[] | undefined;
    let textFileContent = "";
    if (chatAttachments.length > 0) {
      const imageFiles = chatAttachments.filter((f) => f.type.startsWith("image/"));
      const textFiles = chatAttachments.filter((f) => !f.type.startsWith("image/"));

      for (const file of textFiles) {
        try {
          const text = await file.text();
          const ext = file.name.split(".").pop() ?? "txt";
          const lang = ext === "tsx" || ext === "jsx" ? "tsx" : ext === "ts" || ext === "js" ? "typescript" : ext;
          textFileContent += `\n\n**Attached file: ${file.name}**\n\`\`\`${lang}\n${text}\n\`\`\``;
        } catch {
          console.error("Failed to read file:", file.name);
        }
      }

      if (imageFiles.length > 0) {
        try {
          attachments = await uploadAttachments(imageFiles);
        } catch (err) {
          console.error("Failed to upload attachments:", err);
          feedback.error(tr("editor:studio.aiChat.attachmentUploadFailed", "Sent without the images"));
        }
      }
    }

    const finalContent = textFileContent ? content + textFileContent : content;

    // Save world draft to DB before starting agent (ensures server has current state)
    const editorStore = useEditorStore.getState();
    if (editorStore.isDirty && editorStore.serverWorldId === worldId) {
      await editorStore.saveDraft().catch(() => {});
    }
    if (preparationEpoch !== studioAgentEpoch || !isActiveStudioChatScope(requestedScope)) return;

    const latestChatState = get();
    const currentScope = {
      worldId: latestChatState.chatWorldId,
      conversationId: latestChatState.chatConversationId,
    };
    const scopedMessages = selectScopedStudioHistory(
      latestChatState.chatMessages,
      currentScope,
      requestedScope,
      Number.POSITIVE_INFINITY,
    );
    const userMessage: StudioChatMessage = {
      id: nextMsgId(),
      role: "user",
      content: finalContent,
      ...(attachments && attachments.length > 0 && { attachments }),
    };
    const updatedMessages = [...scopedMessages, userMessage];

    set({
      chatMessages: updatedMessages,
      isChatStreaming: true,
      chatStreamContent: "",
      chatAttachments: [],
      chatWorldId: worldId,
      chatConversationId: conversationId ?? null,
      isAgentWorking: true,
      agentIteration: 0,
      reasoningChars: 0,
      reasoningContent: "",
      appliedCount: 0,
      toolGenChars: 0,
      toolGenName: null,
      creditPause: null,
      creditPauseError: null,
      isResumingCredits: false,
      isRefreshingCreditPause: false,
      _currentRunId: null,
      _pendingImageBatch: null,
    });

    // Persist the new user message right away. The panel's debounced
    // auto-save effect skips while isAgentWorking, and even without that
    // gate its 2s timer gets clearTimeout'd if the user switches panels
    // / refreshes before it fires — so without this immediate PATCH the
    // turn the user just typed never reaches the DB and vanishes on the
    // next load. `keepalive: true` lets the request finish even if the
    // tab is closed mid-flight.
    if (conversationId) {
      fetch(`${apiBase}/api/studio/${worldId}/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: serializeStudioChatMessages(updatedMessages) }),
        keepalive: true,
      }).catch((err) => { console.warn("[Studio] Failed to persist user message:", err); });
    }

    // Connect to server-side agent
    const controller = connectAgentSSE(
      `/api/studio/${worldId}/agent/start`,
      {
        message: finalContent,
        model,
        ...(conversationId && { conversationId }),
        context: { activePanel, selectedElementId, selectedElementType },
        attachments: attachments ?? [],
      },
      studioAgentCallbacks(requestedScope),
      undefined,
      // Only the long-lived start stream prefers the direct (CF-bypass) base;
      // it falls back to the proxied apiBase when the origin is unreachable.
      { preferStreamBase: true },
    );

    if (isActiveStudioChatScope(requestedScope)) {
      set({ _agentAbortController: controller, _currentRunId: null });
    } else {
      controller.abort();
    }
  },

  nudgeRecovery: () => {
    // The banner case: a poller is already attached to this run, so the honest
    // action is "ask right now" rather than starting anything. The spinner stays
    // until onRecoveryProgress (or a terminal callback) reports the answer.
    if (!get().isRecovering || get().isReconnecting) return;
    set({ isReconnecting: true });
    window.dispatchEvent(new Event(AGENT_RECOVERY_NUDGE));
  },

  reconnectAgent: async (worldId, conversationId = null, runId) => {
    if (get().isReconnecting || get().isAgentWorking) return;
    // Drop the card first. It is the thing being answered, and the rescue path
    // in refreshCreditPause deliberately refuses to hydrate a run that already
    // has a bubble in this transcript.
    const before = get().chatMessages.filter(message => !message.disconnected);
    set({ chatMessages: before, isReconnecting: true });
    try {
      await get().refreshCreditPause(worldId, conversationId, runId);
      const after = useStudioStore.getState();
      const reattached = after.isAgentWorking || !!after.creditPause;
      const recovered = after.chatMessages.length > before.length;
      if (reattached || recovered) {
        // Whatever the run spent is now reflected in the transcript, and the
        // context meter is derived from it. Pull the wallet so the mushroom
        // balance in the header agrees with what actually ran.
        void useCreditStore.getState().fetchCredits(0); // 0 = ignore the cache TTL
        return;
      }
      // Nothing on the server: say so plainly and leave only the honest option.
      set(state => ({ chatMessages: [...state.chatMessages, {
        id: nextMsgId(), role: "assistant" as const,
        content: tr("editor:studio.aiChat.disconnectedDeadBody",
          "That task did not finish, and the card was not changed."),
        disconnected: { dead: true },
      }] }));
    } finally {
      set({ isReconnecting: false });
    }
  },

  refreshCreditPause: async (worldId, conversationId = null, runId) => {
    const scope = { worldId, conversationId };
    if (!isActiveStudioChatScope(scope) || get().isAgentWorking || get().isResumingCredits) return;
    const epoch = studioAgentEpoch;
    const refreshId = ++creditRefreshEpoch;
    const current = () => epoch === studioAgentEpoch && refreshId === creditRefreshEpoch && isActiveStudioChatScope(scope);
    const previous = get().creditPause;
    set({ isRefreshingCreditPause: true });
    try {
      const query = runId ? `runId=${encodeURIComponent(runId)}` : `conversationId=${encodeURIComponent(conversationId ?? "")}`;
      const response = await fetch(`${apiBase}/api/studio/${encodeURIComponent(worldId)}/agent/status?${query}`, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { data } = await response.json();
      if (!current()) return;
      if (!data) { set({ creditPause: null, creditPauseError: null }); return; }
      if (typeof data.id !== "string" || (runId && data.id !== runId) || data.conversationId !== conversationId) return;
      if (data.status === "awaiting_approval" && data.imageBatchProposal) {
        set({ _currentRunId: data.id });
        studioAgentCallbacks(scope, data.id).onImageBatchProposal?.({ ...data.imageBatchProposal, runId: data.id });
        return;
      }
      // A confirmation can finish on the server before the debounced transcript
      // save. Recover its card from the durable task without another model turn.
      if (data.status === "completed" && data.imageBatchProposal && Array.isArray(data.imageBatches)) {
        const proposal: StudioImageBatchProposal = { ...data.imageBatchProposal, runId: data.id };
        const batch = matchingImageBatch(proposal, worldId, data.imageBatches);
        if ((batch || proposal.status === "declined") && (get().chatMessages.some(message => message.agentRunId === data.id)
          || get().chatMessages.at(-1)?.role === "user")) {
          set(state => {
            const existing = state.chatMessages.findIndex(message => (message.imageBatchProposal?.runId === proposal.runId && message.imageBatchProposal.toolCallId === proposal.toolCallId)
              || (message.agentRunId === proposal.runId && !message.imageProposal && !message.imageBatchProposal && message.content === (data.imageBatchProposal.textContent ?? "")));
            const hydrated = batch ? proposalWithImageBatch(proposal, batch) : proposal;
            return { chatMessages: existing >= 0 ? state.chatMessages.map((message, index) => index === existing ? { ...message, imageBatchProposal: hydrated } : message)
              : [...state.chatMessages, { id: nextMsgId(), role: "assistant" as const, content: data.imageBatchProposal.textContent ?? "", agentRunId: data.id, imageBatchProposal: hydrated }],
              ...(state._pendingImageBatch?.runId === data.id ? { _pendingImageBatch: null } : {}),
              ...(state._currentRunId === data.id ? { _currentRunId: null } : {}) };
          });
        }
      }
      const rawPause = data.creditPause && typeof data.creditPause === "object" ? data.creditPause as Record<string, unknown> : null;
      const rememberedReason = previous && previous.runId === data.id ? previous.reason : undefined;
      const pause = rawPause ? parseCreditPause({ ...rawPause,
        reason: rememberedReason === "STALE_WORLD" ? rememberedReason : rawPause.reason ?? (data.error === "STALE_WORLD" ? data.error : rememberedReason),
        ...(rememberedReason === "STALE_WORLD" ? { resumable: false } : {}),
      }, scope, data.id) : null;
      // Ordinary completed history is loaded by the conversation endpoint, which
      // respects deleted/undone messages, so a finished run is NOT replayed here
      // by default.
      //
      // One exception, and it is worth the extra conditions: the conversation
      // record is written by the CLIENT. When the stream drops and recovery
      // eventually gives up, the client stops writing — but the agent finishes
      // server-side minutes later, and its answer (plus the card edits it already
      // applied) then exist only in agent_runs. Reloading showed the creator a
      // dangling question, no reply, and a card that had in fact been edited.
      // Replaying is safe exactly when the stored conversation still ends on that
      // unanswered user turn: undo trims the user message too, so an undone turn
      // never leaves this shape.
      const terminal = data.status === "completed" || data.status === "awaiting_user";
      const abandonedResult = terminal && !pause
        && wasAbandonedHere(data.id)
        && Array.isArray(data.committedTurns) && data.committedTurns.length > 0
        && !/stopped by user|superseded/i.test(String(data.error ?? ""))
        && !get().chatMessages.some(message => message.agentRunId === data.id);
      if (abandonedResult) forgetAbandonedRun(data.id);
      const turns = ((pause && !terminal) || abandonedResult) && Array.isArray(data.committedTurns)
        ? data.committedTurns : [];
      set(state => {
        const messages = [...state.chatMessages];
        for (const turn of turns) {
          if (typeof turn?.commitId !== "string" || typeof turn.textContent !== "string" || messages.some(message => message.commitId === turn.commitId)) continue;
          messages.push({ id: nextMsgId(), role: "assistant", content: turn.textContent, commitId: turn.commitId, agentRunId: data.id,
            ...(Array.isArray(turn.writeToolCalls) && turn.writeToolCalls.length ? { toolCalls: turn.writeToolCalls, proposalStatus: "approved" as const } : {}) });
        }
        return { chatMessages: messages };
      });
      if (pause) syncStudioCreditBalance(rawPause!);
      if (pause && (data.status === "awaiting_credits" || pause.resumable === true)) {
        set({ creditPause: pause, creditPauseError: creditPauseReasonError(pause) });
      } else if (pause && (data.status === "running" || data.status === "error")
        && !pause.billingUnavailable && pause.reason !== "STALE_WORLD"
        && !/stopped by user|superseded/i.test(String(data.error ?? ""))) {
        // Reattach with GETs only. A healthy task may finish, or a dead worker's
        // lease becomes resumable after five minutes. Neither starts a model.
        set({ creditPause: null, creditPauseError: null, _currentRunId: data.id,
          isAgentWorking: true, isChatStreaming: true, isRecovering: true });
        const callbacks = studioAgentCallbacks(scope, data.id);
        void tryRecoverAgentRun(data.id, callbacks).then(recovered => {
          if (!recovered && callbacks.isActive?.()) {
            rememberAbandonedRun(data.id);
            callbacks.onError("Unable to recover this task yet", "RECOVERY_FAILED");
          }
        });
      } else if (pause && (pause.billingUnavailable || pause.reason === "STALE_WORLD")
        && data.status !== "completed" && data.status !== "awaiting_user") {
        set({ creditPause: pause, creditPauseError: creditPauseReasonError(pause) });
      } else {
        set({ creditPause: null, creditPauseError: null });
        // A long run whose stream died while the tab was away is still alive on
        // the server — the heartbeat bumps updatedAt every 5s, so a fresh
        // timestamp means it is mid-edit right now. Re-attach the poller instead
        // of leaving the panel looking idle while the card is being rewritten.
        // Until now only credit-paused runs got this treatment.
        const liveRun = data.status === "running"
          && Date.now() - new Date(data.updatedAt ?? 0).getTime() < 2 * 60_000
          && !/stopped by user|superseded/i.test(String(data.error ?? ""));
        if (liveRun && !get().isAgentWorking) {
          set({ _currentRunId: data.id, isAgentWorking: true, isChatStreaming: true,
            isRecovering: true });
          const callbacks = studioAgentCallbacks(scope, data.id);
          void tryRecoverAgentRun(data.id, callbacks).then(recovered => {
            if (!recovered && callbacks.isActive?.()) {
              rememberAbandonedRun(data.id);
              callbacks.onError("Unable to recover this task yet", "RECOVERY_FAILED");
            }
          });
        }
      }
    } catch {
      if (current()) set({ creditPauseError: creditPauseFailure() });
    } finally {
      if (current()) set({ isRefreshingCreditPause: false });
    }
  },

  resumeCreditPause: async () => {
    const pause = get().creditPause;
    if (!pause || get().isAgentWorking || get().isResumingCredits || !isActiveStudioChatScope(pause)) return;
    if (pause.billingUnavailable || pause.reason === "STALE_WORLD" || pause.resumable === false) {
      set({ creditPauseError: creditPauseFailure(pause.billingUnavailable ? "BILLING_DETAILS_MISSING" : pause.reason === "STALE_WORLD" ? "STALE_WORLD" : "NOT_PAUSED") });
      return;
    }
    const epoch = ++studioAgentEpoch;
    creditRefreshEpoch++;
    set({ isResumingCredits: true, isRefreshingCreditPause: false, creditPauseError: null });
    const current = () => epoch === studioAgentEpoch && isActiveStudioChatScope(pause) && get().creditPause?.runId === pause.runId;
    try {
      const editor = useEditorStore.getState();
      if (editor.isDirty || editor.saving) {
        const saved = await editor.saveDraft();
        if (!current()) return;
        if (!saved || useEditorStore.getState().isDirty) {
          set({ isResumingCredits: false, creditPauseError: creditPauseFailure("SAVE_FAILED") });
          return;
        }
      }
      if (!current()) return;
      set({ isAgentWorking: true, isChatStreaming: true, isRecovering: false,
        chatStreamContent: "", reasoningChars: 0, reasoningContent: "", toolGenName: null, toolGenChars: 0,
        _currentRunId: pause.runId });
      const controller = connectAgentSSE(`/api/studio/${encodeURIComponent(pause.worldId)}/agent/resume-credits`,
        { runId: pause.runId }, studioAgentCallbacks(pause, pause.runId), undefined, { preferStreamBase: true });
      if (current()) set({ _agentAbortController: controller });
      else controller.abort();
    } catch {
      if (current()) set({ isResumingCredits: false, isAgentWorking: false, isChatStreaming: false,
        _currentRunId: null, creditPauseError: creditPauseFailure() });
    }
  },

  stopAgent: () => {
    studioAgentEpoch++;
    creditRefreshEpoch++;
    const { _agentAbortController, _currentRunId } = get();
    if (_agentAbortController) {
      _agentAbortController.abort();
    }
    // Tell server to stop the agent run
    if (_currentRunId) {
      const worldId = get().chatWorldId ?? useEditorStore.getState().serverWorldId;
      if (worldId) {
        fetch(`${apiBase}/api/studio/${worldId}/agent/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ runId: _currentRunId }),
        }).catch(() => {});
      }
    }
    // Flush any buffered tokens into chatStreamContent first so we capture the
    // latest text the user actually saw before deciding whether to preserve it.
    flushStreamNow();
    if (_streamFlushTimer) { clearTimeout(_streamFlushTimer); _streamFlushTimer = undefined; }
    _textBuf = ""; _reasoningBuf = ""; _reasoningCharsBuf = 0;
    // Flush any pending refresh so applied changes are visible, then reset state
    flushRefresh();
    set((s) => {
      const runId = s._currentRunId ?? undefined;
      // Completed turns are already committed as bubbles via assistant_turn_commit.
      // Only the in-flight tail (chatStreamContent) can be lost on Stop — preserve it.
      const partial = s.chatStreamContent;
      const messages = s.chatMessages.map((m) =>
        m.proposalStatus === "pending"
          ? { ...m, proposalStatus: "rejected" as const }
          : m
      );
      if (partial.trim().length > 0) {
        messages.push({
          id: nextMsgId(),
          role: "assistant" as const,
          content: partial,
          agentRunId: runId,
          stopped: true,
        });
      }
      return {
        chatMessages: messages,
        isChatStreaming: false,
        chatStreamContent: "",
        isAgentWorking: false,
        isRecovering: false,
        agentIteration: 0,
        reasoningChars: 0,
        reasoningContent: "",
        appliedCount: 0,
        _agentAbortController: null,
        _pendingApproval: null,
        _pendingImageBatch: null,
        _currentRunId: null,
        creditPause: null,
        creditPauseError: null,
        isResumingCredits: false,
        isRefreshingCreditPause: false,
      };
    });
  },

  approveProposal: () => {
    const { _pendingApproval } = get();
    if (!_pendingApproval) return;

    const worldId = useEditorStore.getState().serverWorldId;
    if (!worldId) return;
    const requestedScope = { worldId, conversationId: get().chatConversationId };
    let streamRunId: string | null = _pendingApproval.runId;
    if (!isActiveStudioRunScope(requestedScope, streamRunId)) return;
    studioAgentEpoch++;
    creditRefreshEpoch++;

    // Update UI: mark proposal as approved
    set((s) => ({
      chatMessages: s.chatMessages.map((m) =>
        m.proposalStatus === "pending"
          ? { ...m, proposalStatus: "approved" as const }
          : m
      ),
      isChatStreaming: true,
      isAgentWorking: true,
      chatStreamContent: "",
      _pendingApproval: null,
    }));

    // POST approval to server — server applies tools and continues loop
    const controller = connectAgentSSE(
      `/api/studio/${worldId}/agent/approve`,
      { runId: _pendingApproval.runId, approved: true },
      studioAgentCallbacks(requestedScope, streamRunId),
    );

    if (isActiveStudioRunScope(requestedScope, streamRunId)) {
      set({ _agentAbortController: controller });
    } else {
      controller.abort();
    }
  },

  rejectProposal: () => {
    const { _pendingApproval } = get();
    if (!_pendingApproval) return;

    const worldId = useEditorStore.getState().serverWorldId;
    if (!worldId) return;
    const requestedScope = { worldId, conversationId: get().chatConversationId };
    let streamRunId: string | null = _pendingApproval.runId;
    if (!isActiveStudioRunScope(requestedScope, streamRunId)) return;
    studioAgentEpoch++;
    creditRefreshEpoch++;

    // Update UI: mark proposal as rejected
    set((s) => ({
      chatMessages: s.chatMessages.map((m) =>
        m.proposalStatus === "pending"
          ? { ...m, proposalStatus: "rejected" as const }
          : m
      ),
      isChatStreaming: true,
      isAgentWorking: true,
      chatStreamContent: "",
      _pendingApproval: null,
    }));

    // POST rejection — server does one follow-up turn then stops
    const controller = connectAgentSSE(
      `/api/studio/${worldId}/agent/approve`,
      { runId: _pendingApproval.runId, approved: false },
      studioAgentCallbacks(requestedScope, streamRunId, true),
    );

    if (isActiveStudioRunScope(requestedScope, streamRunId)) {
      set({ _agentAbortController: controller });
    } else {
      controller.abort();
    }
  },

  confirmImageProposal: (edits) => {
    const { _pendingImage } = get();
    if (!_pendingImage) return;
    const worldId = useEditorStore.getState().serverWorldId;
    if (!worldId) return;
    const requestedScope = { worldId, conversationId: get().chatConversationId };
    const streamRunId = _pendingImage.runId;
    if (!isActiveStudioRunScope(requestedScope, streamRunId)) return;
    studioAgentEpoch++;
    creditRefreshEpoch++;
    // The card shows exactly what will be drawn: the creator's edits win over the model's draft.
    set(s => ({
      chatMessages: s.chatMessages.map(m => m.imageProposal?.toolCallId === _pendingImage.toolCallId
        ? { ...m, imageProposal: { ...m.imageProposal!, ...edits, status: "generating" as const, elapsed: 0 } } : m),
      isChatStreaming: true, isAgentWorking: true, chatStreamContent: "", _pendingImage: null,
    }));
    const controller = connectAgentSSE(
      `/api/studio/${worldId}/agent/generate-image`,
      { runId: streamRunId, approved: true, ...edits },
      studioAgentCallbacks(requestedScope, streamRunId),
    );
    if (isActiveStudioRunScope(requestedScope, streamRunId)) set({ _agentAbortController: controller });
    else controller.abort();
  },

  declineImageProposal: () => {
    const { _pendingImage } = get();
    if (!_pendingImage) return;
    const worldId = useEditorStore.getState().serverWorldId;
    if (!worldId) return;
    const requestedScope = { worldId, conversationId: get().chatConversationId };
    const streamRunId = _pendingImage.runId;
    if (!isActiveStudioRunScope(requestedScope, streamRunId)) return;
    studioAgentEpoch++;
    creditRefreshEpoch++;
    set(s => ({
      chatMessages: s.chatMessages.map(m => m.imageProposal?.toolCallId === _pendingImage.toolCallId
        ? { ...m, imageProposal: { ...m.imageProposal!, status: "declined" as const } } : m),
      isChatStreaming: true, isAgentWorking: true, chatStreamContent: "", _pendingImage: null,
    }));
    const controller = connectAgentSSE(
      `/api/studio/${worldId}/agent/generate-image`,
      { runId: streamRunId, approved: false },
      studioAgentCallbacks(requestedScope, streamRunId, true),
    );
    if (isActiveStudioRunScope(requestedScope, streamRunId)) set({ _agentAbortController: controller });
    else controller.abort();
  },

  updateImageBatchProposal: (worldId, conversationId, proposal) => {
    if (!isActiveStudioChatScope({ worldId, conversationId })) return;
    let refreshed = false;
    set(state => {
      const messages = state.chatMessages.map(message => {
        const previous = message.imageBatchProposal;
        if (!previous || previous.runId !== proposal.runId || previous.toolCallId !== proposal.toolCallId) return message;
        refreshed = !!proposal.batch?.items.some(item => item.status === "succeeded"
          && !previous.batch?.items.some(old => old.id === item.id && old.status === "succeeded"));
        return { ...message, imageBatchProposal: proposal };
      });
      const answered = proposal.status !== "pending" && state._pendingImageBatch?.runId === proposal.runId;
      return { chatMessages: messages, ...(answered ? { _pendingImageBatch: null,
        ...(state._currentRunId === proposal.runId ? { _currentRunId: null } : {}) } : {}) };
    });
    if (refreshed) flushRefresh();
  },

  setSelectedElement: (id, type = null) =>
    set({ selectedElementId: id, selectedElementType: type }),

  setMode: (mode) => set({ mode }),

  setActivePanel: (panel) => set({ activePanel: panel }),

  clearChat: () => {
    get().stopAgent();
    set({
      chatMessages: [],
      chatWorldId: null,
      chatConversationId: null,
      isChatStreaming: false,
      chatStreamContent: "",
      chatAttachments: [],
    });
  },

  undoLastTurn: async (worldId, conversationId) => {
    if (get().isAgentWorking || get()._pendingApproval || _isUndoing) return;
    _isUndoing = true;
    try {
      const paused = get().creditPause;
      if (paused?.worldId === worldId && paused.conversationId === (conversationId ?? null)) {
        // Undo explicitly discards this task. A later status refresh must not
        // offer to replay the generated edit the user just undid.
        studioAgentEpoch++;
        creditRefreshEpoch++;
        set({ creditPause: null, creditPauseError: null, isResumingCredits: false, isRefreshingCreditPause: false });
        await fetch(`${apiBase}/api/studio/${encodeURIComponent(worldId)}/agent/stop`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: paused.runId }),
        }).catch(() => {});
      }
      const msgs = get().chatMessages;
      // Find last user message index
      let lastUserIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === "user") { lastUserIdx = i; break; }
      }
      if (lastUserIdx < 0) return;
      // Collect agentRunId from assistant messages in this turn
      let agentRunId: string | undefined;
      for (let i = lastUserIdx + 1; i < msgs.length; i++) {
        if (msgs[i]!.agentRunId) { agentRunId = msgs[i]!.agentRunId; break; }
      }
      // Remove messages from lastUserIdx onward
      const trimmed = msgs.slice(0, lastUserIdx);
      set({ chatMessages: trimmed });
      // Immediate conversation save
      if (conversationId) {
        try {
          await fetch(`${apiBase}/api/studio/${worldId}/conversations/${conversationId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              messages: serializeStudioChatMessages(trimmed),
            }),
          });
        } catch { /* best-effort save */ }
      }
      // Rollback world schema if agent made changes
      if (agentRunId) {
        try {
          const snapRes = await fetch(
            `${apiBase}/api/studio/${worldId}/snapshots?agentRunId=${encodeURIComponent(agentRunId)}`,
            { credentials: "include" },
          );
          const snapData = await snapRes.json();
          const snapshot = snapData?.data?.[0];
          if (snapshot?.id) {
            const rollbackRes = await fetch(`${apiBase}/api/studio/${worldId}/rollback/${snapshot.id}`, {
              method: "POST",
              credentials: "include",
            });
            // A non-OK response doesn't throw, so without this check the schema
            // rollback could fail silently while the messages are already gone.
            if (!rollbackRes.ok) throw new Error(`Rollback HTTP ${rollbackRes.status}`);
            await useEditorStore.getState().refreshWorldSchema();
          }
        } catch {
          console.error("[Studio] Rollback failed — messages removed but world schema was not reverted");
          feedback.error(
            tr("editor:studio.aiChat.undoRollbackFailed", "Undid the messages, not the card changes"),
          );
        }
      }
    } finally {
      _isUndoing = false;
    }
  },

  regenerateLastTurn: async (worldId, model, conversationId) => {
    if (get().isAgentWorking || get()._pendingApproval || _isUndoing) return;
    const msgs = get().chatMessages;
    // Find last user message
    let lastUserMsg: StudioChatMessage | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === "user") { lastUserMsg = msgs[i]; break; }
    }
    if (!lastUserMsg) return;
    const content = lastUserMsg.content;
    // Undo first
    await get().undoLastTurn(worldId, conversationId);
    // Resend
    await get().sendChatMessage(worldId, content, model, conversationId);
  },

  restartFromPause: async (worldId, model, conversationId = null) => {
    const pause = get().creditPause;
    if (!pause || get().isAgentWorking || get().isResumingCredits || !isActiveStudioChatScope(pause)) return;
    studioAgentEpoch++;
    creditRefreshEpoch++;
    set({ creditPause: null, creditPauseError: null, isResumingCredits: false, isRefreshingCreditPause: false });
    // Consume the stuck checkpoint so status polling stops offering it.
    await fetch(`${apiBase}/api/studio/${encodeURIComponent(pause.worldId)}/agent/stop`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ runId: pause.runId }),
    }).catch(() => {});
    await get().sendChatMessage(worldId, tr("editor:studio.aiChat.creditPause.restartMessage",
      "Continue from where you stopped, working from the card as it is now."), model, conversationId);
  },

  addChatAttachment: (file) => {
    set((s) => ({ chatAttachments: [...s.chatAttachments, file] }));
  },

  removeChatAttachment: (index) => {
    set((s) => ({
      chatAttachments: s.chatAttachments.filter((_, i) => i !== index),
    }));
  },

}));

// Direct scope setters are used when loading a conversation. Invalidate old
// reads/streams even for A -> B -> A navigation before those promises settle.
useStudioStore.subscribe((state, previous) => {
  if (state.chatWorldId === previous.chatWorldId && state.chatConversationId === previous.chatConversationId) return;
  studioAgentEpoch++;
  creditRefreshEpoch++;
  previous._agentAbortController?.abort();
  if (_streamFlushTimer) { clearTimeout(_streamFlushTimer); _streamFlushTimer = undefined; }
  _textBuf = ""; _reasoningBuf = ""; _reasoningCharsBuf = 0;
  useStudioStore.setState({ creditPause: null, creditPauseError: null, isResumingCredits: false,
    isRefreshingCreditPause: false, _agentAbortController: null, _currentRunId: null, _pendingImageBatch: null });
});

useEditorStore.subscribe((state, previous) => {
  if (state.serverWorldId === previous.serverWorldId) return;
  studioAgentEpoch++;
  creditRefreshEpoch++;
  if (_streamFlushTimer) { clearTimeout(_streamFlushTimer); _streamFlushTimer = undefined; }
  _textBuf = ""; _reasoningBuf = ""; _reasoningCharsBuf = 0;
  useStudioStore.setState({ creditPause: null, creditPauseError: null, isResumingCredits: false, isRefreshingCreditPause: false, _pendingImageBatch: null });
});
