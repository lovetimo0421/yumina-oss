import { useLegacyGallery, type LegacyGalleryOptions } from './legacy-gallery';
import { createContext, useContext } from "react";
import type {
  SessionMemory,
  SessionMemoryPayload,
  SessionSummaryCompactionPayload,
  SessionSummaryImplementation,
  SessionSummaryLanguage,
  SessionSummaryMode,
  SessionSummaryPayload,
} from "@yumina/shared";
import type { SandboxCapabilities, SandboxEntry, SandboxLoreUiBinding, SandboxWorldbook, SandboxMode, SandboxState, LocalBridgeChannelData, TtsChannelData, VoiceInputChannelData, VoicePlaybackFrame } from "./protocol";
import { wrapMessage, postToParentWindow, type ApiCallMessage } from "./protocol";
import { renderMarkdown } from "./chat/markdown";
import type { SessionImage } from "../src/lib/session-media";
import type { SessionStoredValue, SessionStorageWriteOptions } from "../src/lib/session-storage";

export type { SandboxEntry } from "./protocol";

/** Tracks names we've already warned about so a single render loop doesn't
 *  spam the console with the same missing-entry warning. */
const warnedMissingEntries = new Set<string>();

/**
 * A single node in the branch tree, as seen by the current user.
 * Emitted by {@link SandboxedYuminaAPI.getBranchContext}.
 */
export interface BranchNode {
  id: string;
  name: string | null;
  parentSessionId: string | null;
  branchedFromMessageId: string | null;
  messageCount: number;
  /** ISO-8601 */
  updatedAt: string;
  /** ISO-8601 */
  createdAt: string;
}

/**
 * A pre-computed slice of the branch tree relative to the current session.
 * Used by the BranchPopover in the player UI and by sandbox cards that want
 * to render their own branch manager without re-implementing filter logic.
 */
export interface BranchContext {
  current: BranchNode;
  parent: BranchNode | null;
  /** Other branches that share the same parent as `current`, oldest first. */
  siblings: BranchNode[];
  /** Branches that were forked off `current`, oldest first. */
  children: BranchNode[];
}

/**
 * Full SDK exposed to sandboxed custom components via useYumina().
 *
 * Design principle (Roblox model): don't block browser APIs — replace them
 * with safe alternatives so creators never need fetch/localStorage/etc.
 *
 * Reads: synchronous from locally-pushed state.
 * Writes: fire-and-forget or async via postMessage to parent.
 */
export interface SandboxedYuminaAPI {
  /** Internal compatibility hook for recognized legacy gallery sources. */
  __useLegacyGallery?: (options: LegacyGalleryOptions) => ReturnType<typeof useLegacyGallery>;
  // ── State reads (synchronous) ──
  variables: Record<string, unknown>;
  globalVariables: Record<string, unknown>;
  worldName: string;
  /** The world's cover image ("Cover" in Studio) as an absolute URL, or null
   *  when unset. Tracks cover edits automatically — prefer this over
   *  re-uploading the cover as an @asset for avatars/headers/splash art.
   *
   *  Example — cover as the character's chat avatar with a fallback:
   *    const { worldCover } = useYumina();
   *    return worldCover
   *      ? <img src={worldCover} alt="avatar" className="h-10 w-10 rounded-full object-cover" />
   *      : <div className="h-10 w-10 rounded-full bg-muted" />; */
  worldCover: string | null;
  worldId: string;
  sessionId: string;
  /** The raw Yumina account (id, name, image). Use for account-level UI like
   *  "view profile" buttons. For ROLE-PLAY rendering — avatars in chat bubbles,
   *  character cards, profile panels inside the world — use `user` instead,
   *  which follows the same persona-vs-account branching as the {{user}} macro.
   *
   *  Example — correct usage in a custom message bubble:
   *    const { user } = useYumina();
   *    return <img src={user.avatar} alt={user.name} />;  // persona-aware
   *
   *  Incorrect (always shows account, even when persona is active):
   *    const { currentUser } = useYumina();
   *    return <img src={currentUser?.image} />;           // account-only */
  currentUser: { id: string; name?: string; image?: string | null } | null;
  /** Role-played user. Persona-aware: follows the same rule as {{user}}. */
  user: { name: string; avatar: string | null };
  messages: Array<Record<string, unknown>>;
  isStreaming: boolean;
  streamingContent: string;
  mode: SandboxMode;
  capabilities: SandboxCapabilities;
  /** Read-only lorebook entries for the current world (enabled only).
   *  Use these to inject character profiles / world facts into side LLM calls
   *  (`api.ai.complete`) — those calls bypass the main PromptBuilder, so any
   *  knowledge-base content the AI needs must be assembled by the card itself.
   *
   *  Example — pull a character profile by name:
   *    const balder = api.entries.find(e => e.name === "人物：Balder");
   *    api.ai.complete({ messages: [
   *      { role: "system", content: balder?.content ?? "" },
   *      { role: "user", content: userText },
   *    ]});
   */
  entries: ReadonlyArray<SandboxEntry>;
  /** LoreSlot → entry bindings from the world schema. */
  loreUiBindings: ReadonlyArray<SandboxLoreUiBinding>;
  /** Worldbooks (lore modules) defined on the world. */
  worldbooks: ReadonlyArray<SandboxWorldbook>;
  /** Lookup helper: find a single entry by exact name (case-sensitive). Returns
   *  null if missing. Convenience for the common "give me 人物：X's profile" pattern. */
  getEntry: (name: string) => SandboxEntry | null;

  // ── Game actions (fire-and-forget) ──
  pickChatImage: () => Promise<import("@yumina/shared").ChatImageInput | null>;
  sendMessage: (text: string, attachments?: import("@yumina/shared").ChatImageInput[]) => void;
  /** Session-scoped, transactional social simulation; requests resolve after persistence. */
  social: {
    get: () => Promise<any>;
    action: (action: Record<string, unknown>) => Promise<any>;
    generate: (request: Record<string, unknown>) => Promise<any>;
  };
  setVariable: (
    id: string,
    value: unknown,
    options?: { scope?: string; targetUserId?: string }
  ) => void;
  /** Mount/unmount signal from `<LoreSlot />` — gates UI-bound lorebook entries. */
  setLoreSlotActive?: (slotId: string, active: boolean) => void;
  /** Persist a partial variable patch atomically; rejects on failure. */
  patchVariables: (values: Record<string, unknown>) => Promise<void>;
  executeAction: (actionId: string) => void;

  // ── Session management (async, parent-mediated) ──
  // Replaces: fetch('/api/sessions/'+sid+'/revert', POST)
  revertToMessage: (messageId: string) => Promise<void>;
  /**
   * Fork the current session at the given message into a new independent
   * timeline. The branch copies all messages up to (and including)
   * messageId, adopts that message's state snapshot, and clones any
   * session-scoped world memories.
   *
   * Returns the new session id, or null if the call failed (e.g. during
   * streaming, on a multiplayer session, or on a message that no longer
   * exists).
   */
  branchFromMessage: (messageId: string) => Promise<string | null>;
  /**
   * Return the current session's branch context: itself, its parent (if any),
   * its sibling branches (same parent, different id), and its direct
   * children. Each node carries enough metadata to render a branch switcher:
   * name, message count, and timestamps. Re-fetched on every call — there is
   * no client-side cache.
   */
  getBranchContext: () => Promise<BranchContext>;
  // Replaces: fetch('/api/sessions', POST)
  createSession: (worldId: string) => Promise<string>;
  // Replaces: fetch('/api/sessions/'+sid, DELETE)
  deleteSession: (sessionId: string) => Promise<void>;
  // Replaces: fetch('/api/sessions?worldId=...')
  listSessions: (worldId: string) => Promise<Array<Record<string, unknown>>>;
  // Replaces: window.location = ...
  navigate: (path: string) => void;

