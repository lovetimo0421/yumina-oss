/**
 * PostMessage protocol types for the parent ↔ sandbox iframe bridge.
 *
 * The sandbox runs on a cross-origin domain (sandbox.yumina.io) with
 * `sandbox="allow-scripts"` — NO `allow-same-origin`. This means it cannot
 * access parent cookies, localStorage, or make credentialed requests.
 *
 * All communication happens via structured postMessage calls.
 */

import type { Condition, LoreUiBinding, Worldbook, StateChannel } from "@yumina/engine";
import type { TranscriptPosition } from "./chat/transcript-position-types";

export type SandboxMode = "session" | "guest-preview";

export interface SandboxCapabilities {
  canSendMessage: boolean;
  canPersistSession: boolean;
  canUseSessionApis: boolean;
  requiresAuth: boolean;
}

/** Read-only lorebook entry exposed to sandboxed cards. Slim subset of
 *  WorldEntry: only the fields a card author needs for prompt assembly. */
export interface SandboxEntry {
  id: string;
  name: string;
  content: string;
  keywords: string[];
  position: number;
  section: "system-presets" | "examples" | "chat-history" | "post-history";
  enabled: boolean;
  role: string;
  tags?: string[];
  conditions?: Condition[];
  conditionLogic?: "all" | "any";
  audience?: "ai" | "player" | "both";
  /** Character portrait as an absolute URL (host resolves `@asset:` refs before
   *  pushing), or null when the entry has none. */
  portrait?: string | null;
}

export type SandboxLoreUiBinding = LoreUiBinding;
export type SandboxWorldbook = Worldbook;

/** The player's own machine offered as a model source.
 *
 * Only ever non-null for a browser that turned the local bridge on, so the
 * picker can treat "present" as "this player cares about local models" without
 * a second flag. `status` is the courier's live state, not a snapshot: a card
 * mid-session needs to see the connection drop, because every turn after that
 * point fails until it comes back. */
export interface LocalBridgeChannelData {
  status: "idle" | "connecting" | "connected" | "running" | "error";
  /** "Ollama", "LM Studio", … — null before the first successful detection. */
  runtimeLabel: string | null;
  /** Empty whenever the courier is down: a model we can't reach must not be
   *  selectable, only explained. */
  models: Array<{ id: string; name: string }>;
}

// ── Assembled sandbox state ─────────────────────────────────────────
//
// Individual channel updates arrive from the parent (see ChannelUpdateMessage
// below). The sandbox host composes them into this struct so buildAPI() can
// expose a flat shape to creator code.

export interface SandboxState {
  modelFallback?: import("@yumina/shared").ModelFallbackNotice | null;
  variables: Record<string, unknown>;
  globalVariables: Record<string, unknown>;
  worldName: string;
  /** The world's cover image ("Cover" in Studio) as an absolute URL, or null
   *  when unset. Tracks cover edits — no need to re-upload the cover as an
   *  @asset just to render it (avatars, headers, splash art). */
  worldCover: string | null;
  worldId: string;
  sessionId: string;
  /** The raw Yumina account that's logged in. Rarely used by creators — prefer
   *  `user` below, which follows the same persona-vs-account rule as {{user}}. */
  currentUser: { id: string; name?: string; image?: string | null } | null;
  /** The role-played user: follows the same branching as the {{user}} macro.
   *  - Active persona → persona.name + persona.avatarUrl
   *  - No persona    → account.name + account.image
   *  - Not logged in → { name: "Player", avatar: null }
   *  Creators writing `<img src={user.avatar} />` / `{user.name}` in TSX get the
   *  correct identity without having to branch client-side on persona state. */
  user: { name: string; avatar: string | null };
  messages: Array<Record<string, unknown>>;
  isStreaming: boolean;
  streamingContent: string;
  mode: SandboxMode;
  capabilities: SandboxCapabilities;
  /** World lorebook entries (enabled only). Card authors read these to inject
   *  character profiles / world facts into side LLM calls (`api.ai.complete`). */
  entries: SandboxEntry[];
  /** LoreSlot → entry bindings from world schema. */
  loreUiBindings: SandboxLoreUiBinding[];
  worldbooks: SandboxWorldbook[];

