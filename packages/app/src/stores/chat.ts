import { create } from "zustand";
import { feedback } from "@/lib/feedback";
import { toPillText } from "@/lib/feedback-policy";
import { connectSSE } from "@/lib/sse";
import { handleAuthLoss } from "@/lib/auth-guard";
import { localizeChatError } from "@/lib/chat-errors";
import i18n from "@/lib/i18n";
import { pickModelFromPool, pickModelExcluding } from "@/lib/model-mix";
import { floorMushies } from "@/lib/format-mushies";
import { appendRegenSwipe } from "@/features/chat/turn-swipes";
import { drawTurnImage } from "@/features/chat/turn-image-drawing";
import { refreshMessageWindow } from "@/features/chat/refresh-message-window";
import { kimiRepetitionOverride } from "@/lib/kimi-repetition";
import { signalTtsUserStop } from "@/lib/tts-stop-signal";
import { useAudioStore } from "./audio";
import {
  queueSessionStateOperation,
  queueSessionStatePatch,
  whenSessionStateSettled,
} from "../lib/session-state-queue";
import { useConfigStore } from "./config";
import { useCreditStore, syncCreditsFromMessageResponse, handleStreamCreditError } from "@/edition/slots.state";
import { useUserProfileStore } from "./user-profile";
import { fallbackDecision, fallbackRecord, parseFallbackError, type ModelFallbackRetry } from "../lib/model-fallback";
import { DEFAULT_MODEL_FALLBACK_POLICY, type ModelFallbackNotice, type ModelFallbackRecord } from "@yumina/shared";
import type { WorldDefinition, Effect, GameState, Worldbook } from "@yumina/engine";
import { safeParseWorldDef } from "@/lib/utils";
import { hasGroupVoices, nextGroupVoice } from "@/features/chat/group-voices";
import { withRuntimeState } from "@/features/studio/lib/runtime-state";
import { appendRuntimeRecord, type RuntimeRecord, type RuntimeRecordKind } from "@/features/studio/lib/runtime-records";

// ── Streaming Update Batcher ──
//
// SSE "text" events arrive at 20–100 Hz depending on the LLM. Screens can't
// display faster than 60 Hz, so calling set() per-token causes redundant React
// re-renders (every one triggers a full tree reconciliation, including all
// message bubbles — the single biggest CPU hot path on long conversations).
//
// We coalesce pending token appends and flush once per animation frame via
// rAF. Visible typing speed is unchanged; Zustand mutations drop from ~100/msg
// to ~10-15/msg, cutting reconciliation cost proportionally. No gameplay or
// API-surface change.
//
// flushStreamingAppends() is also called synchronously at the top of every
// onDone handler, so the final streamingContent is guaranteed complete before
// message persistence runs. cancelStreamingBatch() drops pending text on error
// or abort paths so stale tokens don't leak into the next session.
let _pendingContent = "";
let _pendingReasoning = "";
let _streamingRafId: number | null = null;

function flushStreamingAppends(): void {
  _streamingRafId = null;
  const content = _pendingContent;
  const reasoning = _pendingReasoning;
  if (!content && !reasoning) return;
  _pendingContent = "";
  _pendingReasoning = "";
  useChatStore.setState((s) => ({
    ...(content ? { streamingContent: s.streamingContent + content } : {}),
    ...(reasoning ? { streamingReasoning: s.streamingReasoning + reasoning } : {}),
  }));
}

function scheduleStreamingFlush(): void {
  if (_streamingRafId != null) return;
  _streamingRafId = requestAnimationFrame(flushStreamingAppends);
}

function enqueueStreamingContent(text: string): void {
  _pendingContent += text;
  scheduleStreamingFlush();
}

function enqueueStreamingReasoning(text: string): void {
  _pendingReasoning += text;
  scheduleStreamingFlush();
}

function cancelStreamingBatch(): void {
  if (_streamingRafId != null) {
    cancelAnimationFrame(_streamingRafId);
    _streamingRafId = null;
  }
  _pendingContent = "";
  _pendingReasoning = "";
}

// Mix mode retry: tracks which models have been attempted during a single send cycle
let _mixAttempted: Set<string> = new Set();
const MIX_NO_RETRY_CODES = new Set([
  "NO_CREDITS",
  "SUSPENDED",
  "CONCURRENT_LIMIT",
  "MESSAGE_TOO_LONG",
  "PROTECTED_WORLD",
  // The send route has already persisted the user turn before this late
  // quality gate runs. Retrying it as a fresh send would duplicate that turn;
  // let the user regenerate the discarded assistant reply instead.
  "REPETITIVE_REPLY",
  // The guard already spent its one bounded correction attempt. Never start
  // new narrative/model attempts behind the user's back after this failure.
  "STATE_VALIDATION",
]);

export interface Attachment {
  type: string;
  mimeType: string;
  name: string;
  data: string; // base64
}

export interface Message {
  stateValidation?: import("@yumina/shared").StateValidationAudit | null;
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "complete" | "streaming" | "failed";
  errorMessage?: string | null;
  stateChanges?: Record<string, unknown> | null;
  stateSnapshot?: Record<string, unknown> | null;
  swipes?: Array<{
    content: string;
    /** Full pre-parse LLM output (segments + directives + JSON wrappers).
     *  Stored alongside `content` so users can inspect the raw response when
     *  parsing eats narrative or directives. Optional for backwards-compat
     *  with messages persisted before 2026-05. */
    rawContent?: string;
    stateValidation?: import("@yumina/shared").StateValidationAudit;
    stateChanges?: Record<string, unknown>;
    stateSnapshot?: Record<string, unknown>;
    createdAt: string;
    model?: string;
    modelFallback?: ModelFallbackRecord;
    tokenCount?: number;
    creditCost?: number;
    creditBalanceAfter?: number;
    /** The server's refusal-detector judged this reply to be a model policy
     *  refusal (set on the `done` SSE payload and persisted on the swipe). */
    refusal?: boolean;
    /** The AI of a group chat that said this, when it was not the turn's
     *  first voice (server lib/group-reply.ts). */
    voice?: string;
  }>;
  activeSwipeIndex?: number;
  model?: string | null;
  modelFallback?: ModelFallbackRecord;
  tokenCount?: number | null;
  generationTimeMs?: number | null;
  creditCost?: number | null;
  creditBalanceAfter?: number | null;
  compacted?: boolean;
  attachments?: Array<{ type: string; mimeType: string; name: string; url: string }> | null;
  createdAt: string;
  /** Client-only: the per-turn picture is drawing, or why it wasn't drawn. */
  turnImage?: import("@/features/chat/turn-image-drawing").TurnImageStatus;
}

interface CreditsPayload {
  cost: number;
  balance?: number;
}

function parseCreditsPayload(data: unknown): CreditsPayload | null {
  const credits = (data as { credits?: { cost?: unknown; balance?: unknown } })?.credits;
  if (!credits || typeof credits.cost !== "number" || !Number.isFinite(credits.cost)) {
    return null;
  }
  return {
    cost: credits.cost,
    ...(typeof credits.balance === "number" && Number.isFinite(credits.balance)
      ? { balance: credits.balance }
      : {}),
  };
}

function syncCreditBalance(credits: CreditsPayload | null): void {
  if (credits?.balance == null) return;
  syncCreditsFromMessageResponse({ balance: credits.balance, cost: credits.cost });
}

/**
 * Resolve the toast text for a transient error code.
 *
 * NO_CREDITS carries two distinct server meanings, distinguished by `balance`:
 *  - balance === 0  → the wallet is genuinely empty ("out of mushies").
 *  - balance  >  0  → the wallet still has mushies, but this single message's
 *    prompt alone costs more than the remaining balance (the pre-flight
 *    affordability gate on big cards / expensive models). Showing "out of
 *    mushies" here is misleading — the user can see they still have a balance.
 *    Surface an accurate "conversation too long for remaining balance" message
 *    instead.
 */
function resolveErrorToast(errorCode: string, errorMsg: string, balance?: number): string {
  if (errorCode === "NO_CREDITS" && typeof balance === "number" && balance > 0) {
    return i18n.t("errors.NO_CREDITS_MSG_TOO_EXPENSIVE", {
      ns: "chat",
      balance: floorMushies(balance),
      defaultValue: errorMsg,
    });
  }
  return i18n.t(`errors.${errorCode}`, { ns: "chat", defaultValue: errorMsg });
}

/**
 * The pill is one line. Server error copy and world-authored notifications are
 * not, so keep the first sentence and hard-clamp the rest — the full
 * explanation still lives where it belongs (the credit popup, the error
 * banner, the card's own UI). Also drops the trailing punctuation the copy
 * policy rejects.
 */

/** Pill copy from the chat namespace, clamped to the pill's one line. */
function chatPill(key: string, fallback: string, vars?: Record<string, unknown>): string {
  return toPillText(i18n.t(key, { ns: "chat", defaultValue: fallback, ...vars }));
}

/** The guard could not check this turn, so the reply applied as written. The
 * audit is re-sent on every progress write, so announce each attempt once. */
const announcedUnverified = new Set<string>();
function noticeUnverifiedTurn(audit: import("@yumina/shared").StateValidationAudit): void {
  if (audit.outcome !== "unverified" || announcedUnverified.has(audit.attemptId)) return;
  announcedUnverified.add(audit.attemptId);
  feedback.notice(chatPill("stateGuard.unverified", "State check unavailable. Stats updated from the reply as written"));
}

/** Recipe R7: an unanchored failure the user can ask us to try again. */
function retryAction(onClick: () => void): { label: string; onClick: () => void } {
  return { label: i18n.t("action.retry", { ns: "common", defaultValue: "Retry" }), onClick };
}

/**
 * Codes where running the same turn again can actually succeed. Out of
 * mushies, a plan gate or a suspension needs a decision, not another attempt —
 * those pills carry no Retry (the credit popup / plan UI takes over).
 */
const RETRYABLE_STREAM_CODES = new Set(["RATE_LIMITED", "CONCURRENT_LIMIT", "REPETITIVE_REPLY"]);

/** While the browser reports no network, that is the error worth naming —
 *  whatever the failed request itself said ("Failed to fetch", a stall). */
function offlineAware(code: string | undefined): string | undefined {
  return typeof navigator !== "undefined" && navigator.onLine === false ? "OFFLINE" : code;
}

/** The app's legitimate pill: a stream that failed out of view. */
function showStreamError(code: string, text: string, retry?: () => void): void {
  feedback.error(
    toPillText(text),
    retry && RETRYABLE_STREAM_CODES.has(code) ? retryAction(retry) : undefined,
  );
}

/**
 * In-game notifications from notify-player rule actions. The copy belongs to
 * the world author, so it is flattened before it reaches the pill, and the
 * DEV-only copy guard is never allowed to break a turn.
 */
function showGameNotifications(
  notifications: Array<{ message: string; style: string; title?: string; image?: string }> | undefined,
): void {
  if (!notifications?.length) return;
  for (const n of notifications) {
    // 时刻: a card with its picture, not a pill.
    if (n.style === "moment") {
      void import("@/features/chat/moment-toast").then(({ showMoment }) => showMoment({ title: String(n.title ?? ""), text: String(n.message ?? ""), image: n.image })).catch(() => {});
      continue;
    }
    const text = toPillText(String(n.message ?? ""));
    if (!text) continue;
    try {
      if (n.style === "error" || n.style === "warning") feedback.error(text);
      else feedback.notice(text);
    } catch {
      /* dev-only copy guard — a card's wording must not stop the game */
    }
  }
}

export interface Checkpoint {
  id: string;
  name: string;
  messageCount: number;
  createdAt: string;
}

export interface SessionData {
  sessionPersona?: {
    selectionVersion?: string;
    persona: {
      id?: string;
      name: string;
      avatarUrl?: string | null;
      appearance?: string | null;
      personality?: string | null;
      backstory?: string | null;
      entries?: { title: string; content: string }[];
    } | null;
  } | null;
  personaLocked?: boolean;
  id: string;
  userId?: string;
  worldId: string;
  name?: string | null;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  world?: {
    id: string;
    name: string;
    description: string;
    schema: Record<string, unknown>;
    creatorId?: string;
    thumbnailUrl?: string | null;
  } | null;
  currentUser?: {
    id: string;
    name: string;
    image?: string | null;
  } | null;
  room?: Record<string, unknown> | null;
  // Branching metadata — populated by GET /api/sessions/:id (Task 4)
  parentSessionId?: string | null;
  branchedFromMessageId?: string | null;
  parentSessionName?: string | null;
  childBranches?: Array<{
    id: string;
    name: string | null;
    branchedFromMessageId: string | null;
  }>;
}

interface PendingSilentChange {
  ruleId: string;
  effects: Effect[];
  timestamp: number;
}

