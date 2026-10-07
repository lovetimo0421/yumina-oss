import type { VoicePose } from "../../../sandbox/voice-types";
import type { VoiceAudio } from "./voice-controller";

interface AudioRuntime {
  createContext(): AudioContext;
  createElement(): HTMLAudioElement;
  schedule(callback: () => void): number;
  cancel(id: number): void;
}

/** Created synchronously by the affirmative host consent click. Never uses iframe audio. */
export function createVoiceAudio(onLevel: (value: number) => void, runtime: AudioRuntime = {
  createContext: () => new AudioContext(),
  createElement: () => new Audio(),
  schedule: callback => window.setInterval(callback, 50),
  cancel: id => window.clearInterval(id),
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
  panner.connect(gain); gain.connect(analyser); analyser.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);
  const inputAnalyser = context.createAnalyser(); inputAnalyser.fftSize = 512;
  const inputSamples = new Float32Array(inputAnalyser.fftSize);
  let inputSource: MediaStreamAudioSourceNode | null = null, inputStream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null, muted = false, closed = false, attachment = 0;
  const timer = runtime.schedule(() => {
    if (closed) return;
    if (inputSource && inputStream?.getAudioTracks().some(track => track.enabled)) {
      inputAnalyser.getFloatTimeDomainData(inputSamples);
      let energy = 0; for (const sample of inputSamples) energy += sample * sample;
      onInputLevel(Math.min(1, Math.sqrt(energy / inputSamples.length) * 3));
    } else onInputLevel(0);
    if (muted || !source) { onLevel(0); return; }
    analyser.getFloatTimeDomainData(samples);
    let energy = 0; for (const sample of samples) energy += sample * sample;
    onLevel(Math.min(1, Math.sqrt(energy / samples.length) * 3));
  });
  const set = (param: AudioParam, value: number) => param.setValueAtTime(value, context.currentTime);
  return {
    async ready(timeoutMs = 2000) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          resumed,
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Voice audio unlock timed out. Start voice again.")), Math.max(1, Math.min(timeoutMs, 2000))); }),
        ]);
        if ("error" in result || closed || context.state !== "running") throw new Error("Voice audio speaker could not start. Start voice again.");
      } finally { clearTimeout(deadline); }
    },
    attachInput(stream) {
      if (closed) return;
      inputSource?.disconnect(); inputStream = stream;
      inputSource = context.createMediaStreamSource(stream); inputSource.connect(inputAnalyser);
      // Deliberately no destination connection: microphone input must never echo into output.
    },
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
    setMuted(value) { muted = value; if (!closed) set(gain.gain, value ? 0 : 1); },
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
      closed = true; runtime.cancel(timer);
      playout.pause(); playout.srcObject = null;
      inputSource?.disconnect(); inputAnalyser.disconnect(); inputStream = null;
      source?.disconnect(); panner.disconnect(); gain.disconnect(); analyser.disconnect();
      void context.close().catch(() => {});
    },
  };
}