  /** Legacy field kept for API shape parity — unused by the single-rootComponent runtime. */
  canvasMode: "chat" | "custom" | "fullscreen";
  /** Pending choice buttons from world logic */
  pendingChoices: string[];
  /** Current error message (API failure, generation error) */
  error: string | null;
  /** AI reasoning/thinking content during streaming */
  streamingReasoning: string;
  /** Whether the session is read-only (e.g. viewing someone else's session) */
  readOnly: boolean;
  /** Saved checkpoints for this session */
  checkpoints: Array<{ id: string; name: string; messageCount: number; createdAt: string }>;
  /** Greeting content extracted from world entries (parent computes this) */
  greetingContent: string | null;

  // ── Model picker fields ──
  selectedModel: string;
  userPlan: string;
  /** Whether the session-memory-summary extension is installed for the user.
   *  Public creator-facing API — kept even though it's derivable from
   *  installedExtensions, because cached creator TSX may reference it. */
  memorySummaryEnabled: boolean;
  /** clientEntry ids of the user's installed extensions (drives the sandbox
   *  contribution registry's lazy loading — see sandbox/extensions/). */
  installedExtensions: string[];
  preferredProvider: "official" | "private";
  /** The player's own machine as a model source, or null when this browser has
   *  never volunteered it. Null is the common case, and the picker shows nothing
   *  about local models for it — discovery lives in AI settings, not in a
   *  permanent row in front of every player without a GPU. */
  localBridge: LocalBridgeChannelData | null;
  mixMode: boolean;
  modelPool: Array<{ modelId: string; weight: number; locked?: boolean }>;
  /** Whether older history pages exist server-side (messages are windowed). */
  hasEarlierMessages: boolean;
  /** True while an older history page is being fetched. */
  isLoadingEarlier: boolean;

  // ── Audio volume ──
  /** Current BGM volume (0–1) */
  bgmVolume: number;
  /** Current SFX volume (0–1) */
  sfxVolume: number;

  // ── Locale ──
  /** Active i18n language code (e.g. "en", "zh"). Mirrors host's i18n.language
   *  so sandbox UI (model picker modal etc.) can translate without round-tripping. */
  language: string;
  /** User's live mushie wallet balance, mirrored from the host credit store.
   *  Null = unknown (not loaded, or no wallet). The model-pill prefers this over
   *  the per-message recorded balance so it's consistent across cards/devices. */
  balance: number | null;
  /** "Press Enter to send" preference — see UIChannelData.composerSendKey. */
  composerSendKey: "enter" | "mod-enter";
  /** Send-failure counter — see UIChannelData.sendFailureNonce. */
  sendFailureNonce: number;
}

// ── Channel data shapes ─────────────────────────────────────────────

/** Game variables — updates on "done" event or setVariable() */
export interface VariablesChannelData {
  variables: Record<string, unknown>;
  globalVariables: Record<string, unknown>;
  /** Display name → variable id, for every declared variable whose name differs
   *  from its id. Lets the sandbox resolve `api.variables.hunger` when the id is
   *  the UUID the editor minted — see sandbox/variable-alias.ts. Optional so an
   *  older host that doesn't send it still works (id-only reads, as before). */
  variableIdsByName?: Record<string, string>;
}

/** Chat messages — updates on message add/edit/delete */
export interface MessagesChannelData {
  messages: Array<Record<string, unknown>>;
}

/** Streaming state — high frequency during generation (~30Hz) */
export interface StreamingChannelData {
  isStreaming: boolean;
  content: string;
  reasoning: string;
  bg: string | null;
}