  // ── UI controls (fire-and-forget) ──
  toggleImmersive: () => void;
  /** Open the player's persona manager (switch / edit / create personas) as a
   *  parent-app overlay. In play, selection changes this session's saved
   *  Persona; global defaults apply when creating a new session. A card that
   *  saved its own imported profile must explicitly re-import to change it.
   *  Fire-and-forget. */
  openPersonaManager: () => void;
  /** Open the shared model picker. Side completions cannot use chat-only trials. */
  openModelPicker: (options?: {purpose: "side-completion"}) => void;
  /** Read the current session's selected Persona when the player chooses to
   * import it. Null means none selected; failures reject. Private notes are
   * excluded. Copy the result into the run's save to keep identity stable. */
  getPersonaProfile: () => Promise<{ name: string; appearance: string; personality: string; backstory: string; entries?: { title: string; content: string }[] } | null>;
  /** Publish the current session as a shared playthrough (opens the share
   *  dialog as a parent-app overlay). Fire-and-forget. */
  sharePlaythrough: () => void;
  /** Open the session / branch manager (switch between branches, rename,
   *  delete) as a parent-app overlay. The modal is already globally mounted by
   *  the app shell. Fire-and-forget. */
  openSessionManager: () => void;
  /** Open the "support the creator" dialog (tip in dollars or gift mushies) as
   *  a parent-app overlay, attributed to the world being played. Lets a
   *  fullscreen custom-UI card offer a support entry of its own — the play
   *  header's heart button is hidden behind that card.
   *
   *  Resolves `{opened:false, reason}` instead of opening when the viewer IS the
   *  creator ("self"), is signed out ("signed-out"), or is in editor preview
   *  ("unavailable"). Awaiting the result matters: the creator testing their own
   *  card is the FIRST person to press this button, and a silent no-op reads as
   *  a broken button. Show the reason. */
  openSupport: () => Promise<{ opened: boolean; reason?: "self" | "signed-out" | "unavailable" }>;
  /** Read one of this world's assets as raw bytes.
   *
   *  The sandbox itself cannot fetch anything (`connect-src 'none'`), and the
   *  browser's privileged loading paths only cover images and media — there is
   *  no `<model>` tag, so a .glb, a large JSON table or a sprite atlas has no
   *  way in at all. This hands the job to the parent, which has no such limit.
   *
   *  Takes an ASSET ID (`"@asset:<uuid>"` or the bare uuid), never a URL, so a
   *  card can read its own assets and nothing else. Resolves
   *  `{ok:false, error}` instead of throwing — `bad-ref`, `http-404`,
   *  `too-large` (32MB ceiling), `unavailable`, or a network message. Always
   *  check `ok` before touching `bytes`. */
  fetchAsset: (ref: string) => Promise<{ ok: boolean; bytes?: ArrayBuffer; contentType?: string; error?: string }>;
  switchGreeting: (index: number) => void;
  // Replaces: navigator.clipboard.writeText(text)
  copyToClipboard: (text: string) => void;

  // ── Audio (fire-and-forget) ──
  // NOTE: all durations here are in SECONDS (not milliseconds).
  playAudio: (
    trackId: string,
    opts?: {
      /** 0–1 multiplier on the track's category volume. */
      volume?: number;
      /** Fade-in time in SECONDS. */
      fadeDuration?: number;
      /** Track id to auto-play when this one ends. */
      chainTo?: string;
      /** Auto-stop after this many SECONDS. */
      maxDuration?: number;
      /** Duck (lower) other BGM while this plays. */
      duckBgm?: boolean;
      /** Override the track's loop setting for this playback. */
      loop?: boolean;
    }
  ) => void;
  /** Stop a track (or all if no id). `fadeDuration` is in SECONDS. Destroys the
   *  element — use pauseAudio if you want to resume from the same position. */
  stopAudio: (trackId?: string, fadeDuration?: number) => void;
  /** Pause a track in place (keeps position; resume with resumeAudio). */
  pauseAudio: (trackId: string) => void;
  /** Resume a track paused with pauseAudio. */
  resumeAudio: (trackId: string) => void;
  /** Subscribe to "track finished playing" notifications (non-looping tracks).
   *  Returns an unsubscribe function. Use to auto-advance a playlist. */
  onAudioEnded: (cb: (trackId: string) => void) => () => void;
  setAudioVolume: (type: "bgm" | "sfx", volume: number) => void;
  getAudioVolume: (type: "bgm" | "sfx") => number;

  // ── Assets (synchronous) ──
  resolveAssetUrl: (ref: string) => string;

  // ── Markdown ──
  renderMarkdown: (text: string) => string;

