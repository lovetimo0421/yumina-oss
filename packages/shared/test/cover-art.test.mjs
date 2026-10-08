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

test("artwork diagnostics list only missing images or unconfirmed crops", () => {
  const crop = { x: 0, y: 0, zoom: 1, fit: "cover" };
  const ready = { thumbnailUrl: "portrait.jpg", landscapeCoverUrl: "wide.jpg", coverCrop: crop, landscapeCoverCrop: crop };
  assert.deepEqual(shared.getDiscoverCoverArtIssues(ready), []);
  assert.deepEqual(shared.getDiscoverCoverArtIssues({}), ["portraitImage", "landscapeImage"]);
  assert.deepEqual(shared.getDiscoverCoverArtIssues({ ...ready, landscapeCoverUrl: " " }), ["landscapeImage"]);
  assert.deepEqual(shared.getDiscoverCoverArtIssues({ ...ready, coverCrop: null }), ["portraitCrop"]);
  for (const invalid of [undefined, null, {}, { ...crop, fit: "contain" }, { ...crop, zoom: 0.1 }, { ...crop, x: NaN }]) {
    assert.deepEqual(shared.getDiscoverCoverArtIssues({ ...ready, landscapeCoverCrop: invalid }), ["landscapeCrop"]);
  }
});
