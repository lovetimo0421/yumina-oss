import { composeVoiceInstructions, voiceStartContextError, formatVoiceSceneReaction, isVoiceSceneReaction, isVoiceToolAllowlist, type VoiceAPI, type VoiceEvent, type VoicePose, type VoiceToolName } from "../../../sandbox/voice-types";
import type { AvatarAudio, AvatarAudioOptions, AvatarConnection } from "./avatar-voice-audio";
import { VoiceActivityWindow, VoiceQuietWindow, INPUT_SETTLEMENT_TIMEOUT_MS, INPUT_REFERENCE_WAIT_MS, OUTPUT_ECHO_TAIL_MS, meaningfulVoiceText, overlapsVoiceReference } from "./voice-interruption";
import { policeSceneAuthority } from "./voice-scene-notice";
import { LiveVoiceSession } from "./live-voice-session";
import { LiveVoiceContext } from './live-voice-context';
import { copyVoiceContext, isVoiceContext, voiceContextText, type VoiceContext } from '../../../sandbox/voice-context';

export interface VoiceConfig { turnControl?: "client-v1"; liveModel?: "gpt-live-1"; available: boolean; funding: "byok" | "testing" | "private-pilot" | null; maxDurationSeconds: number; avatarAvailable?: boolean; avatarRequested?: boolean }

export interface VoiceAudio {
  /** Bounded output unlock acknowledgement; optional for injected legacy adapters. */
  ready?(timeoutMs?: number): Promise<void>;
  attachInput(stream: MediaStream): void;
  attach(stream: MediaStream): void | Promise<void>;
  setMuted(muted: boolean): void;
  setSpatial(pose: VoicePose): void;
  close(): void;
}

export interface VoiceDependencies {
  /** Monotonic milliseconds; injectable for deterministic activity/deadline tests. */
  now?(): number;
  sessionId: string;
  canUse(): boolean;
  /** Host-owned activation, never a world-supplied boolean. */
  hasUserActivation?(): boolean;
  intentTimeoutMs?: number;
  /** prepareAudio must run in the host's affirmative click to unlock Web Audio. */
  requestConsent(signal: AbortSignal, prepareAudio: () => void, config: VoiceConfig): Promise<boolean>;
  getUserMedia(): Promise<MediaStream>;
  createPeer(): RTCPeerConnection;
  createAudio(onLevel: (value: number) => void, onInputLevel: (value: number) => void): VoiceAudio;
  createAvatarAudio?(onLevel: (value: number) => void, onInputLevel: (value: number) => void, options: AvatarAudioOptions): AvatarAudio;
  fetch: typeof fetch;
  apiBase?: string;
  connectTimeoutMs?: number;
  maxDurationMs?: number;
  avatarHeartbeatMs?: number;
}

type InputTurn = {
  id: string; sequence: number; epoch: number; speaking: boolean; stopped: boolean;
  committed: boolean; asr: "pending" | "completed" | "failed"; meaningful: boolean;
  confirmed: boolean; sustained: boolean; eligible: boolean; expired: boolean;
  included: boolean; reply: boolean; interrupted: boolean;
  targetRequest: string | null; targetResponse: string | null;
  activity: VoiceActivityWindow; stoppedAt?: number; timer?: ReturnType<typeof setTimeout>;
  decision: "pending" | "accepted" | "discarding" | "discarded";
  references: Set<string>; intentional: boolean; protected: boolean; quiet: VoiceQuietWindow;
  finalText?: string; referenceTimer?: ReturnType<typeof setTimeout>;
  retirementTimer?: ReturnType<typeof setTimeout>; deleteSent?: boolean;
};

type Run = {
  live?: LiveVoiceSession;
  preflightContext?: LiveVoiceContext;
  closing?: boolean;
  intent?: string;
  interruptionMode: "automatic" | "manual";
  abort: AbortController;
  promise: Promise<{ status: "connected" }>;
  timer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setTimeout>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  stream?: MediaStream;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  audio?: VoiceAudio | AvatarAudio;
  avatar: boolean;
  avatarStarting: boolean;
  avatarPending: boolean;
  ready: boolean;
  voice?: "marin" | "cedar";
  toolAllowlist?: VoiceToolName[];
  sponsored: boolean;
  privatePilot?: boolean;
  connectionId: string;
  connecting: boolean;
  playback: boolean;
  instructions: string;
  pendingInstructions: string | null;
  context: VoiceContext;
  captions: Map<string, { text: string; final: boolean }>;
  eventIds: Set<string>;
  tools: Map<string, boolean>;
  interrupting: boolean;
  responseActive: boolean;
  responseRequested: boolean;
  responseRequestId: string | null;
  responseSequence: number;
  responseOverlap: { id: string; retired: boolean } | null;
  responseRetryPending: boolean;
  responseRetryUsed: boolean;
  responseId: string | null;
  cancelledResponses: Set<string>;
  cancelledRequest: boolean;
  interruptedResponse: boolean;
  interruptedInput: string | null;
  pendingResponse: boolean;
  pendingSceneResponse: boolean;
  inputs: Map<string, InputTurn>;
  speakingInput: string | null;
  inputSequence: number;
  audibilityEpoch: number;
  outputReference: string | null;
  outputTailUntil: number;
  references: Map<string, Map<string, { text: string; final: boolean }>>;
  inputClear: { intent: boolean; timer: ReturnType<typeof setTimeout> } | null;
  takeFloor: boolean;
  sceneIds: Set<string>;
  sceneTimes: number[];
  sceneItem: { id: string; acknowledged: boolean } | null;
  sceneItems: Map<string, { id: string; acknowledged: boolean; active: boolean; followUp: boolean; bulletin: boolean; policeCurrent?: () => boolean }>;
  cancellationIds: Set<string>;
  cancellationSequence: number;
};

class VoiceFailure extends Error {}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundedString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const identifier = (value: unknown): value is string => boundedString(value, 160) && /^[\w:-]+$/.test(value);
const focus = (value: unknown) => value === "desk" || value === "door" || value === "bed";
const stopTracks = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop());

function safeFailure(error: unknown): VoiceFailure {
  if (error instanceof VoiceFailure) return error;
  if (record(error) && error.name === "NotAllowedError") return new VoiceFailure("Microphone access is blocked. Allow it in this site's browser permissions. If it is already allowed, check your computer's microphone privacy settings, then try again.");
  if (record(error) && error.name === "NotFoundError") return new VoiceFailure("No microphone was found. You can continue without voice.");
  if (record(error) && error.name === "NotReadableError") return new VoiceFailure("The microphone could not open. Check your selected input device and whether another app is using it, then try again.");
  return new VoiceFailure("Voice could not connect. You can continue without voice or try again.");
}

function serverFailure(code: unknown, funding?: unknown): VoiceFailure {
  if (code === "UNAUTHORIZED") return new VoiceFailure("Sign in to use live voice.");
  if (code === "VOICE_FORBIDDEN") return new VoiceFailure("Live voice is unavailable for this account.");
  if (code === "VOICE_CONNECTION_PENDING") return new VoiceFailure(funding === "private-pilot"
    ? "The previous private voice call is still closing. Continue in text and try again later."
    : "A live voice call is already active. Stop it before starting another.");
  if (funding === "private-pilot" && code === "VOICE_DAILY_LIMIT") return new VoiceFailure("This private voice test has used its two daily attempts. Try tomorrow or continue in text.");
  if (funding === "private-pilot" && (code === "OPENAI_KEY_REQUIRED" || code === "OPENAI_KEY_REJECTED")) return new VoiceFailure("The private voice test is temporarily unavailable. Continue in text or try again later.");
  if (code === "VOICE_DAILY_LIMIT") return new VoiceFailure("Sponsored testing voice has reached its daily limit. Try tomorrow or add your own OpenAI key in Settings.");
  if (code === "OPENAI_KEY_REQUIRED") return new VoiceFailure("Add your own OpenAI API key in Settings to use live voice.");
  if (code === "VOICE_RATE_LIMITED" || code === "VOICE_PROVIDER_RATE_LIMITED") return new VoiceFailure("Please wait a minute before starting voice again.");
  if (code === "OPENAI_KEY_REJECTED") return new VoiceFailure("OpenAI could not use your API key. Check your key and account in Settings.");
  if (funding === "private-pilot") return new VoiceFailure("The private voice test could not connect. Continue in text or try again later.");
  return new VoiceFailure("Voice could not connect. Check your OpenAI key and try again, or continue without voice.");
}

/** A single capture epoch. Every async continuation is fenced by its run identity. */
export class VoiceController {
  private run: Run | null = null;
  private prepared: Run | null = null;
  private muted = { input: false, output: false };
  private pose: VoicePose = { x: 0, z: 0, yaw: 0, sourceX: 0, sourceZ: -1 };

  constructor(private readonly emit: (event: VoiceEvent) => void, private readonly deps: VoiceDependencies) {}

