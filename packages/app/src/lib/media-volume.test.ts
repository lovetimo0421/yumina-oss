import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setElVolume, getElVolume, isVolumeWritable, __resetMediaVolumeForTests } from "./media-volume";

/**
 * The iOS volume workaround has to be provably harmless everywhere else: routing
 * a media element into Web Audio cannot be undone, and a mis-routed element
 * plays silence. These tests pin the three guard rails.
 */

type Ctx = {
  state: string;
  created: unknown[];
  gains: { gain: { value: number } }[];
  resumed: number;
};

let ctx: Ctx;
let probeVolumeSticks: boolean;

function installEnv(opts: { volumeSticks: boolean; ctxState?: string; noAudioContext?: boolean }) {
  probeVolumeSticks = opts.volumeSticks;
  ctx = { state: opts.ctxState ?? "running", created: [], gains: [], resumed: 0 };

  class FakeAudio {
    #volume = 1;
    src = "";
    currentSrc = "";
    get volume() {
      return this.#volume;
    }
    set volume(v: number) {
      // iOS: the setter is a no-op and the getter always answers 1.
      if (probeVolumeSticks) this.#volume = v;
    }
  }

  class FakeAudioContext {
    state = ctx.state;
    destination = { kind: "destination" };
    resume() {
      ctx.resumed++;
      return Promise.resolve();
    }
    createMediaElementSource(el: unknown) {
      ctx.created.push(el);
      return { connect: (t: unknown) => t };
    }
    createGain() {
      const g = { gain: { value: 1 }, connect: (t: unknown) => t };
      ctx.gains.push(g);
      return g;
    }
  }

  const g = globalThis as unknown as Record<string, unknown>;
  g.Audio = FakeAudio;
  g.window = {
    location: { href: "https://yumina.io/chat/1", origin: "https://yumina.io" },
    ...(opts.noAudioContext ? {} : { AudioContext: FakeAudioContext }),
  };
  __resetMediaVolumeForTests();
  return FakeAudio;
}

function el(src: string, Audio: new () => { src: string; currentSrc: string; volume: number }) {
  const a = new Audio();
  a.src = src;
  a.currentSrc = src;
  return a as unknown as HTMLMediaElement;
}

beforeEach(() => {
  probeVolumeSticks = true;
});
afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.Audio;
  delete g.window;
  __resetMediaVolumeForTests();
});

test("desktop: volume is writable, so nothing is ever routed through Web Audio", () => {
  const A = installEnv({ volumeSticks: true });
  const a = el("https://yumina.io/cdn/x.mp3", A);
  assert.equal(isVolumeWritable(), true);
  setElVolume(a, 0.25);
  assert.equal(a.volume, 0.25, "plain assignment must still be the path");
  assert.equal(getElVolume(a), 0.25);
  assert.equal(ctx.created.length, 0, "no element may be captured when the old path works");
  assert.equal(ctx.gains.length, 0);
});

test("iOS: same-origin media gets a GainNode and the slider actually moves it", () => {
  const A = installEnv({ volumeSticks: false });
  const a = el("https://yumina.io/cdn/x.mp3", A);
  assert.equal(isVolumeWritable(), false);
  setElVolume(a, 0.25);
  assert.equal(ctx.created.length, 1, "element should be routed once");
  assert.equal(ctx.gains.length, 1);
  assert.equal(ctx.gains[0]!.gain.value, 0.25);
  assert.equal(a.volume, 1, "el.volume stays 1 on iOS — that's the whole problem");
  assert.equal(getElVolume(a), 0.25, "reads must answer from the gain, or fades start from the wrong place");

  // A second set reuses the same node — createMediaElementSource twice throws.
  setElVolume(a, 0.5);
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.gains[0]!.gain.value, 0.5);
});

test("iOS: cross-origin media is left alone (routing it would play silence)", () => {
  const A = installEnv({ volumeSticks: false });
  const a = el("https://cdn.example.com/x.mp3", A);
  setElVolume(a, 0.25);
  assert.equal(ctx.created.length, 0, "must not capture cross-origin media");
  assert.equal(getElVolume(a), 0.25, "still reports what was asked for");
});

test("iOS: a suspended AudioContext never captures the element", () => {
  const A = installEnv({ volumeSticks: false, ctxState: "suspended" });
  const a = el("https://yumina.io/cdn/x.mp3", A);
  setElVolume(a, 0.25);
  assert.equal(ctx.created.length, 0, "capturing into a suspended context would mute it for good");
  assert.ok(ctx.resumed > 0, "but we should have asked it to resume");
});

test("no Web Audio at all: falls back to the plain assignment", () => {
  const A = installEnv({ volumeSticks: false, noAudioContext: true });
  const a = el("https://yumina.io/cdn/x.mp3", A);
  setElVolume(a, 0.25);
  assert.equal(ctx.created.length, 0);
  assert.equal(getElVolume(a), 0.25);
});

test("volume is clamped and NaN-safe", () => {
  const A = installEnv({ volumeSticks: true });
  const a = el("https://yumina.io/cdn/x.mp3", A);
  setElVolume(a, 5);
  assert.equal(a.volume, 1);
  setElVolume(a, -2);
  assert.equal(a.volume, 0);
  setElVolume(a, NaN);
  assert.equal(a.volume, 1);
});
