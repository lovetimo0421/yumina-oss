import { strict as assert } from "node:assert";
import { test } from "node:test";
import { measureGaps, snapToNeighbours, type Rect } from "./helper-lines";

/**
 * Slides-style smart guides: a frame being dragged snaps its edges and centre
 * to the edges and centres of the frames around it, and says which line it
 * snapped to so the canvas can draw it.
 */

const r = (id: string, x: number, y: number, width = 100, height = 50): Rect => ({ id, x, y, width, height });

test("snaps a left edge that comes within reach of a neighbour's left edge, and reports the line", () => {
  const out = snapToNeighbours(r("a", 104, 300), [r("b", 100, 0)], 8);
  assert.equal(out.x, 100);
  assert.equal(out.y, 300);
  assert.deepEqual(out.vertical, { x: 100, from: 0, to: 350 });
  assert.equal(out.horizontal, undefined);
});

test("centres count too — aligning middles is what people reach for", () => {
  // b's centre x is 150; a (width 60) centred there has x = 120.
  const out = snapToNeighbours(r("a", 117, 300, 60), [r("b", 100, 0)], 8);
  assert.equal(out.x, 120);
  assert.equal(out.vertical?.x, 150);
});

test("snaps a top edge to a neighbour's bottom edge (stacking) and leaves x alone", () => {
  const out = snapToNeighbours(r("a", 400, 56), [r("b", 0, 0)], 8);
  assert.equal(out.x, 400);
  assert.equal(out.y, 50);
  assert.deepEqual(out.horizontal, { y: 50, from: 0, to: 500 });
});

test("does nothing when nothing is within reach", () => {
  const out = snapToNeighbours(r("a", 300, 300), [r("b", 0, 0)], 8);
  assert.equal(out.x, 300);
  assert.equal(out.y, 300);
  assert.equal(out.vertical, undefined);
  assert.equal(out.horizontal, undefined);
});

test("the nearest candidate wins when several are in reach", () => {
  const out = snapToNeighbours(r("a", 106, 300), [r("b", 100, 0), r("c", 110, 0)], 8);
  assert.equal(out.x, 110);
});

test("ignores itself", () => {
  const out = snapToNeighbours(r("a", 103, 300), [r("a", 100, 300)], 8);
  assert.equal(out.x, 103);
});

test("measures the nearest neighbour it faces on each side, and ignores ones out of line or out of reach", () => {
  const gaps = measureGaps(r("a", 200, 100), [r("left", 50, 110), r("far", -900, 100), r("below", 210, 200), r("offline", 400, 500)], 300);
  const byAxis = gaps.map((g) => `${g.axis}:${g.distance}`).sort();
  assert.deepEqual(byAxis, ["x:50", "y:50"]);
  const left = gaps.find((g) => g.axis === "x")!;
  assert.equal(left.x1, 150);
  assert.equal(left.x2, 200);
});