/** Session context — rarely changes (on session load) */
export interface SessionChannelData {
  worldId: string;
  worldName: string;
  /** World cover image as an absolute URL (host-resolved), null when unset. */
  worldCover: string | null;
  sessionId: string;
  /** Raw Yumina account. Prefer `user` below for persona-aware rendering. */
  currentUser: { id: string; name?: string; image?: string | null } | null;
  /** Role-played user — same branching as {{user}}: persona if active else account. */
  user: { name: string; avatar: string | null };
  /** World lorebook entries (enabled only). Pushed on session load and when the
   *  world's schema changes. Card authors use these to inject character profiles
   *  into side LLM calls (`api.ai.complete`). */
  entries: SandboxEntry[];
  loreUiBindings: SandboxLoreUiBinding[];
  worldbooks: SandboxWorldbook[];
}

/** UI state — changes on user interaction */
export interface UIChannelData {
  modelFallback?: import("@yumina/shared").ModelFallbackNotice | null;
  pendingChoices: string[];
  error: string | null;
  readOnly: boolean;
  checkpoints: Array<{ id: string; name: string; messageCount: number; createdAt: string }>;
  greetingContent: string | null;
  selectedModel: string;
  userPlan: string;
  /** Whether the session-memory-summary extension is installed for the user. */
  memorySummaryEnabled: boolean;
  /** clientEntry ids of the user's installed extensions. */
  installedExtensions: string[];
  preferredProvider: "official" | "private";
  localBridge: LocalBridgeChannelData | null;
  mixMode: boolean;
  modelPool: Array<{ modelId: string; weight: number; locked?: boolean }>;
  /** Whether older history pages exist server-side (messages are windowed). */
  hasEarlierMessages: boolean;
  /** True while an older history page is being fetched. */
  isLoadingEarlier: boolean;
  bgmVolume: number;
  sfxVolume: number;
  language: string;
  /** User's live mushie wallet balance (host credit store). Null = unknown. */
  balance: number | null;
  mode: SandboxMode;
  capabilities: SandboxCapabilities;
  /** The user's "Press Enter to send" preference (Settings → Display).
   *  "enter" = Enter sends / Shift+Enter newline; "mod-enter" = Ctrl/⌘+Enter
   *  sends / Enter newline. The sandbox composer must honor it — the iframe
   *  can't read the host's ui store. */
  composerSendKey: "enter" | "mod-enter";
  /** The user's font-size preference as a multiplier (Settings → Display;
   *  1 = default). Applied to the sandbox document's root font-size so
   *  rem-based text (the injected chat UI, creator Tailwind classes) scales. */
  uiFontScale: number;
  /** Mirrors the host chat store's sendFailureNonce: bumped on every
   *  terminally-failed send, including toast-only failures that never set
   *  `error`. The composer restores its swallowed text on change. */
  sendFailureNonce: number;
}

/** Map channel names to their data types */
export interface ChannelDataMap {
  variables: VariablesChannelData;
  messages: MessagesChannelData;
  streaming: StreamingChannelData;
  session: SessionChannelData;
  ui: UIChannelData;
}

// ── Parent → Sandbox messages ───────────────────────────────────────

/** Install the world's root component (multi-file).
 *  Prefer `compiledCode` — when the parent has pre-bundled + transformed the TSX,
 *  the sandbox can skip bundling/transforming (drops ~956K Sucrase + bundler from
 *  its critical-path bundle). Falls back to `files`+`entryFile` for back-compat. */
export interface InstallRootMessage {
  type: "install-root";
  entryFile: string;
  files: Record<string, string>;
  /** Rendering context hint, available before the UI channel arrives. */
  mode?: SandboxMode;
  /** Pre-compiled JS produced by the parent from `{ files, entryFile }`. Preferred path. */
  compiledCode?: string;
  /** If parent-side compile/bundle failed, delivered here and the sandbox renders the error. */
  compileError?: string;
}

/** Push a single state channel update */
export interface ChannelUpdateMessage {
  type: "channel";
  channel: StateChannel;
  data: ChannelDataMap[StateChannel];
  /** Monotonic version per channel — sandbox skips stale updates */
  version: number;
}

/** Apply CSS custom properties to sandbox document root */
export interface ThemeMessage {
  type: "theme";
  cssVars: Record<string, string>;
}

/** Response to an async API call */
export interface ApiResponseMessage {
  type: "api-response";
  callId: string;
  result: unknown;
}

