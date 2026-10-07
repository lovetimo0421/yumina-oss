import type { Room, RemoteTrack } from "livekit-client";
import type { VoiceAudio } from "./voice-controller";
import { createVoiceAudio } from "./voice-audio";
import { AvatarFrameGate, AvatarUtterances, type AvatarPlayback } from "./avatar-voice-audio-state";
import { AVATAR_PCM_WORKLET } from "./avatar-voice-audio-worklet";
import { AvatarControlSocket } from "./avatar-control-socket";
import { LiveVoiceSegments } from "./live-voice-segments";

export interface AvatarConnection {
  sessionId: string;
  livekitUrl: string;
  livekitClientToken: string;
  wsUrl: string;
  maxDurationSeconds: 300;
}
export interface AvatarAudioOptions {
  signal: AbortSignal;
  onPlayback(event: AvatarPlayback): void;
  onPending?(): void;
  onQueue?(count: number): void;
  /** Provider audio activity, before the avatar has buffered/rendered it. */
  onSourceActivity?(active: boolean): void;
  onVideoFrame(event: { id: number; frame: ImageBitmap }): void;
  onVideoStatus(status: "connecting" | "live" | "stopped", message?: string): void;
  onError(message: string): void;
}
export interface AvatarAudio extends VoiceAudio {
  connectAvatar(connection: AvatarConnection): Promise<void>;
  handleProviderEvent(event: Record<string, unknown>): boolean;
  handleClientEvent(event: Record<string, unknown>): void;
  ackVideoFrame(id: number): void;
}
export interface AvatarAudioRuntime {
  createOutput(onLevel: (value: number) => void, onInputLevel: (value: number) => void): VoiceAudio;
  createCaptureContext(): AudioContext;
  createClockElement(): HTMLAudioElement;
  createVideoElement(): HTMLVideoElement;
  createWorklet(context: AudioContext): Promise<AudioWorkletNode>;
  createSocket(url: string): WebSocket;
  createRoom(): Room | Promise<Room>;
  createStream(track: MediaStreamTrack): MediaStream;
  createFrame(video: HTMLVideoElement, width: number, height: number): Promise<ImageBitmap>;
  scheduleFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  connectTimeoutMs: number;
  reconnectTimeoutMs?: number;
}
const browserRuntime: AvatarAudioRuntime = {
  createOutput: (onLevel, onInputLevel) => createVoiceAudio(onLevel, undefined, onInputLevel),
  createCaptureContext: () => new AudioContext({ sampleRate: 24_000 }),
  createClockElement: () => new Audio(),
  createVideoElement: () => document.createElement("video"),
  async createWorklet(context) {
    const url = URL.createObjectURL(new Blob([AVATAR_PCM_WORKLET], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
      return new AudioWorkletNode(context, "yumina-avatar-pcm", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    } finally { URL.revokeObjectURL(url); }
  },
  createSocket: url => new WebSocket(url),
  // The detached video element must not trigger adaptive-stream visibility
  // optimizations: its pixels are displayed by the sandbox's Three.js canvas.
  createRoom: async () => {
    const { Room } = await import("livekit-client");
    return new Room({ adaptiveStream: false, dynacast: false });
  },
  createStream: track => new MediaStream([track]),
  createFrame: (video, width, height) => createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: "low" }),
  scheduleFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
  connectTimeoutMs: 25_000,
};

/** Invoke inside the affirmative consent click: both AudioContexts are created
 * and resumed before the first await. The OpenAI track has no audible route. */