  start(options: unknown): Promise<{ status: "connected" }> {
    if (!this.deps.canUse() || !this.deps.sessionId) return this.rejectStart("Voice is unavailable in this view.");
    if (!record(options) || !boundedString(options.instructions, 12_000) || !options.instructions.trim()) return this.rejectStart("Voice instructions must contain 1–12,000 characters.");
    const contextError = voiceStartContextError(options.instructions, options.context);
    if (contextError) return this.rejectStart(contextError);
    if (options.voice !== undefined && options.voice !== "marin" && options.voice !== "cedar") return this.rejectStart("Choose the marin or cedar voice.");
    if (options.avatar !== undefined && typeof options.avatar !== "boolean") return this.rejectStart("Invalid avatar video option.");
    if (options.tools !== undefined && !isVoiceToolAllowlist(options.tools)) return this.rejectStart("Invalid voice tool allowlist.");
    if (options.interruptionMode !== undefined && options.interruptionMode !== "automatic" && options.interruptionMode !== "manual") return this.rejectStart("Invalid voice interruption mode.");
    if (this.run) return this.run.promise;
    if (options.intent !== undefined && (typeof options.intent !== "string" || !this.prepared || this.prepared.intent !== options.intent || this.prepared.avatar !== (options.avatar === true))) {
      return this.rejectStart("The microphone action expired. Click Start voice again.");
    }
    const run = options.intent !== undefined ? this.prepared! : this.newRun({ instructions: options.instructions, avatar: options.avatar, voice: options.voice, tools: options.tools });
    if (this.prepared && this.prepared !== run) this.cleanup(this.prepared, new VoiceFailure("Voice stopped."));
    this.prepared = null;
    clearTimeout(run.timer);
    run.instructions = options.instructions; run.context = copyVoiceContext((options.context ?? "") as VoiceContext); run.voice = options.voice;
    run.toolAllowlist = options.tools === undefined ? undefined : [...options.tools];
    if (run.avatar && run.toolAllowlist?.length === 0) run.preflightContext = new LiveVoiceContext(run.context);
    run.interruptionMode = options.interruptionMode ?? "automatic";
    this.run = run;
    this.emit({ type: "status", status: "connecting", message: "Preparing call" });
    // Consent is bounded separately from the network negotiation.
    run.timer = setTimeout(() => this.fail(run, new VoiceFailure("Voice consent timed out. Start voice again when ready.")), 120_000);
    run.promise = this.connect(run).catch(error => {
      const safe = safeFailure(error);
      if (this.run === run) this.fail(run, safe);
      throw safe;
    });
    return run.promise;
  }

  /** Reserve a single start through asynchronous context/save work. No capture or network. */
  async prepare(options: unknown): Promise<{ intent: string }> {
    if (!this.deps.canUse() || !this.deps.sessionId || !this.deps.hasUserActivation?.()) throw new VoiceFailure("Click a voice control to start the microphone.");
    if (!record(options) || (options.avatar !== undefined && typeof options.avatar !== "boolean")) throw new VoiceFailure("Invalid avatar video option.");
    if (this.run) throw new VoiceFailure("A voice call is already active.");
    if (this.prepared) this.cleanup(this.prepared, new VoiceFailure("Voice action replaced."));
    const run = this.newRun({ instructions: "", avatar: options.avatar === true });
    run.intent = crypto.randomUUID(); this.prepared = run;
    try { this.prepareAudio(run); }
    catch (error) { this.cleanup(run, safeFailure(error)); throw safeFailure(error); }
    run.timer = setTimeout(() => this.fail(run, new VoiceFailure("The microphone action expired. Click Start voice again.")), this.deps.intentTimeoutMs ?? 60_000);
    return { intent: run.intent };
  }

  private newRun(options: { instructions: string; avatar?: boolean; voice?: "marin" | "cedar"; tools?: VoiceToolName[] }): Run {
    return {
      interruptionMode: "automatic",
      abort: new AbortController(), promise: null!, ready: false, voice: options.voice, connectionId: crypto.randomUUID(), sponsored: false, connecting: false, playback: false,
      instructions: options.instructions, pendingInstructions: null, context: "", captions: new Map(), eventIds: new Set(), tools: new Map(), interrupting: false, responseActive: false, responseRequested: false, pendingResponse: false,
      pendingSceneResponse: false, inputs: new Map(), speakingInput: null, inputSequence: 0, audibilityEpoch: 0, sceneIds: new Set(), sceneTimes: [], sceneItem: null, sceneItems: new Map(),
      cancellationIds: new Set(), cancellationSequence: 0,
      outputReference: null, outputTailUntil: -Infinity, references: new Map(), inputClear: null, takeFloor: false,
      responseId: null, cancelledResponses: new Set(), cancelledRequest: false, interruptedResponse: false, interruptedInput: null,
      responseRequestId: null, responseSequence: 0,
      responseOverlap: null, responseRetryPending: false, responseRetryUsed: false,
      avatar: options.avatar === true, avatarStarting: false, avatarPending: false,
      toolAllowlist: options.tools === undefined ? undefined : [...options.tools],
    };
  }

  private rejectStart(message: string): Promise<never> {
    this.emit({ type: "status", status: "error", message });
    return Promise.reject(new VoiceFailure(message));
  }

  private current(run: Run): boolean { return (this.run === run || this.prepared === run) && !run.abort.signal.aborted; }
  private check(run: Run): void {
    if (!this.current(run)) throw new VoiceFailure("Voice stopped.");
    if (!this.deps.canUse()) throw new VoiceFailure("Voice is unavailable in this view.");
  }