  /** Private cloud images scoped to the active save; available read-only in replays. */
  media: {
    list: (offset?: number) => Promise<{items:SessionImage[];hasMore:boolean;uploadsEnabled?:boolean}>;
    upload: (file: Blob, options?: {entryId?:string;filename?:string;metadata?:Record<string,unknown>;uploadId?:string}) => Promise<{mediaId:string;entryId:string}>;
    pick: (options?: {entryId?:string;metadata?:Record<string,unknown>}) => Promise<{mediaId:string;entryId:string}|null>;
    remove: (entryId:string,version:number) => Promise<{removed:boolean}>;
  };
  /** JSON data belonging to the save. Versions prevent silent cross-device overwrites.
   * Included in checkpoints and shared snapshots. Store media entry IDs, not image bytes. */
  sessionStorage: {
    get: <T = unknown>(key: string) => Promise<SessionStoredValue<T>>;
    set: <T = unknown>(key: string, value: T, options: SessionStorageWriteOptions) => Promise<SessionStoredValue<T>>;
    remove: (key: string, options: SessionStorageWriteOptions) => Promise<SessionStoredValue>;
  };
  // ── Browser-local cache (does not sync or enter shared snapshots) ──
  // Replaces: localStorage.getItem/setItem
  storage: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };

  // ── Universal canvas: chat actions ──
  /** Edit a message's content (async, triggers auto-regen if applicable) */
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  /** Delete a message (async, with parent-side confirmation bypass) */
  deleteMessage: (messageId: string) => Promise<boolean>;
  /** Draw (or redraw) the illustration for one assistant reply */
  /** Draw (or redraw) a reply's picture; `note` is the player's ask for the redraw ("keep the black sweater"). */
  illustrateMessage: (messageId: string, note?: string, fine?: boolean) => Promise<boolean>;
  /** Whether per-turn illustration is available to this player (server flag + their experimental opt-in), and their auto switch */
  getTurnImageSettings: () => Promise<{ available: boolean; auto: boolean; price?: number; freeLeft?: number; unlimited?: boolean; fine?: boolean } | null>;
  /** Open the host's mushie top-up popup. */
  openCreditTopUp: () => void;
  /** Turn "illustrate every reply" on or off for this player */
  setAutoTurnImages: (on: boolean) => Promise<boolean>;
  /** Regenerate the last assistant message */
  regenerateMessage: (messageId: string) => void;
  /** Continue generating from the last message */
  continueLastMessage: () => void;
  /** Stop the current generation */
  stopGeneration: () => void;
  /** Clear all messages and restart */
  restartChat: () => void;
  /** Dismiss pending choice buttons */
  clearPendingChoices: () => void;
  /** Navigate to a different swipe (left/right) */
  swipeMessage: (messageId: string, direction: "left" | "right") => Promise<Record<string, unknown>>;
  /** Save a checkpoint */
  saveCheckpoint: () => Promise<void>;
  /** Load checkpoints (result pushed via state update) */
  loadCheckpoints: () => Promise<void>;
  /** Restore a saved checkpoint */
  restoreCheckpoint: (checkpointId: string) => Promise<void>;
  /** Delete a checkpoint */
  deleteCheckpoint: (checkpointId: string) => Promise<void>;
  /** Show a toast notification in the parent UI */
  showToast: (message: string, type?: "success" | "error" | "info") => void;

  // ── Universal canvas: state reads ──
  pendingChoices: string[];
  error: string | null;
  /** The user's "Press Enter to send" preference (Settings → Display).
   *  "enter" = Enter sends / Shift+Enter newline; "mod-enter" = Ctrl/⌘+Enter
   *  sends / Enter newline. Custom composers should honor it too. */
  composerSendKey: "enter" | "mod-enter";
  /** Bumped by the host on every terminally-failed send — including toast-only
   *  failures that never set `error`. Watch it to restore swallowed input. */
  sendFailureNonce: number;
  /** Machine code for `error` (e.g. "CONTENT_FILTER"); null when unknown. */
  errorCode: string | null;
  streamingReasoning: string;
  readOnly: boolean;
  checkpoints: Array<{ id: string; name: string; messageCount: number; createdAt: string }>;
  greetingContent: string | null;
  canvasMode: "chat" | "custom" | "fullscreen";
  /** Whether older history pages exist server-side (messages are windowed). */
  hasEarlierMessages: boolean;
  /** True while an older history page is being fetched. */
  isLoadingEarlier: boolean;
  /** Fetch the previous page of history; rows are prepended to `messages`. */
  loadEarlierMessages: () => Promise<boolean>;

  // ── Model picker ──
  selectedModel: string;
  modelFallback: import("@yumina/shared").ModelFallbackNotice | null;
  resolveModelFallback: (id: string, model: string, remember: boolean) => Promise<void>;
  cancelModelFallback: (id: string) => Promise<void>;
  userPlan: string;
  /** Whether the session-memory-summary extension is installed for the user. */
  memorySummaryEnabled: boolean;
  preferredProvider: "official" | "private";
  /** The player's own machine as a model source — null unless this browser
   *  turned the local bridge on. Its `models` are selectable through `setModel`
   *  like any other; the server routes a `local/` id back through this tab. */
  localBridge: LocalBridgeChannelData | null;
  /** Re-detect and reconnect the local runtime after it dropped. Resolves once
   *  the attempt is over — read `localBridge.status` for the outcome. */
  reconnectLocalBridge: () => Promise<void>;
  mixMode: boolean;
  modelPool: Array<{ modelId: string; weight: number; locked?: boolean }>;
  setPreferredProvider: (provider: "official" | "private") => Promise<{
    ok: boolean;
    provider?: "official" | "private";
    error?: string;
  }>;
  /** Active i18n language (e.g. "en", "zh"). Sandbox UI uses this to pick
   *  translations without taking a dep on the host's i18next instance. */
  language: string;
  /** User's live mushie wallet balance (mirrored from the host credit store).
   *  Null = unknown. The model-pill shows this so it's consistent everywhere. */
  balance: number | null;
  setModel: (modelId: string) => void;
  getModels: (provider?: "private") => Promise<{
    models: Array<{ id: string; name: string; provider: string; contextLength: number; supportsImages?: boolean }>;
    pinnedModels: string[];
    recentlyUsed: string[];
  }>;
  /** Resolves with the authoritative pinned list after the change. `accepted`
   *  is false when the pin was refused because the list is full. */
  pinModel: (modelId: string) => Promise<{ pinnedModels: string[]; accepted: boolean }>;
  unpinModel: (modelId: string) => Promise<{ pinnedModels: string[]; accepted: boolean }>;
  setMixMode: (enabled: boolean) => void;
  addToPool: (modelId: string) => void;
  removeFromPool: (modelId: string) => void;
  setPoolWeight: (modelId: string, weight: number) => void;
  togglePoolLock: (modelId: string) => void;

  // ─── Player prompts (platform chat UI) ───────────────────────────────────
  /** The player's own prompt summary, pushed by the host. Null for guests or
   *  before it loads. Used by the built-in 「提示词」 quick panel and the refusal
   *  bar; carries the per-model prompt binding for the current model's family. */
  playerPrompts: import("./protocol").PlayerPromptsChannelData | null;
  /** Switch one of the player's own prompts on/off. */
  togglePlayerPrompt: (promptId: string, enabled: boolean) => Promise<{ ok: boolean }>;

  // ─── Session memory ────────────────────────────────────────────────────
  getStateGuardSettings: () => Promise<import("@yumina/shared").StateGuardSettings>;
  setStateGuardSettings: (patch: Partial<import("@yumina/shared").StateGuardSettings>) => Promise<import("@yumina/shared").StateGuardSettings>;
  getSessionMemory: () => Promise<SessionMemoryPayload>;
  saveSessionMemory: (memory: SessionMemory, model?: string) => Promise<SessionMemoryPayload>;
  /** Player-pinned notes: never rewritten by the updater, always injected. `null` clears. */
  saveSessionMemoryPinned: (pinned: string | null) => Promise<SessionMemoryPayload>;
  clearSessionMemory: () => Promise<SessionMemoryPayload>;
  regenerateSessionMemory: (model?: string) => Promise<SessionMemoryPayload>;
  retrySessionMemory: () => Promise<SessionMemoryPayload>;
  setSessionMemoryModel: (modelId: string) => Promise<SessionMemoryPayload>;
  setSessionMemoryIncluded: (included: boolean) => Promise<SessionMemoryPayload>;
  getSessionSummary: () => Promise<SessionSummaryPayload>;
  saveSessionSummary: (summary: string, model?: string) => Promise<SessionSummaryPayload>;
  setSessionSummaryModel: (modelId: string) => Promise<SessionSummaryPayload>;
  setSessionSummaryceptionModel: (modelId: string) => Promise<SessionSummaryPayload>;
  setSessionSummaryImplementation: (implementation: SessionSummaryImplementation) => Promise<SessionSummaryPayload>;
  setSessionSummaryMode: (mode: SessionSummaryMode) => Promise<SessionSummaryPayload>;
  setSessionSummaryIncluded: (included: boolean) => Promise<SessionSummaryPayload>;
  setSessionSummaryceptionIncluded: (included: boolean) => Promise<SessionSummaryPayload>;
  setSessionSummaryTriggerTokens: (triggerTokens: number) => Promise<SessionSummaryPayload>;
  setSessionSummaryRecentTailTokens: (recentTailTokens: number) => Promise<SessionSummaryPayload>;
  /** Output language for all three summarizers. "auto" = follow the story. */
  setSessionSummaryLanguage: (language: SessionSummaryLanguage) => Promise<SessionSummaryPayload>;
  clearSessionSummary: () => Promise<SessionSummaryPayload>;
  regenerateSessionSummary: (model?: string) => Promise<SessionSummaryPayload>;
  resumeSessionSummaryAutoCompaction: () => Promise<SessionSummaryPayload>;
  compactSessionSummary: (
    model?: string,
    implementation?: SessionSummaryImplementation,
    options?: { force?: boolean },
  ) => Promise<SessionSummaryCompactionPayload>;
  /** Edit the text of a single Summaryception snippet (any layer). */
  updateSummaryceptionSnippet: (snippetId: string, text: string) => Promise<SessionSummaryPayload>;

  // ── AI completions (raw LLM calls, no chat pipeline) ──
  ai: {
    /** Bounded choice questions (8 questions, 64 choices each, 32k total chars).
     * Uses the server's decision model. Official use is platform-funded;
     * OpenRouter BYOK may bill the player's provider. No scene/chat mutation.
     * Failure rejects; do not infer missing confidence or retry paid narration. */
    decide: (params: import("@yumina/shared").AiDecisionRequest) => Promise<import("@yumina/shared").AiDecisionResponse>;
    complete: (params: {
      messages: import("@yumina/shared").ImageCompletionMessage[];
      onDelta?: (text: string) => void;
      model?: string;
      maxTokens?: number;
      temperature?: number;
      /** Opt into the session's current/locked persona (never private notes),
       * enabled narrative prompts and player generation preferences. Native
       * lore defaults to matched against all supplied user messages; depth and
       * examples use this call's history, not saved chat or summary memory.
       * Explicit maxTokens/temperature override preferences (8192-token cap).
       * Caller system instructions/JSON protocol follow narrative presets. */
      context?: "session";
      /**
       * Auto-inject the world's lorebook entries as a system message before
       * `messages`. Use this when a side call (phone chat, NPC dialogue) needs
       * the same world lore the main chat gets. This does not import the
       * player's Persona unless context:'session' is also supplied.
       * In session context, omitted means matched, false excludes world lore,
       * and all/matched honor saved-state activation and interpolate macros.
       *
       * - omitted / `false`: no injection (default — raw LLM proxy).
       * - `true` / `"all"`: inject every enabled non-greeting entry, sorted by
       *   `position`. Predictable token cost, includes everything.
       * - `"matched"`: keyword-match against the LAST user message in
       *   `messages` (same matcher the main chat uses). Always-send entries
       *   plus any keyword hits — leaner, but content depends on wording.
       */
      includeLorebook?: boolean | "all" | "matched";
      /** Request a JSON object from supporting providers; validate its schema before use. */
      responseFormat?: { type: "json_object" };
    }) => Promise<string>;
  };

  // ── Multiplayer room (parent-held WebSocket to the game-rt service) ──
  // First-party surface for realtime game worlds (krew, PvZ). The sandbox
  // cannot open sockets (connect-src 'none'); the parent relays frames.
  // Spec: docs/superpowers/specs/2026-08-24-game-room-primitives-design.md §6.
  room: {
    /** Connect + take a seat. Resolves with the join snapshot on success. */
    join: (roomId: string) => Promise<{
      ok: boolean;
      seatId?: string;
      roomId?: string;
      tick?: number;
      snap?: unknown;
      reason?: string;
    }>;
    /** Disconnect from the room (fire-and-forget). */
    leave: () => void;
    /** Continuous intents (movement/aim). Fire-and-forget; parent coalesces to ≤10Hz. */
    sendInput: (body: Record<string, unknown>) => void;
    /** Discrete validated action (dock, buy, fire-mode…). Ack'd by the module. */
    sendCommand: (name: string, body?: unknown) => Promise<{ ok: boolean; body?: unknown }>;
    /** Subscribe to raw frames: snap | delta | event | presence | status. Returns unsubscribe. */
    onFrame: (cb: (frame: Record<string, unknown>) => void) => () => void;
  };

  // ── Voice readout (TTS) ──
  /** Speak a message (or arbitrary card text) aloud through the platform's
   *  voice pipeline. Billed per character on the account's plan; replaying the
   *  same text+voice is a free cache hit. One voice plays at a time — a new
   *  speak replaces the current one. Track progress via `ttsState.playback`.
   *
   *  - `{ messageId }`: read a chat message (honors the player's reading-mode
   *    setting — full text vs dialogue-only).
   *  - `{ text, key? }`: read raw card text (e.g. an NPC line). Pass a stable
   *    `key` if you want to track its playback state.
   *  - `voice`: optional fish.audio marketplace voice id (32-hex) so cards can
   *    voice their own characters; defaults to the player's chosen voice. */
  tts: {
    speak: (opts: { messageId?: string; text?: string; key?: string; voice?: string }) => Promise<{ ok: boolean; reason?: string }>;
    stop: () => void;
    /** Measured output frames (~15Hz). Match key/generation to the active
     * line; audible alone is not an amplitude measurement. Unsubscribe on
     * unmount. Older hosts do not implement this additive capability. */
    onPlaybackFrame: (cb: (frame: VoicePlaybackFrame) => void) => () => void;
    /** Update the player's voice-readout preferences (in-chat voice panel).
     *  Persists to the account; the new values flow back via `ttsState`. */
    setPrefs: (prefs: {
      enabled?: boolean;
      autoPlay?: boolean;
      mode?: "full" | "dialogue";
      /** "" = auto (platform default for the UI language). Sets a pool of one. */
      voice?: string;
      /** The player's voice pool (voice ids AI casting may use; [] = all). */
      voicePool?: string[];
      /** 0–100. */
      volume?: number;
    }) => void;
    /** Play a short sample of a voice ("" = the auto voice). Billed like any
     *  synth on first listen, cached for everyone after. */
    preview: (voice: string) => Promise<{ ok: boolean; reason?: string }>;
  };
  /** Voice readout prefs + live playback (pushed by the host). `enabled` is
   *  false outside real sessions (guest preview, replay) — hide speaker UI. */
  ttsState: TtsChannelData;

  // ── Voice input (hold-to-talk) ──
  /** Record the player's voice and get the words back. Free to the player.
   *  Call `record()` when the talk button goes down and `stop()` when it comes
   *  up; the promise then resolves with the transcript. `cancel()` throws the
   *  clip away. Recording pauses any voice readout so the AI isn't recorded.
   *
   *  What you do with the text is up to the card — check
   *  `voiceInputState.mode` ("auto" = send it as spoken, "confirm" = let the
   *  player review it) if you want to honor the player's choice. */
  voice: {
    record: (opts?: { onLevel?: (level: number) => void }) => Promise<{ ok: boolean; text?: string; reason?: string }>;
    stop: () => void;
    cancel: () => void;
    /** In-chat voice panel: `mode` "" = follow the card's default. */
    setPrefs: (prefs: { enabled?: boolean; mode?: "" | "confirm" | "auto"; key?: string }) => void;
  };
  /** Voice-input availability and prefs (pushed by the host). */
  voiceInputState: VoiceInputChannelData;

  // ── Context injection (one-shot context for next main chat turn) ──
  /** Inject a one-shot context message into the next main chat AI turn.
   *  The message is consumed and cleared after one use. Does NOT create a visible chat message.
   *  Use for cross-channel awareness: tell the main AI about phone conversations, NPC dialogue, etc. */
  injectContext: (message: string, options?: { role?: "system" | "user" }) => void;

  // ── Composer helpers ──
  /** Prefill the chat composer with `text` and focus it. Does NOT send. Use
   *  for buttons that want the user to review/edit before sending (e.g. NPC
   *  interaction board's 主动聊聊). Fires a sandbox-local event — same iframe
   *  only, no parent round-trip. */
  setComposerDraft: (text: string) => void;
}