/** Streaming response chunk for long-running calls (e.g. LLM completions) */
export interface ApiStreamMessage {
  type: "api-stream";
  callId: string;
  delta: string;
  done: boolean;
  /** Full accumulated result, sent only when done=true */
  result?: unknown;
}

/** Suspend or resume all `<video>` / `<audio>` elements in the sandbox document.
 *  Sent when the iframe is hidden (navigation, theater-mode toggle) without being
 *  unmounted — raw media tags don't auto-pause on `display:none`, so we need an
 *  explicit signal to avoid "ghost BGM playing after exit" leaks. Complement to
 *  the parent-side `useAudioStore.cleanup()` which handles SDK audio. */
export interface SuspendMediaMessage {
  type: "suspend-media";
  suspended: boolean;
}

/** Notify the sandbox that a parent-side SDK audio track finished playing.
 *  component-host re-dispatches this as the AUDIO_ENDED_EVENT window event so
 *  creator code subscribed via `api.onAudioEnded` can react (e.g. auto-advance). */
export interface AudioEventMessage {
  type: "audio-event";
  event: "ended";
  trackId: string;
}

/** Put a previously saved composer draft back into the chat composer.
 *  Sent once after the sandbox signals ready, when the host has a stored draft
 *  for this session (see src/lib/composer-draft.ts for why the host is the one
 *  holding it). Unlike the creator-facing `api.setComposerDraft`, this must NOT
 *  steal focus — restoring text on load should not pop the mobile keyboard. */
export interface RestoreComposerDraftMessage {
  type: "restore-composer-draft";
  text: string;
}

/** A realtime multiplayer frame relayed from the game server (game-rt).
 *  The parent app owns the WebSocket (the sandbox has connect-src 'none');
 *  frames pass through verbatim: welcome/snap/delta/event/presence/ack/bye,
 *  plus parent-synthesized {t:"status", state} connection updates.
 *  Spec: docs/superpowers/specs/2026-08-24-game-room-primitives-design.md §6. */
export interface RoomFrameMessage {
  type: "room-frame";
  frame: Record<string, unknown>;
}

/** Ask the sandbox to open the session-memory extension's panel. Sent by the
 *  parent play-controls bar so worlds whose custom UI never renders the
 *  composer slots (no Memory pill) still have a way into the panel — the
 *  extension's modal is always bundled and mounted host-level when installed. */
export interface OpenMemoryPanelMessage {
  type: "open-memory-panel";
}

export type ParentMessage =
  | { type: "restore-transcript-position"; position: TranscriptPosition }
  | InstallRootMessage
  | ChannelUpdateMessage
  | ThemeMessage
  | ApiResponseMessage
  | ApiStreamMessage
  | SuspendMediaMessage
  | AudioEventMessage
  | RestoreComposerDraftMessage
  | RoomFrameMessage
  | OpenMemoryPanelMessage;

// ── Sandbox → Parent messages ───────────────────────────────────────

/** Sandbox is ready — identifies protocol version */
export interface ReadyMessage {
  type: "ready";
  protocolVersion: 2;
}

export interface ApiCallMessage {
  type: "api-call";
  callId: string;
  method: string;
  args: unknown[];
}

/** Game event emitted by the visual layer */
export interface GameEventMessage {
  type: "game-event";
  event: {
    type: string;
    [key: string]: unknown;
  };
}

/** Root component resize notification */
export interface ResizeMessage {
  type: "resize";
  height: number;
}

/** Root component error */
export interface ComponentErrorMessage {
  type: "component-error";
  message: string;
}

/** The root component has been installed AND painted its first frame (or a
 *  compile-error panel is showing). Distinct from `ready`, which only means the
 *  iframe runtime booted — `ready` fires before any world content exists. The
 *  parent uses `rendered` to hide its loading overlay exactly when the world's
 *  own UI is on screen, eliminating the post-handshake grey gap. */
export interface RenderedMessage {
  type: "rendered";
}

/** Sandbox-side diagnostic (e.g. the scroll-clamp watchdog correcting a stuck
 *  scroll offset). The parent forwards these to analytics so rare, device-
 *  specific layout bugs become measurable fleet-wide instead of depending on
 *  the occasional user report. Never carries user content. */