export function createAvatarVoiceAudio(onLevel: (value: number) => void, onInputLevel: (value: number) => void,
  options: AvatarAudioOptions, runtime: AvatarAudioRuntime = browserRuntime): AvatarAudio {
  let continuous = false, captureEpoch = 0, liveSequence = 0;
  let held = false, heldBytes = 0, heldPackets: Record<string, unknown>[] = [];
  let heldDrainTimer: ReturnType<typeof setTimeout> | undefined;
  const liveSegments = new LiveVoiceSegments({
    start() {
      options.onSourceActivity?.(true);
      state.provider({ type: "output_audio_buffer.started", response_id: `live-audio-${++liveSequence}` });
    },
    pcm: data => state.pcm(captureEpoch, data),
    end() { state.drained(captureEpoch); options.onSourceActivity?.(false); },
  });
  const output = runtime.createOutput(onLevel, onInputLevel);
  let context: AudioContext;
  try { context = runtime.createCaptureContext(); }
  catch (error) { output.close(); throw error; }
  let resumed: Promise<{ error?: unknown }>;
  try { resumed = context.resume().then(() => ({}), error => ({ error })); }
  catch (error) { resumed = Promise.resolve({ error }); }
  const clock = runtime.createClockElement(), video = runtime.createVideoElement();
  clock.muted = true; clock.setAttribute("playsinline", "");
  video.muted = true; video.autoplay = true; video.playsInline = true;
  video.setAttribute("playsinline", "");
  // Both the processor and this gain guarantee zero original OpenAI output.
  const silent = context.createGain(); silent.gain.value = 0; silent.connect(context.destination);
  let worklet: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined, sourceStream: MediaStream | undefined;
  let control: AvatarControlSocket | undefined, room: Room | undefined, closed = false, failed = false, connectionStarted = false;
  let socketReady = false, roomReady = false, audioReady = false, videoReady = false, videoLive = false;
  let audioTrack: RemoteTrack | undefined, videoTrack: RemoteTrack | undefined;
  let frameTimer: number | undefined, lastFrameAt = -Infinity, lastVideoTime = -1, lastVideoChangeAt = Date.now();
  let frameFailureSince: number | undefined;
  let lastKeepAliveAt = Date.now();
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let mediaRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let established = false, videoEpoch = 0, mediaEpoch = 0;
  let resolveConnection: (() => void) | undefined, rejectConnection: ((error: Error) => void) | undefined;
  const drains = new Map<number, ReturnType<typeof setTimeout>>(), tracks = new Set<RemoteTrack>();
  const frameGate = new AvatarFrameGate();
  const state = new AvatarUtterances({
    uuid: () => crypto.randomUUID(),
    send: event => {
      if (event.type === 'agent.interrupt') {
        heldPackets = []; heldBytes = 0;
        clearTimeout(heldDrainTimer); heldDrainTimer = undefined;
      }
      if (event.type !== 'agent.interrupt' && event.type !== 'session.keep_alive') {
        if (!held && heldPackets.length === 0 && control?.trySend(event)) return;
        if (closed) return;
        heldBytes += JSON.stringify(event).length;
        if (heldBytes > 768 * 1024 || heldPackets.length >= 128) { fail('The live reply could not wait for input to finish. Reconnect to continue.'); return; }
        heldPackets.push(event);
        drainHeld();
      } else control?.send(event);
    },
    capture: event => {
      if (continuous) {
        if (event.type === "begin") captureEpoch = Number(event.epoch);
        return;
      }
      if (event.type === "clear") { for (const timer of drains.values()) clearTimeout(timer); drains.clear(); }
      if (event.type === "drain") {
        const epoch = Number(event.epoch);
        drains.set(epoch, setTimeout(() => fail("Avatar audio capture stalled. Start voice again."), 1000));
      }
      worklet?.port.postMessage(event);
    },
    playback: event => options.onPlayback(event), pending: () => options.onPending?.(), queue: count => options.onQueue?.(count),
    mute: value => output.setMuted(value), error: message => fail(message),
  });
  function drainHeld() {
    if (closed || held || !control) return;
    while (heldPackets.length) {
      if (!control.trySend(heldPackets[0])) {
        if (!closed && !heldDrainTimer) heldDrainTimer = setTimeout(() => { heldDrainTimer = undefined; drainHeld(); }, 25);
        return;
      }
      heldBytes -= JSON.stringify(heldPackets.shift()).length;
    }
    clearTimeout(heldDrainTimer); heldDrainTimer = undefined;
  }
  // Observe startup failures immediately, even while the user considers consent.
  let workletReady: Promise<{ error?: unknown }>;
  try {
    workletReady = runtime.createWorklet(context).then(node => {
      if (closed) { node.port.close(); node.disconnect(); return { error: new Error("Avatar audio closed.") }; }
      worklet = node; node.connect(silent);
      node.onprocessorerror = () => fail("Avatar audio capture failed. Start voice again.");
      node.port.onmessage = ({ data }: MessageEvent<{ type: string; epoch: number; pcm?: ArrayBuffer }>) => {
        if (closed) return;
        if (data.type === "live-pcm" && data.pcm) liveSegments.append(new Uint8Array(data.pcm));
        else if (data.type === "pcm" && data.pcm) state.pcm(data.epoch, new Uint8Array(data.pcm));
        else if (data.type === "drained") {
          clearTimeout(drains.get(data.epoch)); drains.delete(data.epoch); state.drained(data.epoch);
        }
      };
      return {};
    }, error => ({ error }));
  } catch (error) { workletReady = Promise.resolve({ error }); }

  function connected() {
    if (closed || !socketReady || !roomReady || !audioReady || !videoReady || !videoLive) return;
    established = true;
    if (mediaRecoveryTimer !== undefined) {
      clearTimeout(mediaRecoveryTimer); mediaRecoveryTimer = undefined;
      options.onVideoStatus("live");
    }
    clearTimeout(connectTimer); resolveConnection?.(); resolveConnection = undefined; rejectConnection = undefined;
  }
  function recoverMedia() {
    if (closed || !established) return;
    mediaEpoch++; videoLive = false; frameFailureSince = undefined;
    if (mediaRecoveryTimer !== undefined) return;
    options.onVideoStatus("connecting");
    // LiveKit removes tracks before emitting Reconnecting. Let its existing
    // room recover; no replacement provider session or microphone is opened.
    mediaRecoveryTimer = setTimeout(() => fail("Avatar media could not reconnect. Start voice again."), runtime.reconnectTimeoutMs ?? 8000);
  }
  function fail(message: string) {
    if (closed || failed) return;
    failed = true;
    rejectConnection?.(new Error(message)); rejectConnection = undefined;
    close(message); options.onError(message);
  }
  function close(message?: string) {
    if (closed) return;
    closed = true;
    heldPackets = []; heldBytes = 0;
    clearTimeout(heldDrainTimer); heldDrainTimer = undefined;
    liveSegments.close(); state.close(); frameGate.close();
    clearTimeout(connectTimer); clearTimeout(mediaRecoveryTimer); clearInterval(watchdog);
    for (const timer of drains.values()) clearTimeout(timer); drains.clear();
    options.signal.removeEventListener("abort", aborted);
    rejectConnection?.(new Error(message ?? "Avatar connection closed.")); rejectConnection = undefined; resolveConnection = undefined;
    if (frameTimer !== undefined) runtime.cancelFrame(frameTimer);
    video.removeEventListener("loadeddata", videoLoaded); video.removeEventListener("error", videoError);
    clock.pause(); clock.srcObject = null; video.pause(); video.srcObject = null;
    source?.disconnect(); sourceStream?.getTracks().forEach(track => track.stop());
    worklet?.port.close(); worklet?.disconnect(); silent.disconnect();
    output.close(); void context.close().catch(() => {});
    control?.close();
    for (const track of tracks) { track.detach(); track.mediaStreamTrack.stop(); }
    tracks.clear();
    if (room) { room.removeAllListeners(); void room.disconnect().catch(() => {}); }
    options.onVideoStatus("stopped", message);
  }
  function aborted() { close(); }
  async function ready(timeoutMs = 2000) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([resumed, workletReady, output.ready?.(timeoutMs)]).then(results => {
          if (closed || context.state !== "running" || context.sampleRate !== 24_000 || results.some(result => result && "error" in result)) {
            throw new Error("Avatar audio could not start. Start voice again.");
          }
        }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Avatar audio startup timed out. Start voice again.")), Math.max(1, Math.min(2000, timeoutMs))); }),
      ]);
    } finally { clearTimeout(timeout); }
  }
  function pump(timestamp: number) {
    if (closed) return;
    frameTimer = runtime.scheduleFrame(pump);
    if ((established && !roomReady) || !videoReady || video.readyState < 2 || timestamp - lastFrameAt < 50 || video.currentTime === lastVideoTime) return;
    const id = frameGate.begin(); if (id === null) return;
    const epoch = videoEpoch, recoveryEpoch = mediaEpoch;
    lastFrameAt = timestamp; lastVideoTime = video.currentTime; lastVideoChangeAt = Date.now();
    const { width, height } = AvatarFrameGate.size(video.videoWidth, video.videoHeight);
    void runtime.createFrame(video, width, height).then(frame => {
      if (closed || epoch !== videoEpoch || recoveryEpoch !== mediaEpoch) { frame.close(); frameGate.ack(id); return; }
      frameFailureSince = undefined;
      try {
        // onVideoFrame transfers ownership. It must either transfer the bitmap
        // into the iframe or close and acknowledge it when no receiver exists.
        options.onVideoFrame({ id, frame });
        // The synchronous handoff may tear down this connection. Availability
        // allows startup to proceed; acknowledgement only releases resources.
        if (closed) return;
        if (!videoLive) { videoLive = true; if (mediaRecoveryTimer === undefined) options.onVideoStatus("live"); }
        connected();
      } catch { frame.close(); frameGate.ack(id); fail("Avatar video could not be displayed. Start voice again."); }
    }, () => {
      frameGate.ack(id);
      if (closed || epoch !== videoEpoch || recoveryEpoch !== mediaEpoch) return;
      // A live video can advance between the ready-state check and bitmap copy.
      // Keep its last good frame and the audio connection while the next frame
      // is attempted. Persistent failure is still bounded and surfaced.
      frameFailureSince ??= Date.now();
      if (Date.now() - frameFailureSince >= 2000) fail("Avatar video could not be decoded. Start voice again.");
    });
  }
  function videoError() { fail("Avatar video failed. Start voice again."); }
  function videoLoaded() {
    if (closed || !videoTrack || videoReady || video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return;
    const epoch = videoEpoch;
    void video.play().then(() => {
      if (closed || epoch !== videoEpoch) return;
      videoReady = true; lastVideoChangeAt = Date.now(); connected();
      if (frameTimer === undefined) frameTimer = runtime.scheduleFrame(pump);
    }, () => { if (epoch === videoEpoch) fail("Avatar video could not start. Start voice again."); });
  }
  function subscribe(track: RemoteTrack) {
    if (closed || tracks.has(track)) return;
    tracks.add(track);
    if (track.kind === "audio") {
      audioTrack = track; audioReady = false;
      void Promise.resolve(output.attach(runtime.createStream(track.mediaStreamTrack))).then(() => {
        if (!closed && audioTrack === track) { audioReady = true; connected(); }
      }, () => { if (audioTrack === track) fail("Avatar speaker could not start. Start voice again."); });
    } else if (track.kind === "video") {
      videoTrack = track; videoReady = false; videoLive = false; videoEpoch++; lastVideoTime = -1;
      video.srcObject = runtime.createStream(track.mediaStreamTrack); videoLoaded();
    }
  }
  function unsubscribe(track: RemoteTrack) {
    if (closed || (track !== audioTrack && track !== videoTrack)) return;
    if (track === audioTrack) { audioTrack = undefined; audioReady = false; }
    if (track === videoTrack) {
      videoTrack = undefined; videoReady = false; videoLive = false; videoEpoch++;
      video.pause(); video.srcObject = null;
    }
    track.detach(); tracks.delete(track); recoverMedia();
  }
  const watchdog = setInterval(() => {
    if (closed) return;
    state.checkTimeout();
    if (frameFailureSince !== undefined && Date.now() - frameFailureSince >= 2000) fail("Avatar video could not be decoded. Start voice again.");
    if (Date.now() - lastKeepAliveAt >= 20_000) { lastKeepAliveAt = Date.now(); state.keepAlive(); }
    if (videoReady && Date.now() - lastVideoChangeAt > 15_000) fail("Avatar video stopped updating. Start voice again.");
  }, 1000);
  video.addEventListener("loadeddata", videoLoaded); video.addEventListener("error", videoError);
  options.signal.addEventListener("abort", aborted, { once: true });
  if (options.signal.aborted) close();
  return {
    ready,
    async attach(stream) {
      if (closed) return;
      await ready();
      if (closed) return;
      source?.disconnect(); sourceStream = stream;
      source = context.createMediaStreamSource(stream); source.connect(worklet!);
      clock.srcObject = stream;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([clock.play(), new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Avatar source audio timed out.")), 5000);
        })]);
      } finally { clearTimeout(deadline); }
    },
    attachInput: stream => output.attachInput(stream), setSpatial: pose => output.setSpatial(pose),
    setMuted: value => state.setMuted(value),
    handleProviderEvent: event => continuous ? false : state.provider(event),
    handleClientEvent: event => {
      if (event.type === "live.enable") {
        continuous = true; worklet?.port.postMessage({ type: "continuous" });
      } else if (event.type === 'live.hold') {
        held = event.held === true;
        if (!held) drainHeld();
      } else if (event.type === "live.interrupt") {
        liveSegments.interrupt(); state.client({ type: "output_audio_buffer.clear" }); options.onSourceActivity?.(false);
      } else state.client(event);
    },
    ackVideoFrame: id => frameGate.ack(id), close,
    async connectAvatar(connection) {
      if (closed || connectionStarted) throw new Error("Avatar connection is no longer available.");
      connectionStarted = true; options.onVideoStatus("connecting");
      try { await ready(); }
      catch { fail("Avatar audio could not start. Start voice again."); throw new Error("Avatar audio could not start."); }
      if (closed) throw new Error("Avatar connection closed.");
      const pending = new Promise<void>((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
      connectTimer = setTimeout(() => fail("Avatar connection timed out. Start voice again."), runtime.connectTimeoutMs);
      try {
        control = new AvatarControlSocket(connection.wsUrl, {
          create: url => runtime.createSocket(url),
          ready: () => { socketReady = true; state.connected(); connected(); },
          event: event => state.avatar(event), fail, canRecover: () => rejectConnection === undefined,
          recovering: () => {
            // A speak_ended event may have been lost during the socket gap.
            // Retire uncertain playback; replay could repeat already heard words.
            liveSegments.interrupt(); state.client({ type: 'output_audio_buffer.clear' });
            options.onSourceActivity?.(false);
          },
        });
        control.start();
        // Neither the lazy SDK import nor room.connect may hold cancellation
        // hostage: the owned pending promise is independently bounded.
        void Promise.resolve(runtime.createRoom()).then(async newRoom => {
          room = newRoom;
          if (closed) { await newRoom.disconnect(); return; }
          newRoom.on("trackSubscribed", subscribe);
          newRoom.on("trackUnsubscribed", unsubscribe);
          newRoom.on("reconnecting", () => { roomReady = false; recoverMedia(); });
          newRoom.on("reconnected", () => { roomReady = true; connected(); });
          newRoom.on("disconnected", () => fail("Avatar media disconnected. Start voice again."));
          await newRoom.connect(connection.livekitUrl, connection.livekitClientToken, { autoSubscribe: true });
          if (closed) { await newRoom.disconnect(); return; }
          roomReady = true;
          newRoom.remoteParticipants.forEach(participant => participant.trackPublications.forEach(publication => {
            if (publication.track) subscribe(publication.track);
          }));
          connected();
        }).catch(() => fail("Avatar media could not connect. Start voice again."));
      } catch { fail("Avatar connection failed. Start voice again."); }
      await pending;
    },
  };
}
