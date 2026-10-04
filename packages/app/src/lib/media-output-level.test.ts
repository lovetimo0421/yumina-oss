import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import * as media from "./media-volume";
function environment({
  writable = true,
  state = "running",
  crossOrigin = false,
  noContext = false,
  failGain = false,
  failAnalyser = false,
} = {}) {
  let sources = 0,
    analysers = 0,
    disconnections = 0;
  const sourceElements = new Set<unknown>(),
    levels: number[] = [];
  class Audio {
    src = crossOrigin
      ? "https://elsewhere.test/a.mp3"
      : "https://yumina.test/cdn/tts/a";
    currentSrc = this.src;
    private value = 1;
    get volume() {
      return this.value;
    }
    set volume(v: number) {
      if (writable) this.value = v;
    }
  }
  let context: AudioContext;
  class AudioContext {
    state = state;
    destination = {};
    constructor() {
      context = this;
    }
    resume() {
      return Promise.resolve();
    }
    createMediaElementSource(el: unknown) {
      assert.ok(
        !sourceElements.has(el),
        "cannot create a second MediaElementSource for an element",
      );
      sourceElements.add(el);
      sources++;
      return {
        connect: (node: unknown) => node,
        disconnect() {
          disconnections++;
        },
      };
    }
    createGain() {
      if (failGain) throw new Error("gain unavailable");
      return {
        gain: { value: 1 },
        connect: (node: unknown) => node,
        disconnect() {
          disconnections++;
        },
      };
    }
    createAnalyser() {
      if (failAnalyser) throw new Error("analyser unavailable");
      analysers++;
      return {
        fftSize: 512,
        getFloatTimeDomainData(buf: Float32Array) {
          buf.fill(levels.at(-1) ?? 0.125);
        },
        connect: (node: unknown) => node,
        disconnect() {
          disconnections++;
        },
      };
    }
  }
  Object.assign(globalThis, {
    Audio,
    window: {
      location: {
        href: "https://yumina.test/chat/a",
        origin: "https://yumina.test",
      },
      ...(noContext ? {} : { AudioContext }),
    },
  });
  media.__resetMediaVolumeForTests();
  return {
    el: new Audio() as unknown as HTMLMediaElement,
    levels,
    get sources() {
      return sources;
    },
    get analysers() {
      return analysers;
    },
    get disconnections() {
      return disconnections;
    },
    suspend() {
      context.state = "suspended";
    },
  };
}
afterEach(() => {
  Reflect.deleteProperty(globalThis, "Audio");
  Reflect.deleteProperty(globalThis, "window");
  media.__resetMediaVolumeForTests();
});
function measure(el: HTMLMediaElement) {
  const read = (
    media as unknown as {
      getElAudioLevel?: (el: HTMLMediaElement) => number | undefined;
    }
  ).getElAudioLevel;
  assert.equal(
    typeof read,
    "function",
    "shared media graph must expose measured output",
  );
  return read!(el);
}
test("output measurement reuses the iOS volume source and respects later gain changes", () => {
  const x = environment({ writable: false });
  media.setElVolume(x.el, 0.25);
  assert.equal(x.sources, 1);
  assert.ok(Number.isFinite(measure(x.el)));
  media.setElVolume(x.el, 0.5);
  measure(x.el);
  assert.equal(x.sources, 1);
  assert.equal(x.analysers, 1);
  assert.equal(media.getElVolume(x.el), 0.5);
});
test("desktop analysis routes once without changing effective volume", () => {
  const x = environment();
  media.setElVolume(x.el, 0.25);
  assert.ok(Number.isFinite(measure(x.el)));
  assert.equal(x.sources, 1);
  assert.equal(media.getElVolume(x.el), 0.25);
  measure(x.el);
  assert.equal(x.sources, 1);
});
test("unmeasurable cross-origin media preserves ordinary playback", () => {
  const x = environment({ crossOrigin: true });
  media.setElVolume(x.el, 0.3);
  assert.equal(measure(x.el), undefined);
  assert.equal(x.sources, 0);
  assert.equal(media.getElVolume(x.el), 0.3);
});
test("suspended context is not allowed to capture an otherwise playable element", () => {
  const x = environment({ state: "suspended" });
  assert.equal(measure(x.el), undefined);
  assert.equal(x.sources, 0);
});
test("unavailable WebAudio reports no synthetic amplitude", () => {
  const x = environment({ noContext: true });
  assert.equal(measure(x.el), undefined);
  assert.equal(x.sources, 0);
});
test("gain construction failure never captures ordinary playable audio", () => {
  const x = environment({ failGain: true });
  assert.equal(measure(x.el), undefined);
  assert.equal(x.sources, 0);
});
test("analyser failure leaves the existing destination graph and volume intact", () => {
  const x = environment({ failAnalyser: true });
  media.setElVolume(x.el, 0.25);
  assert.equal(measure(x.el), undefined);
  assert.equal(x.sources, 1);
  assert.equal(x.disconnections, 0);
  assert.equal(media.getElVolume(x.el), 0.25);
});
test("silent PCM is zero and nonfinite PCM is unavailable rather than guessed", () => {
  const x = environment();
  x.levels.push(0);
  assert.equal(measure(x.el), 0);
  x.levels.push(NaN);
  assert.equal(measure(x.el), undefined);
});
test("a routed element stops reporting output when its shared context suspends", () => {
  const x = environment();
  measure(x.el);
  x.suspend();
  const read = (
    media as unknown as {
      isElAudioOutputRunning?: (el: HTMLMediaElement) => boolean;
    }
  ).isElAudioOutputRunning;
  assert.equal(typeof read, "function");
  assert.equal(read!(x.el), false);
  assert.equal(measure(x.el), undefined);
});
test("retired media disconnects its graph once without allowing a second source", () => {
  const x = environment();
  measure(x.el);
  const release = (
    media as unknown as {
      releaseMediaElement?: (el: HTMLMediaElement) => void;
    }
  ).releaseMediaElement;
  assert.equal(typeof release, "function");
  release!(x.el);
  release!(x.el);
  assert.equal(x.disconnections, 3);
  assert.equal(measure(x.el), undefined);
  assert.equal(x.sources, 1);
});