export interface DiagMessage {
  type: "diag";
  event: string;
  data?: Record<string, string | number | boolean>;
}

/** The chat composer's current unsent text. Debounced, and sent immediately
 *  when it empties. The host uses it to (a) refuse the deploy auto-reload while
 *  a message is half-typed and (b) persist the draft across reloads it can't
 *  avoid — neither of which the sandbox can do for itself on an opaque origin.
 *  Carries user content, so it never goes to analytics. */
export interface ComposerDraftMessage {
  type: "composer-draft";
  text: string;
}

export type SandboxMessage =
  | { type: "play-interaction" }
  | { type: "transcript-position"; position: TranscriptPosition }
  | ReadyMessage
  | ApiCallMessage
  | GameEventMessage
  | ResizeMessage
  | ComponentErrorMessage
  | RenderedMessage
  | DiagMessage
  | ComposerDraftMessage;

// ── Helpers ─────────────────────────────────────────────────────────

/** Channel identifier to prevent processing unrelated postMessage traffic */
export const SANDBOX_CHANNEL = "yumina-sandbox" as const;

export interface ChannelEnvelope<T> {
  channel: typeof SANDBOX_CHANNEL;
  payload: T;
}

export function wrapMessage<T>(payload: T): ChannelEnvelope<T> {
  return { channel: SANDBOX_CHANNEL, payload };
}

export function unwrapMessage<T>(data: unknown): T | null {
  if (
    typeof data === "object" &&
    data !== null &&
    "channel" in data &&
    (data as ChannelEnvelope<T>).channel === SANDBOX_CHANNEL
  ) {
    return (data as ChannelEnvelope<T>).payload;
  }
  return null;
}

// ── Parent-origin pinning (sandbox side) ────────────────────────────
// The host appends ?parentOrigin=<origin> to the iframe src so the sandbox
// can (a) post replies to the embedding app's exact origin instead of "*"
// and (b) validate event.origin on inbound parent messages. The fallback is
// "*"/no-check, which preserves behavior for any stale cached sandbox HTML.
// (The host→sandbox direction must keep targetOrigin "*": the iframe runs
// allow-scripts WITHOUT allow-same-origin, so its origin is opaque and no
// concrete targetOrigin can ever match it — safety in that direction comes
// from posting to the specific contentWindow + this side validating source.)

let cachedParentOrigin: string | null = null;
export function getParentOrigin(): string {
  if (cachedParentOrigin === null) {
    try {
      cachedParentOrigin = new URLSearchParams(window.location.search).get("parentOrigin") || "*";
    } catch {
      cachedParentOrigin = "*";
    }
  }
  return cachedParentOrigin;
}

/** True iff the message came from the embedding parent window (and, when the
 *  parent origin is pinned, from its exact origin). */
export function isFromParent(event: MessageEvent): boolean {
  if (event.source !== window.parent) return false;
  const expected = getParentOrigin();
  return expected === "*" || event.origin === expected;
}

/** Post to the embedding parent with the pinned target origin. */
export function postToParentWindow(data: unknown): void {
  safePostMessage(window.parent, data, getParentOrigin());
}

// iOS Safari's structured clone is stricter than Chrome/Firefox and throws
// DOMException on values it can't clone. Fall back to JSON round-trip which
// strips non-cloneable values (functions, symbols, undefined, circular refs).
export function safePostMessage(target: Window, data: unknown, origin: string): void {
  try {
    target.postMessage(data, origin);
  } catch (e) {
    // Structured clone failed (iOS Safari strict mode). Try JSON round-trip
    // which strips non-cloneable values (functions, symbols, undefined).
    if (typeof console !== "undefined") {
      console.warn("[sandbox] postMessage structured clone failed, using JSON fallback", e);
    }
    try {
      target.postMessage(JSON.parse(JSON.stringify(data)), origin);
    } catch {
      // Both structured clone and JSON failed (circular refs, etc.) — drop.
      // Channel state will be re-pushed on the next update cycle.
    }
  }
}
