import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { advanceHeaderMotion, createHeaderMotion } from "./header-motion.js";

test("a fast reversal preserves velocity instead of restarting an easing curve", () => {
  const moving = advanceHeaderMotion({ position: 0, velocity: 0 }, 1, 0.06);
  assert.ok(moving.velocity > 0);
  const reversed = advanceHeaderMotion(moving, 0, 0.001);
  assert.ok(Math.abs(reversed.velocity - moving.velocity) < 1);
  let state = reversed;
  for (let i = 0; i < 90; i++) state = advanceHeaderMotion(state, 0, 1 / 120);
  assert.ok(state.position < 0.001);
  assert.ok(Math.abs(state.velocity) < 0.01);
});

test("motion stays bounded and settles consistently at 60 and 120 Hz", () => {
  for (const rate of [60, 120]) {
    let state = { position: 0, velocity: 0 };
    for (let i = 0; i < rate; i++) {
      state = advanceHeaderMotion(state, i < rate / 3 ? 1 : 0, 1 / rate);
      assert.ok(state.position >= 0 && state.position <= 1);
      if (i === Math.floor(rate / 3) - 1) assert.ok(state.position > 0.99, "the header must actually travel offscreen");
    }
    assert.ok(state.position < 0.001);
  }
});

test("the surface is released only at the hidden endpoint and cleanup cancels paint", () => {
  const dom = new JSDOM("<div id='header'></div>", { pretendToBeVisual: true });
  const win = dom.window;
  const header = win.document.getElementById("header")!;
  Object.defineProperty(header, "offsetHeight", { value: 137 });
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  win.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  win.cancelAnimationFrame = handle => { frames.delete(handle); };
  const motion = createHeaderMotion(win as unknown as Window, header);
  const frame = (time: number) => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(time)); };
  motion.setHidden(true);
  frame(0);
  assert.equal(header.hasAttribute("data-motion-hidden"), false);
  for (let i = 1; i < 80; i++) frame(i * 16);
  assert.equal(header.hasAttribute("data-motion-hidden"), true);
  motion.setHidden(false);
  frame(1300);
  assert.equal(header.hasAttribute("data-motion-hidden"), false);
  motion.reveal();
  assert.equal(header.style.getPropertyValue("--topbar-motion-progress"), "0");
  assert.equal(frames.size, 0);
  motion.setHidden(true);
  motion.dispose();
  assert.equal(frames.size, 0);
  assert.equal(header.style.cssText, "");
  assert.equal(header.hasAttribute("data-scroll-motion"), false);
  dom.window.close();
});

test("reduced motion changes endpoints immediately without scheduling animation", () => {
  const dom = new JSDOM("<div></div>", { pretendToBeVisual: true });
  const win = dom.window;
  win.matchMedia = (() => ({ matches: true })) as unknown as typeof win.matchMedia;
  const header = win.document.querySelector("div")!;
  const motion = createHeaderMotion(win as unknown as Window, header);
  win.requestAnimationFrame = () => { throw new Error("Reduced motion must not animate"); };
  motion.setHidden(true);
  assert.equal(header.hasAttribute("data-motion-hidden"), true);
  motion.setHidden(false);
  assert.equal(header.hasAttribute("data-motion-hidden"), false);
  motion.dispose();
  dom.window.close();
});