// ── Default no-op API ───────────────────────────────────────────────

function noopPromise<T>(val: T): Promise<T> { return Promise.resolve(val); }

function emptySessionMemory(): SessionMemory {
  return { text: "" };
}

function emptySessionMemoryUsage() {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedMushies: 0,
    last: null,
  };
}

function emptySessionMemoryPayload(): SessionMemoryPayload {
  return {
    memory: emptySessionMemory(),
    hasMemory: false,
    pinned: null,
    model: "",
    included: true,
    language: "auto",
    status: "idle",
    error: null,
    updatedAt: null,
    lastSourceHash: null,
    lastProcessedMessageId: null,
    usage: emptySessionMemoryUsage(),
  };
}

function emptySessionSummaryPayload(): SessionSummaryPayload {
  return {
    summary: "",
    hasSummary: false,
    model: "",
    implementation: "localdev",
    mode: "threshold",
    included: true,
    localdevIncluded: true,
    language: "auto",
    summaryceptionIncluded: false,
    triggerTokens: 50_000,
    recentTailTokens: 20_000,
    status: "idle",
    error: null,
    autoCompactionPaused: false,
    autoCompactionCanResume: false,
    autoCompactionResumePending: false,
    updatedAt: null,
    coversUntilMessageId: null,
    tokenCount: null,
    lastSourceHash: null,
    rawChatProgress: null,
    usage: emptySessionMemoryUsage(),
    summaryception: {
      hasSummary: false,
      model: "",
      layerCount: 0,
      snippetCount: 0,
      tokenCount: null,
      status: "idle",
      error: null,
      updatedAt: null,
      coversUntilMessageId: null,
      coversUntilOrdinal: null,
      usage: emptySessionMemoryUsage(),
      layers: [],
    },
  };
}

function emptySessionSummaryCompactionPayload(): SessionSummaryCompactionPayload {
  return {
    summary: emptySessionSummaryPayload(),
    compaction: {
      compactedCount: 0,
      compactedFromMessageId: null,
      compactedToMessageId: null,
      compactedFromOrdinal: null,
      compactedToOrdinal: null,
      compactedFromPreview: null,
      compactedToPreview: null,
      compactedUntilOneLine: null,
      compactedTokenEstimate: 0,
      retainedCount: 0,
      retainedTokenEstimate: 0,
      noOpReason: "Session APIs are unavailable.",
      noOpReasonCode: "session-apis-unavailable",
    },
  };
}

const sessionCapabilities: SandboxCapabilities = {
  canSendMessage: true,
  canPersistSession: true,
  canUseSessionApis: true,
  requiresAuth: false,
};

const guestPreviewCapabilities: SandboxCapabilities = {
  canSendMessage: false,
  canPersistSession: false,
  canUseSessionApis: false,
  requiresAuth: true,
};

const NO_VOICE_INPUT: VoiceInputChannelData = {
  available: false, enabled: false, mode: "confirm", cardMode: "confirm", playerMode: "", key: "Space",
};

