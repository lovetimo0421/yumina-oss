import type { VoicePose } from "../../../sandbox/voice-types";
import type { VoiceAudio } from "./voice-controller";
import { createVoiceInputMonitor, type VoiceInputMonitor } from './voice-input-monitor';
import { createFloorHold, type FloorHold } from './voice-floor-hold';
import { createInputTail, type InputTail } from './voice-transcript-fallback';

interface AudioRuntime {
  createContext(): AudioContext;
  createElement(): HTMLAudioElement;
  schedule(callback: () => void): number;
  cancel(id: number): void;
  createInputMonitor?(context: AudioContext, source: MediaStreamAudioSourceNode): Promise<VoiceInputMonitor>;
}

/** Created synchronously by the affirmative host consent click. Never uses iframe audio. */
export function createVoiceAudio(onLevel: (value: number) => void, runtime: AudioRuntime = {
  createContext: () => new AudioContext(),
  createElement: () => new Audio(),
  schedule: callback => window.setInterval(callback, 50),
  cancel: id => window.clearInterval(id),
  createInputMonitor: createVoiceInputMonitor,
}, onInputLevel: (value: number) => void = () => {}): VoiceAudio {
  const context = runtime.createContext();
  // Chromium needs a playing media element to start the remote WebRTC playout
  // clock. A MediaStreamAudioSourceNode alone can receive packets but emit only
  // zeroes. This element is always muted: the spatial graph is the sole speaker.
  const playout = runtime.createElement();
  playout.muted = true;
  playout.setAttribute("playsinline", "");
  // Start in the trusted click. Store an observed outcome immediately so a
  // rejection while consent is settling cannot become an unhandled promise.
  let resumed: Promise<{ error?: unknown }>;
  try { resumed = context.resume().then(() => ({}), error => ({ error })); }
  catch (error) { resumed = Promise.resolve({ error }); }
  const panner = context.createPanner(), gain = context.createGain(), analyser = context.createAnalyser();
  // Dialogue must carry across a room. Keep the existing directional colour
  // and nearby level, but bound distance attenuation: the old inverse curve
  // cut speech by over 7 dB at the door and 13 dB across this apartment.
  panner.panningModel = "HRTF"; panner.distanceModel = "linear";
  panner.refDistance = 1.5; panner.maxDistance = 12; panner.rolloffFactor = 0.4;
  analyser.fftSize = 512;
  // The original voice, untouched (owner: keep it; raise the level in the edit instead).
  panner.connect(gain); gain.connect(analyser); analyser.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);
  const inputAnalyser = context.createAnalyser(); inputAnalyser.fftSize = 512;
  const inputSamples = new Float32Array(inputAnalyser.fftSize);
  let inputSource: MediaStreamAudioSourceNode | null = null, inputStream: MediaStream | null = null;
  let inputMonitor: VoiceInputMonitor | undefined;
  let liveDestination: MediaStreamAudioDestinationNode | undefined, liveClock: ConstantSourceNode | undefined;
  // Opt-in (holdFloor): the microphone reaches the live model through this hold.
  let floor: FloorHold | null = null;
  let inputTail: InputTail | null = null;
  let inputAttachment = 0;
  let source: MediaStreamAudioSourceNode | null = null, muted = false, closed = false, attachment = 0;
  // Live transport without an avatar: the session gates speculative output here.
  let liveAllowed = true, held = false, dipTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = runtime.schedule(() => {
    if (closed) return;
    if (inputSource && inputStream?.getAudioTracks().some(track => track.enabled)) {
      inputAnalyser.getFloatTimeDomainData(inputSamples);
      let energy = 0; for (const sample of inputSamples) energy += sample * sample;
      onInputLevel(Math.min(1, Math.sqrt(energy / inputSamples.length) * 3));
    } else onInputLevel(0);
    if (muted || !liveAllowed || held || !source) { onLevel(0); return; }
    analyser.getFloatTimeDomainData(samples);
    let energy = 0; for (const sample of samples) energy += sample * sample;
    onLevel(Math.min(1, Math.sqrt(energy / samples.length) * 3));
  });
  const set = (param: AudioParam, value: number) => param.setValueAtTime(value, context.currentTime);
  // Diagnosis only (read by browser QA): what gates the speaker right now, and the last gate changes.
  const gateLog: { t: number; what: string; value: unknown }[] = [];
  const noteGate = (what: string, value: unknown) => { gateLog.push({ t: Math.round(performance.now()), what, value }); if (gateLog.length > 300) gateLog.shift(); };
  try {
    (globalThis as { __voiceAudio?: () => unknown }).__voiceAudio = () => ({
      gain: gain.gain.value, muted, liveAllowed, held, dipping: Boolean(dipTimer), context: context.state, log: gateLog.slice(-40),
    });
  } catch { /* No global. */ }
  const VOICE_GAIN = 1;
  const applyGain = () => { if (!closed) set(gain.gain, muted || !liveAllowed || held ? 0 : VOICE_GAIN); };
  const closeLiveInput = () => {
    if (liveClock) {
      try { liveClock.stop(); } catch { /* Setup may have failed before start. */ }
      liveClock.disconnect(); liveClock = undefined;
    }
    if (floor) {
      try { inputSource?.disconnect(floor.node); } catch { /* Setup may not have connected input yet. */ }
      floor.close(); floor = null;
    }
    inputTail?.close(); inputTail = null;
    if (liveDestination) {
      try { inputSource?.disconnect(liveDestination); } catch { /* Setup may not have connected input yet. */ }
      liveDestination.stream.getTracks().forEach(track => track.stop());
      liveDestination.disconnect(); liveDestination = undefined;
    }
  };
  async function ready(timeoutMs = 2000) {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        resumed,
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Voice audio unlock timed out. Start voice again.")), Math.max(1, Math.min(timeoutMs, 2000))); }),
      ]);
      if ("error" in result || closed || context.state !== "running") throw new Error("Voice audio speaker could not start. Start voice again.");
    } finally { clearTimeout(deadline); }
  }
  return {
    ready,
    async attachInput(stream) {
      if (closed) return;
      const current = ++inputAttachment;
      inputMonitor?.close(); inputMonitor = undefined;
      inputSource?.disconnect(); inputStream = stream;
      inputSource = context.createMediaStreamSource(stream); inputSource.connect(inputAnalyser);
      if (liveDestination) inputSource.connect(floor?.node ?? liveDestination);
      // The meter never feeds speakers; the monitor branch emits only zeros.
      const monitor = await runtime.createInputMonitor?.(context, inputSource);
      if (closed || current !== inputAttachment) monitor?.close(); else inputMonitor = monitor;
    },
    async prepareLiveInput(options) {
      await ready();
      if (closed || !inputSource || !inputStream?.getAudioTracks().some(track => track.readyState === 'live')) {
        throw new Error('Live microphone audio is unavailable. Start voice again.');
      }
      if (liveDestination) return liveDestination.stream;
      try {
        liveDestination = context.createMediaStreamDestination();
        // Live output follows the incoming WebRTC media clock. Disabling the
        // negotiated track stalls it, even after provider input mute succeeds.
        // An active zero-valued source keeps rendering while the original mic
        // track remains locally disabled for privacy and echo protection.
        liveClock = context.createConstantSource(); liveClock.offset.value = 0;
        liveClock.connect(liveDestination);
        if (options?.holdFloor) {
          floor = await createFloorHold(context);
          if (closed || !liveDestination) throw new Error('closed');
          floor?.node.connect(liveDestination);
          // The second ear: the last seconds of raw microphone, for words the live model never transcribes.
          inputTail = await createInputTail(context, inputSource);
        }
        inputSource.connect(floor?.node ?? liveDestination);
        liveClock.start();
        return liveDestination.stream;
      } catch {
        closeLiveInput();
        throw new Error('Live microphone audio could not start. Start voice again.');
      }
    },
    inputEvidence: () => inputMonitor?.probe() ?? Promise.resolve('unknown'),
    inputTail: seconds => inputTail?.tail(seconds) ?? Promise.resolve(null),
    async attach(stream) {
      if (closed) return;
      const current = ++attachment;
      source?.disconnect(); source = context.createMediaStreamSource(stream); source.connect(panner);
      playout.srcObject = stream;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          playout.play(),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Voice speaker timed out.")), 5000); }),
        ]);
      } catch (error) {
        if (!closed && current === attachment) throw error;
      } finally { clearTimeout(deadline); }
    },
    setMuted(value) { muted = value; noteGate('muted', value); applyGain(); },
    handleClientEvent(event) {
      if (closed) return;
      noteGate(String(event.type), event.allowed ?? event.held ?? null);
      if (event.type === 'live.output') { liveAllowed = event.allowed === true; applyGain(); }
      else if (event.type === 'live.hold') { held = event.held === true; applyGain(); }
      else if (event.type === 'live.floor') floor?.hold(event.held === true);
      else if (event.type === 'live.interrupt') {
        // A live track cannot be cleared; dip the speaker while the provider yields.
        clearTimeout(dipTimer); set(gain.gain, 0);
        dipTimer = setTimeout(() => { dipTimer = undefined; applyGain(); }, 250);
      }
    },
    setSpatial(pose: VoicePose) {
      if (closed) return;
      const listener = context.listener;
      set(listener.positionX, pose.x); set(listener.positionY, 1.6); set(listener.positionZ, pose.z);
      set(listener.forwardX, -Math.sin(pose.yaw)); set(listener.forwardY, 0); set(listener.forwardZ, -Math.cos(pose.yaw));
      set(listener.upX, 0); set(listener.upY, 1); set(listener.upZ, 0);
      set(panner.positionX, pose.sourceX); set(panner.positionY, 1.45); set(panner.positionZ, pose.sourceZ);
    },
    close() {
      if (closed) return;
      closed = true; runtime.cancel(timer); clearTimeout(dipTimer);
      closeLiveInput();
      inputMonitor?.close(); inputMonitor = undefined;
      playout.pause(); playout.srcObject = null;
      inputSource?.disconnect(); inputAnalyser.disconnect(); inputStream = null;
      source?.disconnect(); panner.disconnect(); gain.disconnect(); analyser.disconnect();
      void context.close().catch(() => {});
    },
  };
}
