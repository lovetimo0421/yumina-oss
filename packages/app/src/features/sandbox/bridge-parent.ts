import {
  unwrapMessage,
  wrapMessage,
  safePostMessage,
  type ParentMessage,
  type SandboxMessage,
  type ChannelDataMap,
  type SandboxMode,
} from "../../../sandbox/protocol";
import type { StateChannel } from "@yumina/engine";
import { loadTranscriptPosition, saveTranscriptPosition } from "../../lib/transcript-position-storage";
import { isTranscriptPosition } from "../../../sandbox/chat/transcript-position-types";

// Origins a sandbox message may legitimately carry. The iframe runs
// `allow-scripts` WITHOUT `allow-same-origin`, so its origin is OPAQUE and
// the browser reports it as the literal string "null" — regardless of whether
// the bundle is served same-origin (/sandbox/index.html) or from a dedicated
// VITE_SANDBOX_URL host. The URL's origin is included for the day the iframe
// ever gains allow-same-origin on a separate sandbox domain.
const SANDBOX_EXPECTED_ORIGINS = new Set<string>(["null"]);
try {
  const sandboxUrl = import.meta.env.VITE_SANDBOX_URL as string | undefined;
  if (sandboxUrl) SANDBOX_EXPECTED_ORIGINS.add(new URL(sandboxUrl, window.location.href).origin);
} catch {
  // Malformed VITE_SANDBOX_URL — the "null" entry still covers the opaque iframe.
}

/**
 * Handler for API calls from the sandbox.
 * Returns a value for async calls (resolved via api-response),
 * or void/undefined for fire-and-forget calls.
 */
export type ApiHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;

/**
 * Handler for streaming API calls (e.g. LLM completions).
 * Called when a `stream-*` callId is received. The handler should stream
 * deltas back via the provided callbacks.
 */
export type StreamHandler = (
  method: string,
  args: unknown[],
  callbacks: {
    onDelta: (text: string) => void;
    onDone: (fullText: string) => void;
    onError: (error: string) => void;
  },
) => void;

/**
 * Parent-side bridge for communicating with the sandbox iframe.
 * Manages the iframe lifecycle, sends state updates, and dispatches
 * API calls from sandboxed components to the parent's Zustand stores.
 */
export class SandboxBridge {
  private iframe: HTMLIFrameElement | null = null;
  private ready = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private messageQueue: ParentMessage[] = [];
  private onApiCall: ApiHandler;
  private onStreamCall: StreamHandler;
  private onResize: (height: number) => void;
  private onError: (message: string) => void;
  private onRendered: () => void;
  private onDiag: (event: string, data: Record<string, string | number | boolean>) => void;
  private onComposerDraft: (text: string) => void;
  private onPlayInteraction: () => void;
  private boundListener: (event: MessageEvent) => void;
  private transcriptScope: { accountId: string; sessionId: string } | null = null;

  constructor(opts: {
    onApiCall: ApiHandler;
    onStreamCall?: StreamHandler;
    onResize?: (height: number) => void;
    onError?: (message: string) => void;
    /** Fired when the sandbox reports the world has painted its first frame. */
    onRendered?: () => void;
    /** Sandbox self-diagnostics (e.g. scroll-clamp corrections) for analytics. */
    onDiag?: (event: string, data: Record<string, string | number | boolean>) => void;
    /** The composer's unsent text, mirrored out of the iframe. Carries user
     *  content — for the reload guard and draft persistence only, never analytics. */
    onComposerDraft?: (text: string) => void;
    onPlayInteraction?: () => void;
  }) {
    this.onApiCall = opts.onApiCall;
    this.onStreamCall = opts.onStreamCall ?? (() => {});
    this.onResize = opts.onResize ?? (() => {});
    this.onError = opts.onError ?? (() => {});
    this.onRendered = opts.onRendered ?? (() => {});
    this.onDiag = opts.onDiag ?? (() => {});
    this.onComposerDraft = opts.onComposerDraft ?? (() => {});
    this.onPlayInteraction = opts.onPlayInteraction ?? (() => {});
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.boundListener = this.handleMessage.bind(this);
    window.addEventListener("message", this.boundListener);
  }

  /** Attach an already-created iframe to this bridge */
  attach(iframe: HTMLIFrameElement): void {
    this.iframe = iframe;
  }

  /** Send a message to the sandbox, queuing if not ready */
  send(msg: ParentMessage): void {
    if (!this.ready || !this.iframe?.contentWindow) {
      this.messageQueue.push(msg);
      return;
    }
    // targetOrigin MUST stay "*": the iframe's origin is opaque
    // (allow-scripts without allow-same-origin), so no concrete origin can
    // ever match it and anything stricter silently drops every message.
    // Safety in this direction comes from addressing the exact contentWindow;
    // inbound messages are what get origin-validated (handleMessage).
    safePostMessage(this.iframe.contentWindow, wrapMessage(msg), "*");
  }

  /** Wait for the sandbox to signal readiness */
  waitReady(): Promise<void> {
    return this.readyPromise;
  }

