import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTopEdgeSample,
  shouldRevealTopEdge,
  TOP_EDGE_PX,
  TOP_EDGE_ALWAYS_PX,
} from "./top-edge-gate.js";

// ── classifyTopEdgeSample (mouse path: edge-slam only) ──────────────

test("the outermost strip fires immediately", () => {
  assert.equal(classifyTopEdgeSample(0), "fire");
  assert.equal(classifyTopEdgeSample(TOP_EDGE_ALWAYS_PX), "fire");
});

// Regression (@burlingk): merely RESTING the cursor in the top band — how
// readers track their place in the text — used to summon the bar over the
// text after a 300ms dwell, with no setting to stop it. Mouse presence in
// the band (outside the slam strip) must never reveal.
test("mouse samples below the slam strip never fire", () => {
  assert.equal(classifyTopEdgeSample(TOP_EDGE_ALWAYS_PX + 1), "cancel");
  assert.equal(classifyTopEdgeSample(30), "cancel");
  assert.equal(classifyTopEdgeSample(TOP_EDGE_PX), "cancel");
  assert.equal(classifyTopEdgeSample(TOP_EDGE_PX + 1), "cancel");
  assert.equal(classifyTopEdgeSample(300), "cancel");
  assert.equal(classifyTopEdgeSample(Infinity), "cancel");
});

// ── shouldRevealTopEdge (touch path: discrete taps keep the wide band) ──

test("touch: taps below the band never reveal", () => {
  assert.equal(shouldRevealTopEdge(TOP_EDGE_PX + 1, false), false);
  assert.equal(shouldRevealTopEdge(Infinity, false), false);
});

test("touch: taps in the band over plain content reveal", () => {
  assert.equal(shouldRevealTopEdge(TOP_EDGE_ALWAYS_PX + 1, false), true);
  assert.equal(shouldRevealTopEdge(TOP_EDGE_PX, false), true);
});

// Regression (@haorenstalin): tapping the "show earlier messages" button must
// not slide the bar in on top of it and steal the follow-up tap.
test("touch: taps in the band over interactive controls do not reveal", () => {
  assert.equal(shouldRevealTopEdge(30, true), false);
});

test("touch: the outermost strip reveals even over interactive controls", () => {
  assert.equal(shouldRevealTopEdge(0, true), true);
  assert.equal(shouldRevealTopEdge(TOP_EDGE_ALWAYS_PX, true), true);
});
