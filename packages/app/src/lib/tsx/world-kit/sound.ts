/**
 * Sound for a world without sound files: rain, room tone, a fire, a city at night, wind, a ticking clock, a
 * telescreen's hum, a fluorescent tube's buzz, a room of people talking low. Each is made in WebAudio from
 * noise and oscillators, placed at a point (or everywhere), and fades with distance from where the player
 * stands. A card's own audio asset plays the same way. Nothing makes a sound until the player first clicks,
 * taps or presses a key (browsers allow no sooner), and the pause menu has a mute.
 */

export const SOUND_KINDS = ["rain", "room", "fire", "city", "wind", "clock", "hum", "buzz", "murmur", "drip"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

export interface SoundOptions {
  /** Where it comes from [x, y, z] or [x, z]; leave out for a sound that is everywhere (rain on the roof, wind). */
  at?: number[];
  /** 0..1 (default per kind). */
  volume?: number;
  /** Metres at which it is half as loud (default 2). */
  near?: number;
  loop?: boolean;
}
export interface SoundHandle { setVolume(v: number): void; stop(): void; moveTo(at: number[]): void }

type Spec = { kind?: SoundKind; bytes?: () => Promise<ArrayBuffer | null>; o: SoundOptions; handle: SoundRec };
type SoundRec = SoundHandle & { gain: GainNode | null; panner: PannerNode | null; nodes: AudioScheduledSourceNode[]; timers: number[]; volume: number; at?: number[]; stopped: boolean };

const DEFAULT_VOL: Record<SoundKind, number> = { rain: 0.5, room: 0.35, fire: 0.6, city: 0.45, wind: 0.45, clock: 0.35, hum: 0.25, buzz: 0.18, murmur: 0.4, drip: 0.4 };

export class Soundscape {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private specs: Spec[] = [];
  private noise: Record<string, AudioBuffer> = {};
  private muted = false;
  private duck = 1;
  private off: (() => void)[] = [];
  private disposed = false;

  constructor(private win: Window, target: EventTarget) {
    const start = () => this.start();
    for (const ev of ["pointerdown", "keydown", "touchstart"]) {
      target.addEventListener(ev, start, { passive: true });
      win.document.addEventListener(ev, start, { passive: true });
      this.off.push(() => { target.removeEventListener(ev, start); win.document.removeEventListener(ev, start); });
    }
    try { this.muted = win.localStorage?.getItem("ywk-muted") === "1"; } catch { /* the sandbox may have no storage */ }
  }

  get isMuted() { return this.muted; }
  get started() { return Boolean(this.ctx); }

  add(kind: SoundKind | null, o: SoundOptions, bytes?: () => Promise<ArrayBuffer | null>): SoundHandle {
    const rec: SoundRec = {
      gain: null, panner: null, nodes: [], timers: [], volume: o.volume ?? (kind ? DEFAULT_VOL[kind] : 0.8), at: o.at, stopped: false,
      setVolume: (v) => { rec.volume = v; if (rec.gain && this.ctx) rec.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.2); },
      stop: () => {
        rec.stopped = true;
        for (const t of rec.timers) this.win.clearTimeout(t);
        if (rec.gain && this.ctx) rec.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
        const nodes = rec.nodes;
        this.win.setTimeout(() => { for (const n of nodes) { try { n.stop(); } catch { /* fine */ } } }, 1500);
      },
      moveTo: (at) => { rec.at = at; this.place(rec); },
    };
    const spec: Spec = { kind: kind ?? undefined, bytes, o, handle: rec };
    this.specs.push(spec);
    if (this.ctx) void this.build(spec);
    return rec;
  }

  start() {
    if (this.ctx || this.disposed) { void this.ctx?.resume?.(); return; }
    const AC = (this.win as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      || (this.win as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch { return; }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.duck, ctx.currentTime + 0.05, 0.8);
    void ctx.resume?.();
    for (const s of this.specs) void this.build(s);
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { this.win.localStorage?.setItem("ywk-muted", m ? "1" : "0"); } catch { /* fine */ }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.duck, this.ctx.currentTime, 0.15);
  }
  /** Quieter while the pause menu is open. */
  setDuck(d: number) {
    this.duck = d;
    if (this.master && this.ctx && !this.muted) this.master.gain.setTargetAtTime(d, this.ctx.currentTime, 0.25);
  }

  /** The player's ears: where the camera is and which way it looks. */
  listen(px: number, py: number, pz: number, fx: number, fy: number, fz: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const L = ctx.listener;
    if (L.positionX) {
      const t = ctx.currentTime;
      L.positionX.setTargetAtTime(px, t, 0.03); L.positionY.setTargetAtTime(py, t, 0.03); L.positionZ.setTargetAtTime(pz, t, 0.03);
      L.forwardX.setTargetAtTime(fx, t, 0.03); L.forwardY.setTargetAtTime(fy, t, 0.03); L.forwardZ.setTargetAtTime(fz, t, 0.03);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      (L as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(px, py, pz);
      (L as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  dispose() {
    this.disposed = true;
    for (const f of this.off) f();
    for (const s of this.specs) { for (const t of s.handle.timers) this.win.clearTimeout(t); }
    void this.ctx?.close?.();
    this.ctx = null;
  }

  // ---------- building ----------

  private place(rec: SoundRec) {
    const p = rec.panner, at = rec.at;
    if (!p || !at || !this.ctx) return;
    const x = at[0], y = at.length === 3 ? at[1] : 1.2, z = at[at.length - 1];
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }

  private async build(spec: Spec) {
    const ctx = this.ctx!, rec = spec.handle;
    if (rec.stopped || rec.gain) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    rec.gain = gain;
    if (spec.o.at) {
      const p = ctx.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = spec.o.near ?? 2;
      p.rolloffFactor = 1.3;
      p.maxDistance = 60;
      rec.panner = p;
      this.place(rec);
      gain.connect(p).connect(this.master!);
    } else gain.connect(this.master!);
    try {
      if (spec.bytes) {
        const data = await spec.bytes();
        if (!data || rec.stopped) return;
        const buf = await ctx.decodeAudioData(data.slice(0));
        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = spec.o.loop !== false;
        src.connect(gain); src.start();
        rec.nodes.push(src);
      } else if (spec.kind) this.synth(spec.kind, gain, rec);
    } catch (e) { console.warn("[world] a sound could not play", e); return; }
    gain.gain.setTargetAtTime(rec.volume, ctx.currentTime, 0.6);
  }

  /** Noise buffers, made once: white, pink (Kellet) and brown (integrated), 4 s, looped. */
  private buf(kind: "white" | "pink" | "brown" | "crackle" | "drops" | "tick"): AudioBuffer {
    if (this.noise[kind]) return this.noise[kind];
    const ctx = this.ctx!, sr = ctx.sampleRate;
    const seconds = kind === "tick" ? 2 : kind === "crackle" ? 7 : 4;
    const b = ctx.createBuffer(1, Math.floor(sr * seconds), sr);
    const d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    const r = () => Math.random() * 2 - 1;
    if (kind === "white") for (let i = 0; i < d.length; i++) d[i] = r() * 0.5;
    else if (kind === "pink") for (let i = 0; i < d.length; i++) {
      const w = r();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    } else if (kind === "brown") for (let i = 0; i < d.length; i++) { last = (last + 0.02 * r()) / 1.02; d[i] = last * 3.5; }
    else if (kind === "crackle" || kind === "drops") {
      // sparse sharp pops (a fire's crackle) or soft taps (drops on glass and sill), each a short decaying burst
      const n = kind === "crackle" ? 70 : 900;
      for (let k = 0; k < n; k++) {
        const at = Math.floor(Math.random() * (d.length - sr * 0.05));
        const amp = kind === "crackle" ? 0.25 + Math.random() ** 3 * 0.75 : 0.05 + Math.random() ** 2 * 0.3;
        const len = Math.floor(sr * (kind === "crackle" ? 0.002 + Math.random() * 0.012 : 0.004 + Math.random() * 0.01));
        const decay = kind === "crackle" ? 3 : 5;
        for (let i = 0; i < len; i++) d[at + i] += r() * amp * Math.exp(-decay * i / len);
        if (kind === "crackle" && Math.random() < 0.3) {
          // a pop is often a short run of smaller ones
          for (let j = 1; j < 4; j++) { const a2 = at + Math.floor(sr * 0.012 * j * (0.5 + Math.random())); for (let i = 0; i < len && a2 + i < d.length; i++) d[a2 + i] += r() * amp * 0.4 * Math.exp(-3 * i / len); }
        }
      }
    } else if (kind === "tick") {
      // tick at 0 s, tock at 1 s: a click of the escapement, then its ring in the case
      for (const [t0, f] of [[0, 3300], [1, 2500]] as const) {
        const s0 = Math.floor(t0 * sr), len = Math.floor(sr * 0.05);
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          d[s0 + i] += (r() * Math.exp(-t * 900) * 0.8 + Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 160) * 0.35);
        }
      }
    }
    this.noise[kind] = b;
    return b;
  }

  private loop(kind: Parameters<Soundscape["buf"]>[0], rec: SoundRec, rate = 1): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.buf(kind); s.loop = true; s.playbackRate.value = rate;
    // start each loop at a random point so two of the same kind never phase together
    s.start(0, Math.random() * s.buffer.duration);
    rec.nodes.push(s);
    return s;
  }
  private filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f;
  }
  private g(v: number): GainNode { const n = this.ctx!.createGain(); n.gain.value = v; return n; }
  /** A slow wobble added to a parameter. */
  private lfo(param: AudioParam, hz: number, depth: number, rec: SoundRec) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.frequency.value = hz;
    const d = ctx.createGain(); d.gain.value = depth;
    o.connect(d).connect(param); o.start(0);
    rec.nodes.push(o);
  }
  private every(min: number, max: number, rec: SoundRec, fn: () => void) {
    const go = () => { if (rec.stopped || this.disposed) return; fn(); rec.timers.push(this.win.setTimeout(go, (min + Math.random() * (max - min)) * 1000)); };
    rec.timers.push(this.win.setTimeout(go, (min + Math.random() * (max - min)) * 500));
  }

  private synth(kind: SoundKind, out: GainNode, rec: SoundRec) {
    const ctx = this.ctx!;
    switch (kind) {
      case "rain": {
        this.loop("pink", rec).connect(this.filter("highpass", 500)).connect(this.filter("lowpass", 7000)).connect(this.g(0.5)).connect(out);
        this.loop("brown", rec).connect(this.filter("lowpass", 260)).connect(this.g(0.35)).connect(out);
        this.loop("drops", rec).connect(this.filter("bandpass", 2600, 0.9)).connect(this.g(0.9)).connect(out);
        const swell = this.g(0.85); this.loop("pink", rec, 0.7).connect(this.filter("bandpass", 1200, 0.5)).connect(swell).connect(out);
        this.lfo(swell.gain, 0.07, 0.25, rec);
        break;
      }
      case "room": {
        this.loop("brown", rec).connect(this.filter("lowpass", 160)).connect(this.g(0.6)).connect(out);
        this.loop("pink", rec).connect(this.filter("bandpass", 420, 0.6)).connect(this.g(0.04)).connect(out);
        break;
      }
      case "fire": {
        const body = this.g(0.55); this.loop("brown", rec).connect(this.filter("lowpass", 420)).connect(body).connect(out);
        this.lfo(body.gain, 0.6, 0.2, rec);
        const roar = this.g(0.12); this.loop("pink", rec).connect(this.filter("bandpass", 900, 0.8)).connect(roar).connect(out);
        this.lfo(roar.gain, 0.23, 0.06, rec);
        this.loop("crackle", rec).connect(this.filter("highpass", 1300)).connect(this.g(1.1)).connect(out);
        this.loop("crackle", rec, 0.6).connect(this.filter("bandpass", 600, 1.2)).connect(this.g(0.7)).connect(out);
        break;
      }
      case "city": {
        const rumble = this.g(0.7); this.loop("brown", rec).connect(this.filter("bandpass", 140, 0.6)).connect(rumble).connect(out);
        this.lfo(rumble.gain, 0.05, 0.25, rec);
        this.loop("pink", rec).connect(this.filter("bandpass", 700, 0.5)).connect(this.g(0.05)).connect(out);
        // a car passing somewhere below: noise swelling and falling with a lowpass sweep
        this.every(5, 14, rec, () => {
          const t = ctx.currentTime, len = 4 + Math.random() * 4;
          const s = ctx.createBufferSource(); s.buffer = this.buf("brown"); s.start(t, Math.random() * 2, len + 0.2);
          const f = this.filter("lowpass", 200, 0.8); const gg = this.g(0);
          f.frequency.setValueAtTime(180, t); f.frequency.linearRampToValueAtTime(900, t + len / 2); f.frequency.linearRampToValueAtTime(200, t + len);
          gg.gain.setValueAtTime(0, t); gg.gain.linearRampToValueAtTime(0.5 + Math.random() * 0.4, t + len / 2); gg.gain.linearRampToValueAtTime(0, t + len);
          s.connect(f).connect(gg).connect(out);
        });
        // now and then a far horn or a siren, very low
        this.every(18, 40, rec, () => {
          const t = ctx.currentTime, siren = Math.random() < 0.35;
          const o = ctx.createOscillator(); o.type = "sawtooth";
          const f = this.filter("lowpass", 900, 0.5); const gg = this.g(0);
          if (siren) { o.frequency.setValueAtTime(620, t); for (let i = 1; i < 8; i++) o.frequency.linearRampToValueAtTime(i % 2 ? 860 : 620, t + i * 0.7); }
          else o.frequency.value = 330 + Math.random() * 90;
          const len = siren ? 5.5 : 0.5 + Math.random() * 0.6;
          gg.gain.setValueAtTime(0, t); gg.gain.linearRampToValueAtTime(siren ? 0.03 : 0.045, t + 0.08); gg.gain.setValueAtTime(siren ? 0.03 : 0.045, t + len - 0.2); gg.gain.linearRampToValueAtTime(0, t + len);
          o.connect(f).connect(gg).connect(out); o.start(t); o.stop(t + len + 0.1);
        });
        break;
      }
      case "wind": {
        const f = this.filter("bandpass", 420, 0.8), gg = this.g(0.7);
        this.loop("pink", rec).connect(f).connect(gg).connect(out);
        this.lfo(f.frequency, 0.08, 220, rec); this.lfo(gg.gain, 0.11, 0.35, rec);
        const w = this.filter("bandpass", 950, 9), wg = this.g(0.12);
        this.loop("white", rec).connect(w).connect(wg).connect(out);
        this.lfo(w.frequency, 0.05, 260, rec); this.lfo(wg.gain, 0.09, 0.1, rec);
        break;
      }
      case "clock": {
        this.loop("tick", rec).connect(this.filter("highpass", 900)).connect(this.g(0.9)).connect(out);
        break;
      }
      case "hum": {
        // a telescreen: mains hum and its harmonics, the speaker's hiss, the CRT's high whine kept very low
        for (const [f, v] of [[50, 0.5], [100, 0.3], [150, 0.18], [250, 0.06]] as const) {
          const o = ctx.createOscillator(); o.frequency.value = f; o.connect(this.g(v)).connect(out); o.start(); rec.nodes.push(o);
        }
        this.loop("white", rec).connect(this.filter("highpass", 4500)).connect(this.g(0.05)).connect(out);
        const whine = ctx.createOscillator(); whine.frequency.value = 15625; whine.connect(this.g(0.006)).connect(out); whine.start(); rec.nodes.push(whine);
        break;
      }
      case "buzz": {
        const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = 100;
        o.connect(this.filter("lowpass", 700, 1.5)).connect(this.g(0.22)).connect(out); o.start(); rec.nodes.push(o);
        break;
      }
      case "murmur": {
        // a room of people talking low: voice-band noise whose loudness and pitch wander like phrases
        for (let i = 0; i < 4; i++) {
          const f = this.filter("bandpass", 380 + i * 160, 2.2), gg = this.g(0.22);
          this.loop("pink", rec, 0.9 + i * 0.05).connect(f).connect(gg).connect(out);
          this.lfo(gg.gain, 1.6 + i * 0.7, 0.18, rec); this.lfo(f.frequency, 0.9 + i * 0.4, 90, rec);
        }
        this.every(4, 11, rec, () => {
          // a laugh or a raised word somewhere in the room
          const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = this.buf("pink"); s.start(t, Math.random() * 2, 0.9);
          const f = this.filter("bandpass", 700 + Math.random() * 500, 3), gg = this.g(0);
          gg.gain.setValueAtTime(0, t); for (let i = 0; i < 4; i++) { gg.gain.linearRampToValueAtTime(0.35, t + i * 0.18 + 0.05); gg.gain.linearRampToValueAtTime(0.05, t + i * 0.18 + 0.14); }
          gg.gain.linearRampToValueAtTime(0, t + 0.85);
          s.connect(f).connect(gg).connect(out);
        });
        break;
      }
      case "drip": {
        this.every(0.7, 2.4, rec, () => {
          const t = ctx.currentTime, o = ctx.createOscillator(), gg = this.g(0);
          o.type = "sine"; o.frequency.setValueAtTime(1400 + Math.random() * 600, t); o.frequency.exponentialRampToValueAtTime(500, t + 0.08);
          gg.gain.setValueAtTime(0.0001, t); gg.gain.exponentialRampToValueAtTime(0.25, t + 0.005); gg.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
          o.connect(gg).connect(out); o.start(t); o.stop(t + 0.2);
        });
        break;
      }
    }
  }
}