const defaultAPI: SandboxedYuminaAPI = {
  variables: {},
  globalVariables: {},
  worldName: "",
  worldCover: null,
  worldId: "",
  sessionId: "",
  currentUser: null,
  user: { name: "Player", avatar: null },
  messages: [],
  isStreaming: false,
  streamingContent: "",
  mode: "session",
  capabilities: sessionCapabilities,
  entries: [],
  loreUiBindings: [],
  worldbooks: [],
  getEntry: () => null,
  pickChatImage: async () => null,
  sendMessage: () => {},
  social: { get: () => noopPromise(null), action: () => noopPromise(null), generate: () => noopPromise(null) },
  setVariable: () => {},
  patchVariables: () => noopPromise(undefined),
  executeAction: () => {},
  revertToMessage: () => noopPromise(undefined),
  branchFromMessage: () => noopPromise(null),
  getBranchContext: () =>
    noopPromise<BranchContext>({
      current: {
        id: "",
        name: null,
        parentSessionId: null,
        branchedFromMessageId: null,
        messageCount: 0,
        updatedAt: new Date(0).toISOString(),
        createdAt: new Date(0).toISOString(),
      },
      parent: null,
      siblings: [],
      children: [],
    }),
  createSession: () => noopPromise(""),
  deleteSession: () => noopPromise(undefined),
  listSessions: () => noopPromise([]),
  navigate: () => {},
  toggleImmersive: () => {},
  openPersonaManager: () => {},
  openModelPicker: () => {},
  getPersonaProfile: () => noopPromise(null),
  sharePlaythrough: () => {},
  openSessionManager: () => {},
  openSupport: () => noopPromise({ opened: false, reason: "unavailable" as const }),
  fetchAsset: () => noopPromise({ ok: false, error: "unavailable" }),
  switchGreeting: () => {},
  copyToClipboard: () => {},
  playAudio: () => {},
  stopAudio: () => {},
  pauseAudio: () => {},
  resumeAudio: () => {},
  onAudioEnded: () => () => {},
  setAudioVolume: () => {},
  getAudioVolume: () => 1,
  resolveAssetUrl: (ref) => ref,
  renderMarkdown: (t) => t,
  media: {
    list: () => noopPromise({items:[],hasMore:false}),
    upload: () => Promise.reject(new Error("No active session")),
    pick: () => noopPromise(null),
    remove: () => Promise.reject(new Error("No active session")),
  },
  sessionStorage: {
    get: () => Promise.reject(new Error("No active session")),
    set: () => Promise.reject(new Error("No active session")),
    remove: () => Promise.reject(new Error("No active session")),
  },
  storage: {
    get: () => noopPromise(null),
    set: () => noopPromise(undefined),
    remove: () => noopPromise(undefined),
  },
  editMessage: () => noopPromise(false),
  deleteMessage: () => noopPromise(false),
  illustrateMessage: () => noopPromise(false),
  getTurnImageSettings: () => noopPromise(null),
  openCreditTopUp: () => {},
  setAutoTurnImages: () => noopPromise(false),
  regenerateMessage: () => {},
  continueLastMessage: () => {},
  stopGeneration: () => {},
  restartChat: () => {},
  clearPendingChoices: () => {},
  swipeMessage: () => noopPromise({}),
  saveCheckpoint: () => noopPromise(undefined),
  loadCheckpoints: () => noopPromise(undefined),
  restoreCheckpoint: () => noopPromise(undefined),
  deleteCheckpoint: () => noopPromise(undefined),
  showToast: () => {},
  pendingChoices: [],
  error: null,
  composerSendKey: "enter",
  sendFailureNonce: 0,
  errorCode: null,
  streamingReasoning: "",
  // Start safe until the parent pushes UI state. This prevents the sandbox from
  // briefly exposing a playable composer before session/guest-preview state is known.
  readOnly: true,
  checkpoints: [],
  greetingContent: null,
  canvasMode: "custom",
  hasEarlierMessages: false,
  isLoadingEarlier: false,
  loadEarlierMessages: () => noopPromise(false),
  selectedModel: "",
  modelFallback: null,
  resolveModelFallback: () => noopPromise(undefined),
  cancelModelFallback: () => noopPromise(undefined),
  userPlan: "free",
  memorySummaryEnabled: false,
  preferredProvider: "official",
  localBridge: null,
  reconnectLocalBridge: () => noopPromise(undefined),
  mixMode: false,
  modelPool: [],
  setPreferredProvider: () => noopPromise({ ok: false, error: "Unavailable" }),
  language: "en",
  balance: null,
  setModel: () => {},
  getModels: () => noopPromise({ models: [], pinnedModels: [], recentlyUsed: [] }),
  pinModel: () => noopPromise({ pinnedModels: [], accepted: false }),
  unpinModel: () => noopPromise({ pinnedModels: [], accepted: false }),
  setMixMode: () => {},
  addToPool: () => {},
  removeFromPool: () => {},
  setPoolWeight: () => {},
  playerPrompts: null,
  togglePlayerPrompt: () => noopPromise({ ok: false }),
  getStateGuardSettings: () => Promise.reject(new Error("No active session")),
  setStateGuardSettings: () => Promise.reject(new Error("No active session")),
  getSessionMemory: () =>
    noopPromise(emptySessionMemoryPayload()),
  saveSessionMemory: (_memory, _model) =>
    defaultAPI.getSessionMemory(),
  saveSessionMemoryPinned: (_pinned) =>
    defaultAPI.getSessionMemory(),
  clearSessionMemory: () =>
    defaultAPI.getSessionMemory(),
  regenerateSessionMemory: (_model) =>
    defaultAPI.getSessionMemory(),
  retrySessionMemory: () =>
    defaultAPI.getSessionMemory(),
  setSessionMemoryModel: (_modelId) =>
    defaultAPI.getSessionMemory(),
  setSessionMemoryIncluded: (_included) =>
    defaultAPI.getSessionMemory(),
  getSessionSummary: () =>
    noopPromise(emptySessionSummaryPayload()),
  saveSessionSummary: (_summary, _model) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryModel: (_modelId) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryceptionModel: (_modelId) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryImplementation: (_implementation) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryMode: (_mode) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryIncluded: (_included) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryceptionIncluded: (_included) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryTriggerTokens: (_triggerTokens) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryRecentTailTokens: (_recentTailTokens) =>
    defaultAPI.getSessionSummary(),
  setSessionSummaryLanguage: (_language) =>
    defaultAPI.getSessionSummary(),
  clearSessionSummary: () =>
    defaultAPI.getSessionSummary(),
  regenerateSessionSummary: (_model) =>
    defaultAPI.getSessionSummary(),
  resumeSessionSummaryAutoCompaction: () =>
    defaultAPI.getSessionSummary(),
  compactSessionSummary: (_model, _implementation, _options) =>
    noopPromise(emptySessionSummaryCompactionPayload()),
  updateSummaryceptionSnippet: (_snippetId, _text) =>
    defaultAPI.getSessionSummary(),
  togglePoolLock: () => {},
  ai: {
    complete: () => noopPromise(""),
    decide: () => Promise.reject(new Error("Decisions require an active session")),
  },
  room: {
    join: () => noopPromise({ ok: false, reason: "unavailable" }),
    leave: () => {},
    sendInput: () => {},
    sendCommand: () => noopPromise({ ok: false }),
    onFrame: () => () => {},
  },
  tts: {
    speak: () => noopPromise({ ok: false, reason: "unavailable" }),
    stop: () => {},
    onPlaybackFrame: () => () => {},
    setPrefs: () => {},
    preview: () => noopPromise({ ok: false, reason: "unavailable" }),
  },
  ttsState: { available: false, enabled: false, voice: "", mode: "full", autoPlay: false, volume: 100, playback: null },
  voice: {
    record: () => noopPromise({ ok: false, reason: "unavailable" }),
    stop: () => {},
    cancel: () => {},
    setPrefs: () => {},
  },
  voiceInputState: NO_VOICE_INPUT,
  injectContext: () => {},
  setComposerDraft: () => {},
};

/** Sandbox-local event name for prefilling the chat composer. Dispatched on
 *  `window` inside the sandbox iframe; MessageInput listens. */
export const COMPOSER_DRAFT_EVENT = "yumina:set-composer-draft";

/** Sandbox-local event name for "an audio track finished". Dispatched on
 *  `window` inside the sandbox iframe by component-host when the parent
 *  forwards a track-ended notification; api.onAudioEnded subscribers listen. */
