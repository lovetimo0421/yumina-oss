/**
 * Volume control that also works on iOS.
 *
 * On iOS Safari `HTMLMediaElement.volume` is **read-only**: assigning to it is
 * silently ignored and reading it back always returns 1. Every iPhone user
 * therefore hears every card's BGM at full blast — the in-card volume slider,
 * fade-in/fade-out and the duck-under-dialogue all do nothing. (Reported by the
 * owner playing 骗子酒馆 on an iPhone: "dragging the volume does nothing".)
 *
 * The workaround is to route the element through Web Audio —
 * `MediaElementSource → GainNode → destination` — because `GainNode.gain` *is*
 * controllable on iOS.
 *
 * Routing an element through Web Audio is **irreversible** (you cannot detach a
 * MediaElementSource), and a mis-routed element plays *silence*. So three rules
 * keep this from ever making things worse than they are today:
 *
 *  1. **Feature-detect, never UA-sniff.** If `el.volume` is actually writable
 *     (all desktop browsers, Android Chrome), volume uses the plain assignment.
 *     Explicit output measurement can request a safe graph; volume alone never
 *     creates an AudioContext on that path.
 *  2. **Same-origin media only.** A cross-origin element without CORS routed
 *     into Web Audio outputs silence. Those keep the plain assignment (still
 *     broken on iOS, but no worse than today).
 *  3. **Never capture into a context that isn't running.** We create and resume
 *     the AudioContext first and only call `createMediaElementSource` once it
 *     reports `running`. A suspended context would mute the element for good.
 */

let volumeWritable: boolean | null = null;

/** Does assigning to `.volume` actually stick in this browser? */
export function isVolumeWritable(): boolean {
  if (volumeWritable !== null) return volumeWritable;
  try {
    const probe = new Audio();
    probe.volume = 0.5;
    volumeWritable = Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    // No Audio constructor (SSR/tests) — assume the normal path.
    volumeWritable = true;
  }
  return volumeWritable;
}

let ctx: AudioContext | null = null;
interface MediaGraph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  analyser?: AnalyserNode;
  samples?: Float32Array<ArrayBuffer>;
}
const graphs = new WeakMap<HTMLMediaElement, MediaGraph>();
/** Elements we know can never be routed (cross-origin, no Web Audio). Don't retry. */
const unroutable = new WeakSet<HTMLMediaElement>();
/** Last value we were asked for, so `getElVolume` is truthful on iOS. */
const wanted = new WeakMap<HTMLMediaElement, number>();

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Create/resume the shared context. Returns it only when it is actually running. */
function runningContext(): AudioContext | null {
  if (!ctx) {
    const AC = getAudioContextCtor();
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    // Fire-and-forget: iOS resumes this inside a user gesture. If it is still
    // suspended we simply don't route this element yet and try again next time.
    void ctx.resume().catch(() => {});
  }
  return ctx.state === "running" ? ctx : null;
}

/** Media we may safely pull into the graph. Cross-origin without CORS = silence. */
function isSameOriginMedia(el: HTMLMediaElement): boolean {
  const src = el.currentSrc || el.src || "";
  if (!src) return false;
  try {
    const u = new URL(src, window.location.href);
    if (u.protocol === "blob:" || u.protocol === "data:") return true;
    return u.origin === window.location.origin;
  } catch {
    return false;
  }
}

function gainFor(el: HTMLMediaElement): GainNode | null {
  const existing = graphs.get(el);
  if (existing) return existing.gain;
  if (unroutable.has(el)) return null;

  if (!isSameOriginMedia(el) || !getAudioContextCtor()) {
    // Permanent — remember so we stop probing on every volume tick.
    unroutable.add(el);
    return null;
  }
  // NOT permanent: the context may just not be awake yet. Retry next call.
  const c = runningContext();
  if (!c) return null;

  try {
    // Prepare the playable destination before capturing irreversibly. If gain
    // allocation/connection fails, the element keeps its ordinary output.
    const gain = c.createGain();
    // Desktop still uses the element's volume: adding analysis must not apply
    // that same volume again through the gain.
    gain.gain.value = isVolumeWritable() ? 1 : wanted.get(el) ?? 1;
    gain.connect(c.destination);
    const source = c.createMediaElementSource(el);
    source.connect(gain);
    graphs.set(el, { context: c, source, gain });
    return gain;
  } catch {
    unroutable.add(el);
    return null;
  }
}

/** Set an element's effective volume (0–1). */
export function setElVolume(el: HTMLMediaElement, volume: number): void {
  const v = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
  wanted.set(el, v);
  if (isVolumeWritable()) {
    el.volume = v;
    return;
  }
  const gain = gainFor(el);
  if (gain) gain.gain.value = v;
  else el.volume = v; // best effort; a no-op on iOS but never worse than before
}

/**
 * Read an element's effective volume.
 *
 * Fades read the current volume to ramp from it. On iOS `el.volume` always
 * reports 1, so a fade-out would start from full and jump — hence we answer
 * from the last value we were asked to set.
 */
export function getElVolume(el: HTMLMediaElement): number {
  if (isVolumeWritable()) return el.volume;
  const gain = graphs.get(el)?.gain;
  if (gain) return gain.gain.value;
  return wanted.get(el) ?? el.volume;
}

/** Measured output RMS, scaled/clamped to 0–1. Undefined means unavailable,
 * never an inferred level. Reuse the iOS volume graph rather than capturing
 * its element a second time. Cross-origin and suspended contexts stay on the
 * existing playable path. The analyser is a tap; it cannot alter playback. */
export function getElAudioLevel(el: HTMLMediaElement): number | undefined {
  if (!gainFor(el)) return undefined;
  const graph = graphs.get(el)!;
  if (graph.context.state !== 'running') return undefined;
  try {
    if (!graph.analyser) {
      const analyser = graph.context.createAnalyser();
      analyser.fftSize = 512;
      graph.gain.connect(analyser);
      graph.analyser = analyser;
      graph.samples = new Float32Array(analyser.fftSize);
    }
    const samples = graph.samples!;
    graph.analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) {
      if (!Number.isFinite(value)) return undefined;
      sum += value * value;
    }
    return Math.min(1, Math.sqrt(sum / samples.length) * 4);
  } catch { return undefined; }
}

/** Once routed, a suspended context also suspends this element's output. */
export function isElAudioOutputRunning(el: HTMLMediaElement): boolean {
  const graph = graphs.get(el);
  return !graph || graph.context.state === 'running';
}

/** Release only a retired element, after its owner pauses it and clears src.
 * Other elements retain the shared context and their independent graphs. */
export function releaseMediaElement(el: HTMLMediaElement): void {
  const graph = graphs.get(el);
  if (!graph) return;
  graph.source.disconnect();
  graph.gain.disconnect();
  graph.analyser?.disconnect();
  graphs.delete(el);
  // MediaElementSource ownership is irreversible even after disconnecting.
  unroutable.add(el);
}

/** Test seam: forget the cached feature-detect and graph state. */
export function __resetMediaVolumeForTests(): void {
  volumeWritable = null;
  ctx = null;
}
