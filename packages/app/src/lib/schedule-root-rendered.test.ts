import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleRootRendered } from "../../sandbox/schedule-root-rendered";

function scheduler() {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  const clock = {
    requestAnimationFrame(callback: FrameRequestCallback) { const id = next++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    setTimeout(callback: TimerHandler, delay?: number) {
      assert.equal(delay, 1000);
      const id = next++; timers.set(id, callback as () => void); return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  } as Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout" | "clearTimeout">;
  const tickFrame = () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));
  };
  const tickTimer = () => {
    const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback());
  };
  return { clock, frames, timers, tickFrame, tickTimer };
}

test("committed root reports once after two frames and cancels the timer", () => {
  const s = scheduler(); let calls = 0;
  scheduleRootRendered(s.clock, () => calls++);
  s.tickFrame(); assert.equal(calls, 0);
  s.tickFrame(); assert.equal(calls, 1);
  assert.equal(s.timers.size, 0);
  s.tickTimer(); assert.equal(calls, 1);
});

for (const framesBeforeFallback of [0, 1]) {
  test(`throttled root reports once after the timer with ${framesBeforeFallback} frames`, () => {
    const s = scheduler(); let calls = 0;
    scheduleRootRendered(s.clock, () => calls++);
    if (framesBeforeFallback) s.tickFrame();
    const staleFrame = [...s.frames.values()][0]!;
    s.tickTimer(); assert.equal(calls, 1);
    assert.equal(s.frames.size, 0);
    staleFrame(0); s.tickFrame(); assert.equal(calls, 1);
  });
  test(`unmount or reinstall cancels callbacks after ${framesBeforeFallback} frames`, () => {
    const s = scheduler(); let calls = 0;
    const cancel = scheduleRootRendered(s.clock, () => calls++);
    if (framesBeforeFallback) s.tickFrame();
    const staleFrame = [...s.frames.values()][0]!;
    const staleTimer = [...s.timers.values()][0]!;
    cancel(); cancel(); staleFrame(0); staleTimer();
    s.tickFrame(); s.tickTimer();
    assert.equal(calls, 0);
    assert.equal(s.frames.size + s.timers.size, 0);
  });
}