export const AUDIO_ENDED_EVENT = "yumina:audio-ended";
export const VOICE_PLAYBACK_FRAME_EVENT = 'yumina:voice-playback-frame';

/** Sandbox-local event name for a multiplayer room frame. Dispatched on
 *  `window` by component-host when the parent relays a frame from the game
 *  WebSocket; api.room.on* subscribers listen. */
export const ROOM_FRAME_EVENT = "yumina:room-frame";

/** Sandbox-local event name for "open the session-memory panel". Dispatched on
 *  `window` by component-host when the parent play-controls bar asks for it;
 *  the host-level panel mount listens (see MemoryPanelHostMount). */
export const OPEN_MEMORY_PANEL_EVENT = "yumina:open-memory-panel";

export const YuminaContext = createContext<SandboxedYuminaAPI>(defaultAPI);

export function useYumina(): SandboxedYuminaAPI {
  return useContext(YuminaContext);
}

// ── PostMessage helpers ─────────────────────────────────────────────

let callCounter = 0;
const pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function postToParent(method: string, args: unknown[]): void {
  const msg: ApiCallMessage = {
    type: "api-call",
    callId: `fire-${++callCounter}`,
    method,
    args,
  };
  postToParentWindow(wrapMessage(msg));
}

async function socialCall(method: string, args: unknown[], timeoutMs = 25_000): Promise<any> {
  const result = await callParent<any>(method, args, timeoutMs);
  if (result?.error) throw new Error(result.error);
  return result;
}

function callParent<T>(method: string, args: unknown[], timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const callId = `async-${++callCounter}`;
    pendingCalls.set(callId, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    const msg: ApiCallMessage = { type: "api-call", callId, method, args };
    postToParentWindow(wrapMessage(msg));

    // Timeout after 10s to prevent leaked promises
    setTimeout(() => {
      if (pendingCalls.has(callId)) {
        pendingCalls.delete(callId);
        reject(new Error(`API call '${method}' timed out`));
      }
    }, timeoutMs);
  });
}

/** Called by sandbox-host when receiving api-response from parent */
export function resolveApiCall(callId: string, result: unknown, error?: string): void {
  const pending = pendingCalls.get(callId);
  if (pending) {
    pendingCalls.delete(callId);
    if (error !== undefined) pending.reject(new Error(error));
    else pending.resolve(result);
  }
}

// ── Streaming calls (for LLM completions) ──────────────────────────

const streamingCalls = new Map<string, {
  onDelta: (text: string) => void;
  resolve: (fullText: string) => void;
  reject: (err: Error) => void;
}>();

function callParentStreaming(
  method: string,
  args: unknown[],
  onDelta: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const callId = `stream-${++callCounter}`;
    streamingCalls.set(callId, { onDelta, resolve, reject });
    const msg: ApiCallMessage = { type: "api-call", callId, method, args };
    postToParentWindow(wrapMessage(msg));

    // Timeout after 120s for LLM calls (much longer than regular API calls)
    setTimeout(() => {
      if (streamingCalls.has(callId)) {
        streamingCalls.delete(callId);
        reject(new Error(`Streaming call '${method}' timed out`));
      }
    }, 120_000);
  });
}

/** Called by component-host when receiving api-stream from parent */
export function receiveStreamChunk(callId: string, delta: string, done: boolean, result?: unknown): void {
  const stream = streamingCalls.get(callId);
  if (!stream) return;
  if (delta) stream.onDelta(delta);
  if (done) {
    streamingCalls.delete(callId);
    stream.resolve(typeof result === "string" ? result : "");
  }
}

/** Resolve @asset:{id} → CDN URL (pure string transform, no network) */
function resolveAssetUrl(ref: string): string {
  if (!ref) return ref;
  if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
  if (ref.startsWith("@asset:")) return `/cdn/${ref.slice(7)}`;
  return ref;
}

// ── API factory ─────────────────────────────────────────────────────

