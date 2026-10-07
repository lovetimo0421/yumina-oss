import assert from "node:assert/strict";
import test from "node:test";
import { isShortTranscript, lastSentLineId, revealSentLineStep } from "../../../sandbox/chat/sent-line-reveal";

/** A 234px box (the example template's) whose sent line sits 369px down. */
function box(frameHeight: number, clientHeight: number) {
  const state = { scrollTop: 0, scrollHeight: 369 };
  const viewport = {
    clientHeight,
    get scrollHeight() { return state.scrollHeight; },
    get scrollTop() { return state.scrollTop; },
    getBoundingClientRect: () => ({ top: 100 }),
    ownerDocument: { defaultView: { innerHeight: frameHeight } },
  } as unknown as HTMLElement;
  const row = { getBoundingClientRect: () => ({ top: 100 + 330 - state.scrollTop }) } as unknown as HTMLElement;
  const setTop = (_: HTMLElement, top: number) => { state.scrollTop = top; };
  return { state, viewport, row, setTop };
}

test("only a box under half the frame counts as a card's short transcript", () => {
  assert.equal(isShortTranscript(box(812, 234).viewport), true);
  assert.equal(isShortTranscript(box(812, 670).viewport), false);
  assert.equal(isShortTranscript(box(0, 234).viewport), false);
});

test("the sent line walks up as the reply grows, then the reader has the rest", () => {
  const { state, viewport, row, setTop } = box(812, 234);
  // On send nothing is below the line yet: go as far as the content allows.
  assert.equal(revealSentLineStep(viewport, row, setTop), false);
  assert.equal(state.scrollTop, 135);
  state.scrollHeight = 500;
  assert.equal(revealSentLineStep(viewport, row, setTop), false);
  assert.equal(state.scrollTop, 266);
  // Enough reply to put the line at the top (8px gap): stop there.
  state.scrollHeight = 900;
  assert.equal(revealSentLineStep(viewport, row, setTop), true);
  assert.equal(state.scrollTop, 322);
});

test("a step never scrolls back up", () => {
  const { state, viewport, row, setTop } = box(812, 234);
  state.scrollHeight = 900;
  state.scrollTop = 400;
  revealSentLineStep(viewport, row, setTop);
  assert.equal(state.scrollTop, 400);
});

test("the walk follows the newest sent line, so later turns reveal too", () => {
  assert.equal(lastSentLineId([]), null);
  assert.equal(lastSentLineId([{ id: "g", role: "assistant" }]), null);
  assert.equal(lastSentLineId([
    { id: "u1", role: "user" }, { id: "a1", role: "assistant" },
    { id: "u2", role: "user" }, { id: "a2", role: "assistant" },
    { id: "__pending_3", role: "user" },
  ]), "__pending_3");
});

test("a third turn starts from a box the last reply left mid-way and still walks up", () => {
  // Turn 3's line sits 1200px down; the reader left the box at 700 after turn 2.
  const state = { scrollTop: 700, scrollHeight: 1240 };
  const viewport = {
    clientHeight: 234,
    get scrollHeight() { return state.scrollHeight; },
    get scrollTop() { return state.scrollTop; },
    getBoundingClientRect: () => ({ top: 100 }),
    ownerDocument: { defaultView: { innerHeight: 812 } },
  } as unknown as HTMLElement;
  const row = { getBoundingClientRect: () => ({ top: 100 + 1200 - state.scrollTop }) } as unknown as HTMLElement;
  const setTop = (_: HTMLElement, top: number) => { state.scrollTop = top; };
  assert.equal(revealSentLineStep(viewport, row, setTop), false);
  assert.equal(state.scrollTop, 1006);
  state.scrollHeight = 1600;
  assert.equal(revealSentLineStep(viewport, row, setTop), true);
  assert.equal(state.scrollTop, 1192);
});

test("a card stage scaled by a transform still lands the line at the top", () => {
  // Stage at 0.75x: the 234px box is 175.5 screen px; the line sits 330 box px down.
  const scale = 0.75;
  const state = { scrollTop: 0, scrollHeight: 900 };
  const viewport = {
    clientHeight: 234,
    offsetHeight: 234,
    get scrollHeight() { return state.scrollHeight; },
    get scrollTop() { return state.scrollTop; },
    getBoundingClientRect: () => ({ top: 100, height: 234 * scale }),
    ownerDocument: { defaultView: { innerHeight: 600 } },
  } as unknown as HTMLElement;
  const row = { getBoundingClientRect: () => ({ top: 100 + (330 - state.scrollTop) * scale }) } as unknown as HTMLElement;
  const setTop = (_: HTMLElement, top: number) => { state.scrollTop = top; };
  assert.equal(revealSentLineStep(viewport, row, setTop), true);
  assert.equal(state.scrollTop, 322);
});
