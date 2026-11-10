import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { __resetMediaVolumeForTests } from "../lib/media-volume";
import type { VoicePlaybackFrame } from "../lib/voice-playback-performance";
const created: FakeAudio[] = [];
class FakeAudio extends EventTarget {
  src: string;
  currentSrc = "";
  volume = 1;
  muted = false;
  paused = true;
  ended = false;
  duration = 4;
  currentTime = 0;
  preload = "";
  handlerCount = 0;
  constructor(src = "") {
    super();
    this.src = src;
    created.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.fire("pause");
  }
  fire(event: string) {
    this.dispatchEvent(new Event(event));
  }
  override addEventListener(
    ...args: Parameters<EventTarget["addEventListener"]>
  ) {
    this.handlerCount++;
    super.addEventListener(...args);
  }
  override removeEventListener(
    ...args: Parameters<EventTarget["removeEventListener"]>
  ) {
    this.handlerCount--;
    super.removeEventListener(...args);
  }
}
Object.assign(globalThis, {
  Audio: FakeAudio,
  window: {
    location: {
      href: "https://yumina.test/chat",
      origin: "https://yumina.test",
    },
  },
  document: {
    addEventListener() {},
    createElement() {
      return {};
    },
    head: { appendChild() {} },
  },
});
const audioModule = await import("./audio");
const store = audioModule.useAudioStore;
afterEach(() => {
  store.getState().stopAll();
  __resetMediaVolumeForTests();
});
function subscribe(frames: VoicePlaybackFrame[]) {
  const listen = (
    audioModule as unknown as {
      onVoicePlaybackFrame?: (
        cb: (frame: VoicePlaybackFrame) => void,
      ) => () => void;
    }
  ).onVoicePlaybackFrame;
  assert.equal(
    typeof listen,
    "function",
    "voice store must publish owned output frames",
  );
  return listen!((frame) => frames.push(frame));
}
function lastVoice() {
  return created.filter((a) => a.src.includes("/cdn/tts/")).at(-1)!;
}
test("parent voice lane preserves legacy progress and waits for the real playing event", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const frames: VoicePlaybackFrame[] = [],
    off = subscribe(frames);
  store.getState().setVoicePlayback({ key: "hat-a", status: "loading" });
  assert.ok(frames.every((f) => !f.audible));
  store.getState().playVoice("hat-a", "https://yumina.test/cdn/tts/a");
  assert.equal(frames.at(-1)?.audible, false);
  const audio = lastVoice();
  audio.currentTime = 1;
  audio.fire("playing");
  assert.equal(frames.at(-1)?.audible, true);
  t.mock.timers.tick(500);
  assert.equal(store.getState().voicePlayback?.progress, 0.25);
  off();
});
test("replacement silences the retired generation and rejects its later media events", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const frames: VoicePlaybackFrame[] = [],
    off = subscribe(frames);
  store.getState().playVoice("hat-a", "https://yumina.test/cdn/tts/a");
  const first = lastVoice();
  first.fire("playing");
  const oldGeneration = frames.at(-1)!.generation;
  store.getState().playVoice("hat-b", "https://yumina.test/cdn/tts/b");
  const second = lastVoice();
  assert.equal(frames.at(-1)?.audible, false);
  assert.equal(frames.at(-1)?.key, "hat-b");
  assert.ok(frames.some((f) => f.generation === oldGeneration && !f.audible));
  const count = frames.length;
  first.fire("playing");
  first.fire("ended");
  t.mock.timers.tick(66);
  assert.equal(frames.length, count);
  second.fire("playing");
  assert.equal(frames.at(-1)?.key, "hat-b");
  assert.ok(frames.at(-1)!.generation > oldGeneration);
  off();
});
test("stop publishes silence synchronously and releases all element handlers", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const frames: VoicePlaybackFrame[] = [],
    off = subscribe(frames);
  store.getState().playVoice("hat-a", "https://yumina.test/cdn/tts/a");
  const audio = lastVoice();
  audio.fire("playing");
  store.getState().stopVoice();
  assert.equal(frames.at(-1)?.audible, false);
  assert.equal(frames.at(-1)?.audioLevel, 0);
  assert.equal(audio.handlerCount, 0);
  const count = frames.length;
  audio.fire("playing");
  t.mock.timers.tick(1000);
  assert.equal(frames.length, count);
  off();
});
test("cleanup and media error cannot leave an audible snapshot", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const frames: VoicePlaybackFrame[] = [],
    off = subscribe(frames);
  store.getState().playVoice("hat-a", "https://yumina.test/cdn/tts/a");
  lastVoice().fire("playing");
  lastVoice().fire("error");
  assert.equal(frames.at(-1)?.audible, false);
  assert.equal(store.getState().voicePlayback, null);
  store.getState().playVoice("hat-b", "https://yumina.test/cdn/tts/b");
  lastVoice().fire("playing");
  store.getState().cleanup();
  assert.equal(frames.at(-1)?.audible, false);
  off();
});
test("voice-volume changes reset measured output immediately without waiting for a ticker", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const frames: VoicePlaybackFrame[] = [],
    off = subscribe(frames);
  store.getState().setVoiceVolume(1);
  store.getState().playVoice("hat-a", "https://yumina.test/cdn/tts/a");
  lastVoice().fire("playing");
  assert.equal(frames.at(-1)?.audible, true);
  store.getState().setVoiceVolume(0);
  assert.equal(frames.at(-1)?.audible, false);
  off();
  store.getState().setVoiceVolume(1);
});
test("a throwing initial frame subscriber cannot break the owned voice lane", () => {
  store.getState().playVoice("hat-a", "https://yumina.test/cdn/tts/a");
  let off: () => void = () => {};
  assert.doesNotThrow(() => {
    off = audioModule.onVoicePlaybackFrame(() => {
      throw new Error("card failure");
    });
  });
  store.getState().stopVoice();
  off();
});
test("interrupting a voice restores the BGM volume it ducked", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const bgm = new FakeAudio("/bgm");
  store.setState({
    activeTracks: new Map([
      [
        "bgm",
        {
          audio: bgm as unknown as HTMLAudioElement,
          volume: 0.7,
          type: "bgm" as const,
        },
      ],
    ]),
  });
  store.getState().playVoice("hat-a", "https://yumina.test/cdn/tts/a");
  assert.equal(store.getState().activeTracks.get("bgm")?.volume, 0.7 * 0.2);
  store.getState().stopVoice();
  assert.equal(store.getState().activeTracks.get("bgm")?.volume, 0.7);
});