export function buildAPI(state: SandboxState): SandboxedYuminaAPI {
  const capabilities = state.capabilities ?? (
    state.mode === "guest-preview" ? guestPreviewCapabilities : sessionCapabilities
  );
  const sessionApisAvailable = capabilities.canUseSessionApis && Boolean(state.sessionId);
  const promptAuth = () => {
    if (capabilities.requiresAuth) postToParent("sendMessage", [""]);
  };
  const guardedCall = <T,>(fallback: T, prompt = false): Promise<T> => {
    if (prompt) promptAuth();
    return noopPromise(fallback);
  };

  return {
    __useLegacyGallery: (options) => useLegacyGallery(state.sessionId, !!state.readOnly || !capabilities.canPersistSession, options, callParent),
    // State reads
    variables: state.variables,
    globalVariables: state.globalVariables,
    worldName: state.worldName,
    worldCover: state.worldCover ?? null,
    worldId: state.worldId,
    sessionId: state.sessionId,
    currentUser: state.currentUser,
    user: state.user,
    messages: state.messages,
    isStreaming: state.isStreaming,
    streamingContent: state.streamingContent,
    mode: state.mode ?? "session",
    capabilities,
    entries: state.entries ?? [],
    loreUiBindings: state.loreUiBindings ?? [],
    worldbooks: state.worldbooks ?? [],
    getEntry: (name: string) => {
      const list = state.entries ?? [];
      for (const e of list) if (e.name === name) return e;
      // Dev hint: silent lookups that always return null are how cards drift
      // away from the lorebook (entry got renamed, typo). Log once per name
      // so authors notice during testing without spamming production logs.
      if (typeof location !== "undefined" && location.hostname === "localhost") {
        if (!warnedMissingEntries.has(name)) {
          warnedMissingEntries.add(name);
          // eslint-disable-next-line no-console
          console.warn(
            `[useYumina] api.getEntry(${JSON.stringify(name)}) → null. Either the entry was renamed, removed, or the name is misspelled. Available names:`,
            list.map((e) => e.name),
          );
        }
      }
      return null;
    },

    // Game actions (fire-and-forget)
    pickChatImage: () => sessionApisAvailable ? callParent("pickChatImage", [], 600_000) : Promise.resolve(null),
    sendMessage: (text, attachments) => postToParent("sendMessage", [text, attachments]),
    social: {
      get: () => socialCall("social.get", []),
      action: (action) => socialCall("social.action", [action]),
      generate: (request) => socialCall("social.generate", [request], 210_000),
    },
    setVariable: (id, value, options) =>
      postToParent("setVariable", [id, value, options]),
    setLoreSlotActive: (slotId, active) =>
      postToParent("setLoreSlotActive", [slotId, active]),
    patchVariables: (values) => callParent("patchVariables", [values], 20_000),
    executeAction: (actionId) => postToParent("executeAction", [actionId]),

    // Session management (async)
    revertToMessage: (messageId) =>
      sessionApisAvailable ? callParent("revertToMessage", [messageId]) : guardedCall(undefined),
    branchFromMessage: (messageId) =>
      sessionApisAvailable ? callParent("branchFromMessage", [messageId]) : guardedCall(null),
    getBranchContext: () => sessionApisAvailable
      ? callParent<BranchContext>("getBranchContext", [])
      : guardedCall<BranchContext>({
          current: {
            id: "",
            name: null,
            parentSessionId: null,
            branchedFromMessageId: null,
            messageCount: 0,
            updatedAt: new Date(0).toISOString(),
            createdAt: new Date(0).toISOString(),
          },
          parent: null,
          siblings: [],
          children: [],
        }),
    createSession: (worldId) =>
      sessionApisAvailable ? callParent("createSession", [worldId]) : guardedCall("", true),
    deleteSession: (sessionId) =>
      sessionApisAvailable ? callParent("deleteSession", [sessionId]) : guardedCall(undefined),
    listSessions: (worldId) =>
      sessionApisAvailable ? callParent("listSessions", [worldId]) : guardedCall([]),
    navigate: (path) => postToParent("navigate", [path]),

    // UI controls
    toggleImmersive: () => postToParent("toggleImmersive", []),
    openPersonaManager: () => postToParent("openPersonaManager", []),
    openModelPicker: (options) => postToParent("openModelPicker", options?.purpose === "side-completion" ? [{purpose: "side-completion"}] : []),
    getPersonaProfile: () => callParent("getPersonaProfile", []),
    sharePlaythrough: () => postToParent("sharePlaythrough", []),
    openSessionManager: () => postToParent("openSessionManager", []),
    openSupport: () =>
      sessionApisAvailable
        ? callParent("openSupport", [])
        : guardedCall({ opened: false, reason: "signed-out" as const }, true),
    // Deliberately NOT gated on session capabilities: assets are public, and a
    // creator previewing in Studio must see the same models/textures a player
    // does — otherwise the editor always shows the untextured version.
    // A callParent timeout rejects; fold it into {ok:false} so card code never
    // needs a try/catch around it.
    // Give large model downloads a bounded 30-second response window.
    fetchAsset: (ref) =>
      callParent<{ ok: boolean; bytes?: ArrayBuffer; contentType?: string; error?: string }>(
        "fetchAsset",
        [ref],
        30_000,
      ).catch((e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 120) })),
    switchGreeting: (index) => postToParent("switchGreeting", [index]),
    copyToClipboard: (text) => postToParent("copyToClipboard", [text]),

    // Audio
    playAudio: (trackId, opts) => postToParent("playAudio", [trackId, opts]),
    stopAudio: (trackId, fadeDuration) =>
      postToParent("stopAudio", [trackId, fadeDuration]),
    pauseAudio: (trackId) => postToParent("pauseAudio", [trackId]),
    resumeAudio: (trackId) => postToParent("resumeAudio", [trackId]),
    onAudioEnded: (cb) => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<{ trackId?: string }>).detail;
        cb(String(detail?.trackId ?? ""));
      };
      window.addEventListener(AUDIO_ENDED_EVENT, handler);
      return () => window.removeEventListener(AUDIO_ENDED_EVENT, handler);
    },
    setAudioVolume: (type, volume) =>
      postToParent("setAudioVolume", [type, volume]),
    getAudioVolume: (type) => {
      // Synchronous read from state pushed by parent
      return type === "bgm" ? (state.bgmVolume ?? 1) : (state.sfxVolume ?? 1);
    },

    // Assets
    resolveAssetUrl,

    // Markdown
    renderMarkdown,

    media: {
      list: (offset) => callParent("media.list", [offset ?? 0], 60_000),
      upload: (file, options) => callParent("media.upload", [file, options], 240_000),
      pick: (options) => callParent("media.pick", [options], 600_000),
      remove: (entryId, version) => callParent("media.remove", [entryId, version], 60_000),
    },
    sessionStorage: {
      get: (key) => callParent("sessionStorage.get", [key], 60_000),
      set: (key, value, options) => callParent("sessionStorage.set", [key, value, options], 60_000),
      remove: (key, options) => callParent("sessionStorage.remove", [key, options], 60_000),
    },
    // Browser-local cache (not a cloud save).
    storage: {
      get: (key) => callParent("storage.get", [key], key.startsWith("oncin:gallery:v2:") ? 600_000 : 10_000),
      set: (key, value) => callParent("storage.set", [key, value], key.startsWith("oncin:gallery:v2:") ? 600_000 : 10_000),
      remove: (key) => callParent("storage.remove", [key]),
    },

    // Chat actions (universal canvas)
    editMessage: (messageId, content) => sessionApisAvailable ? callParent("editMessage", [messageId, content]) : guardedCall(false, true),
    deleteMessage: (messageId) => sessionApisAvailable ? callParent("deleteMessage", [messageId]) : guardedCall(false, true),
    // Rendering + upload can take a while on a cold GPU.
    illustrateMessage: (messageId, note, fine) => sessionApisAvailable
      ? callParent("illustrateMessage", fine ? [messageId, note ?? "", true] : note ? [messageId, note] : [messageId], 120_000)
      : guardedCall(false, true),
    getTurnImageSettings: () => sessionApisAvailable ? callParent("getTurnImageSettings", []) : Promise.resolve(null),
    openCreditTopUp: () => { if (sessionApisAvailable) void callParent("openCreditTopUp", []); },
    setAutoTurnImages: (on) => sessionApisAvailable ? callParent("setAutoTurnImages", [on]) : guardedCall(false, true),
    regenerateMessage: (messageId) => { if (sessionApisAvailable) postToParent("regenerateMessage", [messageId]); else promptAuth(); },
    continueLastMessage: () => { if (sessionApisAvailable) postToParent("continueLastMessage", []); else promptAuth(); },
    stopGeneration: () => { if (sessionApisAvailable) postToParent("stopGeneration", []); },
    restartChat: () => { if (sessionApisAvailable) postToParent("restartChat", []); else promptAuth(); },
    clearPendingChoices: () => { if (sessionApisAvailable) postToParent("clearPendingChoices", []); },
    swipeMessage: (messageId, direction) => sessionApisAvailable ? callParent("swipeMessage", [messageId, direction]) : guardedCall({}),
    saveCheckpoint: () => sessionApisAvailable ? callParent("saveCheckpoint", []) : guardedCall(undefined, true),
    loadCheckpoints: () => sessionApisAvailable ? callParent("loadCheckpoints", []) : guardedCall(undefined),
    restoreCheckpoint: (checkpointId) => sessionApisAvailable ? callParent("restoreCheckpoint", [checkpointId]) : guardedCall(undefined, true),
    deleteCheckpoint: (checkpointId) => sessionApisAvailable ? callParent("deleteCheckpoint", [checkpointId]) : guardedCall(undefined),
    showToast: (message, type) => postToParent("showToast", [message, type]),

    // Canvas state reads
    pendingChoices: state.pendingChoices ?? [],
    error: state.error ?? null,
    composerSendKey: state.composerSendKey ?? "enter",
    sendFailureNonce: state.sendFailureNonce ?? 0,
    errorCode: state.errorCode ?? null,
    streamingReasoning: state.streamingReasoning ?? "",
    readOnly: state.readOnly ?? false,
    checkpoints: state.checkpoints ?? [],
    greetingContent: state.greetingContent ?? null,
    canvasMode: state.canvasMode ?? "custom",
    hasEarlierMessages: state.hasEarlierMessages ?? false,
    isLoadingEarlier: state.isLoadingEarlier ?? false,
    loadEarlierMessages: () => sessionApisAvailable ? callParent("loadEarlierMessages", []) : guardedCall(false),

    // Model picker
    selectedModel: state.selectedModel ?? "",
    modelFallback: state.modelFallback ?? null,
    resolveModelFallback: (id, model, remember) => callParent("resolveModelFallback", [id, model, remember]),
    cancelModelFallback: (id) => callParent("cancelModelFallback", [id]),
    userPlan: state.userPlan ?? "free",
    memorySummaryEnabled: state.memorySummaryEnabled ?? false,
    preferredProvider: state.preferredProvider ?? "official",
    localBridge: state.localBridge ?? null,
    reconnectLocalBridge: () => callParent("reconnectLocalBridge", []),
    mixMode: state.mixMode ?? false,
    modelPool: state.modelPool ?? [],
    setPreferredProvider: (provider) => callParent("setPreferredProvider", [provider]),
    language: state.language ?? "en",
    balance: state.balance ?? null,
    setModel: (modelId) => postToParent("setModel", [modelId]),
    getModels: (provider) => callParent("getModels", provider ? [provider] : []),
    pinModel: (modelId) => callParent("pinModel", [modelId]),
    unpinModel: (modelId) => callParent("unpinModel", [modelId]),
    setMixMode: (enabled) => postToParent("setMixMode", [enabled]),
    addToPool: (modelId) => postToParent("addToPool", [modelId]),
    removeFromPool: (modelId) => postToParent("removeFromPool", [modelId]),
    setPoolWeight: (modelId, weight) => postToParent("setPoolWeight", [modelId, weight]),
    playerPrompts: state.playerPrompts ?? null,
    togglePlayerPrompt: (promptId, enabled) =>
      sessionApisAvailable
        ? callParent<{ ok: boolean }>("togglePlayerPrompt", [promptId, enabled], 20_000).catch(() => ({ ok: false }))
        : Promise.resolve({ ok: false }),
    getStateGuardSettings: () => sessionApisAvailable ? callParent("getStateGuardSettings", []) : Promise.reject(new Error("No active session")),
    setStateGuardSettings: (patch) => sessionApisAvailable ? callParent("setStateGuardSettings", [patch]) : Promise.reject(new Error("No active session")),
    getSessionMemory: () =>
      sessionApisAvailable
        ? callParent<SessionMemoryPayload>("getSessionMemory", [])
        : guardedCall(emptySessionMemoryPayload(), true),
    saveSessionMemory: (memory, model) =>
      sessionApisAvailable
        ? callParent<SessionMemoryPayload>("saveSessionMemory", [memory, model])
        : guardedCall(emptySessionMemoryPayload(), true),
    saveSessionMemoryPinned: (pinned) =>
      sessionApisAvailable
        ? callParent<SessionMemoryPayload>("saveSessionMemoryPinned", [pinned])
        : guardedCall(emptySessionMemoryPayload(), true),
    clearSessionMemory: () =>
      sessionApisAvailable
        ? callParent<SessionMemoryPayload>("clearSessionMemory", [])
        : guardedCall(emptySessionMemoryPayload(), true),
    regenerateSessionMemory: (model) =>
      sessionApisAvailable
        ? callParent<SessionMemoryPayload>("regenerateSessionMemory", [model], 120_000)
        : guardedCall(emptySessionMemoryPayload(), true),
    retrySessionMemory: () =>
      sessionApisAvailable
        ? callParent<SessionMemoryPayload>("retrySessionMemory", [], 120_000)
        : guardedCall(emptySessionMemoryPayload(), true),
    setSessionMemoryModel: (modelId) =>
      sessionApisAvailable
        ? callParent<SessionMemoryPayload>("setSessionMemoryModel", [modelId])
        : guardedCall(emptySessionMemoryPayload(), true),
    setSessionMemoryIncluded: (included) =>
      sessionApisAvailable
        ? callParent<SessionMemoryPayload>("setSessionMemoryIncluded", [included])
        : guardedCall(emptySessionMemoryPayload(), true),
    getSessionSummary: () =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("getSessionSummary", [])
        : guardedCall(emptySessionSummaryPayload(), true),
    saveSessionSummary: (summary, model) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("saveSessionSummary", [summary, model])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryModel: (modelId) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryModel", [modelId])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryceptionModel: (modelId) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryceptionModel", [modelId])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryImplementation: (implementation) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryImplementation", [implementation])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryMode: (mode) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryMode", [mode])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryIncluded: (included) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryIncluded", [included])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryceptionIncluded: (included) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryceptionIncluded", [included])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryTriggerTokens: (triggerTokens) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryTriggerTokens", [triggerTokens])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryRecentTailTokens: (recentTailTokens) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryRecentTailTokens", [recentTailTokens])
        : guardedCall(emptySessionSummaryPayload(), true),
    setSessionSummaryLanguage: (language) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("setSessionSummaryLanguage", [language])
        : guardedCall(emptySessionSummaryPayload(), true),
    clearSessionSummary: () =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("clearSessionSummary", [])
        : guardedCall(emptySessionSummaryPayload(), true),
    regenerateSessionSummary: (model) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("regenerateSessionSummary", [model], 180_000)
        : guardedCall(emptySessionSummaryPayload(), true),
    resumeSessionSummaryAutoCompaction: () =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("resumeSessionSummaryAutoCompaction", [])
        : guardedCall(emptySessionSummaryPayload(), true),
    compactSessionSummary: (model, implementation, options) =>
      sessionApisAvailable
        ? callParent<SessionSummaryCompactionPayload>("compactSessionSummary", [model, implementation, options], 180_000)
        : guardedCall(emptySessionSummaryCompactionPayload(), true),
    updateSummaryceptionSnippet: (snippetId, text) =>
      sessionApisAvailable
        ? callParent<SessionSummaryPayload>("updateSummaryceptionSnippet", [snippetId, text])
        : guardedCall(emptySessionSummaryPayload(), true),
    togglePoolLock: (modelId) => postToParent("togglePoolLock", [modelId]),

    // AI completions (raw LLM calls).
    // Default to the player's currently selected chat model so side calls
    // (phones, NPC dialogue) honor the model + BYOK choice the player made
    // for the main chat. Card authors can still override per-call by passing
    // an explicit `model`.
    ai: {
      decide: (params) => sessionApisAvailable
        ? callParent("ai.decide", [{ state: params.state, questions: params.questions }], 15_000)
        : Promise.reject(new Error("Decisions require an active session")),
      complete: (params) =>
        sessionApisAvailable
          ? callParentStreaming(
              "ai.complete",
              [{
                messages: params.messages,
                model: params.model || state.selectedModel || undefined,
                maxTokens: params.maxTokens,
                temperature: params.temperature,
                context: params.context,
                includeLorebook: params.includeLorebook,
                responseFormat: params.responseFormat,
              }],
              params.onDelta ?? (() => {}),
            )
          : guardedCall("", true),
    },

    // Multiplayer room — parent holds the WebSocket, frames arrive as
    // ROOM_FRAME_EVENT window events (relayed by component-host).
    room: {
      join: (roomId) => callParent("room.join", [roomId], 20_000),
      leave: () => postToParent("room.leave", []),
      sendInput: (body) => postToParent("room.input", [body]),
      sendCommand: (name, body) => callParent("room.cmd", [name, body]),
      onFrame: (cb) => {
        const handler = (e: Event) => cb((e as CustomEvent).detail as Record<string, unknown>);
        window.addEventListener(ROOM_FRAME_EVENT, handler);
        return () => window.removeEventListener(ROOM_FRAME_EVENT, handler);
      },
    },

    // Voice readout (TTS) — synthesis happens parent-side (sandbox can't
    // fetch); playback runs on the parent audio store; state comes back via
    // the UI channel's `tts` field.
    tts: {
      speak: (opts) =>
        sessionApisAvailable
          ? callParent<{ ok: boolean; reason?: string }>("tts.speak", [opts], 60_000)
            .catch(() => ({ ok: false as const, reason: "timeout" }))
          : guardedCall({ ok: false as const, reason: "unavailable" }, true),
      stop: () => postToParent("tts.stop", []),
      onPlaybackFrame: (cb) => {
        const handler = (event: Event) => cb((event as CustomEvent<VoicePlaybackFrame>).detail);
        window.addEventListener(VOICE_PLAYBACK_FRAME_EVENT, handler);
        return () => window.removeEventListener(VOICE_PLAYBACK_FRAME_EVENT, handler);
      },
      setPrefs: (prefs) => postToParent("tts.setPrefs", [prefs]),
      preview: (voice) =>
        sessionApisAvailable
          ? callParent<{ ok: boolean; reason?: string }>("tts.preview", [voice], 60_000)
            .catch(() => ({ ok: false as const, reason: "timeout" }))
          : guardedCall({ ok: false as const, reason: "unavailable" }, true),
    },
    ttsState: state.tts ?? { available: false, enabled: false, voice: "", mode: "full", autoPlay: false, volume: 100, playback: null },

    // Voice input — the parent records (the sandbox has no microphone) and
    // streams the input level back while it does.
    voice: {
      record: (opts) => {
        if (!sessionApisAvailable) return guardedCall({ ok: false as const, reason: "unavailable" }, true);
        return callParentStreaming("voice.record", [], (delta) => {
          const level = Number(delta);
          if (Number.isFinite(level)) opts?.onLevel?.(level);
        })
          .then((raw) => {
            try {
              return JSON.parse(raw) as { ok: boolean; text?: string; reason?: string };
            } catch {
              return { ok: false, reason: "error" };
            }
          })
          .catch(() => ({ ok: false, reason: "timeout" }));
      },
      stop: () => postToParent("voice.stop", []),
      cancel: () => postToParent("voice.cancel", []),
      setPrefs: (prefs) => postToParent("voice.setPrefs", [prefs]),
    },
    voiceInputState: state.voiceInput ?? NO_VOICE_INPUT,

    // Context injection (one-shot for next main chat turn)
    injectContext: (message, options) =>
      postToParent("injectContext", [message, options]),

    // Composer prefill — sandbox-local, no parent round-trip
    setComposerDraft: (text) => {
      window.dispatchEvent(
        new CustomEvent(COMPOSER_DRAFT_EVENT, { detail: { text: String(text ?? "") } }),
      );
    },
  };
}