  /** Reject immediately on cancellation even for non-abortable browser permission prompts. */
  private wait<T>(run: Run, promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const signal = run.abort.signal;
      const abort = () => reject(signal.reason ?? new VoiceFailure("Voice stopped."));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private prepareAudio(run: Run): void {
    this.check(run);
    const outputLevel = (value: number) => {
      if (this.current(run) && run.ready) this.emit({ type: "level", value: this.muted.output ? 0 : Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) });
    };
    const inputLevel = (value: number) => {
      if (!this.current(run) || !run.ready) return;
      this.emit({ type: "input-level", value: this.muted.input ? 0 : Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) });
      if (run.live) { run.live.inputLevel(this.muted.input ? 0 : value); return; }
      const input = run.speakingInput ? run.inputs.get(run.speakingInput) : undefined;
      if (input && !this.deps.canUse()) input.eligible = false;
      if (input?.protected && input.decision === "pending") {
        if (!this.deps.canUse() || this.muted.input || this.muted.output || input.epoch !== run.audibilityEpoch) return;
        if (input.quiet.sample(this.now(), value)) {
          const clear = !input.committed;
          this.discardInput(run, input, false);
          if (clear) this.clearInputBuffer(run, false);
        }
        return;
      }
      if (input && this.inputEligible(run, input)) {
        this.markOverlap(run, input);
        // Energy can schedule idle native input; pending output needs final words.
        if (input.activity.sample(this.now(), value) && !input.references.size
          && !this.hasActiveGeneration(run) && !run.playback && !run.avatarPending) this.confirmInput(run, input, true);
        if (!input.confirmed && input.quiet.sample(this.now(), value)) {
          const clear = !input.committed;
          this.discardInput(run, input);
          if (clear) this.clearInputBuffer(run, false);
        }
      }
    };
    run.audio ??= run.avatar ? this.deps.createAvatarAudio!(outputLevel, inputLevel, {
      signal: run.abort.signal,
      onPending: () => {
        if (!this.current(run) || run.interruptedResponse || this.muted.output) return;
        if (run.live) { run.live.avatarPending(); return; }
        run.avatarPending = true;
        if (run.interruptionMode === "manual") for (const input of run.inputs.values()) this.markOverlap(run, input);
        this.emitActivity(run);
      },
      onSourceActivity: active => { if (this.current(run)) run.live?.sourceActivity(active); },
      onQueue: count => { if (this.current(run)) run.live?.avatarQueue(count); },
      onPlayback: state => { if (this.current(run)) { if (run.live) run.live.playback(state); else this.playback(run, state); } },
      onVideoFrame: ({ id, frame }) => {
        if (!this.current(run) || !this.deps.canUse()) { frame.close(); return; }
        this.emit({ type: "video-frame", id, frame });
      },
      onVideoStatus: (status, message) => { if (this.current(run)) this.emit({ type: "video-status", status, message }); },
      onError: message => this.fail(run, new VoiceFailure(message)),
    }) : this.deps.createAudio(outputLevel, inputLevel);
    run.audio.setMuted(this.muted.output);
    run.audio.setSpatial(this.pose);
  }

  private async connect(run: Run): Promise<{ status: "connected" }> {
    const preflight = await this.wait(run, this.deps.fetch(`${this.deps.apiBase ?? ""}/api/voice/${encodeURIComponent(this.deps.sessionId)}/config`, {
      credentials: "include", signal: run.abort.signal,
    }));
    const config: unknown = await this.wait(run, preflight.json()); this.check(run);
    if (!preflight.ok) throw serverFailure(record(config) ? config.code : undefined);
    if (!record(config) || config.available !== true) throw serverFailure("OPENAI_KEY_REQUIRED");
    if ((config.funding !== "byok" && config.funding !== "testing" && config.funding !== "private-pilot") || config.maxDurationSeconds !== 300) throw new VoiceFailure("Voice configuration is unavailable. Please try again.");
    if (config.turnControl !== "client-v1") throw new VoiceFailure("Voice turn control is incompatible. Refresh the page and try again.");
    if (run.avatar && (config.avatarAvailable !== true || !this.deps.createAvatarAudio)) throw new VoiceFailure("Live telescreen video is unavailable. Please try again when the avatar service is ready.");
    run.sponsored = config.funding === "testing" || config.funding === "private-pilot";
    run.privatePilot = config.funding === "private-pilot";
    // The host explicitly enables this migration. Other worlds and tool-using
    // voice sessions retain their negotiated Realtime protocol.
    if (config.liveModel === "gpt-live-1" && run.avatar && run.toolAllowlist?.length === 0) {
      run.instructions = run.pendingInstructions ?? run.instructions; run.pendingInstructions = null;
      run.live = new LiveVoiceSession({
        send: event => this.send(run, event),
        emit: event => { if (this.current(run)) this.emit(event); },
        input: enabled => run.stream?.getAudioTracks().forEach(track => { track.enabled = enabled; }),
        holdAudio: held => (run.audio as AvatarAudio | undefined)?.handleClientEvent({ type: 'live.hold', held }),
        interruptAudio: () => (run.audio as AvatarAudio | undefined)?.handleClientEvent({ type: "live.interrupt" }),
        fail: message => this.fail(run, new VoiceFailure(message)),
      }, run.instructions, run.context, run.interruptionMode, run.preflightContext);
    }
    run.preflightContext = undefined;
    if (!run.intent) this.emit({ type: "status", status: "connecting", message: "Confirm microphone" });
    const consent = run.intent ? true : await this.wait(run, this.deps.requestConsent(run.abort.signal, () => this.prepareAudio(run), { ...config, avatarRequested: run.avatar } as unknown as VoiceConfig));
    this.check(run);
    if (!consent) { this.stop(); throw new VoiceFailure("Live voice was declined. You can continue without a microphone."); }
    this.prepareAudio(run);
    try { if (run.audio?.ready) await this.wait(run, run.audio.ready()); }
    catch (error) {
      this.check(run);
      throw new VoiceFailure("The voice speaker could not start. Click Start voice again to unlock audio.");
    }
    this.check(run);
    if (run.live) (run.audio as AvatarAudio).handleClientEvent({ type: "live.enable" });
    clearTimeout(run.timer);
    run.timer = setTimeout(() => this.fail(run, new VoiceFailure("Voice connection timed out. You can continue without voice.")), this.deps.connectTimeoutMs ?? (run.avatar ? 65_000 : 35_000));
    this.emit({ type: "status", status: "connecting", message: "Allow microphone" });
    const pendingMedia = this.deps.getUserMedia();
    // A permission prompt can resolve after stop. It must never leave a live track.
    void pendingMedia.then(stream => { if (!this.current(run)) stopTracks(stream); }, () => {});
    run.stream = await this.wait(run, pendingMedia);
    this.check(run);
    const microphoneTracks = run.stream.getAudioTracks();
    const microphoneEnded = () => this.fail(run, new VoiceFailure("Your microphone disconnected or its permission was revoked. Start voice again or continue without a microphone."));
    for (const track of microphoneTracks) track.onended = microphoneEnded;
    // Capture can end before the promise settles; registering a handler alone
    // would miss that event. Transient track mute is not permanent termination.
    if (microphoneTracks.some(track => track.readyState === "ended")) {
      throw new VoiceFailure("Your microphone disconnected or its permission was revoked. Start voice again or continue without a microphone.");
    }
    for (const track of microphoneTracks) {
      // Probe the actual captured track, not generic supported-constraint flags.
      // Rejection leaves the original getUserMedia echoCancellation:true intact.
      try {
        const modes: unknown = track.getCapabilities?.().echoCancellation;
        if (Array.isArray(modes) && modes.includes("all")) {
          await this.wait(run, track.applyConstraints({ echoCancellation: { exact: "all" } } as unknown as MediaTrackConstraints));
        }
      } catch { this.check(run); }
      this.check(run);
      let selected: unknown;
      try { selected = track.getSettings?.().echoCancellation; } catch { /* Diagnostics must not prevent capture. */ }
      this.emit({ type: "capture-settings", echoCancellation: typeof selected === "boolean" || selected === "all" || selected === "remote-only" ? selected : "unknown" });
    }
    run.audio?.attachInput(run.stream);
    if (run.avatar) {
      this.emit({ type: "status", status: "connecting", message: "Connecting video" });
      await this.connectAvatar(run);
    }
    this.check(run);
    this.emit({ type: "status", status: "connecting", message: "Connecting voice" });
    const peer = this.deps.createPeer();
    run.peer = peer;
    for (const track of run.stream.getAudioTracks()) { track.enabled = !this.muted.input; peer.addTrack(track, run.stream); }
    peer.ontrack = event => {
      if (!this.current(run)) return;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      try {
        void Promise.resolve(run.audio?.attach(stream)).catch(() => {
          if (this.current(run)) this.fail(run, new VoiceFailure("The voice speaker could not play. Start voice again to enable sound."));
        });
      } catch {
        this.fail(run, new VoiceFailure("The voice speaker could not play. Start voice again to enable sound."));
      }
    };
    peer.onconnectionstatechange = () => {
      if (!this.current(run)) return;
      if (peer.connectionState === 'disconnected') {
        // ICE may recover on the existing connection after a brief network gap.
        if (!run.reconnectTimer) run.reconnectTimer = setTimeout(() => {
          run.reconnectTimer = undefined;
          if (this.current(run) && peer.connectionState === 'disconnected') this.fail(run, new VoiceFailure('Voice could not reconnect. Start voice again.'));
        }, 8000);
      } else {
        clearTimeout(run.reconnectTimer); run.reconnectTimer = undefined;
        if (["failed", "closed"].includes(peer.connectionState)) this.fail(run, new VoiceFailure("Voice disconnected. Start voice again or continue without a microphone."));
      }
    };
    const channel = peer.createDataChannel("oai-events", { ordered: true });
    run.channel = channel;
    const opened = new Promise<void>(resolve => { channel.onopen = () => resolve(); });
    channel.onclose = channel.onerror = () => { if (this.current(run)) this.fail(run, new VoiceFailure("Voice disconnected. Start voice again or continue without a microphone.")); };
    channel.onmessage = event => { if (this.current(run)) this.receive(run, event.data); };
    const offer = await this.wait(run, peer.createOffer()); this.check(run);
    await this.wait(run, peer.setLocalDescription(offer)); this.check(run);
    run.connecting = true;
    const startupContext = copyVoiceContext(run.context);
    run.live?.setStartupContext(startupContext);
    const startupInstructions = run.instructions;
    run.live?.setStartupInstructions(startupInstructions);
    this.check(run);
    const response = await this.wait(run, this.deps.fetch(`${this.deps.apiBase ?? ""}/api/voice/${encodeURIComponent(this.deps.sessionId)}/connect`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-Voice-Connection-Id": run.connectionId },
      body: JSON.stringify({ turnControl: run.live ? "live-v1" : "client-v1", sdp: offer.sdp, instructions: composeVoiceInstructions(startupInstructions, startupContext), voice: run.voice, tools: run.toolAllowlist }), signal: run.abort.signal,
    }));
    this.check(run);
    const result: unknown = await this.wait(run, response.json()); this.check(run);
    if (!response.ok) throw serverFailure(record(result) ? result.code : undefined, config.funding);
    if (!record(result) || !boundedString(result.sdp, 65_536) || !result.sdp.startsWith("v=0")) throw new VoiceFailure("Voice returned an invalid connection. Please try again.");
    if (result.turnControl !== (run.live ? "live-v1" : "client-v1")) throw new VoiceFailure("Voice turn control is incompatible. Refresh the page and try again.");
    await this.wait(run, peer.setRemoteDescription({ type: "answer", sdp: result.sdp })); this.check(run);
    if (channel.readyState !== "open") await this.wait(run, opened);
    if (run.live) await this.wait(run, run.live.ready);
    this.check(run); clearTimeout(run.timer); run.ready = true;
    run.timer = setTimeout(() => {
      if (!this.current(run)) return;
      this.cleanup(run, new VoiceFailure("Voice stopped."));
      this.emit({ type: "level", value: 0 });
      this.emit({ type: "status", status: "stopped", message: "Voice reached its five-minute limit. Start voice again to continue." });
    }, this.deps.maxDurationMs ?? 300_000);
    if (!run.live && !this.flushInstructions(run) && run.context) this.sendContext(run);
    if (this.muted.input || this.muted.output) this.applyMute(run);
    this.check(run);
    this.emit({ type: "status", status: "connected" });
    this.emit({ type: "activity", status: "listening" });
    if (run.live) { run.live.setMuted(this.muted); if (!this.muted.output) run.live.start(); }
    else if (!this.muted.output) this.requestResponse(run);
    this.check(run);
    return { status: "connected" };
  }

  stop(): void {
    if (!this.run && !this.prepared) return;
    if (this.prepared) this.cleanup(this.prepared, new VoiceFailure("Voice stopped."));
    if (this.run) this.cleanup(this.run, new VoiceFailure("Voice stopped."));
    this.emit({ type: "level", value: 0 }); this.emit({ type: "status", status: "stopped" });
  }

  private fail(run: Run, error: VoiceFailure): void {
    if (!this.current(run)) return;
    this.cleanup(run, error);
    this.emit({ type: "level", value: 0 }); this.emit({ type: "status", status: "error", message: error.message });
  }

  private cleanup(run: Run, reason: Error): void {
    if (run.closing) return;
    run.closing = true;
    run.live?.close();
    if (this.run === run) this.emit({ type: "activity", status: "listening" });
    if (this.run === run) this.run = null;
    if (this.prepared === run) this.prepared = null;
    clearTimeout(run.timer); clearTimeout(run.heartbeat); clearTimeout(run.reconnectTimer); run.abort.abort(reason);
    for (const input of run.inputs.values()) { clearTimeout(input.timer); clearTimeout(input.referenceTimer); clearTimeout(input.retirementTimer); }
    if (run.inputClear) clearTimeout(run.inputClear.timer);
    run.inputs.clear(); run.speakingInput = null;
    if (run.avatarStarting) {
      void this.deps.fetch(`${this.deps.apiBase ?? ""}/api/voice/${encodeURIComponent(this.deps.sessionId)}/avatar/stop`, {
        method: "POST", credentials: "include", keepalive: true, headers: { "X-Voice-Connection-Id": run.connectionId },
      }).catch(() => {});
      this.emit({ type: "video-status", status: "stopped" });
    }
    if (run.privatePilot && !run.live && run.connecting) {
      this.emit({ type: "input-level", value: 0 });
      this.closePrivatePilotTransport(run);
    }
    else {
      if ((run.sponsored || run.live) && run.connecting) void this.deps.fetch(`${this.deps.apiBase ?? ""}/api/voice/${encodeURIComponent(this.deps.sessionId)}/stop`, {
        method: "POST", credentials: "include", keepalive: true, headers: { "X-Voice-Connection-Id": run.connectionId },
      }).catch(() => {});
      this.emit({ type: "input-level", value: 0 });
      if (run.channel) {
        run.channel.onmessage = run.channel.onopen = run.channel.onclose = run.channel.onerror = null;
        run.channel.close();
      }
      if (run.peer) { run.peer.ontrack = run.peer.onconnectionstatechange = null; run.peer.close(); }
      if (run.stream) {
        for (const track of run.stream.getAudioTracks()) track.onended = null;
        stopTracks(run.stream);
      }
      run.audio?.close();
    }
    run.captions.clear(); run.tools.clear(); run.eventIds.clear(); run.cancellationIds.clear(); run.sceneIds.clear(); run.sceneItems.clear(); run.sceneTimes.length = 0;
  }

  private closePrivatePilotTransport(run: Run): void {
    const { channel, peer } = run;
    if (channel) channel.onmessage = channel.onopen = channel.onclose = channel.onerror = null;
    if (peer) peer.ontrack = peer.onconnectionstatechange = null;
    if (run.stream) {
      for (const track of run.stream.getAudioTracks()) { track.onended = null; track.enabled = false; }
      stopTracks(run.stream);
    }
    run.audio?.close();
    // Keep only the inert transport while the server attempts hangup. This
    // reduces the peer-close race; it does not prove provider cleanup succeeded.
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(deadline); channel?.close(); peer?.close();
    };
    // Three 4s provider attempts plus the 1.5s accounting drain and 0.5s margin.
    const deadline = setTimeout(close, 14_000);
    try {
      void this.deps.fetch(`${this.deps.apiBase ?? ""}/api/voice/${encodeURIComponent(this.deps.sessionId)}/stop`, {
        method: "POST", credentials: "include", keepalive: true, headers: { "X-Voice-Connection-Id": run.connectionId },
      }).then(close, close);
    } catch { close(); }
  }

  private send(run: Run, event: object): void {
    if (!this.current(run) || run.channel?.readyState !== "open") return;
    try {
      run.channel.send(JSON.stringify(event));
      // Local avatar clearing can synchronously release a queued response. The
      // provider must receive this clear before that new response.create.
      if (run.avatar) (run.audio as AvatarAudio | undefined)?.handleClientEvent(event as Record<string, unknown>);
    }
    catch { this.fail(run, new VoiceFailure("Voice disconnected. Start voice again or continue without a microphone.")); }
  }

  private requestResponse(run: Run, scene = false, retry = false): void {
    this.prunePoliceScenes(run);
    if (!this.current(run) || !run.ready || !this.deps.canUse() || this.muted.output) return;
    if (this.hasActiveGeneration(run) || this.inputBlocked(run) || run.avatarPending || run.playback) {
      if (scene) run.pendingSceneResponse = true;
      else run.pendingResponse = true;
      this.emitActivity(run);
      return;
    }
    this.flushInstructions(run);
    if (!retry) { run.pendingResponse = false; run.pendingSceneResponse = false; }
    run.responseActive = true; run.responseRequested = true;
    if (run.interruptionMode === "manual") run.takeFloor = false;
    run.responseId = null; run.interruptedResponse = false;
    run.responseRequestId = `voice-response-${++run.responseSequence}`;
    run.responseOverlap = null; run.responseRetryPending = false; run.responseRetryUsed = retry;
    if (!retry) {
      for (const item of run.sceneItems.values()) item.active = true;
      for (const input of run.inputs.values()) if (input.committed) { input.included = true; input.reply = false; }
    }
    if (run.interruptionMode === "manual") for (const input of run.inputs.values()) this.markOverlap(run, input);
    this.send(run, { type: "response.create", event_id: run.responseRequestId, response: { metadata: { yumina_request_id: run.responseRequestId } } });
    this.emitActivity(run);
  }

  private flushResponse(run: Run): void {
    this.prunePoliceScenes(run);
    if (this.retryInterruptedResponse(run)) return;
    this.flushInstructions(run);
    const pendingInput = [...run.inputs.values()].some(input => input.reply && this.inputEligible(run, input) && input.committed && !input.included);
    // Do not turn a scene-only queue into generic response work while audio
    // drains: host authority may withdraw that scene before playback stops.
    if ((run.pendingResponse || run.pendingSceneResponse || pendingInput)
      && !this.hasActiveGeneration(run) && !run.playback && !run.avatarPending && !this.inputBlocked(run)) this.requestResponse(run);
  }

  private emitActivity(run: Run, idle: "listening" | "thinking" = "listening"): void {
    if (!this.current(run) || !run.ready) return;
    // Provider retirement and output ownership differ after cancellation. Keep
    // the former as a scheduling fence without advertising a cancelled utterance.
    const output = !this.muted.output && !run.interruptedResponse;
    this.emit({ type: "activity", status: output && run.playback ? "speaking"
      : output && (run.responseActive || run.responseRequested || run.avatarPending) ? "thinking" : idle });
  }

  private hasActiveGeneration(run: Run): boolean {
    // Abandoning a rejected request does not retire the provider generation
    // that rejected it. Keep that independent ownership gate until its done.
    return run.responseActive || run.responseOverlap?.retired === false;
  }

  private discardRejectedRequest(run: Run): void {
    run.responseActive = false; run.responseRequested = false; run.responseRequestId = null;
    run.responseRetryPending = false; run.cancelledRequest = false;
    this.emitActivity(run);
  }

  private retryInterruptedResponse(run: Run): boolean {
    if (!run.responseRetryPending || !run.responseOverlap?.retired || !this.current(run) || !this.deps.canUse() || this.muted.output
      || this.inputBlocked(run) || run.avatarPending || run.playback) return false;
    this.discardRejectedRequest(run);
    this.requestResponse(run, false, true);
    return true;
  }

  private now(): number { return this.deps.now?.() ?? performance.now(); }

  private inputEligible(run: Run, input: InputTurn): boolean {
    return this.current(run) && this.deps.canUse() && input.eligible && input.decision !== "discarding" && input.decision !== "discarded" && input.epoch === run.audibilityEpoch && !this.muted.input && !this.muted.output;
  }

  private inputBlocked(run: Run): boolean {
    return run.interrupting || !!run.inputClear || [...run.inputs.values()].some(input => input.decision === "discarding"
      || input.decision !== "discarded" && (input.speaking || !!input.referenceTimer || !input.expired && (!input.stopped || !input.committed || input.asr === "pending")));
  }

  private inputTurn(run: Run, id: string, intentional = false): InputTurn | undefined {
    const existing = run.inputs.get(id);
    if (existing) return existing;
    if (run.inputs.size >= 512) { this.fail(run, new VoiceFailure("This voice conversation has reached its limit. Start voice again to continue.")); return; }
    const input: InputTurn = { id, sequence: ++run.inputSequence, epoch: run.audibilityEpoch,
      speaking: false, stopped: false, committed: false, asr: "pending", meaningful: false,
      confirmed: false, sustained: false, eligible: !this.muted.input && !this.muted.output,
      expired: false, included: false, reply: false, interrupted: false,
      targetRequest: run.responseRequestId, targetResponse: run.responseId,
      decision: "pending", references: new Set(), intentional, protected: false, quiet: new VoiceQuietWindow(),
      activity: new VoiceActivityWindow(this.now()) };
    run.inputs.set(id, input); this.markOverlap(run, input);
    if (run.inputClear) this.discardInput(run, input, false);
    return input;
  }

  private markOverlap(run: Run, input: InputTurn): void {
    // Manual admission follows output ownership, even before its first word or
    // reference arrives. Native tombstones keep late ASR excluded after playback.
    if (run.interruptionMode === "manual" && input.decision === "pending" && !input.intentional && !input.included
      && (input.protected || !input.stopped && (this.hasActiveGeneration(run) || run.responseRequested || run.avatarPending || run.playback))) {
      input.protected = true; input.eligible = false;
      // Onset is not settlement. Keep ongoing native capture until stop, commit,
      // final ASR or the existing quiet recovery boundary before timing deletion.
      if (input.stopped || input.committed || input.finalText !== undefined) this.discardInput(run, input, false);
      return;
    }
    // Once playback ends, listening is advertised and a genuine reply may begin
    // immediately. Keep the tail's reference check below to reject echoed words,
    // without classifying every post-playback utterance as an interruption.
    if (input.decision !== "pending" || input.stopped || input.intentional || !run.outputReference) return;
    if (run.playback || this.now() <= run.outputTailUntil) input.references.add(run.outputReference);
  }

  private classifyInput(run: Run, input: InputTurn): void {
    if (input.decision !== "pending" || input.finalText === undefined) return;
    if (input.protected) { this.discardInput(run, input, false); return; }
    const references = [...input.references].map(id => run.references.get(id));
    // A final reference is needed: a partial prefix cannot establish nonmatch.
    if (references.some(parts => !parts?.size || [...parts.values()].some(part => !part.final))) {
      input.referenceTimer ??= setTimeout(() => {
        input.referenceTimer = undefined;
        if (this.current(run) && input.decision === "pending") this.discardInput(run, input);
      }, INPUT_REFERENCE_WAIT_MS);
      return;
    }
    if (references.some(parts => overlapsVoiceReference(input.finalText!, [...parts!.values()].map(part => part.text).join(" ")))) {
      this.discardInput(run, input); return;
    }
    clearTimeout(input.referenceTimer); input.referenceTimer = undefined;
    this.acceptInputTranscription(run, input);
  }

  private discardInput(run: Run, input: InputTurn, hint = true): void {
    if (input.decision === "discarding" || input.decision === "discarded") return;
    input.decision = "discarding"; input.eligible = false; input.reply = false;
    input.speaking = false; input.stopped = true;
    if (run.speakingInput === input.id) run.speakingInput = null;
    clearTimeout(input.timer); clearTimeout(input.referenceTimer);
    input.timer = input.referenceTimer = undefined;
    this.emit({ type: "input", status: "discarded", id: `user:${input.id}:0` });
    if (hint) this.emit({ type: "input-hint", message: "Overlapping words weren't saved. Please repeat, or use Interrupt and speak." });
    input.retirementTimer = setTimeout(() => {
      if (this.current(run) && input.decision === "discarding") this.fail(run, new VoiceFailure("Overlapping microphone input could not be removed. Start voice again to continue safely."));
    }, INPUT_SETTLEMENT_TIMEOUT_MS);
    this.deleteInput(run, input);
  }

  private deleteInput(run: Run, input: InputTurn): void {
    if (!input.committed || input.deleteSent) return;
    input.decision = "discarding"; input.deleteSent = true;
    // Install the barrier before sending; only the exact native receipt retires it.
    input.retirementTimer ??= setTimeout(() => {
      if (this.current(run) && input.decision === "discarding") this.fail(run, new VoiceFailure("Overlapping microphone input could not be removed. Start voice again to continue safely."));
    }, INPUT_SETTLEMENT_TIMEOUT_MS);
    this.send(run, { type: "conversation.item.delete", item_id: input.id });
  }

  private retireInput(input: InputTurn): void {
    input.decision = "discarded";
    clearTimeout(input.retirementTimer); input.retirementTimer = undefined;
  }

  private clearInputBuffer(run: Run, intent: boolean): void {
    if (run.inputClear) { run.inputClear.intent ||= intent; return; }
    run.takeFloor = false;
    run.inputClear = { intent, timer: setTimeout(() => {
      if (this.current(run)) this.fail(run, new VoiceFailure("Microphone buffering could not be cleared. Start voice again to continue."));
    }, INPUT_SETTLEMENT_TIMEOUT_MS) };
    // Only a deliberate take-floor / quiet recovery boundary gates capture.
    // Ordinary output never disables the microphone.
    run.stream?.getAudioTracks().forEach(track => { track.enabled = false; });
    this.send(run, { type: "input_audio_buffer.clear" });
  }

  interrupt(): void {
    const run = this.run;
    if (!run?.ready || !this.current(run) || !this.deps.canUse() || this.muted.output) return;
    if (run.live) { run.live.interrupt(); return; }
    run.interrupting = true;
    for (const input of run.inputs.values()) {
      if (input.decision === "pending") this.discardInput(run, input, false);
      else if (input.decision === "accepted" && input.speaking) this.stopInput(run, input);
    }
    this.clearInputBuffer(run, !this.muted.input);
    this.interruptOutput(run);
    run.interrupting = false;
  }

  private stopInput(run: Run, input: InputTurn): void {
    input.speaking = false; input.stopped = true;
    if (run.speakingInput === input.id) run.speakingInput = null;
    input.stoppedAt ??= this.now();
    if (!input.timer && !input.expired && (input.asr === "pending" || !input.committed)) {
      const expire = () => {
        input.timer = undefined;
        if (!this.current(run) || run.inputs.get(input.id) !== input || input.speaking || input.expired) return;
        const remaining = input.stoppedAt! + INPUT_SETTLEMENT_TIMEOUT_MS - this.now();
        if (remaining > 0) { input.timer = setTimeout(expire, remaining); return; }
        if (input.references.size && input.decision === "pending") { this.discardInput(run, input); return; }
        input.expired = true;
        // Scheduling settlement never fabricates a final transcription receipt.
        if (input.sustained && input.committed && this.inputEligible(run, input) && !input.included) input.reply = true;
        this.flushResponse(run);
      };
      const remaining = input.stoppedAt + INPUT_SETTLEMENT_TIMEOUT_MS - this.now();
      if (remaining <= 0) expire(); else input.timer = setTimeout(expire, remaining);
    }
  }

  private confirmInput(run: Run, input: InputTurn, sustained = false): void {
    if (!this.inputEligible(run, input)) return;
    input.confirmed = true; input.sustained ||= sustained;
    if (!input.included) input.reply = true;
    // Late A must never interrupt B or a response newer than A's onset.
    if (input.interrupted || input.expired || input.sequence !== run.inputSequence) return;
    input.interrupted = true;
    const sameResponse = input.targetRequest !== null && input.targetRequest === run.responseRequestId
      && (!input.targetResponse || input.targetResponse === run.responseId);
    run.interrupting = true;
    if (sameResponse) this.interruptOutput(run);
    for (const [id, item] of run.sceneItems) if (item.followUp) {
      this.send(run, { type: "conversation.item.delete", item_id: item.id }); run.sceneItems.delete(id);
      if (run.sceneItem === item) run.sceneItem = null;
    }
    run.pendingSceneResponse = [...run.sceneItems.values()].some(item => !item.active);
    run.interrupting = false;
  }

  private finishInputTranscription(run: Run, itemId: string, text?: string): void {
    const input = run.inputs.get(itemId);
    if (!input || input.asr !== "pending") return;
    if (input.protected) { this.discardInput(run, input, false); return; }
    input.asr = text === undefined ? "failed" : "completed";
    input.meaningful = text !== undefined && meaningfulVoiceText(text);
    input.finalText = text;
    if (input.references.size && !input.intentional) {
      if (!input.meaningful) this.discardInput(run, input);
      else this.classifyInput(run, input);
      return;
    }
    this.acceptInputTranscription(run, input);
  }

  private acceptInputTranscription(run: Run, input: InputTurn): void {
    const text = input.finalText, itemId = input.id;
    input.decision = "accepted";
    if (text !== undefined) this.emit({ type: "transcript", role: "user", id: `user:${itemId}:0`, text, final: true });
    if (text !== undefined && !input.meaningful) this.emit({ type: "input", status: "discarded", id: `user:${itemId}:0` });
    if (input.committed) { clearTimeout(input.timer); input.timer = undefined; }
    if (input.meaningful && this.inputEligible(run, input)) {
      if (!input.expired) this.confirmInput(run, input);
      else if (input.committed && !input.included && input.sequence === run.inputSequence) input.reply = true;
    }
    this.flushResponse(run);
  }

  private interruptOutput(run: Run): void {
    if (!(run.responseActive || run.playback || run.avatarPending) || run.interruptedResponse) return;
    // Install tombstones before send(): avatar callbacks can clear synchronously.
    run.interruptedResponse = true; run.cancelledRequest ||= run.responseRequested;
    if (run.responseId) this.rememberCancelledResponse(run, run.responseId);
    if (run.responseRetryPending) this.discardRejectedRequest(run);
    const alreadyInterrupting = run.interrupting;
    run.interrupting = true;
    if (run.playback) run.outputTailUntil = this.now() + OUTPUT_ECHO_TAIL_MS;
    if (run.responseActive) this.cancelResponse(run, run.responseId ?? undefined);
    this.send(run, { type: "output_audio_buffer.clear" });
    run.playback = false; run.avatarPending = false; run.interrupting = alreadyInterrupting;
    this.emit({ type: "activity", status: "listening" }); this.emit({ type: "level", value: 0 });
  }

  private cancelResponse(run: Run, responseId?: string): void {
    if (!run.responseActive && !responseId) return;
    const eventId = `voice-cancel-${++run.cancellationSequence}`;
    if (run.cancellationIds.size >= 128) run.cancellationIds.delete(run.cancellationIds.values().next().value!);
    run.cancellationIds.add(eventId);
    this.send(run, { type: "response.cancel", event_id: eventId, ...(responseId ? { response_id: responseId } : {}) });
  }

  setMuted(options: unknown): void {
    if (!record(options) || typeof options.input !== "boolean" || typeof options.output !== "boolean") throw new VoiceFailure("Invalid voice mute options.");
    if (options.input === this.muted.input && options.output === this.muted.output) return;
    if (this.run && (options.input && !this.muted.input || options.output && !this.muted.output)) {
      this.run.audibilityEpoch++;
      this.run.takeFloor = false;
      if (this.run.inputClear) this.run.inputClear.intent = false;
      for (const input of this.run.inputs.values()) { input.eligible = false; input.reply = false; }
    }
    this.muted = { input: options.input, output: options.output };
    if (this.run) this.applyMute(this.run);
  }

  private applyMute(run: Run): void {
    if (run.live) {
      if (this.muted.output) run.audio?.setMuted(true);
      run.live.setMuted(this.muted);
      if (!this.muted.output) run.audio?.setMuted(false);
      return;
    }
    this.prunePoliceScenes(run);
    run.stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted.input && !run.inputClear; });
    run.audio?.setMuted(this.muted.output);
    this.send(run, { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: {
      type: "semantic_vad", eagerness: "medium", create_response: false, interrupt_response: false,
    } } } } });
    // Buffered genuine words still drain. Muting never clears native input.
    if (this.muted.output) {
      if (run.responseRetryPending) this.discardRejectedRequest(run);
      run.pendingResponse = false; run.pendingSceneResponse = false;
      if (run.inputs.size) run.interruptedInput = [...run.inputs.values()].at(-1)!.id;
      this.interruptOutput(run);
    }
  }

  updateContext(context: unknown): void {
    if (!isVoiceContext(context)) throw new VoiceFailure("Voice context must be text or a valid public snapshot of at most 4,000 characters.");
    if (this.run?.live) { this.run.context = copyVoiceContext(context); this.run.live.updateContext(context); return; }
    if (this.run?.preflightContext) {
      try { this.run.preflightContext.offer(context); }
      catch { this.fail(this.run, new VoiceFailure('Too many room updates arrived while connecting voice. Reconnect to continue from your saved room.')); return; }
    }
    if (this.run) this.prunePoliceScenes(this.run);
    if (!this.run || voiceContextText(this.run.context) === voiceContextText(context)) return;
    this.run.context = copyVoiceContext(context);
    if (this.run.ready) this.sendContext(this.run);
  }

  updateInstructions(instructions: unknown): void {
    if (!boundedString(instructions, 12_000) || !instructions.trim()) throw new VoiceFailure("Voice instructions must contain 1–12,000 characters.");
    const run = this.run;
    if (!run) return;
    if (run.live) { run.instructions = instructions; run.live.updateInstructions(instructions); return; }
    run.pendingInstructions = instructions === run.instructions ? null : instructions;
    this.flushInstructions(run);
  }

  private flushInstructions(run: Run): boolean {
    if (!run.ready || run.pendingInstructions === null || this.hasActiveGeneration(run) || this.inputBlocked(run) || run.playback || run.avatarPending) return false;
    run.instructions = run.pendingInstructions; run.pendingInstructions = null;
    this.sendContext(run);
    return true;
  }

  private sendContext(run: Run): void {
    this.send(run, { type: "session.update", session: { type: "realtime", instructions: composeVoiceInstructions(run.instructions, run.context) } });
  }

  reactToScene(notice: unknown): void {
    if (!isVoiceSceneReaction(notice)) throw new VoiceFailure("Invalid voice scene notice.");
    const run = this.run;
    if (!run?.ready || !this.current(run) || !this.deps.canUse() || this.muted.output || run.sceneIds.has(notice.id)) return;
    // Retain every accepted id for this connection, with no eviction/replay.
    // Flooding drops new notices while ordinary conversation remains usable.
    if (run.sceneIds.size >= 128) return;
    const now = Date.now();
    run.sceneTimes = run.sceneTimes.filter(time => now - time < 10_000);
    if (run.sceneTimes.length >= 8) return;
    const policeCurrent = policeSceneAuthority(notice);
    if (policeCurrent && !policeCurrent()) return;
    this.prunePoliceScenes(run, !!policeCurrent);
    run.sceneIds.add(notice.id); run.sceneTimes.push(now);
    if (run.live) { run.live.scene(notice); return; }
    const item = { id: `voice-scene-${run.sceneIds.size}`, acknowledged: false, active: false, followUp: notice.kind === "follow-up", bulletin: notice.kind === "bulletin", policeCurrent };
    run.sceneItem = item;
    run.sceneItems.set(notice.id, item);
    this.send(run, { type: "conversation.item.create", item: { id: run.sceneItem.id, type: "message", role: "user", content: [{
      type: "input_text", text: formatVoiceSceneReaction(notice),
    }] } });
    this.requestResponse(run, true);
  }

  /** Delete only queued host-validated police instructions. A physical clock
   * never cancels an active reply or clears its audio. Latest context is already
   * sent before the surviving milestone requests the next quiet turn. */
  private prunePoliceScenes(run: Run, superseded = false): void {
    let removed = false;
    for (const [noticeId, item] of run.sceneItems) {
      if (item.active || !item.policeCurrent || !superseded && item.policeCurrent()) continue;
      this.send(run, { type: "conversation.item.delete", item_id: item.id });
      run.sceneItems.delete(noticeId);
      removed = true;
      if (run.sceneItem === item) run.sceneItem = null;
    }
    if (removed) run.pendingSceneResponse = [...run.sceneItems.values()].some(item => !item.active);
  }

  cancelSceneReaction(id?: unknown): void {
    if (id !== undefined && !identifier(id)) throw new VoiceFailure("Invalid voice scene id.");
    const run = this.run;
    if (!run) return;
    if (run.live) { run.live.cancelScene(id); return; }
    let active = false;
    for (const [noticeId, item] of run.sceneItems) {
      if (id === undefined ? !item.followUp : noticeId !== id) continue;
      active ||= item.active;
      this.send(run, { type: "conversation.item.delete", item_id: item.id });
      run.sceneItems.delete(noticeId);
      if (run.sceneItem === item) run.sceneItem = null;
    }
    run.pendingSceneResponse = [...run.sceneItems.values()].some(item => !item.active);
    if (active) {
      this.interruptOutput(run);
      this.emit({ type: "activity", status: "listening" }); this.emit({ type: "level", value: 0 });
      this.flushInstructions(run); this.retireScenes(run); this.flushResponse(run);
    }
  }

  private retireScenes(run: Run): void {
    if (run.interrupting || this.hasActiveGeneration(run) || run.playback || run.avatarPending) return;
    for (const [noticeId, item] of run.sceneItems) {
      if (!item.active) continue;
      // Completed questions and broadcasts must not remain standing commands.
      // Delete only the injected prompt; generated dialogue remains history.
      if (item.followUp || item.bulletin) this.send(run, { type: "conversation.item.delete", item_id: item.id });
      run.sceneItems.delete(noticeId);
      if (run.sceneItem === item) run.sceneItem = null;
    }
  }

  resolveTool(callId: unknown, result: unknown): void {
    const run = this.run;
    if (!run || !identifier(callId) || run.tools.get(callId) !== false) return;
    if (!record(result) || typeof result.accepted !== "boolean" || (result.focus !== undefined && !focus(result.focus)) || (result.reason !== undefined && !boundedString(result.reason, 240))) throw new VoiceFailure("Invalid inspection response.");
    run.tools.set(callId, true);
    this.send(run, { type: "conversation.item.create", item: { type: "function_call_output", call_id: callId,
      output: JSON.stringify({ accepted: result.accepted, ...(result.focus !== undefined ? { focus: result.focus } : {}), ...(result.reason !== undefined ? { reason: result.reason } : {}) }),
    } });
    if (!this.muted.output) this.requestResponse(run);
  }

  setSpatial(pose: unknown): void {
    if (!record(pose) || !["x", "z", "yaw", "sourceX", "sourceZ"].every(key => typeof pose[key] === "number" && Number.isFinite(pose[key]) && Math.abs(pose[key]) <= 10_000)) throw new VoiceFailure("Invalid voice spatial pose.");
    this.pose = { x: pose.x as number, z: pose.z as number, yaw: pose.yaw as number, sourceX: pose.sourceX as number, sourceZ: pose.sourceZ as number };
    this.run?.audio?.setSpatial(this.pose);
  }

  private rememberCancelledResponse(run: Run, id: string): void {
    if (run.cancelledResponses.size >= 512 && !run.cancelledResponses.has(id)) {
      this.fail(run, new VoiceFailure("This voice conversation has reached its limit. Start voice again to continue.")); return;
    }
    run.cancelledResponses.add(id);
  }

  private receive(run: Run, data: unknown): void {
    if (typeof data !== "string" || data.length > 65_536) return;
    let event: unknown; try { event = JSON.parse(data); } catch { return; }
    if (!record(event) || typeof event.type !== "string") return;
    if (run.live) { run.live.receive(event); return; }
    if (identifier(event.event_id)) {
      if (run.eventIds.has(event.event_id)) return;
      // Stop rather than evict duplicate protection in an unbounded session.
      if (run.eventIds.size >= 20_000) { this.fail(run, new VoiceFailure("This voice conversation has reached its limit. Start voice again to continue.")); return; }
      run.eventIds.add(event.event_id);
    }
    const responseId = identifier(event.response_id) ? event.response_id
      : record(event.response) && identifier(event.response.id) ? event.response.id : null;
    if (event.type === "input_audio_buffer.cleared" && run.inputClear) {
      clearTimeout(run.inputClear.timer);
      run.takeFloor = run.inputClear.intent && !this.muted.input && !this.muted.output; run.inputClear = null;
      for (const input of run.inputs.values()) if (input.decision === "discarding" && !input.committed) this.retireInput(input);
      run.stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted.input; });
      this.flushResponse(run); return;
    }
    if (event.type === "conversation.item.deleted" && identifier(event.item_id)) {
      const input = run.inputs.get(event.item_id);
      if (input?.deleteSent && input.decision === "discarding") { this.retireInput(input); this.flushResponse(run); }
      return;
    }
    // Terminal inputs are tombstones, including for late native commits after a clear.
    const nativeInput = identifier(event.item_id) ? run.inputs.get(event.item_id) : undefined;
    if (nativeInput && (nativeInput.decision === "discarding" || nativeInput.decision === "discarded")
      && (event.type.startsWith("input_audio_buffer.") || event.type.startsWith("conversation.item.input_audio_transcription."))) {
      if (event.type === "input_audio_buffer.committed") { nativeInput.committed = true; this.deleteInput(run, nativeInput); }
      return;
    }
    if (event.type === "response.created") {
      if (responseId && run.cancelledResponses.has(responseId) && responseId !== run.responseId) return;
      const metadata = record(event.response) && record(event.response.metadata) ? event.response.metadata : null;
      const requestId = metadata && identifier(metadata.yumina_request_id) ? metadata.yumina_request_id : null;
      if (responseId && responseId === run.responseId && !run.responseRequested) return;
      const requested = requestId !== null && requestId === run.responseRequestId && run.responseRequested;
      // Managed turns accept only the matching request receipt. Foreign or
      // pre-cut replies cannot consume this request or its input/scene cutoff.
      if (!requested || !run.responseActive) {
        if (responseId) {
          if (!requestId && run.responseRequested) run.responseOverlap = { id: responseId, retired: false };
          this.rememberCancelledResponse(run, responseId); this.cancelResponse(run, responseId);
        }
        return;
      }
      run.responseId = responseId;
      run.interruptedResponse = run.cancelledRequest || this.muted.output;
      run.cancelledRequest = false;
      if (run.interruptedResponse && responseId) this.rememberCancelledResponse(run, responseId);
    }
    const responseEvent = event.type.startsWith("response.") || event.type.startsWith("output_audio_buffer.");
    const staleResponse = responseEvent && (responseId ? run.cancelledResponses.has(responseId) : run.interruptedResponse);
    if (staleResponse && event.type !== "response.created") {
      if (event.type === "response.done" && responseId === run.responseOverlap?.id) {
        run.responseOverlap.retired = true;
        this.flushResponse(run);
        return;
      }
      if (event.type === "response.done" && (!responseId || responseId === run.responseId)) {
        run.responseActive = false; run.responseRequested = false; run.cancelledRequest = false;
        this.retireScenes(run); this.flushResponse(run);
        this.emitActivity(run);
      }
      return;
    }
    if (responseEvent && event.type !== "response.created" && responseId && responseId !== run.responseId) return;
    if (event.type === "input_audio_buffer.speech_started" && identifier(event.item_id)) {
      const newCapture = !run.inputs.has(event.item_id);
      const input = this.inputTurn(run, event.item_id, run.takeFloor && newCapture);
      if (!input) return;
      if (input.decision === "discarding" || input.decision === "discarded") return;
      if (run.takeFloor && newCapture) {
        input.intentional = true; input.references.clear(); run.takeFloor = false;
      }
      if (run.responseRetryPending && this.inputEligible(run, input)) {
        this.discardRejectedRequest(run); run.pendingSceneResponse = true;
      }
      run.interruptedInput = this.muted.input || this.muted.output ? input.id : null;
      if (!input.speaking) input.activity = new VoiceActivityWindow(this.now());
      input.speaking = true; input.stopped = false; run.speakingInput = input.id;
      this.markOverlap(run, input);
    }
    if (run.avatar && !staleResponse && (run.audio as AvatarAudio | undefined)?.handleProviderEvent(event)) return;
    if (event.type === "error") {
      // An already-finished response is safe to cancel. The provider may return
      // an error for that request while keeping the transcription session valid.
      if (record(event.error) && identifier(event.error.event_id) && run.cancellationIds.delete(event.error.event_id)) return;
      // Retry only this exact request's single-conversation collision, once,
      // after the identified interrupted response has actually retired.
      if (record(event.error) && event.error.code === "conversation_already_has_active_response"
        && event.error.event_id === run.responseRequestId && run.responseRequested && run.interruptedInput !== null && !run.responseRetryUsed) {
        if (this.muted.output || run.cancelledRequest) this.discardRejectedRequest(run);
        else { run.responseRetryPending = true; this.retryInterruptedResponse(run); }
        return;
      }
      this.fail(run, new VoiceFailure("The voice provider reported a problem. Start voice again or continue without voice.")); return;
    }
    if (event.type === "conversation.item.added" || event.type === "conversation.item.created") {
      if (record(event.item)) for (const item of run.sceneItems.values()) if (item.id === event.item.id) item.acknowledged = true;
      const input = record(event.item) && identifier(event.item.id) ? run.inputs.get(event.item.id) : undefined;
      if (input && (input.decision === "discarding" || input.decision === "discarded")) { input.committed = true; this.deleteInput(run, input); }
      return;
    }
    if (event.type === "response.created") {
      run.responseRequested = false; run.responseActive = true;
      if (this.muted.output || run.interruptedResponse) this.cancelResponse(run, responseId ?? undefined);
      this.emitActivity(run);
      return;
    }
    if (event.type === "output_audio_buffer.started" || event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared") {
      this.playback(run, event.type === "output_audio_buffer.started" ? "started" : event.type === "output_audio_buffer.stopped" ? "stopped" : "cleared");
      return;
    }
    if (event.type === "response.done") {
      if (record(event.response) && (event.response.status === "failed" || event.response.status === "cancelled")) {
        if (event.response.status === "failed") {
          this.fail(run, new VoiceFailure("The voice response failed. Start voice again or continue without voice.")); return;
        }
        this.interruptOutput(run);
      }
      run.responseActive = false; run.responseRequested = false;
      this.retireScenes(run);
      this.flushResponse(run);
      this.emitActivity(run);
      return;
    }
    if (event.type === "response.function_call_arguments.done") { this.receiveTool(run, event); return; }
    if (event.type === "input_audio_buffer.speech_started" || event.type === "input_audio_buffer.speech_stopped" || event.type === "input_audio_buffer.committed") {
      if (identifier(event.item_id)) {
        const input = this.inputTurn(run, event.item_id);
        if (!input) return;
        if (input.decision === "discarding" || input.decision === "discarded") {
          if (event.type.endsWith("committed")) { input.committed = true; this.deleteInput(run, input); }
          return;
        }
        if (event.type.endsWith("committed")) {
          input.committed = true;
          if (run.interruptionMode === "manual") this.markOverlap(run, input);
          if (input.asr !== "pending") { clearTimeout(input.timer); input.timer = undefined; }
          if (input.expired && (input.sustained || input.meaningful && input.sequence === run.inputSequence) && !input.included && this.inputEligible(run, input)) input.reply = true;
        } else {
          const speaking = event.type.endsWith("speech_started");
          if (!speaking) this.stopInput(run, input);
          if (run.interruptionMode === "manual") this.markOverlap(run, input);
          if (input.protected) return;
          this.emitActivity(run, speaking ? "listening" : "thinking");
          if (input.asr === "pending") this.emit({ type: "input", status: speaking ? "speaking" : "transcribing", id: `user:${event.item_id}:0` });
        }
        this.flushResponse(run);
      }
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      if (identifier(event.item_id) && event.content_index === 0) {
        const input = run.inputs.get(event.item_id);
        if (input && input.asr !== "pending" || run.captions.get(`user:${event.item_id}:0`)?.final) return;
        this.emit({ type: "input", status: "discarded", id: `user:${event.item_id}:0` });
        this.finishInputTranscription(run, event.item_id);
      }
      return;
    }
    const user = event.type === "conversation.item.input_audio_transcription.delta" || event.type === "conversation.item.input_audio_transcription.completed";
    const assistant = event.type === "response.output_audio_transcript.delta" || event.type === "response.output_audio_transcript.done";
    if (!user && !assistant) return;
    if (!identifier(event.item_id) || !Number.isInteger(event.content_index) || (event.content_index as number) < 0 || (event.content_index as number) > 20) return;
    const final = event.type.endsWith(".completed") || event.type.endsWith(".done");
    const text = final ? event.transcript : event.delta;
    if (!boundedString(text, 8_000)) return;
    const role = user ? "user" : "assistant", id = `${role}:${event.item_id}:${event.content_index}`;
    // Hold all input deltas: playback can begin after onset, before final ASR.
    // The existing transcript event is durable to some consumers.
    if (user) {
      const input = this.inputTurn(run, event.item_id);
      if (!input || input.decision === "discarding" || input.decision === "discarded") return;
      this.markOverlap(run, input);
    }
    const previous = run.captions.get(id);
    if (previous?.final) return;
    if (!previous && run.captions.size >= 512) { this.fail(run, new VoiceFailure("This voice conversation has reached its limit. Start voice again to continue.")); return; }
    const combined = final ? text : (previous?.text ?? "") + text;
    if (combined.length > 8_000) return;
    run.captions.set(id, { text: combined, final });
    if (assistant) {
      this.emit({ type: "transcript", role, id, text: combined, final });
      if (run.responseRequestId) {
        let reference = run.references.get(run.responseRequestId);
        if (!reference) { reference = new Map(); run.references.set(run.responseRequestId, reference); }
        reference.set(id, { text: combined, final });
        for (const input of run.inputs.values()) if (input.references.has(run.responseRequestId)) this.classifyInput(run, input);
      }
    }
    if (user && final && event.content_index === 0) this.finishInputTranscription(run, event.item_id, combined);
  }

  private receiveTool(run: Run, event: Record<string, unknown>): void {
    if (run.toolAllowlist?.length === 0) return;
    if (!identifier(event.call_id) || run.tools.has(event.call_id) || run.tools.size >= 64) return;
    run.tools.set(event.call_id, true);
    if (event.name !== "request_inspection_focus" || !boundedString(event.arguments, 1_024)) return;
    let args: unknown; try { args = JSON.parse(event.arguments); } catch { return; }
    if (!record(args) || !focus(args.focus) || !boundedString(args.reason, 240) || Object.keys(args).some(key => key !== "focus" && key !== "reason")) return;
    run.tools.set(event.call_id, false);
    if (this.muted.output) { this.resolveTool(event.call_id, { accepted: false, reason: "The encounter is paused." }); return; }
    this.emit({ type: "tool", callId: event.call_id, name: "request_inspection_focus", arguments: { focus: args.focus as "desk" | "door" | "bed", reason: args.reason } });
  }

  private playback(run: Run, state: "started" | "stopped" | "cleared"): void {
    if (state === "started" && (run.interruptedResponse || this.muted.output)) return;
    const wasPlaying = run.playback;
    run.avatarPending = false;
    run.playback = state === "started" && !this.muted.output;
    if (run.playback) {
      run.outputReference = run.responseRequestId;
      for (const input of run.inputs.values()) if (input.speaking || run.interruptionMode === "manual") this.markOverlap(run, input);
    } else if (wasPlaying) run.outputTailUntil = this.now() + OUTPUT_ECHO_TAIL_MS;
    this.emitActivity(run);
    this.retireScenes(run); this.flushResponse(run);
  }

  private async connectAvatar(run: Run): Promise<void> {
    run.avatarStarting = true;
    this.emit({ type: "video-status", status: "connecting" });
    const response = await this.wait(run, this.deps.fetch(`${this.deps.apiBase ?? ""}/api/voice/${encodeURIComponent(this.deps.sessionId)}/avatar/start`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-Voice-Connection-Id": run.connectionId },
      body: "{}", signal: run.abort.signal,
    }));
    const connection: unknown = await this.wait(run, response.json()); this.check(run);
    if (!response.ok || !record(connection) || !identifier(connection.sessionId)
      || !boundedString(connection.livekitClientToken, 8192) || !connection.livekitClientToken
      || !boundedString(connection.livekitUrl, 4096) || !connection.livekitUrl.startsWith("wss://")
      || !boundedString(connection.wsUrl, 8192) || !connection.wsUrl.startsWith("wss://")
      || connection.maxDurationSeconds !== 300) {
      throw new VoiceFailure("The live telescreen video could not connect. Please wait a moment and try again.");
    }
    this.scheduleAvatarHeartbeat(run);
    await this.wait(run, (run.audio as AvatarAudio).connectAvatar(connection as unknown as AvatarConnection));
    this.check(run);
  }

  private scheduleAvatarHeartbeat(run: Run, failures = 0): void {
    run.heartbeat = setTimeout(async () => {
      if (!this.current(run)) return;
      try {
        const response = await this.deps.fetch(`${this.deps.apiBase ?? ""}/api/voice/${encodeURIComponent(this.deps.sessionId)}/avatar/heartbeat`, {
          method: "POST", credentials: "include", headers: { "X-Voice-Connection-Id": run.connectionId },
          signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(10_000)]),
        });
        if ([401, 403, 404, 409].includes(response.status)) {
          if (this.current(run)) this.fail(run, new VoiceFailure('The live telescreen connection ended. Start voice again to reconnect.'));
          return;
        }
        if (!response.ok) throw new Error('Heartbeat temporarily unavailable');
        const result: unknown = await response.json();
        if (!record(result) || result.active !== true) {
          if (this.current(run)) this.fail(run, new VoiceFailure('The live telescreen connection ended. Start voice again to reconnect.'));
          return;
        }
        if (this.current(run)) this.scheduleAvatarHeartbeat(run);
      } catch {
        if (this.current(run)) {
          if (failures < 2) this.scheduleAvatarHeartbeat(run, failures + 1);
          else this.fail(run, new VoiceFailure("The live telescreen connection ended after repeated network failures. Start voice again to reconnect."));
        }
      }
    }, failures ? Math.min(this.deps.avatarHeartbeatMs ?? 2000, 2000) : this.deps.avatarHeartbeatMs ?? 20_000);
  }

  ackVideoFrame(id: unknown): void {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) throw new VoiceFailure("Invalid video frame acknowledgement.");
    if (this.run?.avatar) (this.run.audio as AvatarAudio | undefined)?.ackVideoFrame(id);
  }
}

