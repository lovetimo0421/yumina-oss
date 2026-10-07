import assert from "node:assert/strict";
import test from "node:test";
import { getStageInspectorLayout, STAGE_CANVAS_MIN_WIDTH, STAGE_INDEX_RAIL_WIDTH, STAGE_INSPECTOR_DEFAULT_WIDTH } from "./stage-inspector-layout";

test("a narrow workspace overlays the inspector and a wide workspace leaves room for the canvas", () => {
  assert.deepEqual(getStageInspectorLayout(780, 360), { overlay: true, minWidth: 280, maxWidth: 520, width: 360 });
  for (const stageWidth of [884, 900, 1000, 1280, 1920]) {
    const layout = getStageInspectorLayout(stageWidth, 520);
    assert.equal(layout.overlay, false);
    assert.ok(stageWidth - STAGE_INDEX_RAIL_WIDTH - layout.width >= STAGE_CANVAS_MIN_WIDTH);
    assert.ok(layout.width >= 280 && layout.width <= 520);
  }
  assert.equal(getStageInspectorLayout(883, 360).overlay, true);
});

test("temporary constraints preserve the preferred width and keep the close control within the workspace", () => {
  const preferred = 500;
  assert.equal(getStageInspectorLayout(420, preferred).width, 352);
  assert.equal(getStageInspectorLayout(1280, preferred).width, preferred);
  for (const width of [240, 300, 360, 420, 780]) {
    const layout = getStageInspectorLayout(width, 520);
    assert.equal(layout.overlay, true);
    assert.ok(layout.width <= width - STAGE_INDEX_RAIL_WIDTH - 24);
    assert.ok(layout.minWidth <= layout.width && layout.width <= layout.maxWidth);
  }
});

test("unmeasured workspaces start with an overlay and invalid preferences use the normal default", () => {
  assert.equal(getStageInspectorLayout(0, 360).overlay, true);
  assert.equal(getStageInspectorLayout(1280, Number.NaN).width, STAGE_INSPECTOR_DEFAULT_WIDTH);
  assert.equal(getStageInspectorLayout(1280, -100).width, 280);
});