test("a new voice cancels the old restore fade and restores BGM once when it ends", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const bgm = new FakeAudio("/bgm");
  const writes: number[] = [];
  let physicalVolume = 1;
  Object.defineProperty(bgm, "volume", {
    get: () => physicalVolume,
    set: (value: number) => {
      physicalVolume = value;
      writes.push(value);
    },
  });
  store.setState({
    masterVolume: 1,
    bgmVolume: 1,
    voiceVolume: 1,
    muted: false,
    activeTracks: new Map([
      [
        "bgm",
        {
          audio: bgm as unknown as HTMLAudioElement,
          volume: 0.8,
          type: "bgm" as const,
        },
      ],
    ]),
  });
  store.getState().playVoice("old", "https://yumina.test/cdn/tts/old");
  store.getState().stopVoice();
  store.getState().playVoice("new", "https://yumina.test/cdn/tts/new");
  const current = lastVoice();
  current.fire("playing");
  t.mock.timers.tick(1050);
  assert.ok(Math.abs(bgm.volume - 0.16) < 1e-10);
  assert.equal(store.getState().activeTracks.get("bgm")?.volume, 0.8 * 0.2);
  writes.length = 0;
  current.fire("ended");
  current.fire("ended"); // retired events cannot schedule another restoration
  t.mock.timers.tick(1000);
  assert.equal(bgm.volume, 0.8);
  assert.equal(store.getState().activeTracks.get("bgm")?.volume, 0.8);
  assert.equal(writes.length, 20);
  t.mock.timers.tick(1000);
  assert.equal(writes.length, 20);
});

test("rapid stop/start during partial restoration preserves the original BGM volume", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const bgm = new FakeAudio("/bgm");
  store.setState({
    masterVolume: 1,
    bgmVolume: 1,
    voiceVolume: 1,
    muted: false,
    activeTracks: new Map([
      [
        "bgm",
        {
          audio: bgm as unknown as HTMLAudioElement,
          volume: 0.8,
          type: "bgm" as const,
        },
      ],
    ]),
  });
  for (let i = 0; i < 3; i++) {
    store.getState().playVoice("hat-" + i, "https://yumina.test/cdn/tts/" + i);
    t.mock.timers.tick(1050);
    assert.ok(Math.abs(bgm.volume - 0.16) < 1e-10);
    store.getState().stopVoice();
    t.mock.timers.tick(150);
    assert.ok(bgm.volume > 0.16 && bgm.volume < 0.8);
    assert.equal(store.getState().activeTracks.get("bgm")?.volume, 0.8);
  }
  t.mock.timers.tick(1000);
  assert.equal(bgm.volume, 0.8);
});
