import type { VoicePose } from '../../../sandbox/voice-types';
import { captureWorkletSource } from './voice-pcm-capture-worklet';

/** Scheduled render samples, rather than received bytes or response age. */
export class PCMPlayback {
  private segments: { source: AudioBufferSourceNode; start: number; samples: number }[] = [];
  private completed = 0;
  private received = 0;
  private end = 0;
  private epoch: number | null = null;
  constructor(private readonly context: AudioContext, private readonly destination: AudioNode) {}
  get playedSamples(): number {
    let count = this.completed;
    for (const s of this.segments) count += Math.max(0, Math.min(s.samples, Math.floor((this.context.currentTime - s.start) * 24000 + 1e-7)));
    return Math.min(this.received, count);
  }
  get pendingSamples(): number { return this.received - this.playedSamples; }
  enqueue(pcm: Uint8Array, epoch: number): void {
    if (!pcm.length || pcm.length % 2 || pcm.length > 4800) throw Error('Invalid PCM frame');
    if (this.epoch !== epoch) { this.flush(); this.epoch = epoch; }
    const samples = pcm.length / 2;
    if (this.pendingSamples + samples > 48000) throw Error('Voice output queue exceeded two seconds');
    // Retire completed segments even when device onended callbacks are delayed.
    this.segments = this.segments.filter(s => {
      if (this.context.currentTime + 1e-9 < s.start + s.samples / 24000) return true;
      this.completed += s.samples; s.source.disconnect(); return false;
    });
    const values = new Float32Array(samples), view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < samples; i++) values[i] = view.getInt16(i * 2, true) / 32768;
    const buffer = this.context.createBuffer(1, samples, 24000); buffer.copyToChannel(values, 0);
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.destination);
    const start = Math.max(this.context.currentTime, this.end);
    source.start(start); this.end = start + samples / 24000;
    this.segments.push({ source, start, samples }); this.received += samples;
  }
  flush(): number {
    const played = this.playedSamples;
    for (const s of this.segments) { s.source.onended = null; try { s.source.stop(); } catch { /* Already ended. */ } s.source.disconnect(); }
    this.segments = []; this.completed = this.received = 0; this.end = 0; this.epoch = null;
    return played;
  }
}

export interface PCMCaptureFrame { epoch: number; sequence: number; pcm: ArrayBuffer }
export interface BalanceAudio {
  ready(): Promise<void>;
  capture(stream: MediaStream, epoch: number, frame: (value: PCMCaptureFrame) => void, fail: () => void): Promise<void>;
  pauseInput(paused: boolean): void;
  enqueue(pcm: Uint8Array, epoch: number): void;
  readonly playedSamples: number;
  readonly pendingSamples: number;
  flush(): number;
  setMuted(muted: boolean): void;
  setSpatial(pose: VoicePose): void;
  close(): void;
}

/** Created in trusted affirmative consent. Microphone and speaker graphs are
 * disjoint; the worklet has a zeroed destination solely to keep capture running. */
export function createBalanceAudio(onLevel: (n: number) => void, onInputLevel: (n: number) => void): BalanceAudio {
  const context = new AudioContext(), panner = context.createPanner(), gain = context.createGain(), analyser = context.createAnalyser();
  panner.panningModel = 'HRTF'; panner.distanceModel = 'linear'; panner.refDistance = 1.5; panner.maxDistance = 12; panner.rolloffFactor = .4;
  analyser.fftSize = 512; panner.connect(gain); gain.connect(analyser); analyser.connect(context.destination);
  const playback = new PCMPlayback(context, panner), resumed = context.resume().then(() => true, () => false);
  let closed = false, muted = false, paused = false, moduleUrl: string | null = null, source: MediaStreamAudioSourceNode | null = null, worklet: AudioWorkletNode | null = null;
  const samples = new Float32Array(512);
  const timer = setInterval(() => { analyser.getFloatTimeDomainData(samples); onLevel(closed || muted ? 0 : Math.min(1, Math.sqrt(samples.reduce((n, v) => n + v * v, 0) / samples.length) * 3)); }, 100);
  const set = (param: AudioParam, value: number) => param.setValueAtTime(value, context.currentTime);
  return {
    async ready() { if (!await resumed || closed || context.state !== 'running') throw Error('Voice speaker could not start'); },
    async capture(stream, epoch, frame, fail) {
      const url = URL.createObjectURL(new Blob([captureWorkletSource], { type: 'text/javascript' })); moduleUrl = url;
      try { await context.audioWorklet.addModule(url); } finally { if (moduleUrl === url) { URL.revokeObjectURL(url); moduleUrl = null; } }
      if (closed) return;
      worklet = new AudioWorkletNode(context, 'yumina-balance-capture-v1', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { epoch } });
      worklet.onprocessorerror = fail;
      worklet.port.onmessage = ({ data }) => {
        if (closed) return;
        if (data?.type === 'failure') { fail(); return; }
        if (data?.type !== 'pcm') { fail(); return; }
        try {
          frame(data);
          if (closed) return;
          if (!closed) worklet?.port.postMessage({ type: 'ack', sequence: data.sequence });
          const pcm = new DataView(data.pcm); let energy = 0;
          for (let i = 0; i < pcm.byteLength; i += 2) energy += (pcm.getInt16(i, true) / 32768) ** 2;
          onInputLevel(paused ? 0 : Math.min(1, Math.sqrt(energy / 480) * 3));
        } catch { fail(); }
      };
      worklet.port.postMessage({ type: 'pause', paused });
      source = context.createMediaStreamSource(stream); source.connect(worklet); worklet.connect(context.destination);
    },
    pauseInput(value) { paused = value; worklet?.port.postMessage({ type: 'pause', paused }); if (paused) onInputLevel(0); },
    enqueue: (pcm, epoch) => playback.enqueue(pcm, epoch),
    get playedSamples() { return playback.playedSamples; }, get pendingSamples() { return playback.pendingSamples; },
    flush: () => playback.flush(),
    setMuted(value) { muted = value; if (!closed) set(gain.gain, value ? 0 : 1); },
    setSpatial(pose) {
      if (closed) return; const l = context.listener;
      set(l.positionX, pose.x); set(l.positionY, 1.6); set(l.positionZ, pose.z);
      set(l.forwardX, -Math.sin(pose.yaw)); set(l.forwardY, 0); set(l.forwardZ, -Math.cos(pose.yaw));
      set(l.upX, 0); set(l.upY, 1); set(l.upZ, 0);
      set(panner.positionX, pose.sourceX); set(panner.positionY, 1.45); set(panner.positionZ, pose.sourceZ);
    },
    close() {
      if (closed) return; closed = true; clearInterval(timer); playback.flush(); source?.disconnect();
      if (moduleUrl) { URL.revokeObjectURL(moduleUrl); moduleUrl = null; }
      if (worklet) { worklet.port.onmessage = null; worklet.onprocessorerror = null; worklet.port.postMessage({ type: 'stop' }); worklet.port.close(); worklet.disconnect(); }
      panner.disconnect(); gain.disconnect(); analyser.disconnect(); onLevel(0); onInputLevel(0); void context.close().catch(() => {});
    },
  };
}
