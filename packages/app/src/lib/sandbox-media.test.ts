import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { installSandboxMedia } from "./sandbox-media";

function harness(t: TestContext, deferredContexts = false) {
  const elements: Media[] = [];
  let plays = 0;
  let contexts = 0;
  class Media extends EventTarget {
    paused = true;
    autoplay = false;
    play() { plays++; this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  class Context extends EventTarget {
    state = "running";
    pending: Array<{ state: "running" | "suspended"; resolve: () => void; reject: (error: Error) => void }> = [];
    constructor() { super(); contexts++; }
    private changeState(state: "running" | "suspended") {
      if (this.state === state) return;
      this.state = state;
      this.dispatchEvent(new Event("statechange"));
    }
    private requestState(state: "running" | "suspended") {
      if (deferredContexts) {
        return new Promise<void>((resolve, reject) => { this.pending.push({ state, resolve, reject }); });
      }
      this.changeState(state);
      return Promise.resolve();
    }
    suspend() { return this.requestState("suspended"); }
    resume() { return this.requestState("running"); }
    async settleNext(error?: Error) {
      // Native control messages execute in order; state changes are observable
      // only after that operation runs, and may enqueue more control messages.
      const operation = this.pending.shift();
      assert.ok(operation, "expected a queued native operation");
      if (error) operation.reject(error);
      else { this.changeState(operation.state); operation.resolve(); }
      await Promise.resolve();
      await Promise.resolve();
    }
    async settleAll() {
      let remaining = 20;
      while (this.pending.length) {
        assert.ok(remaining-- > 0, "native operations must converge");
        await this.settleNext();
      }
    }
  }
  const win = { Audio: Media, HTMLMediaElement: Media, AudioContext: Context };
  const doc = Object.assign(new EventTarget(), {
    querySelectorAll: (selector: string) => elements.filter(el => !selector.includes("autoplay") || el.autoplay),
  });
  for (const [key, value] of Object.entries({ window: win, document: doc })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const runtime = installSandboxMedia();
  return { runtime, win, elements, get plays() { return plays; }, get contexts() { return contexts; } };
}

test("ordinary gestures create no audio or contexts; actual autoplay still retries", t => {
  const h = harness(t);
  h.runtime.rescueAutoplay();
  assert.equal(h.plays, 0);
  assert.equal(h.contexts, 0);
  const video = new h.win.Audio(); video.autoplay = true; h.elements.push(video);
  h.runtime.rescueAutoplay();
  assert.equal(video.paused, false);
});

test("leaving pauses detached audio and blocks late plays until the world returns", async t => {
  const h = harness(t);
  const detached = new h.win.Audio();
  await detached.play();
  h.runtime.setSuspended(true);
  assert.equal(detached.paused, true);
  await detached.play().catch(() => {});
  const late = new h.win.Audio();
  await late.play().catch(() => {});
  assert.equal(h.plays, 1, "hidden callbacks must not call native play");
  h.runtime.rescueAutoplay();
  h.runtime.setSuspended(false);
  assert.equal(detached.paused, true, "returning must not blindly resume media");
  await detached.play();
  assert.equal(detached.paused, false);
});

test("hidden worlds suspend existing and new Web Audio contexts and block resume", async t => {
  const h = harness(t);
  const context = new h.win.AudioContext();
  h.runtime.setSuspended(true);
  assert.equal(context.state, "suspended");
  await context.resume();
  assert.equal(context.state, "suspended");
  const late = new h.win.AudioContext();
  assert.equal(late.state, "suspended");
  h.runtime.setSuspended(false);
  assert.equal(context.state, "running");
});

test("creator-paused contexts are not automatically resumed", async t => {
  const h = harness(t);
  const context = new h.win.AudioContext();
  await context.suspend();
  h.runtime.setSuspended(true);
  h.runtime.setSuspended(false);
  assert.equal(context.state, "suspended");
});

test("native autoplay cannot revive media while the world is hidden", t => {
  const h = harness(t);
  const media = new h.win.Audio();
  h.runtime.setSuspended(true);
  media.paused = false;
  media.dispatchEvent(new Event("play"));
  assert.equal(media.paused, true);
  media.autoplay = true;
  h.elements.push(media);
  h.runtime.rescueAutoplay();
  assert.equal(h.plays, 0);
});

test("returning before native suspension settles restores the context after queued operations", async t => {
  const h = harness(t, true);
  const context = new h.win.AudioContext();
  h.runtime.setSuspended(true);
  assert.equal(context.state, "running", "suspend has not executed yet");
  h.runtime.setSuspended(false);
  await context.settleAll();
  assert.equal(context.state, "running");
  assert.equal(context.pending.length, 0);
});

test("exit return exit before native operations settle leaves the context suspended", async t => {
  const h = harness(t, true);
  const context = new h.win.AudioContext();
  h.runtime.setSuspended(true);
  h.runtime.setSuspended(false);
  h.runtime.setSuspended(true);
  await context.settleAll();
  assert.equal(context.state, "suspended");
  await context.resume();
  assert.equal(context.pending.length, 0, "hidden creator callbacks cannot queue native resumes");
  h.runtime.setSuspended(false);
  await context.settleAll();
  assert.equal(context.state, "running", "a subsequent visible visit can still restore audio");
});

test("a queued resume completing after another exit is suspended again", async t => {
  const h = harness(t, true);
  const context = new h.win.AudioContext();
  h.runtime.setSuspended(true);
  await context.settleAll();
  h.runtime.setSuspended(false);
  h.runtime.setSuspended(true);
  assert.equal(context.state, "suspended");
  await context.settleNext();
  assert.equal(context.state, "running", "the previously queued resume completes");
  assert.equal(context.pending.length, 1, "statechange queues a corrective suspension");
  await context.settleAll();
  assert.equal(context.state, "suspended");
});

test("rejected native suspend and resume promises are handled without blocking later playback", async t => {
  const h = harness(t, true);
  const context = new h.win.AudioContext();
  h.runtime.setSuspended(true);
  await context.settleNext(new DOMException("Suspension failed", "InvalidStateError"));
  assert.equal(context.state, "running");
  h.runtime.setSuspended(true);
  await context.settleAll();
  assert.equal(context.state, "suspended");
  h.runtime.setSuspended(false);
  await context.settleNext(new DOMException("Resume failed", "NotAllowedError"));
  assert.equal(context.state, "suspended");
  const retry = context.resume();
  await context.settleAll();
  await retry;
  assert.equal(context.state, "running");
  // Allow unhandled rejections to surface to node:test without wall-clock sleeps.
  await new Promise<void>(resolve => setImmediate(resolve));
});
