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
 *     (all desktop browsers, Android Chrome), we do the plain assignment and no
 *     AudioContext is ever created. That path is byte-for-byte the old behaviour.
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
const gains = new WeakMap<HTMLMediaElement, GainNode>();
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
  const existing = gains.get(el);
  if (existing) return existing;
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
    const source = c.createMediaElementSource(el);
    const gain = c.createGain();
    gain.gain.value = wanted.get(el) ?? 1;
    source.connect(gain).connect(c.destination);
    gains.set(el, gain);
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
  const gain = gains.get(el);
  if (gain) return gain.gain.value;
  return wanted.get(el) ?? el.volume;
}

/** Test seam: forget the cached feature-detect and graph state. */
export function __resetMediaVolumeForTests(): void {
  volumeWritable = null;
  ctx = null;
}
