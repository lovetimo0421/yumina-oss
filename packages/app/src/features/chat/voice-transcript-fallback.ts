/** A second ear for live voice. The live model sometimes hears the player and answers, yet
 * never sends their words as a transcript (a treason the world never learns of). The host keeps
 * the last seconds of raw microphone audio; when a stretch of speech gets no transcript in time,
 * that stretch is transcribed through /api/voice-input and given to the world as the player's line.
 * Opt-in with holdFloor. Nothing is stored; only an unanswered stretch is ever uploaded. */
export const INPUT_TAIL_WORKLET = `
class InputTail extends AudioWorkletProcessor {
  constructor() {
    super(); this.size = Math.ceil(sampleRate * 20); this.ring = new Float32Array(this.size); this.at = 0; this.filled = 0;
    this.port.onmessage = ({data}) => {
      if (!data || data.type !== 'tail') return;
      const n = Math.max(0, Math.min(this.filled, Math.round(data.seconds * sampleRate)));
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = this.ring[(this.at - n + i + this.size) % this.size];
      this.port.postMessage({ id: data.id, samples: out, sampleRate }, [out.buffer]);
    };
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (!input) return true;
    for (let i = 0; i < input.length; i++) { this.ring[this.at] = input[i]; this.at = (this.at + 1) % this.size; }
    this.filled = Math.min(this.size, this.filled + input.length);
    return true;
  }
}
registerProcessor('yumina-input-tail', InputTail);
`;

export interface InputTail { tail(seconds: number): Promise<{ samples: Float32Array; sampleRate: number } | null>; close(): void }

export async function createInputTail(context: AudioContext, source: AudioNode): Promise<InputTail | null> {
  if (!context.audioWorklet) return null;
  const url = URL.createObjectURL(new Blob([INPUT_TAIL_WORKLET], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(context, "yumina-input-tail", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    // Pulled by a silent sink so it keeps rendering; it never reaches the speakers audibly.
    const sink = context.createGain(); sink.gain.value = 0;
    source.connect(node); node.connect(sink); sink.connect(context.destination);
    let seq = 0;
    const pending = new Map<number, (value: { samples: Float32Array; sampleRate: number } | null) => void>();
    node.port.onmessage = ({ data }) => { const done = pending.get(data?.id); if (done) { pending.delete(data.id); done({ samples: data.samples, sampleRate: data.sampleRate }); } };
    return {
      tail(seconds) {
        return new Promise(resolve => {
          const id = ++seq; pending.set(id, resolve);
          node.port.postMessage({ type: "tail", id, seconds });
          setTimeout(() => { if (pending.delete(id)) resolve(null); }, 1000);
        });
      },
      close() {
        try { source.disconnect(node); } catch { /* Already detached. */ }
        node.disconnect(); sink.disconnect(); node.port.close();
        for (const done of pending.values()) done(null); pending.clear();
      },
    };
  } catch { return null; }
  finally { URL.revokeObjectURL(url); }
}

/** 16 kHz mono 16-bit WAV: small, and every speech-to-text provider takes it. */
export function encodeWav(samples: Float32Array, sampleRate: number, targetRate = 16000): Blob {
  const step = sampleRate / targetRate, length = Math.floor(samples.length / step);
  const data = new DataView(new ArrayBuffer(44 + length * 2));
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) data.setUint8(at + i, value.charCodeAt(i)); };
  text(0, "RIFF"); data.setUint32(4, 36 + length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, targetRate, true); data.setUint32(28, targetRate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  text(36, "data"); data.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const from = Math.floor(i * step), to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0; for (let j = from; j < to && j < samples.length; j++) sum += samples[j]!;
    const value = Math.max(-1, Math.min(1, sum / (to - from)));
    data.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

export interface FallbackDeps {
  tail(seconds: number): Promise<{ samples: Float32Array; sampleRate: number } | null>;
  transcribe(clip: Blob): Promise<string | null>;
  emit(text: string): void;
  now?(): number;
  schedule?(callback: () => void, ms: number): unknown;
}

/** Speech energy above this (raw microphone, 0..1 meter scale) is the player talking. */
const SPEECH = 0.025;
/** A stretch ends after this much quiet (clause pauses stay inside it). */
const QUIET_MS = 1200;
/** A stretch shorter than this is a cough or a click. */
const MIN_SPEECH_MS = 500;
/** How long the live model gets to transcribe a stretch before the second ear does. */
const WAIT_MS = 7000;

export class TranscriptFallback {
  private start?: number;
  private last = 0;
  private heardAt = -Infinity;
  private closed = false;
  constructor(private deps: FallbackDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private later(callback: () => void, ms: number) { (this.deps.schedule ?? setTimeout)(callback, ms); }

  /** Raw microphone level, sampled often (before any floor hold). */
  level(value: number): void {
    if (this.closed) return;
    const now = this.now();
    if (value >= SPEECH) { this.start ??= now; this.last = now; return; }
    if (this.start === undefined || now - this.last < QUIET_MS) return;
    const start = this.start, end = this.last; this.start = undefined;
    if (end - start < MIN_SPEECH_MS) return;
    this.later(() => void this.check(start, end), WAIT_MS);
  }
  /** The live model transcribed something the player said. */
  heard(): void { this.heardAt = this.now(); }
  close(): void { this.closed = true; }

  private async check(start: number, end: number): Promise<void> {
    if (this.closed || this.heardAt >= start) return;
    // From just before the speech to just after it; the ring holds the last 20 s.
    const seconds = Math.min(19, (this.now() - start) / 1000 + 0.4);
    const clip = await this.deps.tail(seconds);
    if (!clip || this.closed || this.heardAt >= start) return;
    const keep = Math.round(((end - start) / 1000 + 0.7) * clip.sampleRate);
    const samples = clip.samples.subarray(0, Math.min(clip.samples.length, keep));
    const text = (await this.deps.transcribe(encodeWav(samples, clip.sampleRate)).catch(() => null))?.trim();
    if (text && !this.closed && this.heardAt < start) this.deps.emit(text);
  }
}
