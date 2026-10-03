import { test } from "node:test";
import assert from "node:assert/strict";
import * as shared from "../dist/index.js";
test("publishing requires both artwork slots and confirmed full-frame crops", () => {
  assert.equal(typeof shared.hasDiscoverCoverArt, "function");
  const crop = { x: 0, y: 0, zoom: 1, fit: "cover" };
  const ready = { thumbnailUrl: "portrait.jpg", landscapeCoverUrl: "wide.jpg", coverCrop: crop, landscapeCoverCrop: crop };
  assert.equal(shared.hasDiscoverCoverArt(ready), true);
  for (const patch of [{landscapeCoverUrl: null}, {coverCrop: null}, {landscapeCoverCrop: null}, {landscapeCoverCrop: {...crop,fit:"contain"}}, {thumbnailUrl:""}]) {
    assert.equal(shared.hasDiscoverCoverArt({...ready,...patch}), false);
  }
});