interface ChatState {
  // Current session
  session: SessionData | null;
  /** Scene image ids this session has shown: the server's record on load,
   *  plus whatever this tab's own turns revealed. Read by the gallery. */
  revealedSceneImages: string[];
  runtimeRecords: RuntimeRecord[];
  /** 现场: the card interface's latest api.setScene — sent with every AI
   *  call (send / regenerate / continue / quiet tick), never stored. */
  liveScene: { scene: unknown; events: unknown } | null;
  setLiveScene: (scene: unknown, events?: unknown) => void;
  /** Quiet-station turns that chose silence — the playtest timeline's
   *  hollow dots. Nothing else records them. */
  quietSilences: Array<{ at: string; sessionId: string; speakerId: string; speakerName: string }>;
  /** Events the AI set off ([event: name]) waiting to reach the card. */
  storyEvents: Array<{ id: string; name: string; ai?: { channel: string; id: string; name: string; text: string; fields: Record<string, unknown> }; code?: { reactionId: string; source: string; names: Record<string, string> } }>;
  runtimeRecordingSessionId: string | null;
  startRuntimeRecording: (sessionId: string) => void;
  stopRuntimeRecording: (sessionId: string) => void;
  applyRuntimeResult: (sessionId: string, payload: Record<string, unknown>, kind?: RuntimeRecordKind, actionId?: string) => void;
  messages: Message[];
  // Full history size server-side. The server returns only a recent window
  // (mega sessions froze it serializing full histories — 2026-08-11 outage);
  // older pages load on demand via loadEarlierMessages.
  messageTotal: number;
  hasEarlierMessages: boolean;
  isLoadingEarlier: boolean;
  gameState: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;

  // Read-only mode (world unpublished)
  readOnly: boolean;

  // Streaming state
  isStreaming: boolean;
  isContinuing: boolean;
  streamingContent: string;
  streamingReasoning: string;
  streamingSegments: Record<string, unknown>[];
  streamingBg: string | null;
  streamStartTime: number | null;
  abortController: AbortController | null;

  // AI-provided choices
  pendingChoices: string[];

  // Silent action rule changes pending next AI message
  pendingSilentChanges: PendingSilentChange[];

  // Error state
  error: string | null;
  /** Server action code for `error` (e.g. "CONTENT_FILTER" when the provider's
   *  safety filter blocked the reply). Only meaningful while `error` is set.
   *  Send failures ALSO persist it on the user row (`[CODE] msg` errorMessage);
   *  regenerate/continue don't touch that row, so this is their only channel. */
  errorCode: string | null;
  /** Bumped on every terminally-failed send (including "transient" toast-only
   *  failures that deliberately do NOT set `error`). The sandbox composer
   *  watches this to restore the swallowed text — a toast-class rejection
   *  (NO_CREDITS, MODEL_NOT_ALLOWED, …) must never eat a typed message. */
  sendFailureNonce: number;
  /** Structured terminal send outcome for persistent recovery UI. Never stores
   * provider text or the submitted message; transient toasts can still expire. */
  lastSendFailure: { sessionId: string; code: string; balance?: number } | null;
  modelFallback: ModelFallbackNotice | null;
  resolveModelFallback: (noticeId: string, model: string, remember?: boolean) => void;
  cancelModelFallback: (noticeId: string) => void;

  // Actions
  setSession: (session: SessionData | null) => void;
  clearError: () => void;
  setMessages: (messages: Message[]) => void;
  setGameState: (state: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  removeMessage: (id: string) => void;
  sendMessage: (content: string, model?: string, attachments?: Attachment[], retry?: ModelFallbackRetry) => void;
  regenerateMessage: (messageId: string, model?: string, retry?: ModelFallbackRetry) => void;
  stopGeneration: () => void;
  setPendingChoices: (choices: string[]) => void;
  clearPendingChoices: () => void;

  // Continue
  continueLastMessage: (model?: string, retry?: ModelFallbackRetry) => void;

  // Revert & restart
  revertLastExchange: () => Promise<void>;
  revertToMessage: (messageId: string) => Promise<void>;
  branchFromMessage: (messageId: string) => Promise<string | null>;
  restartChat: () => Promise<void>;

  // Checkpoints
  checkpoints: Checkpoint[];
  saveCheckpoint: () => Promise<void>;
  loadCheckpoints: () => Promise<void>;
  restoreCheckpoint: (checkpointId: string) => Promise<void>;
  deleteCheckpoint: (checkpointId: string) => Promise<void>;

  // Direct variable update (from custom components)
  setVariableDirectly: (id: string, value: number | string | boolean | Record<string, unknown> | unknown[]) => void;

  // Action rule execution (from custom component buttons)
  /** The open game's clock: asks the card's quiet stations whether this
   *  silence is worth a line. No-op while streaming or read-only. */
  /** The open game's clock; with `call`, the card's screen calling one
   *  UI-based AI (by id or name) to answer now. */
  quietTick: (call?: string) => Promise<void>;
  /** The card's screen calling one of its AIs: runs it, applies what it
   *  changed, and resolves with its answer (null when it could not run). */
  callAi: (ai: string, input?: unknown) => Promise<{ text: string; fields: Record<string, unknown>; fallback: boolean } | null>;
  /** A group chat's later voices: after an answer lands, asks for the next
   *  AI in the room until every one has spoken. No-op on a card without. */
  groupReply: (model?: string) => Promise<void>;
  executeActionRule: (actionId: string) => void;
  executeActionAndWait: (actionId: string, params?: Record<string, unknown>, clock?: number) => Promise<{ applied: true; variables: Record<string, unknown>; firedIds: string[] }>;

  // Switch greeting to a different pre-written opening (by swipe index)
  /** Resolves once the switch has been applied (or immediately when there is
   *  nothing to switch). Never rejects. */
  switchGreeting: (index: number) => Promise<void>;

  // Load session data from API
  loadSession: (sessionId: string, shouldApply?: () => boolean) => Promise<void>;

  // Reconcile messages with server (lightweight — messages only, no audio/asset reload).
  // Used after abort/error to replace any __pending_* placeholder with the real DB row.
  refreshMessages: (options?: { preserveHistory?: boolean }) => Promise<boolean>;

  // Prepend the previous page of history (older than the oldest loaded row).
  loadEarlierMessages: () => Promise<boolean>;
}

type ChatStateSetter = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
) => void;

/**
 * A 401 means the browser no longer has a usable Yumina session. Never show
 * the server's raw "Unauthorized" payload as a model/chat error: clean up the
 * optimistic streaming state, then use the app-wide sign-in recovery path.
 */
function finishChatAuthLoss(
  setState: ChatStateSetter,
  { dropPendingMessage = false }: { dropPendingMessage?: boolean } = {},
): void {
  cancelStreamingBatch();
  _isSending = false;
  setState((state) => ({
    isStreaming: false,
    streamingContent: "",
    streamingReasoning: "",
    streamingSegments: [],
    streamingBg: null,
    streamStartTime: null,
    abortController: null,
    error: null,
    ...(dropPendingMessage
      ? {
          sendFailureNonce: state.sendFailureNonce + 1,
          messages: state.messages.filter((message) => !message.id.startsWith("__pending_")),
        }
      : {}),
  }));
  handleAuthLoss();
}

const apiBase = import.meta.env.VITE_API_URL || "";

// Module-level abort controller for loadSession — prevents stale session data
// when the user rapidly switches between sessions (#31).
let _loadSessionAbort: AbortController | null = null;

// Separate controller for refreshMessages so a quick stop->refresh doesn't get
// cancelled by an unrelated loadSession (or vice versa).
let _refreshMessagesAbort: AbortController | null = null;

// Synchronous guard against double-click sending (#33).
// Zustand's set() is async-batched by React, so checking `isStreaming` alone
// has a TOCTOU window. This flag is set synchronously before any async work.
let _isSending = false;

// Serialize branch requests across every UI entry point (header, popover, sandbox).
let _branchInFlight = false;

function reconcileMessagesWithRetry(refresh: () => Promise<boolean>) {
  void refresh()
    .then((ok) => {
      if (!ok) {
        window.setTimeout(() => void refresh(), 800);
      }
    })
    .catch(() => {
      window.setTimeout(() => void refresh(), 800);
    });
}

// Cancels an in-flight connection-loss recovery poll. Bumped by
// stopGeneration and by each new recovery so only the latest one runs.
let _recoveryToken = 0;

const RECOVERY_POLL_INTERVAL_MS = 5_000;
const RECOVERY_POLL_WINDOW_MS = 120_000;

/**
 * After a network-layer stream failure ("connection" origin) the server is
 * often STILL generating: Cloudflare/Railway don't propagate the client
 * disconnect to the origin, so the reply gets persisted and charged even
 * though this client saw an error. Erroring out immediately invites a
 * resend/regenerate that duplicates the whole turn (the cxyyy/Misa
 * duplicated-reply incidents).
 *
 * Instead: confirm the request actually reached the server, then keep the
 * "generating" UI up and poll until the orphaned reply lands. The user gets
 * the reply they already paid for, exactly once.
 *
 * Send mode (`sentContent` set): the user row is inserted BEFORE generation
 * starts, so its absence in the DB proves the request never landed → give up
 * immediately (resending is then safe). Continue mode (`sentContent` null)
 * has no early marker; we just watch for a new tail message.
 */
