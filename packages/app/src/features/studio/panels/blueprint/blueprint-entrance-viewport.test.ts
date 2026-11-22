import assert from "node:assert/strict";
import test from "node:test";
import { blueprintEntranceViewport } from "./blueprint-entrance-viewport";

for (const [name, width, left, right, boardWidth] of [
  ["laptop with assistant", 1200, 0, 420, 1400],
  ["narrow canvas with both docks", 900, 180, 360, 1200],
  ["multiple module columns", 1440, 0, 420, 3000],
  ["small phone canvas", 320, 0, 0, 1500],
  ["wide desktop", 2400, 0, 420, 1000],
] as const) {
  test(`${name}: both horizontal edges are visible on entry`, () => {
    const bounds = { x: -350, y: -120, width: boardWidth, height: 1800 };
    const viewport = blueprintEntranceViewport(bounds, width, { left, right }, 16, 800)!;
    assert.ok(viewport);
    const start = viewport.x + bounds.x * viewport.zoom;
    const end = start + bounds.width * viewport.zoom;
    assert.ok(start >= left + 24 - 1e-6);
    assert.ok(end <= width - right - 24 + 1e-6);
    assert.ok(Math.abs(viewport.y + bounds.y * viewport.zoom - 40) < 1e-6);
    assert.ok(viewport.zoom <= 1);
    if (viewport.zoom < 1) {
      assert.ok(Math.abs(start - left - 24) < 1e-6);
      assert.ok(Math.abs(end - (width - right - 24)) < 1e-6);
    }
  });
}

test("waits for usable measurements", () => {
  assert.equal(blueprintEntranceViewport({ x: 0, y: 0, width: 0, height: 100 }, 1000, { left: 0, right: 0 }, 16, 800), null);
  assert.equal(blueprintEntranceViewport({ x: 0, y: 0, width: 100, height: 100 }, 400, { left: 0, right: 400 }, 16, 800), null);
  assert.equal(blueprintEntranceViewport({ x: 0, y: 0, width: 100, height: 100 }, 1000, { left: 0, right: 0 }, 16, 50), null);
});

test("the default assistant column shifts the initial board center left", () => {
  const bounds = { x: 0, y: 0, width: 1400, height: 400 };
  const margins = { left: 12, right: 12 };
  // DockWorkspace gives the canvas the remaining width after mounting AI.
  const closed = blueprintEntranceViewport(bounds, 1440, margins, 16, 800)!;
  const open = blueprintEntranceViewport(bounds, 1440 - 400, margins, 16, 800)!;
  const center = (viewport: typeof open) => viewport.x + bounds.width * viewport.zoom / 2;
  assert.equal(center(open), 520);
  assert.equal(center(closed) - center(open), 200);
  assert.ok(open.x + bounds.width * open.zoom <= 1040 - 36);
});

test("a tall card uses the same width fit on short and tall screens", () => {
  const bounds = { x: -100, y: 50, width: 1400, height: 1800 };
  const laptop = blueprintEntranceViewport(bounds, 1000, { left: 12, right: 12 }, 16, 560)!;
  const desktop = blueprintEntranceViewport(bounds, 1000, { left: 12, right: 12 }, 16, 1000)!;
  assert.equal(laptop.zoom, desktop.zoom);
  assert.equal(laptop.zoom, (1000 - 24 - 48) / 1400);
  assert.ok(laptop.y + (bounds.y + bounds.height) * laptop.zoom > 560, "height is pannable instead of shrinking the whole board");
});
