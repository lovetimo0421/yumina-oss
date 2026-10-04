import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { __resetMediaVolumeForTests } from "./media-volume";
type Frame = {
  key: string;
  generation: number;
  audible: boolean;
  audioLevel?: number;
  currentTime: number;
  duration?: number;
};
type Monitor = (
  audio: HTMLMediaElement,
  key: string,
  generation: number,
  emit: (frame: Frame) => void,
) => {
  dispose: () => void;
};
const module = await import("./voice-playback-performance").catch(() => ({}));
function setup(noContext = false) {
  class Audio extends EventTarget {
    src = "https://yumina.test/cdn/tts/a";
    currentSrc = this.src;
    volume = 1;
    muted = false;
    paused = true;
    ended = false;
    duration = 4;
    currentTime = 0;
    fire(name: string) {
      this.dispatchEvent(new Event(name));
    }
  }
  class AudioContext {
    state = "running";
    destination = {};
    createMediaElementSource() {
      return { connect: (node: unknown) => node };
    }
    createGain() {
      return { gain: { value: 1 }, connect: (node: unknown) => node };
    }
    createAnalyser() {
      return {
        fftSize: 512,
        getFloatTimeDomainData(buf: Float32Array) {
          buf.fill(0.125);
        },
        disconnect() {},
      };
    }
  }
  Object.assign(globalThis, {
    Audio,
    window: {
      location: {
        href: "https://yumina.test/chat",
        origin: "https://yumina.test",
      },
      ...(noContext ? {} : { AudioContext }),
    },
  });
  __resetMediaVolumeForTests();
  const frames: Frame[] = [],
    audio = new Audio();
  const create = (
    module as {
      createVoicePlaybackMonitor?: Monitor;
    }
  ).createVoicePlaybackMonitor;
  assert.equal(
    typeof create,
    "function",
    "voice output needs a real-event monitor",
  );
  return {
    audio,
    frames,
    monitor: create!(
      audio as unknown as HTMLMediaElement,
      "hat-turn-3",
      7,
      (frame) => frames.push(frame),
    ),
  };
}
afterEach(() => {
  Reflect.deleteProperty(globalThis, "Audio");
  Reflect.deleteProperty(globalThis, "window");
  __resetMediaVolumeForTests();
});
test("loading and a resolved play request never imply audible playback", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const x = setup();
  t.mock.timers.tick(1000);
  assert.equal(x.frames.at(-1)?.audible, false);
  assert.equal(x.frames.at(-1)?.audioLevel, 0);
  x.monitor.dispose();
});
test("actual playing emits keyed measured PCM frames and real elapsed time", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const x = setup();
  x.audio.paused = false;
  x.audio.currentTime = 0.75;
  x.audio.fire("playing");
  t.mock.timers.tick(66);
  const frame = x.frames.at(-1)!;
  assert.equal(frame.key, "hat-turn-3");
  assert.equal(frame.generation, 7);
  assert.equal(frame.audible, true);
  assert.equal(frame.currentTime, 0.75);
  assert.equal(frame.duration, 4);
  assert.ok(frame.audioLevel! > 0 && frame.audioLevel! <= 1);
  x.monitor.dispose();
});
for (const event of ["pause", "waiting", "error", "ended"])
  test(event + " resets output synchronously before the next tick", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const x = setup();
    x.audio.paused = false;
    x.audio.fire("playing");
    assert.equal(x.frames.at(-1)?.audible, true);
    x.audio.fire(event);
    assert.equal(x.frames.at(-1)?.audible, false);
    assert.equal(x.frames.at(-1)?.audioLevel, 0);
    x.monitor.dispose();
  });
test("dispose publishes silence and removes stale media events and timers", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const x = setup();
  x.audio.paused = false;
  x.audio.fire("playing");
  x.monitor.dispose();
  assert.equal(x.frames.at(-1)?.audible, false);
  const count = x.frames.length;
  x.audio.fire("playing");
  t.mock.timers.tick(1000);
  assert.equal(x.frames.length, count);
  x.monitor.dispose();
  assert.equal(x.frames.length, count);
});

test("a download stall preserves buffered playback and keeps sampling without another playing event", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const x = setup();
  x.audio.paused = false;
  x.audio.fire("playing");
  x.audio.fire("stalled");
  assert.equal(x.frames.at(-1)?.audible, true);
  const count = x.frames.length;
  x.audio.currentTime = 1;
  t.mock.timers.tick(66);
  assert.equal(x.frames.length, count + 1);
  assert.equal(x.frames.at(-1)?.currentTime, 1);
  assert.ok(x.frames.at(-1)!.audioLevel! > 0);
  x.monitor.dispose();
});
test("ordinary audible playback survives unavailable measurement", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const x = setup(true);
  x.audio.paused = false;
  x.audio.fire("playing");
  assert.equal(x.frames.at(-1)?.audible, true);
  assert.equal(x.frames.at(-1)?.audioLevel, undefined);
  x.monitor.dispose();
});
test("muted output cannot animate speech even while the element is advancing", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const x = setup();
  x.audio.paused = false;
  x.audio.fire("playing");
  x.audio.volume = 0;
  t.mock.timers.tick(66);
  assert.equal(x.frames.at(-1)?.audible, false);
  assert.equal(x.frames.at(-1)?.audioLevel, 0);
  x.monitor.dispose();
});