async function recoverFromConnectionLoss(opts: {
  sessionId: string;
  sentContent: string | null;
  lastMessageIdAtSend: string | null;
  getState: () => ChatState;
  setState: (
    partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)
  ) => void;
  /** Pre-existing error path, run when recovery is impossible or times out. */
  giveUp: () => void;
  /** Send mode only: the probe proved the request never reached the server
   *  (no user row) — re-requesting is safe. Falls back to giveUp if absent. */
  onNeverLanded?: () => void;
}): Promise<void> {
  const { sessionId, sentContent, lastMessageIdAtSend, getState, setState, giveUp } = opts;
  const token = ++_recoveryToken;
  const cancelled = (): boolean => {
    // Token bump = stopGeneration (which already cleared the flags) or a
    // newer recovery took over. Nothing left to do here.
    if (_recoveryToken !== token) return true;
    if (getState().session?.id !== sessionId) {
      // Session switched under us. Streams always terminate through
      // onDone/onError which clear _isSending — recovery replaced that
      // terminal path, so it must restore the invariant itself or the
      // module-level flag stays true forever and blocks every future send.
      _isSending = false;
      setState({
        isStreaming: false,
        streamingContent: "",
        streamingReasoning: "",
        streamingSegments: [],
        streamingBg: null,
        streamStartTime: null,
        abortController: null,
      });
      return true;
    }
    return false;
  };

  const fetchList = async (): Promise<Message[] | null> => {
    try {
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages`, {
        credentials: "include",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const { data } = await res.json();
      return Array.isArray(data) ? (data as Message[]) : null;
    } catch {
      return null;
    }
  };

  /** Index of the message the reply must come AFTER (-1 = any tail works). */
  const findAnchor = (list: Message[]): number => {
    if (sentContent === null) return -1;
    const prevIdx = lastMessageIdAtSend
      ? list.findIndex((m) => m.id === lastMessageIdAtSend)
      : -1;
    for (let i = list.length - 1; i > prevIdx; i--) {
      const m = list[i];
      if (m && m.role === "user") {
        return m.content === sentContent ? i : -1;
      }
    }
    return -1;
  };

  const replyLanded = (list: Message[], anchorIdx: number): boolean => {
    const last = list[list.length - 1];
    if (!last || last.role !== "assistant") return false;
    if (sentContent !== null) return anchorIdx !== -1 && list.length - 1 > anchorIdx;
    return last.id !== lastMessageIdAtSend;
  };

  const finish = (list: Message[]) => {
    const last = list[list.length - 1];
    const vars = (last?.stateSnapshot as { variables?: ChatState["gameState"] } | null | undefined)
      ?.variables;
    _isSending = false;
    if (last) getState().applyRuntimeResult(sessionId, {
      state: last.stateSnapshot, stateChanges: last.stateChanges, messageId: last.id,
    }, sentContent === null ? "continue" : "turn");
    setState({
      messages: list,
      isStreaming: false,
      streamingContent: "",
      streamingReasoning: "",
      streamingSegments: [],
      streamingBg: null,
      streamStartTime: null,
      abortController: null,
      error: null,
      ...(vars ? { gameState: vars } : {}),
    });
  };

  // Offline: nothing can be probed or polled, and a spinner that waits on
  // the network is the "stuck generating forever" bug. Give the turn back
  // now (error + the typed text restored), then look again the moment the
  // network returns — the server may have finished the reply meanwhile.
  if (typeof navigator !== "undefined" && navigator.onLine === false && typeof window !== "undefined") {
    giveUp();
    const onOnline = () => {
      window.removeEventListener("online", onOnline);
      if (_recoveryToken !== token || getState().session?.id !== sessionId) return;
      void getState().refreshMessages().then(() => {
        const state = getState();
        if (state.session?.id !== sessionId) return;
        // The turn did land: the error no longer describes the transcript.
        if (sentContent !== null && findAnchor(state.messages) !== -1) {
          setState({ error: null, lastSendFailure: null });
        }
      });
    };
    window.addEventListener("online", onOnline);
    return;
  }

  // Probe: did the request land at all? The user-row insert runs a few
  // seconds into the request (auth + session load first), so wait before
  // probing — an instant probe could race ahead of the insert and misread
  // a landed request as "never landed".
  if (sentContent !== null) {
    await new Promise((r) => window.setTimeout(r, 10_000));
    if (cancelled()) return;
  }
  const first = await fetchList();
  if (cancelled()) return;
  if (sentContent !== null) {
    if (!first) {
      giveUp();
      return;
    }
    const anchorIdx = findAnchor(first);
    if (anchorIdx === -1) {
      // Server reachable, no user row → the request never landed.
      (opts.onNeverLanded ?? giveUp)();
      return;
    }
    if (replyLanded(first, anchorIdx)) {
      finish(first);
      return;
    }
    // The persisted user row replaces the local __pending_ placeholder.
    setState({ messages: first });
  } else if (first && replyLanded(first, -1)) {
    finish(first);
    return;
  }

  const deadline = Date.now() + RECOVERY_POLL_WINDOW_MS;
  let consecutiveFailures = first ? 0 : 1;
  while (Date.now() < deadline) {
    await new Promise((r) => window.setTimeout(r, RECOVERY_POLL_INTERVAL_MS));
    if (cancelled()) return;
    const list = await fetchList();
    if (cancelled()) return;
    if (!list) {
      // Server genuinely unreachable — stop burning the user's time.
      if (++consecutiveFailures >= 3) {
        giveUp();
        return;
      }
      continue;
    }
    consecutiveFailures = 0;
    const anchorIdx = findAnchor(list);
    if (sentContent !== null && anchorIdx === -1) {
      // Our user row vanished (revert/delete from another tab) — recovery moot.
      giveUp();
      return;
    }
    if (replyLanded(list, anchorIdx)) {
      finish(list);
      return;
    }
  }
  giveUp();
}

type FallbackReplay = {
  id: string;
  userId: string | null;
  keyId: string | null;
  provider: "official" | "private";
  tailId: string | null;
  attemptedFallback: boolean;
  run: (model: string, retry: ModelFallbackRetry) => void;
};
let fallbackReplay: FallbackReplay | null = null;

function activePrivateKey(): string | null {
  const id = useUserProfileStore.getState().profile?.preferences?.activeApiKeyId;
  return typeof id === "string" ? id : null;
}

/** Pause only after an explicit, completed server failure. A lost connection
 * still follows the existing recovery path; it must never spend on a second model. */
function pauseForModelFallback(
  error: string,
  origin: string | undefined,
  sessionId: string,
  retry: ModelFallbackRetry | undefined,
  run: FallbackReplay["run"],
  tempUserMessageId?: string,
): boolean {
  const failure = origin === "server" ? parseFallbackError(error) : null;
  if (!failure) return false;
  const state = useChatStore.getState();
  if (state.session?.id !== sessionId) return true;
  const policy = useConfigStore.getState().modelFallback;
  const decision = fallbackDecision(policy, failure.provider, activePrivateKey(), failure.requestedModel, !!retry?.attemptedFallback);
  const notice: ModelFallbackNotice = {
    id: crypto.randomUUID(), sessionId,
    userMessageId: failure.userMessageId ?? retry?.userMessageId,
    requestedModel: retry?.requestedModel ?? failure.requestedModel,
    failedModel: failure.requestedModel,
    suggestedModel: decision.suggestedModel,
    reason: failure.reason, provider: failure.provider, status: decision.status,
  };
  cancelStreamingBatch();
  _isSending = false;
  useChatStore.setState((s) => ({
    isStreaming: false, streamingContent: "", streamingReasoning: "",
    streamingSegments: [], streamingBg: null, streamStartTime: null,
    abortController: null, error: null, modelFallback: notice,
    messages: s.messages.map((m) => m.id === tempUserMessageId && failure.userMessageId
      ? { ...m, id: failure.userMessageId, status: "failed", errorMessage: "[MODEL_FALLBACK_REQUIRED] Model unavailable" }
      : m),
  }));
  fallbackReplay = {
    id: notice.id,
    userId: useUserProfileStore.getState().profile?.id ?? null,
    provider: useCreditStore.getState().provider,
    keyId: activePrivateKey(),
    tailId: useChatStore.getState().messages.at(-1)?.id ?? null,
    attemptedFallback: !!retry?.attemptedFallback,
    run,
  };
  if (decision.autoRetry) {
    // No timer-based loop: consume this turn's one automatic attempt once.
    queueMicrotask(() => resumeModelFallback(notice.id, decision.suggestedModel, false, true));
  }
  return true;
}

function resumeModelFallback(id: string, model: string, remember: boolean, automatic = false): void {
  const state = useChatStore.getState();
  const notice = state.modelFallback;
  const replay = fallbackReplay;
  if (!notice || !replay || id !== notice.id || id !== replay.id || state.isStreaming ||
      state.readOnly || state.session?.id !== notice.sessionId || !model.trim() || model.length > 200) return;
  // A choice from an old card, another account, or a changed API key cannot
  // authorize a new request against the current conversation/provider.
  if (replay.userId !== (useUserProfileStore.getState().profile?.id ?? null) ||
      replay.provider !== useCreditStore.getState().provider || replay.keyId !== activePrivateKey() ||
      replay.tailId !== (state.messages.at(-1)?.id ?? null)) {
    state.cancelModelFallback(id);
    return;
  }
  fallbackReplay = null; // Consumed before dispatch: double clicks cannot send twice.
  const isFallback = model !== notice.requestedModel;
  if (remember && isFallback) {
    const config = useConfigStore.getState();
    const policy = config.modelFallback ?? DEFAULT_MODEL_FALLBACK_POLICY;
    config.setConfig("modelFallback", {
      ...policy, mode: "auto",
      ...(notice.provider === "official" ? { officialModel: model }
        : { privateModel: model, privateKeyId: activePrivateKey() }),
    });
  }
  useChatStore.setState({ modelFallback: isFallback
    ? { ...notice, status: "switching", suggestedModel: model }
    : null });
  replay.run(model, {
    requestedModel: notice.requestedModel, reason: notice.reason,
    automatic, attemptedFallback: replay.attemptedFallback || isFallback,
    userMessageId: notice.userMessageId,
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  session: null,
  revealedSceneImages: [],
  runtimeRecords: [],
  runtimeRecordingSessionId: null,
  startRuntimeRecording: (sessionId) => set((s) => ({
    runtimeRecordingSessionId: sessionId,
    runtimeRecords: s.runtimeRecordingSessionId === sessionId ? s.runtimeRecords : [],
  })),
  stopRuntimeRecording: (sessionId) => set((s) =>
    s.runtimeRecordingSessionId === sessionId ? { runtimeRecordingSessionId: null } : {}),
  applyRuntimeResult: (sessionId, payload, kind, actionId) => set((s) => {
    if (s.session?.id !== sessionId) return {};
    const session = withRuntimeState(s.session, sessionId, payload.state);
    const variables = session?.state.variables as ChatState["gameState"] | undefined;
    const fired: ChatState["storyEvents"] = Array.isArray(payload.storyEvents)
      ? payload.storyEvents.filter((name): name is string => typeof name === "string").map((name) => ({ id: crypto.randomUUID(), name }))
      : [];
    // 回复处理: blocks a reply rule sends to an interface channel reach the
    // card's api.onAiOutput listeners, like a custom AI's words do.
    if (Array.isArray(payload.replyChannels)) {
      for (const out of payload.replyChannels as Array<{ channel: string; text: string; rule: string }>) {
        if (out && typeof out.channel === "string") fired.push({ id: crypto.randomUUID(), name: `ai:${out.channel}`, ai: { channel: out.channel, id: "reply", name: String(out.rule ?? ""), text: String(out.text ?? ""), fields: {} } });
      }
    }
    // 代码行为: a behaviour with code of its own that fired here runs in the
    // card's sandbox (world-renderer hands it over with the story events).
    if (Array.isArray(payload.firedIds) && payload.firedIds.length > 0) {
      const schema = s.session?.world?.schema as { reactions?: Array<{ id: string; code?: string }>; variables?: Array<{ id: string; name: string }> } | undefined;
      const reactions = schema?.reactions ?? [];
      for (const id of payload.firedIds) {
        const r = reactions.find((x) => x.id === id && typeof x.code === "string" && x.code.trim());
        if (r) fired.push({ id: crypto.randomUUID(), name: `code:${r.id}`, code: { reactionId: r.id, source: r.code!, names: Object.fromEntries((schema?.variables ?? []).map((v) => [v.name, v.id])) } });
      }
    }
    return {
      session,
      ...(fired.length > 0 ? { storyEvents: [...s.storyEvents, ...fired].slice(-20) } : {}),
      ...(variables ? { gameState: variables } : {}),
      ...(kind ? { runtimeRecords: appendRuntimeRecord(s.runtimeRecords, s.runtimeRecordingSessionId, sessionId, kind, payload, actionId) } : {}),
    };
  }),
  liveScene: null,
  setLiveScene: (scene, events) => set({ liveScene: scene == null && events == null ? null : { scene, events: events ?? [] } }),
  storyEvents: [],
  quietSilences: [],
  messages: [],
  messageTotal: 0,
  hasEarlierMessages: false,
  isLoadingEarlier: false,
  gameState: {},
  readOnly: false,
  isStreaming: false,
  isContinuing: false,
  streamingContent: "",
  streamingReasoning: "",
  streamingSegments: [],
  streamingBg: null,
  streamStartTime: null,
  abortController: null,
  pendingChoices: [],
  pendingSilentChanges: [],
  checkpoints: [],
  error: null,
  errorCode: null,
  sendFailureNonce: 0,
  lastSendFailure: null,
  modelFallback: null,
  resolveModelFallback: (id, model, remember = false) => resumeModelFallback(id, model, remember),
  cancelModelFallback: (id) => {
    if (get().modelFallback?.id !== id || get().isStreaming) return;
    fallbackReplay = null;
    set({ modelFallback: null });
  },

  setSession: (session) => {
    const changed = session?.id !== get().session?.id;
    if (changed) fallbackReplay = null;
    set({
      session,
      ...(changed && { error: null, lastSendFailure: null, modelFallback: null, liveScene: null, storyEvents: [] }),
      ...(session === null && { readOnly: false }),
    });
  },
  clearError: () => set({ error: null, lastSendFailure: null, errorCode: null }),
  setMessages: (messages) => set({ messages }),
  setGameState: (gameState) => set((s) => ({
    gameState,
    session: s.session ? { ...s.session, state: { ...s.session.state, variables: gameState } } : null,
  })),

  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),

  updateMessage: (id, updates) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    })),

  removeMessage: (id) =>
    set((s) => ({
      messages: s.messages.filter((m) => m.id !== id),
    })),

  loadSession: async (sessionId: string, shouldApply?: () => boolean) => {
    if (get().session?.id !== sessionId) { fallbackReplay = null; set({ modelFallback: null }); }
    // Abort any in-flight session load to prevent stale data (#31)
    _loadSessionAbort?.abort();
    const controller = new AbortController();
    _loadSessionAbort = controller;

    try {
      // Stop any existing audio only when switching to a different session
      const currentSession = get().session;
      if (currentSession && currentSession.id !== sessionId) {
        useAudioStore.getState().cleanup();
      }

      const res = await fetch(`${apiBase}/api/sessions/${sessionId}`, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });

      // Guard: if this load was superseded by a newer one, discard results
      if (controller.signal.aborted || shouldApply?.() === false) return;

      if (res.status === 401) {
        set({ error: null });
        handleAuthLoss();
        return;
      }

      if (res.status === 401) {
        set({ error: null });
        handleAuthLoss();
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg = typeof body?.error === "string" ? body.error : "Failed to load session";
        set({ error: msg });
        return;
      }

      const { data } = await res.json();

      // Guard again after async JSON parsing
      if (controller.signal.aborted || shouldApply?.() === false) return;

      const gameState = (data.state?.variables ?? {}) as Record<
        string,
        number | string | boolean
      >;

      const loadedMessages: Message[] = data.messages ?? [];
      const messageTotal: number = typeof data.messageTotal === "number" ? data.messageTotal : loadedMessages.length;
      // Root components can request opening music as soon as the session is
      // visible. Register tracks before publishing it; the asset-preload import
      // below may yield long enough for the sandbox to mount on a cold load.
      const worldDef = data.world?.schema as Record<string, unknown> | undefined;
      useAudioStore.getState().setTracks(
        Array.isArray(worldDef?.audioTracks)
          ? worldDef.audioTracks as import("@yumina/engine").AudioTrack[]
          : [],
      );
      set({
        session: data,
        messages: loadedMessages,
        messageTotal,
        hasEarlierMessages: messageTotal > loadedMessages.length,
        isLoadingEarlier: false,
        gameState,
        readOnly: Boolean(data.readOnly),
        error: null,
        lastSendFailure: null,
      });

      // Prime asset preload links in the parent <head> so the browser starts
      // fetching priority images in parallel with the sandbox iframe boot.
      // For heavy-asset worlds this moves images from "appear 2–3s after chat
      // is interactive" to "appear as soon as the iframe mounts".
      if (data.assetManifest) {
        const { primeAssetManifest } = await import("@/lib/asset-preload");
        if (controller.signal.aborted) return;
        primeAssetManifest(data.assetManifest);
      }

      // Configure playback after the registry is available to the renderer.
      if (worldDef?.audioTracks && Array.isArray(worldDef.audioTracks)) {
        const audioStore = useAudioStore.getState();

        // Set playlist and conditional rules
        if (worldDef.bgmPlaylist) {
          audioStore.setPlaylist(worldDef.bgmPlaylist as import("@yumina/engine").BGMPlaylist);
        }
        if (worldDef.conditionalBGM && Array.isArray(worldDef.conditionalBGM)) {
          audioStore.setConditionalRules(worldDef.conditionalBGM as import("@yumina/engine").ConditionalBGM[]);
        }

        // Resume audio from persisted state or start playlist
        const metadata = data.state?.metadata as Record<string, unknown> | undefined;
        set({
          revealedSceneImages: Array.isArray(metadata?.sceneImagesUnlocked)
            ? (metadata!.sceneImagesUnlocked as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
        });
        if (metadata?.activeAudio) {
          audioStore.resumeFromState(metadata.activeAudio);
        } else {
          // Start default playlist if autoPlay and no active audio to resume
          const pl = worldDef.bgmPlaylist as import("@yumina/engine").BGMPlaylist | undefined;
          if (pl?.autoPlay && !pl.waitForFirstMessage && pl.tracks.length > 0) {
            audioStore.startPlaylist();
          }
        }

        // Evaluate conditional BGM with session-start flag
        audioStore.evaluateConditionalBGM({
          worldId: data.worldId ?? "",
          variables: gameState,
          // Full history size, not the inline window — turn-based BGM
          // conditions must keep counting past the pagination cap.
          turnCount: messageTotal,
          metadata: {},
          isSessionStart: true,
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      set({ error: "Failed to load session" });
    }
  },

  refreshMessages: async (options) => {
    const sessionId = get().session?.id;
    if (!sessionId) return false;
    const original = get().messages;
    if (options?.preserveHistory && (get().isStreaming || _isSending || get().isLoadingEarlier)) return false;

    _refreshMessagesAbort?.abort();
    const controller = new AbortController();
    _refreshMessagesAbort = controller;

    try {
      if (options?.preserveHistory) {
        const refreshed = await refreshMessageWindow(original, async (before) => {
          const params = new URLSearchParams({ limit: "200" });
          if (before) { params.set("before", before.createdAt); params.set("beforeId", before.id); }
          const response = await fetch(`${apiBase}/api/sessions/${sessionId}/messages?${params}`, {
            credentials: "include", cache: "no-store", signal: controller.signal,
          });
          if (!response.ok) throw new Error("Message refresh failed");
          if (controller.signal.aborted || get().session?.id !== sessionId ||
              get().messages !== original || get().isStreaming || _isSending) {
            throw new DOMException("Stale refresh", "AbortError");
          }
          return response.json();
        });
        if (!refreshed || controller.signal.aborted || get().session?.id !== sessionId ||
            get().messages !== original || get().isStreaming || _isSending) return false;
        set(refreshed);
        return true;
      }
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages`, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted || !res.ok) return false;
      const { data, meta } = await res.json();
      if (controller.signal.aborted) return false;
      if (Array.isArray(data) && get().session?.id === sessionId) {
        // The server returns the recent window; a refresh resets any older
        // pages the user had loaded (they can re-load via the earlier button).
        set({
          messages: data as Message[],
          ...(typeof meta?.hasMore === "boolean" ? { hasEarlierMessages: meta.hasMore } : {}),
        });
        return true;
      }
      return false;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return false;
      // Non-fatal — we tried to reconcile, server hiccupped, leave local state alone.
      console.warn("[refreshMessages] failed:", err);
      return false;
    }
  },

  loadEarlierMessages: async () => {
    const { session, messages: current, isLoadingEarlier, hasEarlierMessages } = get();
    if (!session || isLoadingEarlier || !hasEarlierMessages) return false;
    // Oldest REAL row is the cursor (skip optimistic __pending_* placeholders).
    const oldest = current.find((m) => !m.id.startsWith("__pending_"));
    if (!oldest) return false;

    set({ isLoadingEarlier: true });
    try {
      const params = new URLSearchParams({
        before: oldest.createdAt,
        beforeId: oldest.id,
      });
      const res = await fetch(
        `${apiBase}/api/sessions/${session.id}/messages?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) return false;
      const { data, meta } = await res.json();
      if (!Array.isArray(data)) return false;
      // Session may have switched while we fetched.
      if (get().session?.id !== session.id) return false;
      const existingIds = new Set(get().messages.map((m) => m.id));
      const older = (data as Message[]).filter((m) => !existingIds.has(m.id));
      set((s) => ({
        messages: [...older, ...s.messages],
        hasEarlierMessages: Boolean(meta?.hasMore),
      }));
      return true;
    } catch (err) {
      console.warn("[loadEarlierMessages] failed:", err);
      return false;
    } finally {
      set({ isLoadingEarlier: false });
    }
  },

  sendMessage: (content: string, model?: string, attachments?: Attachment[], retry?: ModelFallbackRetry) => {
    const { session, isStreaming } = get();
    if (!session || isStreaming || _isSending || get().readOnly || (get().modelFallback && !retry)) {
      console.warn("[sendMessage] blocked:", { session: !!session, isStreaming, _isSending });
      return;
    }
    _isSending = true;
    const config = useConfigStore.getState();

    // Mix mode: pick a random model from the weighted pool
    let useModel: string;
    if (!model && config.mixMode && config.modelPool.length > 1) {
      useModel = pickModelFromPool(config.modelPool);
      _mixAttempted = new Set([useModel]);
    } else {
      useModel = model ?? config.selectedModel;
      _mixAttempted = new Set();
    }

    // Snapshot the tail BEFORE the optimistic insert — connection-loss
    // recovery uses it to tell "our user row landed server-side" apart from
    // an identical user message from an earlier turn.
    const lastMessageIdAtSend = get().messages[get().messages.length - 1]?.id ?? null;
    // One-shot guard for the safe auto-reattempt when a connection error's
    // probe proves the request never reached the server.
    let neverLandedReattempted = false;
    // Add user message immediately so it appears in chat before AI responds
    const tempUserMsgId = retry?.userMessageId ?? `__pending_${Date.now()}`;
    set((s) => ({
      isStreaming: true,
      streamingContent: "",
      streamingReasoning: "",
      streamingSegments: [],
      streamingBg: null,
      streamStartTime: Date.now(),
      pendingChoices: [],
      pendingSilentChanges: [],
      error: null,
      lastSendFailure: null,
      errorCode: null,
      messages: retry?.userMessageId ? s.messages : [
        ...s.messages,
        {
          id: tempUserMsgId,
          sessionId: session.id,
          role: "user" as const,
          content,
          attachments: attachments?.map(a => ({ type: a.type, name: a.name, mimeType: a.mimeType, url: `data:${a.mimeType};base64,${a.data}` })),
          createdAt: new Date().toISOString(),
        },
      ],
    }));

    const sseUrl = `${apiBase}/api/sessions/${session.id}/messages`;
    const overrides = {
      maxTokens: config.maxTokens,
      maxContext: config.maxContext,
      storyMemory: config.storyMemory ?? undefined,
      temperature: config.temperature,
      topP: config.topP,
      frequencyPenalty: config.frequencyPenalty,
      presencePenalty: config.presencePenalty,
      topK: config.topK,
      minP: config.minP,
      reasoningEffort: config.reasoningEffort,
      streaming: config.streaming,
    };

    const startSSE = (modelId: string, isMixRetry = false) => {
      const controller = connectSSE(sseUrl, {
        method: "POST",
        telemetry: { model: modelId, endpoint: "send" },
        body: {
          content,
          model: modelId,
          modelFallback: fallbackRecord(retry, modelId),
          ...(retry?.userMessageId && { retryMessageId: retry.userMessageId }),
          overrides: {
            ...overrides,
            ...kimiRepetitionOverride(modelId, config.repetitionPenalty),
          },
          ...(attachments && attachments.length > 0 && { attachments }),
          ...(get().liveScene && { scene: get().liveScene }),
          // Attempt #1 may have already persisted the user message server-side
          // (insert runs before the stream). The flag lets the server reuse
          // that row instead of inserting a duplicate.
          ...(isMixRetry && { mixRetry: true }),
        },
        callbacks: {
          onStateValidation: (audit) => {
            noticeUnverifiedTurn(audit);
            set((state) => ({ messages: state.messages.map((message, index) =>
              message.id === audit.targetMessageId || (audit.path === "send" && index === state.messages.length - 1 && message.role === "user")
                ? { ...message, stateValidation: audit } : message) }));
          },
          onText: (text) => {
            enqueueStreamingContent(text);
          },
          onReasoning: (text) => {
            enqueueStreamingReasoning(text);
          },
          onSegment: (data) => {
            set((s) => ({
              streamingSegments: [...s.streamingSegments, data.segment],
            }));
          },
          onBg: (data) => {
            set({ streamingBg: data.bg });
          },
          onDone: (data) => {
            fallbackReplay = null;
            set({ modelFallback: null });
            flushStreamingAppends();
            const state = get();
            if (state.session?.id !== session.id) return;
            state.applyRuntimeResult(session.id, data, "turn");
            const credits = parseCreditsPayload(data);

            // Update temp user message with server-assigned ID
            const serverUserId = data.userMessageId as string | undefined;

            // Build assistant message — prefer server-parsed clean text over raw stream
            const doneContent = (data.content as string) ?? state.streamingContent;
            const assistantMsg: Message = {
              id: (data.messageId as string) ?? crypto.randomUUID(),
              sessionId: session.id,
              role: "assistant",
              content: doneContent,
              stateValidation: data.stateValidation as Message["stateValidation"],
              stateChanges: data.stateChanges as Record<string, unknown> | null,
              stateSnapshot: (data.state as Record<string, unknown>) ?? null,
              model: (data.model as string) ?? null,
              modelFallback: data.modelFallback as ModelFallbackRecord | undefined,
              tokenCount: (data.tokenCount as number) ?? null,
              generationTimeMs: (data.generationTimeMs as number) ?? null,
              creditCost: credits?.cost ?? null,
              creditBalanceAfter: credits?.balance ?? null,
              createdAt: new Date().toISOString(),
              // Mirror the swipe row the server just persisted. Without this
              // the "view raw" (directives) toggle — which reads
              // swipes[activeSwipeIndex].rawContent — only appears after a
              // page refresh re-fetches messages.
              swipes: [
                {
                  content: doneContent,
                  rawContent: (data.rawContent as string) || undefined,
                  stateChanges:
                    (data.stateChanges as Record<string, unknown>) ?? undefined,
                  createdAt: new Date().toISOString(),
                  model: (data.model as string) ?? undefined,
                    modelFallback: data.modelFallback as ModelFallbackRecord | undefined,
                  tokenCount: (data.tokenCount as number) ?? undefined,
                  creditCost: credits?.cost,
                  creditBalanceAfter: credits?.balance,
                  ...(data.refusal === true && { refusal: true }),
                },
              ],
              activeSwipeIndex: 0,
            };

            // Update game state
            const newGameState = (
              (data.state as Record<string, unknown>)
                ?.variables as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>
            ) ?? state.gameState;

            // Extract AI-provided choices
            const choices = data.choices as string[] | undefined;
            if (choices && Array.isArray(choices) && choices.length > 0) {
              get().setPendingChoices(choices);
            }

            // CRITICAL: Save message FIRST, before any audio processing.
            // Audio/BGM code can throw (e.g. undefined track), which would
            // prevent the message from being saved if set() comes after.
            _isSending = false;
            set((s) => ({
              messages: [
                // Replace temp user msg ID with server ID, then append assistant.
                // A mixRetry send can reuse a user row that an earlier reconcile
                // already restored locally — drop it so the rename can't create
                // two messages with the same id.
                ...s.messages
                  .filter((m) => !(serverUserId && m.id === serverUserId && m.id !== tempUserMsgId))
                  .map((m) =>
                    m.id === tempUserMsgId && serverUserId
                      ? { ...m, id: serverUserId, status: "complete" as const, errorMessage: null }
                      : m
                  ),
                assistantMsg,
              ],
              isStreaming: false,
              streamingContent: "",
              streamingReasoning: "",
              streamingSegments: [],
              streamingBg: null,
              streamStartTime: null,
              abortController: null,
              gameState: newGameState,
            }));

            recordRevealedSceneImages(data.sceneImages);
            // Draw this reply's picture now that the turn is over (see turn-image-drawing).
            if (data.refusal !== true) void drawTurnImage(assistantMsg.id, true);
            // In a room of several AIs, the next one answers now.
            if (data.refusal !== true) void get().groupReply((data.model as string) || modelId);

            // Process audio effects (after message is safely saved)
            try {
              const audioEffects = data.audioEffects as import("@yumina/engine").AudioEffect[] | undefined;
              if (audioEffects && Array.isArray(audioEffects) && audioEffects.length > 0) {
                useAudioStore.getState().processAudioEffects(audioEffects);
              }
            } catch (audioErr) {
              console.warn("Audio effect processing failed:", audioErr);
            }

            // Process in-game notifications (from notify-player rule actions)
            try {
              showGameNotifications(
                data.notifications as Array<{ message: string; style: string }> | undefined,
              );
            } catch (notifErr) {
              console.warn("Notification processing failed:", notifErr);
            }

            // Update credit balance from server (real-time, no API call)
            syncCreditBalance(credits);

            // (Auto voice readout runs as a streaming read-along — see
            // ensureStreamReadAlong in lib/tts-playback — no per-done hook.)

            // Evaluate conditional BGM after state update
            try {
              if (newGameState) {
                const worldId = get().session?.worldId ?? "";
                useAudioStore.getState().evaluateConditionalBGM({
                  worldId,
                  variables: newGameState,
                  turnCount: get().messages.length,
                  metadata: {},
                  playerMessage: content,
                  aiMessage: state.streamingContent,
                });
              }

              // Start playlist after first AI message if waitForFirstMessage
              const audioSt = useAudioStore.getState();
              if (audioSt.playlist?.waitForFirstMessage && !audioSt.playlistState.isPlaying) {
                audioSt.startPlaylist();
              }
            } catch (bgmErr) {
              console.warn("BGM evaluation failed:", bgmErr);
            }
          },
          onError: (err, meta) => {
            if (pauseForModelFallback(err, meta?.origin, session.id, retry,
              (next, nextRetry) => get().sendMessage(content, next, attachments, nextRetry), tempUserMsgId)) return;
            if (retry) set({ modelFallback: null });
            if (meta?.origin === "http" && meta.status === 401) {
              finishChatAuthLoss(set, { dropPendingMessage: true });
              return;
            }

            // Parse error details once
            let errorMsg = err;
            let errorCode: string | undefined;
            let errorBalance: number | undefined;
            try {
              const parsed = JSON.parse(err.replace(/^HTTP \d+: /, ""));
              if (parsed.error) errorMsg = parsed.error;
              if (parsed.code) errorCode = parsed.code;
              if (typeof parsed.balance === "number") errorBalance = parsed.balance;
            } catch { /* use raw */ }

            // Network-layer failure: the server never said anything, so it may
            // STILL be generating (proxies don't propagate our disconnect) and
            // will persist + charge the reply. A retry here would duplicate the
            // whole turn — probe + poll for the orphaned reply instead. Only a
            // server-sent error (clean origin state) may fall through to the
            // mix-retry below.
            // The browser was offline before the request left: nothing reached
            // the server, so there is nothing to recover — stop "generating",
            // hand the text back to the composer and say what happened.
            if (meta?.origin === "offline") {
              cancelStreamingBatch();
              _isSending = false;
              set((s) => ({
                isStreaming: false,
                streamingContent: "",
                streamingReasoning: "",
                streamingSegments: [],
                streamingBg: null,
                streamStartTime: null,
                abortController: null,
                error: localizeChatError(errorMsg, "OFFLINE"),
                lastSendFailure: { sessionId: session.id, code: "OFFLINE" },
                sendFailureNonce: s.sendFailureNonce + 1,
                messages: s.messages.filter((m) => !m.id.startsWith("__pending_")),
              }));
              return;
            }

            if (meta?.origin === "connection") {
              void recoverFromConnectionLoss({
                sessionId: session.id,
                // Server stores the trimmed content — compare against that.
                sentContent: content.trim(),
                lastMessageIdAtSend,
                getState: get,
                setState: set,
                onNeverLanded: () => {
                  // Nothing landed server-side, so a re-request cannot
                  // duplicate anything. One automatic reattempt (mixRetry
                  // flag kept as a belt in case the row lands late).
                  if (neverLandedReattempted) {
                    // Second consecutive failure — surface the error.
                    cancelStreamingBatch();
                    _isSending = false;
                    set((s) => ({
                      isStreaming: false,
                      streamingContent: "",
                      streamingReasoning: "",
                      streamingSegments: [],
                      streamingBg: null,
                      streamStartTime: null,
                      abortController: null,
                      error: localizeChatError(errorMsg, offlineAware(errorCode)),
                      lastSendFailure: { sessionId: session.id, code: "CONNECTION_FAILED" },
                      sendFailureNonce: s.sendFailureNonce + 1,
                      messages: s.messages.filter((m) => !m.id.startsWith("__pending_")),
                    }));
                    reconcileMessagesWithRetry(get().refreshMessages);
                    return;
                  }
                  neverLandedReattempted = true;
                  set({ streamStartTime: Date.now() });
                  startSSE(modelId, true);
                },
                giveUp: () => {
                  cancelStreamingBatch();
                  console.error("SSE error (recovery exhausted):", err);
                  _isSending = false;
                  set((s) => ({
                    isStreaming: false,
                    streamingContent: "",
                    streamingReasoning: "",
                    streamingSegments: [],
                    streamingBg: null,
                    streamStartTime: null,
                    abortController: null,
                    error: localizeChatError(errorMsg, offlineAware(errorCode)),
                    lastSendFailure: { sessionId: session.id, code: "CONNECTION_UNCERTAIN" },
                    sendFailureNonce: s.sendFailureNonce + 1,
                    messages: s.messages.filter((m) => !m.id.startsWith("__pending_")),
                  }));
                  reconcileMessagesWithRetry(get().refreshMessages);
                },
              });
              return;
            }

            // Mix mode auto-retry: try another model from the pool
            const cfg = useConfigStore.getState();
            if (
              !retry && !MIX_NO_RETRY_CODES.has(errorCode ?? "") &&
              cfg.mixMode &&
              cfg.modelPool.length > 1
            ) {
              const nextModel = pickModelExcluding(cfg.modelPool, _mixAttempted);
              if (nextModel) {
                _mixAttempted.add(nextModel);
                cancelStreamingBatch();
                set({
                  streamingContent: "",
                  streamingReasoning: "",
                  streamingSegments: [],
                  streamingBg: null,
                  streamStartTime: Date.now(),
                });
                startSSE(nextModel, true);
                return;
              }
            }

            cancelStreamingBatch();
            console.error("SSE error:", err);
            _isSending = false;

            // Transient errors: show translated toast, remove pending user message, don't set error state
            const TRANSIENT_CODES = ["RATE_LIMITED", "CONCURRENT_LIMIT", "MESSAGE_TOO_LONG", "SUSPENDED", "NO_CREDITS", "MODEL_NOT_ALLOWED", "PROTECTED_WORLD", "REPETITIVE_REPLY", "MODEL_UNAVAILABLE"];
            if (errorCode && TRANSIENT_CODES.includes(errorCode)) {
              // No Retry here: the composer restores the typed text on
              // sendFailureNonce, so the send button IS the retry affordance.
              showStreamError(errorCode, resolveErrorToast(errorCode, errorMsg, errorBalance));
              if (errorCode === "NO_CREDITS" || errorCode === "MODEL_NOT_ALLOWED" || errorCode === "PROTECTED_WORLD") {
                handleStreamCreditError(errorCode);
              }
              set((s) => ({
                isStreaming: false,
                streamingContent: "",
                streamingReasoning: "",
                streamingSegments: [],
                streamingBg: null,
                streamStartTime: null,
                abortController: null,
                // Toast-only failures skip `error` on purpose, so the composer
                // restore must ride this nonce instead.
                sendFailureNonce: s.sendFailureNonce + 1,
                lastSendFailure: { sessionId: session.id, code: errorCode, ...(errorBalance !== undefined ? { balance: errorBalance } : {}) },
                messages: s.messages.filter((m) => !m.id.startsWith("__pending_")),
              }));
              reconcileMessagesWithRetry(get().refreshMessages);
              return;
            }

            set((s) => ({
              isStreaming: false,
              streamingContent: "",
              streamingReasoning: "",
              streamingSegments: [],
              streamingBg: null,
              streamStartTime: null,
              abortController: null,
              error: localizeChatError(errorMsg, offlineAware(errorCode)),
              lastSendFailure: { sessionId: session.id, code: errorCode ?? "GENERATION_FAILED" },
              errorCode: errorCode ?? null,
              sendFailureNonce: s.sendFailureNonce + 1,
              // Drop the local-only placeholder; refreshMessages() below will
              // restore the real persisted user row so the user can delete /
              // revert / regenerate from it instead of being stuck.
              messages: s.messages.filter((m) => !m.id.startsWith("__pending_")),
            }));
            reconcileMessagesWithRetry(get().refreshMessages);
          },
        },
      });

      set({ abortController: controller });
    };

    // Land every queued setVariable before the turn reads session state —
    // otherwise the server reads a half-written session and the reply's state
    // write reflects a card mid-setup (问道 opening: writes 25..60 lost).
    // The preflight controller keeps Stop working during that wait: without an
    // abortController in the store, stopGeneration is a no-op and the UI would
    // sit in "streaming" until the flush finished.
    const preflight = new AbortController();
    set({ abortController: preflight });
    void whenSessionStateSettled()
      .catch(() => {})
      .then(() => {
        if (preflight.signal.aborted) return; // stopped while the flush drained
        startSSE(useModel);
      });
  },

  regenerateMessage: (messageId: string, model?: string, retry?: ModelFallbackRetry) => {
    const { session, isStreaming } = get();
    if (!session || isStreaming || _isSending || get().readOnly || (get().modelFallback && !retry)) return;

    const config = useConfigStore.getState();
    const useModel = model ??
      (config.mixMode && config.modelPool.length > 1
        ? pickModelFromPool(config.modelPool)
        : config.selectedModel);

    // A group chat's later voice is asked again, not rewritten by the turn's
    // narrator: its line goes and the same AI, next in the room, answers anew.
    const target = get().messages.find((m) => m.id === messageId);
    const voice = target?.swipes?.[target.activeSwipeIndex ?? 0]?.voice;
    if (voice) {
      // One at a time: a second click while the line is going would delete
      // it twice and ask the room twice.
      _isSending = true;
      void (async () => {
        try {
          const res = await fetch(`${apiBase}/api/messages/${messageId}`, { method: "DELETE", credentials: "include" }).catch(() => null);
          if (!res?.ok || get().session?.id !== session.id) return;
          get().removeMessage(messageId);
        } finally {
          _isSending = false;
        }
        await get().groupReply(useModel);
      })();
      return;
    }
    _isSending = true;

    set({
      isStreaming: true,
      streamingContent: "",
      streamingReasoning: "",
      streamingSegments: [],
      streamingBg: null,
      streamStartTime: Date.now(),
      errorCode: null,
      error: null,
      lastSendFailure: null,
    });

    const controller = connectSSE(
      `${apiBase}/api/messages/${messageId}/regenerate`,
      {
        method: "POST",
        telemetry: { model: useModel, endpoint: "regenerate" },
        body: {
          model: useModel,
          modelFallback: fallbackRecord(retry, useModel),
          ...(get().liveScene && { scene: get().liveScene }),
          overrides: {
            maxTokens: config.maxTokens,
            maxContext: config.maxContext,
            storyMemory: config.storyMemory ?? undefined,
            temperature: config.temperature,
            topP: config.topP,
            frequencyPenalty: config.frequencyPenalty,
            presencePenalty: config.presencePenalty,
            ...kimiRepetitionOverride(useModel, config.repetitionPenalty),
            topK: config.topK,
            minP: config.minP,
            reasoningEffort: config.reasoningEffort,
            streaming: config.streaming,
          },
        },
        callbacks: {
          onStateValidation: (audit) => {
            noticeUnverifiedTurn(audit);
            set((state) => ({ messages: state.messages.map((message, index) =>
              message.id === audit.targetMessageId || (audit.path === "send" && index === state.messages.length - 1 && message.role === "user")
                ? { ...message, stateValidation: audit } : message) }));
          },
          onText: (text) => {
            enqueueStreamingContent(text);
          },
          onReasoning: (text) => {
            enqueueStreamingReasoning(text);
          },
          onSegment: (data) => {
            set((s) => ({
              streamingSegments: [...s.streamingSegments, data.segment],
            }));
          },
          onBg: (data) => {
            set({ streamingBg: data.bg });
          },
          onDone: (data) => {
            fallbackReplay = null;
            set({ modelFallback: null });
            flushStreamingAppends();
            const state = get();
            const credits = parseCreditsPayload(data);
            if (state.session?.id !== session.id) return;
            state.applyRuntimeResult(session.id, data, "regenerate");
            _isSending = false;

            set((s) => ({
              messages: s.messages.map((m) => {
                if (m.id !== messageId) return m;
                const newContent =
                  (data.content as string) ?? state.streamingContent;
                // Mirror the swipe the server just appended so the "N/M"
                // control and the "view raw" toggle update without a page
                // refresh (see turn-swipes.ts).
                const { swipes, activeSwipeIndex } = appendRegenSwipe(
                  m.swipes,
                  {
                    content: newContent,
                    rawContent: (data.rawContent as string) || undefined,
                    stateChanges:
                      (data.stateChanges as Record<string, unknown>) ??
                      undefined,
                    createdAt: new Date().toISOString(),
                    model: (data.model as string) ?? undefined,
                    modelFallback: data.modelFallback as ModelFallbackRecord | undefined,
                    tokenCount: (data.tokenCount as number) ?? undefined,
                    creditCost: credits?.cost,
                    creditBalanceAfter: credits?.balance,
                    ...(data.refusal === true && { refusal: true }),
                  },
                  {
                    serverSwipeIndex: data.swipeIndex as number | undefined,
                    serverTotal: data.totalSwipes as number | undefined,
                    padCreatedAt: m.createdAt,
                  },
                );
                return {
                  ...m,
                  content: newContent,
                  stateChanges: data.stateChanges as Record<
                    string,
                    unknown
                  > | null,
                  stateSnapshot:
                    (data.state as Record<string, unknown>) ?? null,
                  swipes,
                  activeSwipeIndex,
                  model: (data.model as string) ?? m.model,
                  modelFallback: data.modelFallback as ModelFallbackRecord | undefined,
                  tokenCount: (data.tokenCount as number) ?? m.tokenCount,
                  generationTimeMs:
                    (data.generationTimeMs as number) ?? m.generationTimeMs,
                  creditCost: credits?.cost ?? null,
                  creditBalanceAfter: credits?.balance ?? null,
                };
              }),
              isStreaming: false,
              streamingContent: "",
              streamingReasoning: "",
              streamingSegments: [],
              streamingBg: null,
              streamStartTime: null,
              abortController: null,
              gameState:
                ((data.state as Record<string, unknown>)
                  ?.variables as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>) ??
                state.gameState,
            }));

            const choices = data.choices as string[] | undefined;
            if (choices && Array.isArray(choices) && choices.length > 0) {
              get().setPendingChoices(choices);
            }
            syncCreditBalance(credits);

            recordRevealedSceneImages(data.sceneImages);
            // Draw this reply's picture now that the turn is over (see turn-image-drawing).
            if (data.refusal !== true) void drawTurnImage(messageId, true);

            // Process audio effects (wrapped in try-catch for safety)
            try {
              const regenAudioEffects = data.audioEffects as import("@yumina/engine").AudioEffect[] | undefined;
              if (regenAudioEffects && Array.isArray(regenAudioEffects) && regenAudioEffects.length > 0) {
                useAudioStore.getState().processAudioEffects(regenAudioEffects);
              }
            } catch (audioErr) {
              console.warn("Regeneration audio effect failed:", audioErr);
            }

            // Process in-game notifications (from notify-player rule actions)
            try {
              showGameNotifications(
                data.notifications as Array<{ message: string; style: string }> | undefined,
              );
            } catch (notifErr) {
              console.warn("Notification processing failed:", notifErr);
            }

          },
          onError: (err, meta) => {
            if (pauseForModelFallback(err, meta?.origin, session.id, retry,
              (next, nextRetry) => get().regenerateMessage(messageId, next, nextRetry))) return;
            if (retry) set({ modelFallback: null });
            if (meta?.origin === "http" && meta.status === 401) {
              finishChatAuthLoss(set);
              return;
            }

            cancelStreamingBatch();
            console.error("Regeneration error:", err);
            _isSending = false;
            let errorMsg = err;
            let errorCode: string | undefined;
            let errorBalance: number | undefined;
            try {
              const parsed = JSON.parse(err.replace(/^HTTP \d+: /, ""));
              if (parsed.error) errorMsg = parsed.error;
              if (parsed.code) errorCode = parsed.code;
              if (typeof parsed.balance === "number") errorBalance = parsed.balance;
            } catch { /* use raw */ }

            const _tc = ["RATE_LIMITED", "CONCURRENT_LIMIT", "SUSPENDED", "NO_CREDITS", "MODEL_NOT_ALLOWED", "PROTECTED_WORLD", "REPETITIVE_REPLY", "MODEL_UNAVAILABLE"];
            if (errorCode && _tc.includes(errorCode)) {
              showStreamError(errorCode, resolveErrorToast(errorCode, errorMsg, errorBalance), () =>
                get().regenerateMessage(messageId, model),
              );
              if (errorCode === "NO_CREDITS" || errorCode === "MODEL_NOT_ALLOWED" || errorCode === "PROTECTED_WORLD") {
                handleStreamCreditError(errorCode);
              }
              set({
                isStreaming: false,
                streamingContent: "",
                streamingReasoning: "",
                streamingSegments: [],
                streamingBg: null,
                streamStartTime: null,
                abortController: null,
              });
              reconcileMessagesWithRetry(get().refreshMessages);
              return;
            }

            set({
              isStreaming: false,
              streamingContent: "",
              streamingReasoning: "",
              streamingSegments: [],
              streamingBg: null,
              streamStartTime: null,
              abortController: null,
              error: localizeChatError(errorMsg, offlineAware(errorCode)),
              errorCode: errorCode ?? null,
            });
            reconcileMessagesWithRetry(get().refreshMessages);
          },
        },
      }
    );

    set({ abortController: controller });
  },

  continueLastMessage: (model?: string, retry?: ModelFallbackRetry) => {
    // "Continue" = generate the next AI message without user input.
    // Works for: AI never replied (case 1) + user wants AI to keep going (case 3).
    const { session, isStreaming } = get();
    if (!session || isStreaming || _isSending || get().readOnly || (get().modelFallback && !retry)) return;
    _isSending = true;

    const config = useConfigStore.getState();
    const useModel = model ??
      (config.mixMode && config.modelPool.length > 1
        ? pickModelFromPool(config.modelPool)
        : config.selectedModel);

    // Tail snapshot for connection-loss recovery: a zombie continue surfaces
    // as a new assistant message appended after this one.
    const lastMessageIdAtSend = get().messages[get().messages.length - 1]?.id ?? null;

    set({
      isStreaming: true,
      streamingContent: "",
      streamingReasoning: "",
      streamingSegments: [],
      streamingBg: null,
      errorCode: null,
      streamStartTime: Date.now(),
      error: null,
      lastSendFailure: null,
    });

    const controller = connectSSE(
      `${apiBase}/api/sessions/${session.id}/messages`,
      {
        method: "POST",
        telemetry: { model: useModel, endpoint: "continue" },
        body: {
          continue: true,
          model: useModel,
          modelFallback: fallbackRecord(retry, useModel),
          ...(get().liveScene && { scene: get().liveScene }),
          overrides: {
            maxTokens: config.maxTokens,
            maxContext: config.maxContext,
            storyMemory: config.storyMemory ?? undefined,
            temperature: config.temperature,
            topP: config.topP,
            frequencyPenalty: config.frequencyPenalty,
            presencePenalty: config.presencePenalty,
            ...kimiRepetitionOverride(useModel, config.repetitionPenalty),
            topK: config.topK,
            minP: config.minP,
            reasoningEffort: config.reasoningEffort,
            streaming: config.streaming,
          },
        },
        callbacks: {
          onStateValidation: (audit) => {
            noticeUnverifiedTurn(audit);
            set((state) => ({ messages: state.messages.map((message, index) =>
              message.id === audit.targetMessageId || (audit.path === "send" && index === state.messages.length - 1 && message.role === "user")
                ? { ...message, stateValidation: audit } : message) }));
          },
          onText: (text) => {
            enqueueStreamingContent(text);
          },
          onReasoning: (text) => {
            enqueueStreamingReasoning(text);
          },
          onSegment: (data) => {
            set((s) => ({
              streamingSegments: [...s.streamingSegments, data.segment],
            }));
          },
          onBg: (data) => {
            set({ streamingBg: data.bg });
          },
          onDone: (data) => {
            fallbackReplay = null;
            set({ modelFallback: null });
            flushStreamingAppends();
            _isSending = false;
            const state = get();
            if (state.session?.id !== session.id) return;
            state.applyRuntimeResult(session.id, data, "continue");
            const credits = parseCreditsPayload(data);
            const content = (data.content as string) ?? state.streamingContent;
            const messageId = data.messageId as string;

            // Add the new assistant message to the list
            const newMsg: Message = {
              id: messageId,
              sessionId: session!.id,
              role: "assistant",
              content,
              stateSnapshot: (data.state as Record<string, unknown>) ?? null,
              tokenCount: data.tokenCount as number | undefined,
              generationTimeMs: data.generationTimeMs as number | undefined,
              model: (data.model as string) ?? useModel,
              modelFallback: data.modelFallback as ModelFallbackRecord | undefined,
              creditCost: credits?.cost ?? null,
              creditBalanceAfter: credits?.balance ?? null,
              createdAt: new Date().toISOString(),
              // Mirror the one swipe the send route persisted, like sendMessage
              // does, so swipes[active].refusal is readable without a refetch.
              swipes: [
                {
                  content,
                  rawContent: (data.rawContent as string) || undefined,
                  createdAt: new Date().toISOString(),
                  model: (data.model as string) ?? undefined,
                  tokenCount: (data.tokenCount as number) ?? undefined,
                  creditCost: credits?.cost,
                  creditBalanceAfter: credits?.balance,
                  ...(data.refusal === true && { refusal: true }),
                },
              ],
              activeSwipeIndex: 0,
            };

            set((s) => ({
              messages: [...s.messages, newMsg],
              isStreaming: false,
              streamingContent: "",
              streamingReasoning: "",
              streamingSegments: [],
              streamingBg: null,
              streamStartTime: null,
              abortController: null,
              gameState:
                ((data.state as Record<string, unknown>)
                  ?.variables as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>) ??
                state.gameState,
              pendingChoices: (data.choices as string[]) ?? [],
            }));
            syncCreditBalance(credits);

            try {
              const audioEffects = data.audioEffects as import("@yumina/engine").AudioEffect[] | undefined;
              if (audioEffects && Array.isArray(audioEffects) && audioEffects.length > 0) {
                useAudioStore.getState().processAudioEffects(audioEffects);
              }
            } catch (audioErr) {
              console.warn("Continue audio effect failed:", audioErr);
            }
            recordRevealedSceneImages(data.sceneImages);

            // Process in-game notifications (from notify-player rule actions)
            try {
              showGameNotifications(
                data.notifications as Array<{ message: string; style: string }> | undefined,
              );
            } catch (notifErr) {
              console.warn("Notification processing failed:", notifErr);
            }

          },
          onError: (err, meta) => {
            if (pauseForModelFallback(err, meta?.origin, session.id, retry,
              (next, nextRetry) => get().continueLastMessage(next, nextRetry))) return;
            if (retry) set({ modelFallback: null });
            if (meta?.origin === "http" && meta.status === 401) {
              finishChatAuthLoss(set);
              return;
            }

            let errorMsg = err;
            let errorCode: string | undefined;
            let errorBalance: number | undefined;
            try {
              const parsed = JSON.parse(err.replace(/^HTTP \d+: /, ""));
              if (parsed.error) errorMsg = parsed.error;
              if (parsed.code) errorCode = parsed.code;
              if (typeof parsed.balance === "number") errorBalance = parsed.balance;
            } catch { /* use raw */ }

            // Network-layer failure: the zombie continue may still persist a
            // reply server-side — poll for it instead of erroring (see
            // sendMessage's onError for the full rationale).
            if (meta?.origin === "connection") {
              void recoverFromConnectionLoss({
                sessionId: session.id,
                sentContent: null,
                lastMessageIdAtSend,
                getState: get,
                setState: set,
                giveUp: () => {
                  cancelStreamingBatch();
                  console.error("Continue error (recovery exhausted):", err);
                  _isSending = false;
                  set({
                    isStreaming: false,
                    streamingContent: "",
                    streamingReasoning: "",
                    streamingSegments: [],
                    streamingBg: null,
                    streamStartTime: null,
                    abortController: null,
                    error: localizeChatError(errorMsg, offlineAware(errorCode)),
                  });
                  reconcileMessagesWithRetry(get().refreshMessages);
                },
              });
              return;
            }

            cancelStreamingBatch();
            console.error("Continue error:", err);
            _isSending = false;

            const _tc = ["RATE_LIMITED", "CONCURRENT_LIMIT", "SUSPENDED", "NO_CREDITS", "MODEL_NOT_ALLOWED", "PROTECTED_WORLD", "REPETITIVE_REPLY", "MODEL_UNAVAILABLE"];
            if (errorCode && _tc.includes(errorCode)) {
              showStreamError(errorCode, resolveErrorToast(errorCode, errorMsg, errorBalance), () =>
                get().continueLastMessage(model),
              );
              if (errorCode === "NO_CREDITS" || errorCode === "MODEL_NOT_ALLOWED" || errorCode === "PROTECTED_WORLD") {
                handleStreamCreditError(errorCode);
              }
              set({
                isStreaming: false,
                streamingContent: "",
                streamingReasoning: "",
                streamingSegments: [],
                streamingBg: null,
                streamStartTime: null,
                abortController: null,
              });
              reconcileMessagesWithRetry(get().refreshMessages);
              return;
            }

            set({
              isStreaming: false,
              streamingContent: "",
              streamingReasoning: "",
              streamingSegments: [],
              streamingBg: null,
              streamStartTime: null,
              abortController: null,
              error: localizeChatError(errorMsg, offlineAware(errorCode)),
              errorCode: errorCode ?? null,
            });
            reconcileMessagesWithRetry(get().refreshMessages);
          },
        },
      }
    );

    set({ abortController: controller });
  },

  stopGeneration: () => {
    fallbackReplay = null;
    set({ modelFallback: null });
    const { abortController, session } = get();
    _isSending = false;
    // Cancel any connection-loss recovery poll — the user chose to stop.
    _recoveryToken++;
    cancelStreamingBatch();
    // Stop means stop: the voice read-along must cancel its queue instead of
    // flushing (and billing) the unread tail. Synchronous — the falling-edge
    // subscriber below fires inside set().
    signalTtsUserStop();
    if (abortController) {
      // Tell the server this is an EXPLICIT stop. Closing the SSE connection
      // alone no longer cancels generation (disconnects now finish + persist
      // server-side so suspended mobile tabs stop losing replies), so without
      // this call the "stopped" turn would keep generating and get charged.
      if (session?.id) {
        void fetch(`${apiBase}/api/sessions/${session.id}/messages/stop`, {
          method: "POST",
          credentials: "include",
          keepalive: true,
        }).catch(() => {
          /* best effort — worst case the reply persists and can be deleted */
        });
      }
      abortController.abort();
      set((s) => ({
        isStreaming: false,
        streamingContent: "",
        streamingReasoning: "",
        streamingSegments: [],
        streamingBg: null,
        streamStartTime: null,
        abortController: null,
        // Keep the local placeholder visible until the reconciliation fetch
        // replaces it with the real DB row. If mobile networking drops the
        // refresh, the user's text does not disappear from the UI.
        messages: s.messages,
      }));
      reconcileMessagesWithRetry(get().refreshMessages);
      // The stopped turn is settled server-side a few seconds later, once the
      // provider reports what the partial reply actually cost (up to ~15s of
      // lookup). Refresh the balance then, so the charge shows up together with
      // its ledger row instead of surfacing on some later poll with no receipt.
      for (const delay of [6_000, 18_000]) {
        setTimeout(() => { void useCreditStore.getState().forceFetchCredits(); }, delay);
      }
    }
  },

  setPendingChoices: (choices) => set({ pendingChoices: choices }),
  clearPendingChoices: () => set({ pendingChoices: [] }),

  revertLastExchange: async () => {
    const { session, isStreaming } = get();
    if (!session || isStreaming) return;
    // R7: nothing on screen changed, so the failure needs its own pill. The
    // server's reason stays in the console — the pill is localized and short.
    const fail = () =>
      feedback.error(
        chatPill("feedback.revertFailed", "Couldn't revert the chat"),
        retryAction(() => void get().revertLastExchange()),
      );

    try {
      const res = await fetch(`${apiBase}/api/sessions/${session.id}/revert`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Revert failed" }));
        console.warn("Revert failed:", (err as { error: string }).error);
        fail();
        return;
      }
      const { data } = await res.json();
      if (get().session?.id !== session.id) return;
      get().applyRuntimeResult(session.id, data, "restore");
      const newGameState = ((data.state as Record<string, unknown>)
        ?.variables as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>) ?? {};
      set({
        messages: data.messages ?? [],
        messageTotal: data.messageTotal ?? data.messages?.length ?? 0,
        hasEarlierMessages: (data.messageTotal ?? 0) > (data.messages?.length ?? 0),
        isLoadingEarlier: false,
        gameState: newGameState,
        pendingChoices: [],
        pendingSilentChanges: [],
      });
    } catch {
      fail();
    }
  },

  revertToMessage: async (messageId: string) => {
    const { session, isStreaming } = get();
    if (!session || isStreaming) return;
    const fail = () =>
      feedback.error(
        chatPill("feedback.revertFailed", "Couldn't revert the chat"),
        retryAction(() => void get().revertToMessage(messageId)),
      );

    try {
      const res = await fetch(`${apiBase}/api/sessions/${session.id}/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messageId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Revert failed" }));
        console.warn("Revert failed:", (err as { error: string }).error);
        fail();
        return;
      }
      const { data } = await res.json();
      if (get().session?.id !== session.id) return;
      get().applyRuntimeResult(session.id, data, "restore");
      const newGameState = ((data.state as Record<string, unknown>)
        ?.variables as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>) ?? {};
      set({
        messages: data.messages ?? [],
        messageTotal: data.messageTotal ?? data.messages?.length ?? 0,
        hasEarlierMessages: (data.messageTotal ?? 0) > (data.messages?.length ?? 0),
        isLoadingEarlier: false,
        gameState: newGameState,
        pendingChoices: [],
        pendingSilentChanges: [],
      });
    } catch {
      fail();
    }
  },

  branchFromMessage: async (messageId: string) => {
    const { session, isStreaming } = get();
    if (!session || isStreaming || _branchInFlight) return null;
    // No Retry: the caller navigates to the new session, so a retry from a pill
    // would branch with nowhere to go. The button that started it is still there.
    const fail = () => feedback.error(chatPill("feedback.branchFailed", "Couldn't create the branch"));

    _branchInFlight = true;
    try {
      const res = await fetch(`${apiBase}/api/sessions/${session.id}/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messageId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Branch failed" }));
        console.warn("Branch failed:", (err as { error: string }).error);
        fail();
        return null;
      }
      // No pill on success: the caller navigates into the new branch.
      const { data } = await res.json();
      return (data?.sessionId as string | undefined) ?? null;
    } catch {
      fail();
      return null;
    } finally {
      _branchInFlight = false;
    }
  },

  restartChat: async () => {
    const { session, isStreaming } = get();
    if (!session || isStreaming) return;
    const fail = () =>
      feedback.error(
        chatPill("feedback.restartFailed", "Couldn't restart the chat"),
        retryAction(() => void get().restartChat()),
      );

    try {
      const res = await fetch(`${apiBase}/api/sessions/${session.id}/restart`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Restart failed" }));
        console.warn("Restart failed:", (err as { error: string }).error);
        fail();
        return;
      }
      const { data } = await res.json();
      if (get().session?.id !== session.id) return;
      get().applyRuntimeResult(session.id, data, "restore");
      const newGameState = ((data.state as Record<string, unknown>)
        ?.variables as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>) ?? {};

      // Stop all audio on restart
      useAudioStore.getState().cleanup();

      set({
        messages: data.messages ?? [],
        gameState: newGameState,
        pendingChoices: [],
        pendingSilentChanges: [],
        error: null,
      });
    } catch {
      fail();
    }
  },

  saveCheckpoint: async () => {
    const { session, isStreaming } = get();
    if (!session || isStreaming) return;
    const fail = () =>
      feedback.error(
        chatPill("feedback.checkpointSaveFailed", "Couldn't save the checkpoint"),
        retryAction(() => void get().saveCheckpoint()),
      );

    try {
      const res = await fetch(`${apiBase}/api/sessions/${session.id}/checkpoints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        console.warn("Checkpoint save failed:", (err as { error: string }).error);
        fail();
        return;
      }
      const { data } = await res.json();
      // Add to local checkpoints list
      set((s) => ({
        checkpoints: [
          {
            id: data.id,
            name: data.name,
            messageCount: data.messageCount,
            createdAt: data.createdAt,
          },
          ...s.checkpoints,
        ],
      }));
    } catch {
      fail();
    }
  },

  loadCheckpoints: async () => {
    const { session } = get();
    if (!session) return;

    try {
      const res = await fetch(`${apiBase}/api/sessions/${session.id}/checkpoints`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const { data } = await res.json();
      set({ checkpoints: data ?? [] });
    } catch {
      // Silently fail
    }
  },

  restoreCheckpoint: async (checkpointId: string) => {
    const { session, isStreaming } = get();
    if (!session || isStreaming) return;
    const fail = () =>
      feedback.error(
        chatPill("feedback.checkpointRestoreFailed", "Couldn't restore the checkpoint"),
        retryAction(() => void get().restoreCheckpoint(checkpointId)),
      );

    try {
      const res = await fetch(
        `${apiBase}/api/sessions/${session.id}/checkpoints/${checkpointId}/restore`,
        {
          method: "POST",
          credentials: "include",
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Restore failed" }));
        console.warn("Checkpoint restore failed:", (err as { error: string }).error);
        fail();
        return;
      }
      const { data } = await res.json();
      if (get().session?.id !== session.id) return;
      get().applyRuntimeResult(session.id, data, "restore");
      const newGameState = ((data.state as Record<string, unknown>)
        ?.variables as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>) ?? {};
      set({
        messages: data.messages ?? [],
        gameState: newGameState,
        pendingChoices: [],
      });
    } catch {
      fail();
    }
  },

  deleteCheckpoint: async (checkpointId: string) => {
    const { session } = get();
    if (!session) return;
    const fail = () =>
      feedback.error(
        chatPill("feedback.checkpointDeleteFailed", "Couldn't delete the checkpoint"),
        retryAction(() => void get().deleteCheckpoint(checkpointId)),
      );

    try {
      const res = await fetch(
        `${apiBase}/api/sessions/${session.id}/checkpoints/${checkpointId}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );
      if (!res.ok) {
        fail();
        return;
      }
      set((s) => ({
        checkpoints: s.checkpoints.filter((cp) => cp.id !== checkpointId),
      }));
    } catch {
      fail();
    }
  },

  setVariableDirectly: (id, value) => {
    const writingSessionId = get().session?.id;
    for (const tracker of sessionConfirmationWrites) {
      if (tracker.sessionId === writingSessionId) tracker.writes.set(id, value);
    }
    set((s) => {
      const nextVariables = { ...s.gameState, [id]: value };
      const nextSession = s.session
        ? {
            ...s.session,
            state: {
              ...(s.session.state ?? {}),
              variables: nextVariables,
            },
          }
        : s.session;

      return {
        gameState: nextVariables,
        session: nextSession,
      };
    });
    // Persist to server. Coalesced + serialized (see queueSessionStatePatch):
    // the body is read at flush time, so a burst of writes ships as one PATCH
    // carrying the final values instead of N racing full-state overwrites.
    const session = get().session;
    if (session?.id) {
      const nextVariables = get().gameState;
      const readPatch = () => {
        const current = get().session;
        if (!current?.id) return null;
        return {
          sessionId: current.id,
          // Variables ONLY. Echoing the whole cached `session.state` also sent
          // back the turnCount this tab loaded with, which rewound the turn
          // counter on every custom-UI write — reactions with `cooldownTurns`
          // then fired once and stayed locked out for the rest of the session.
          state: { variables: get().gameState },
        };
      };
      // 409 session_busy: the row is held by an in-flight turn (the server
      // already retried for ~6s without pinning a connection). Re-queue; the
      // patch body is re-read at flush time so it always carries the latest
      // variables. Bounded so a wedged session can't loop forever.
      let busyRetries = 0;
      const send = (patch: { sessionId: string; state: unknown }): Promise<unknown> =>
        fetch(`${apiBase}/api/sessions/${patch.sessionId}/state`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ state: patch.state }),
        }).then((res) => {
          if (res.status === 409 && busyRetries < 5) {
            busyRetries += 1;
            setTimeout(() => queueSessionStatePatch(readPatch, send), 1500);
          }
          return res;
        });
      queueSessionStatePatch(readPatch, send);

      // Re-evaluate conditional BGM after variable change (no message context)
      useAudioStore.getState().evaluateConditionalBGM({
        worldId: session.worldId ?? "",
        variables: nextVariables,
        turnCount: get().messages.length,
        metadata: {},
      });
    }
  },

  executeActionRule: (actionId: string) => {
    // Legacy callers intentionally do not await; handle failures here.
    void get().executeActionAndWait(actionId).catch(() => {});
  },

  executeActionAndWait: async (actionId: string, params?: Record<string, unknown>, clock?: number) => {
    const { session, readOnly } = get();
    if (!session || readOnly) throw new Error("Actions are unavailable in this read-only or missing session.");
    if (clock === undefined && (typeof actionId !== "string" || !actionId)) throw new Error("Invalid action ID.");
    const sessionId = session.id;
    const tracker = { sessionId, writes: new Map<string, unknown>() };
    let stale = false;
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state.session?.id !== sessionId || state.readOnly) stale = true;
    });
    sessionConfirmationWrites.add(tracker);
    try {
      return await queueSessionStateOperation(async (signal) => {
        const check = () => {
          if (signal.aborted) throw signal.reason;
          if (stale || get().session?.id !== sessionId) throw new Error("Action session changed.");
          if (get().readOnly) throw new Error("Actions are unavailable in this read-only session.");
        };
        check();
        const response = await fetch(`${apiBase}/api/sessions/${sessionId}/execute-action`, {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify(clock !== undefined ? { clock } : { actionId, ...(params && typeof params === "object" ? { params } : {}) }), signal,
        });
        if (!response.ok) throw new Error("Action failed. Please try again.");
        const json = await response.json();
        check();
        const data = (json.data ?? json) as Record<string, unknown> & {
          variables?: ChatState["gameState"]; state?: Record<string, unknown>; firedIds?: string[];
          notifications?: Array<{ message: string; style: string }>; audio?: unknown;
        };
        const newGameState = data.variables;
        if (!newGameState || typeof newGameState !== "object" || Array.isArray(newGameState)) throw new Error("Action returned invalid state.");
        // Keep runtime gates as well as variables; actions can toggle modules
        // and entries without changing any declared variable.
        get().applyRuntimeResult(sessionId, {
          ...data,
          state: data.state ?? { ...get().session?.state, variables: newGameState },
        }, "action", actionId);

        restoreOptimisticWrites(tracker);

        // Audio emitted by fired reactions.
        try {
          const audioEffects = data.audio as import("@yumina/engine").AudioEffect[] | undefined;
          if (audioEffects && Array.isArray(audioEffects) && audioEffects.length > 0) {
            useAudioStore.getState().processAudioEffects(audioEffects);
          }
        } catch (audioErr) {
          console.warn("Audio effect processing failed:", audioErr);
        }

        // In-game notifications (from notify-player reactions).
        showGameNotifications(data.notifications);

        // Re-evaluate conditional BGM after the state change.
        const worldDef = session.world?.schema as unknown as WorldDefinition | undefined;
        if (worldDef) {
          useAudioStore.getState().evaluateConditionalBGM({
            worldId: worldDef.id,
            variables: get().gameState,
            turnCount: get().messages.length,
            metadata: {},
          });
        }
        return { applied: true as const, variables: newGameState, firedIds: data.firedIds ?? [] };
      }, 30_000);
    } finally { unsubscribe(); sessionConfirmationWrites.delete(tracker); }
  },

  quietTick: async (call?: string) => {
    const { session, isStreaming, readOnly } = get();
    if (!session || isStreaming || readOnly) return;
    const sessionId = session.id;
    try {
      const response = await fetch(`${apiBase}/api/sessions/${sessionId}/quiet-tick`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ ...(get().liveScene ? { scene: get().liveScene } : {}), ...(call ? { call } : {}) }),
      });
      if (!response.ok) return;
      const json = await response.json() as { data?: Record<string, unknown> };
      const data = json.data;
      // The player may have sent something while this was out.
      const now = get();
      // A result carries `state` when it spoke OR quietly moved values.
      if (data?.ran === true && !data.state && now.session?.id === sessionId) {
        const sp = data.speaker as { id?: string; name?: string } | undefined;
        set((s) => ({ quietSilences: [...s.quietSilences, { at: new Date().toISOString(), sessionId, speakerId: String(sp?.id ?? ""), speakerName: String(sp?.name ?? "") }].slice(-60) }));
        return;
      }
      if (!data || !data.state || now.session?.id !== sessionId || now.isStreaming) return;
      const message = data.message as { id: string; role: "assistant"; content: string; createdAt: string } | null;
      if (message) {
        if (now.messages.some((m) => m.id === message.id)) return;
        get().addMessage({ ...message, sessionId, status: "complete" } as Message);
      }
      get().applyRuntimeResult(sessionId, { ...data, stateChanges: data.changes }, "quiet");
      showGameNotifications(data.notifications as Parameters<typeof showGameNotifications>[0]);
    } catch {
      // A missed tick is just a quieter moment.
    }
  },

  callAi: async (ai, input) => {
    const { session, readOnly } = get();
    if (!session || readOnly || typeof ai !== "string" || !ai.trim()) return null;
    const sessionId = session.id;
    try {
      const response = await fetch(`${apiBase}/api/sessions/${sessionId}/ai-call`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ ai, ...(input !== undefined ? { input } : {}), ...(get().liveScene ? { scene: get().liveScene } : {}) }),
      });
      if (!response.ok) return null;
      const data = ((await response.json()) as { data?: Record<string, unknown> }).data;
      if (!data || data.ok !== true || get().session?.id !== sessionId) return null;
      const answer = data.answer as { text: string; fields: Record<string, unknown>; fallback: boolean };
      const message = data.message as { id: string; role: "assistant"; content: string; createdAt: string } | null;
      if (message && !get().messages.some((m) => m.id === message.id)) get().addMessage({ ...message, sessionId, status: "complete" } as Message);
      get().applyRuntimeResult(sessionId, { ...data, stateChanges: data.changes }, "quiet");
      // Words for an interface channel reach the card's listeners
      // (api.onAiOutput), the way story events do.
      const say = String(data.say ?? "story");
      if (say !== "story" && say !== "none") {
        const ai = data.ai as { id: string; name: string };
        set((s) => ({ storyEvents: [...s.storyEvents, { id: crypto.randomUUID(), name: `ai:${say}`, ai: { channel: say, id: ai.id, name: ai.name, text: answer.text, fields: answer.fields } }].slice(-20) }));
      }
      showGameNotifications(data.notifications as Parameters<typeof showGameNotifications>[0]);
      return answer;
    } catch {
      return null;
    }
  },

  groupReply: async (model?: string) => {
    const start = get();
    if (!start.session || start.readOnly) return;
    const sessionId = start.session.id;
    const books = (safeParseWorldDef(start.session.world?.schema)?.worldbooks ?? []) as Worldbook[];
    if (!hasGroupVoices(books)) return;
    // A room holds a handful of voices; the cap only stops a loop that a
    // server answering the same voice twice would otherwise never leave.
    for (let asked = 0; asked < 8; asked++) {
      const now = get();
      if (now.session?.id !== sessionId || now.isStreaming || _isSending) return;
      // Who is next, read the way the server reads it: from the state the
      // latest answer left behind.
      const latest = [...now.messages].reverse().find((m) => m.role === "assistant");
      const snapshot = latest?.stateSnapshot as GameState | null | undefined;
      const upNext = snapshot ? nextGroupVoice(books, snapshot, now.messages) : null;
      if (!upNext) return;
      // The waiting bubble already wears the name of whoever is typing.
      set({ isStreaming: true, streamingContent: `[speaker: ${upNext.name}]\n`, streamStartTime: Date.now() });
      let data: Record<string, unknown> | undefined;
      try {
        const response = await fetch(`${apiBase}/api/sessions/${sessionId}/group-reply`, {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ ...(model ? { model } : {}), ...(get().liveScene ? { scene: get().liveScene } : {}) }),
        });
        data = response.ok ? ((await response.json()) as { data?: Record<string, unknown> }).data : undefined;
      } catch {
        data = undefined;
      } finally {
        if (get().session?.id === sessionId) set({ isStreaming: false, streamingContent: "", streamStartTime: null });
      }
      if (!data || data.ran !== true || get().session?.id !== sessionId) return;
      const message = data.message as (Omit<Message, "sessionId" | "status"> & { id: string }) | null;
      if (message && !get().messages.some((m) => m.id === message.id)) {
        get().addMessage({
          ...message,
          sessionId,
          status: "complete",
          stateSnapshot: (data.state as Record<string, unknown>) ?? null,
          stateChanges: (data.changes as unknown as Record<string, unknown>) ?? null,
        } as Message);
      }
      // The playtest's "this turn" names the voice the way it names a quiet one.
      get().applyRuntimeResult(sessionId, { ...data, stateChanges: data.changes, speaker: data.voice, group: true, messageId: message?.id }, "quiet");
      showGameNotifications(data.notifications as Parameters<typeof showGameNotifications>[0]);
    }
  },

  switchGreeting: (index: number) => {
    const { messages, session, isStreaming } = get();
    if (!session || isStreaming) return Promise.resolve();

    // Find the first assistant message (the greeting)
    const greetingMsg = messages.find((m) => m.role === "assistant");
    if (!greetingMsg) return Promise.resolve();

    const swipes = greetingMsg.swipes ?? [];
    if (index < 0 || index >= swipes.length) return Promise.resolve();

    const currentIndex = greetingMsg.activeSwipeIndex ?? 0;
    if (index === currentIndex) return Promise.resolve();

    // Cast-picker cards call `setVariable(setupVar)` and `switchGreeting()` in
    // the same tick. The PATCH carrying that write is flushed a microtask later,
    // so a bare fetch here reached the server FIRST: the switch kept the setup
    // variable's stale value, the late PATCH then re-sent the old opening's
    // variables over the new one, and the "restore" below wiped the pick from
    // the local state (and from every later full-variables PATCH). 29% of
    // SEVENTEEN 模拟器 sessions ended with an empty member list.
    // So the switch rides the same serialized queue as variable writes: every
    // earlier write is acknowledged before it starts, and later writes flush
    // only after its result is applied (so the result is applied INSIDE the
    // queued operation — a later PATCH reads the post-switch variables).
    const tracker = { sessionId: session.id, writes: new Map<string, unknown>() };
    sessionConfirmationWrites.add(tracker);
    return queueSessionStateOperation(async (signal) => {
      const res = await fetch(`${apiBase}/api/messages/${greetingMsg.id}/swipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ index }),
        signal,
      });
      if (!res.ok) throw new Error("Swipe failed");
      const { data } = await res.json();
      if (signal.aborted || get().session?.id !== session.id) return;
      // Update the greeting message locally
      get().updateMessage(greetingMsg.id, {
        content: data.content,
        activeSwipeIndex: data.activeSwipeIndex,
        stateChanges: data.stateChanges,
        stateSnapshot: data.state ?? null,
        model: data.model ?? null,
        tokenCount: data.tokenCount ?? null,
      });

      // Restore game state from the swipe's snapshot
      const nextGameState = (data.state?.variables ?? null) as
        | Record<string, number | string | boolean | Record<string, unknown> | unknown[]>
        | null;
      if (nextGameState && data.stateRestored !== false) {
        get().applyRuntimeResult(session.id, data, "restore");
        // Writes the card made after calling switchGreeting are newer than the
        // opening's snapshot. Their PATCH is queued behind this operation and
        // reads the store at flush time, so re-applying them here both keeps
        // them on screen and sends them to the server.
        restoreOptimisticWrites(tracker);
      }
    }, 30_000)
      .catch(() => {})
      .finally(() => sessionConfirmationWrites.delete(tracker));
  },
}));

/** Later optimistic writes survive authoritative opening/action snapshots. */
const sessionConfirmationWrites = new Set<{ sessionId: string; writes: Map<string, unknown> }>();

function restoreOptimisticWrites(tracker: { sessionId: string; writes: Map<string, unknown> }): void {
  if (!tracker.writes.size) return;
  useChatStore.setState((s) => {
    if (s.session?.id !== tracker.sessionId) return {};
    const variables = { ...s.gameState, ...Object.fromEntries(tracker.writes) } as ChatState["gameState"];
    return { gameState: variables, session: { ...s.session, state: { ...(s.session.state ?? {}), variables } } };
  });
}

/** A turn's `sceneImages` (ids the reply revealed) into the session's gallery set. */
function recordRevealedSceneImages(raw: unknown): void {
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return;
  useChatStore.setState((s) => {
    const next = new Set(s.revealedSceneImages);
    for (const id of ids) next.add(id);
    return next.size === s.revealedSceneImages.length ? {} : { revealedSceneImages: [...next] };
  });
}

