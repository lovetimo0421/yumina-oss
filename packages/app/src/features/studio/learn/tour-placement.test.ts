import test from "node:test";
import assert from "node:assert/strict";
import { clipTourTarget, placeTourCard, type TourBox } from "./tour-placement";

function inside(card: TourBox, viewport: TourBox) {
  assert.ok(card.left >= viewport.left + 12 && card.top >= viewport.top + 12);
  assert.ok(card.left + card.width <= viewport.left + viewport.width - 12);
  assert.ok(card.top + card.height <= viewport.top + viewport.height - 12);
}
test("desktop guide avoids the writing field and stays inside the viewport", () => {
  const viewport = { left: 0, top: 0, width: 1366, height: 768 };
  const target = { left: 400, top: 200, width: 350, height: 250 };
  const card = placeTourCard(target, viewport, { width: 380, height: 320 });
  inside(card, viewport);
  assert.ok(card.left >= target.left + target.width || card.left + card.width <= target.left || card.top >= target.top + target.height || card.top + card.height <= target.top);
});
test("a card under a wide shelf is centred on it", () => {
  const viewport = { left: 0, top: 0, width: 1366, height: 768 };
  const shelf = { left: 40, top: 100, width: 1280, height: 300 };
  const card = placeTourCard(shelf, viewport, { width: 380, height: 300 });
  assert.equal(card.top, 416, "under the shelf, since neither side has room");
  assert.equal(card.left, 40 + (1280 - 380) / 2);
});
test("phone guide fits the visible space above a keyboard with viewport offset", () => {
  const viewport = { left: 0, top: 120, width: 375, height: 300 };
  const card = placeTourCard({ left: 20, top: 145, width: 335, height: 100 }, viewport, { width: 380, height: 68 });
  inside(card, viewport);
  assert.equal(card.width, 351);
  assert.ok(card.top >= 245, "folded guide stays below the input");
  inside(placeTourCard(null, viewport, { width: 380, height: 600 }), viewport);
});
test("offscreen targets are discarded and partial targets are clipped", () => {
  const viewport = { left: 0, top: 0, width: 375, height: 667 };
  assert.equal(clipTourTarget({ left: -500, top: 100, width: 50, height: 50 }, viewport), null);
  assert.deepEqual(clipTourTarget({ left: -10, top: 100, width: 200, height: 50 }, viewport), { left: 4, top: 94, width: 192, height: 62 });
});
