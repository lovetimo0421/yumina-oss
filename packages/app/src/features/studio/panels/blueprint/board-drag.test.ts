import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Block } from "@yumina/engine";
import { FRAME_COLLAPSED_H, FRAME_COLLAPSED_W, FRAME_GAP } from "./board";
import { tileBoardLayout } from "./tile-board";

/**
 * A frame the creator dragged stays where they put it; the rest flow into
 * the formation around it. Nothing may overlap: when a frame grows into the
 * one below, the one below moves down, keeping the left/right the creator
 * chose and the order they are in.
 */

const block = (id: string): Block => ({ id, kind: "state", ownerId: "x", headSlots: [], rows: [], hiddenCount: 0, total: 1, sharedCount: 0 });
const tall = () => 400;
const frames = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `module:m${i}`, blocks: [] as Block[] }));
const layout = (fs: ReturnType<typeof frames>, pinned?: Record<string, { x: number; y: number }>, isOpen: (id: string) => boolean = () => false) =>
  tileBoardLayout(fs, tall, { isOpen, pinned, rowW: 3000 });

test("a pinned frame keeps its coordinate", () => {
  const boxes = layout(frames(3), { "module:m1": { x: 900, y: 700 } });
  const m1 = boxes.find((b) => b.id === "module:m1")!;
  assert.deepEqual({ x: m1.x, y: m1.y }, { x: 900, y: 700 });
});

test("unpinned frames still tile as a formation", () => {
  const boxes = layout(frames(3), { "module:m1": { x: 900, y: 700 } });
  const m0 = boxes.find((b) => b.id === "module:m0")!;
  const m2 = boxes.find((b) => b.id === "module:m2")!;
  assert.equal(m0.y, m2.y, "the two free frames share a row");
  assert.equal(m2.x - m0.x, FRAME_COLLAPSED_W + FRAME_GAP);
});

test("a frame dropped onto another stays exactly where it was dropped — like a slide, the overlap is the creator's to see", () => {
  const pinned = { "module:m0": { x: 0, y: 0 }, "module:m1": { x: 40, y: 10 } };
  const boxes = layout(frames(2), pinned);
  const m1 = boxes.find((b) => b.id === "module:m1")!;
  assert.deepEqual({ x: m1.x, y: m1.y }, { x: 40, y: 10 });
});

test("a pinned frame is not moved when the frame above it grows", () => {
  const two = frames(2).map((f, i) => (i === 0 ? { ...f, blocks: [block("block:m:m0:state")] } : f));
  const pinned = { "module:m0": { x: 0, y: 0 }, "module:m1": { x: 0, y: FRAME_COLLAPSED_H + FRAME_GAP } };
  const open = layout(two, pinned, (id) => id === "module:m0");
  const m1Open = open.find((b) => b.id === "module:m1")!;
  const m0Open = open.find((b) => b.id === "module:m0")!;
  assert.ok(m0Open.height > FRAME_COLLAPSED_H, "opening m0 makes it taller");
  assert.equal(m1Open.y, FRAME_COLLAPSED_H + FRAME_GAP, "m1 stays where the creator put it");
});

test("a free frame still flows below a pinned frame it would overlap", () => {
  // m1 is pinned right where the formation would put m0; m0 (free) goes under it.
  const boxes = layout(frames(2), { "module:m1": { x: -400, y: -23 } });
  const m0 = boxes.find((b) => b.id === "module:m0")!;
  const m1 = boxes.find((b) => b.id === "module:m1")!;
  const overlapX = m0.x < m1.x + m1.width && m1.x < m0.x + m0.width;
  if (overlapX) assert.ok(m0.y >= m1.y + m1.height + FRAME_GAP, `m0 at ${m0.y}, m1 bottom ${m1.y + m1.height}`);
});

test("with nothing pinned the layout is the formation it always was", () => {
  const a = layout(frames(4));
  const b = layout(frames(4), {});
  assert.deepEqual(a.map((f) => [f.id, f.x, f.y]), b.map((f) => [f.id, f.x, f.y]));
});

test("a free frame above a pinned one it shares columns with stays where it is", () => {
  // The pin is far below, so the two only overlap horizontally. Settling used
  // to check that alone and shove the free frame under the pin — "I moved one
  // and three others jumped".
  const alone = layout(frames(1)).find((b) => b.id === "module:m0")!;
  const boxes = layout(frames(2), { "module:m1": { x: alone.x, y: alone.y + 5000 } });
  const m0 = boxes.find((b) => b.id === "module:m0")!;
  assert.deepEqual({ x: m0.x, y: m0.y }, { x: alone.x, y: alone.y });
});