/** Only these typed methods are callable from a card; never accept raw provider events. */
export function dispatchVoiceCall(controller: VoiceController, method: string, args: unknown[]): ReturnType<VoiceAPI["start"]> | ReturnType<VoiceAPI["prepare"]> | void {
  if (!Array.isArray(args) || args.length > 2) throw new VoiceFailure("Invalid voice arguments.");
  switch (method) {
    case "realtimeVoice.prepare": return controller.prepare(args[0]);
    case "realtimeVoice.start": return controller.start(args[0]);
    case "realtimeVoice.stop": return controller.stop();
    case "realtimeVoice.interrupt":
      if (args.length !== 0) throw new VoiceFailure("Invalid voice arguments.");
      return controller.interrupt();
    case "realtimeVoice.setMuted": return controller.setMuted(args[0]);
    case "realtimeVoice.updateContext": return controller.updateContext(args[0]);
    case "realtimeVoice.updateInstructions":
      if (args.length !== 1) throw new VoiceFailure("Invalid voice arguments.");
      return controller.updateInstructions(args[0]);
    case "realtimeVoice.cancelSceneReaction":
      if (args.length > 1) throw new VoiceFailure("Invalid voice arguments.");
      return controller.cancelSceneReaction(args[0]);
    case "realtimeVoice.reactToScene":
      if (args.length !== 1) throw new VoiceFailure("Invalid voice arguments.");
      return controller.reactToScene(args[0]);
    case "realtimeVoice.resolveTool": return controller.resolveTool(args[0], args[1]);
    case "realtimeVoice.setSpatial": return controller.setSpatial(args[0]);
    case "realtimeVoice.ackVideoFrame":
      if (args.length !== 1) throw new VoiceFailure("Invalid video frame acknowledgement.");
      return controller.ackVideoFrame(args[0]);
    default: throw new VoiceFailure("Unknown voice method.");
  }
}