  /** Push theme CSS variables to the sandbox */
  pushTheme(cssVars: Record<string, string>): void {
    this.send({ type: "theme", cssVars });
  }

  /** Install the world's root component (multi-file).
   *  Pass `compiledCode` to skip bundling/Sucrase inside the sandbox. Falls back to
   *  files+entryFile when absent (legacy path, pulls the bundler chunk dynamically). */
  installRoot(
    entryFile: string,
    files: Record<string, string>,
    compiledCode?: string,
    compileError?: string,
    mode?: SandboxMode,
  ): void {
    this.send({ type: "install-root", entryFile, files, compiledCode, compileError, mode });
  }

  /** Push a single state channel update */
  pushChannel<C extends StateChannel>(
    channel: C,
    data: ChannelDataMap[C],
    version: number,
  ): void {
    this.send({ type: "channel", channel, data, version });
  }

  /** Tell the sandbox to pause all raw `<video>`/`<audio>` tags. Called when the
   *  parent hides the iframe without unmounting it. */
  setMediaSuspended(suspended: boolean): void {
    this.send({ type: "suspend-media", suspended });
  }

  restoreTranscriptPosition(accountId: string, sessionId: string): void {
    this.transcriptScope = { accountId, sessionId };
    const position = loadTranscriptPosition(accountId, sessionId);
    if (position) this.send({ type: "restore-transcript-position", position });
  }

  /** Tell the sandbox a parent-side SDK audio track finished, so creator code
   *  subscribed via `api.onAudioEnded` can react (e.g. play the next track). */
  sendAudioEnded(trackId: string): void {
    this.send({ type: "audio-event", event: "ended", trackId });
  }

  /** Put a draft this tab typed before a reload back into the composer. */
  restoreComposerDraft(text: string): void {
    this.send({ type: "restore-composer-draft", text });
  }

  /** Relay a multiplayer frame from the parent-held game WebSocket. */
  sendRoomFrame(frame: Record<string, unknown>): void {
    this.send({ type: "room-frame", frame });
  }

  /** Ask the sandbox to open the session-memory panel (play-controls bar
   *  fallback for worlds whose custom UI has no Memory pill). */
  openMemoryPanel(): void {
    this.send({ type: "open-memory-panel" });
  }

  /** Cleanup */
  destroy(): void {
    window.removeEventListener("message", this.boundListener);
    this.iframe = null;
    this.ready = false;
    this.messageQueue = [];
  }

  private handleMessage(event: MessageEvent): void {
    // Only process messages from OUR iframe's window. Requiring the iframe to
    // be attached also closes the pre-attach window where the old
    // `this.iframe && …` form let arbitrary messages through unvalidated.
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    // And only with the origin an opaque-origin sandbox can legitimately have.
    if (!SANDBOX_EXPECTED_ORIGINS.has(event.origin)) return;

    const msg = unwrapMessage<SandboxMessage>(event.data);
    if (!msg) return;

    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.resolveReady();
        this.flushQueue();
        break;

      case "rendered":
        this.onRendered();
        break;

      case "api-call": {
        // Streaming calls (LLM completions) — route to stream handler
        if (msg.callId.startsWith("stream-")) {
          this.onStreamCall(msg.method, msg.args, {
            onDelta: (text) => {
              this.send({
                type: "api-stream",
                callId: msg.callId,
                delta: text,
                done: false,
              });
            },
            onDone: (fullText) => {
              this.send({
                type: "api-stream",
                callId: msg.callId,
                delta: "",
                done: true,
                result: fullText,
              });
            },
            onError: (error) => {
              this.send({
                type: "api-stream",
                callId: msg.callId,
                delta: "",
                done: true,
                result: `[Error: ${error}]`,
              });
            },
          });
          break;
        }

        const result = this.onApiCall(msg.method, msg.args);
        // Send api-response for async calls (both SDK "async-" and compat shim "shim-")
        // Fire-and-forget calls (prefixed "fire-" or "shim-fire-") don't need a response
        const needsResponse =
          !msg.callId.includes("fire") && result !== undefined;
        if (needsResponse) {
          Promise.resolve(result).then((resolved) => {
            this.send({
              type: "api-response",
              callId: msg.callId,
              result: resolved,
            });
          });
        }
        break;
      }

      case "game-event":
        this.onApiCall("emitEvent", [msg.event]);
        break;

      case "resize":
        this.onResize(msg.height);
        break;

      case "component-error":
        this.onError(msg.message);
        break;

      case "diag":
        this.onDiag(msg.event, msg.data ?? {});
        break;

      case "play-interaction":
        this.onPlayInteraction();
        break;
      case "composer-draft":
        this.onComposerDraft(msg.text);
        break;

      case "transcript-position":
        if (this.transcriptScope && isTranscriptPosition(msg.position) &&
            msg.position.sessionId === this.transcriptScope.sessionId) {
          saveTranscriptPosition(this.transcriptScope.accountId, msg.position);
        }
        break;
    }
  }

  private flushQueue(): void {
    for (const msg of this.messageQueue) {
      this.send(msg);
    }
    this.messageQueue = [];
  }
}
