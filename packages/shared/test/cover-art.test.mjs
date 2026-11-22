import { test } from "node:test";
import assert from "node:assert/strict";
import * as shared from "../dist/index.js";
test("publishing requires both artwork slots; crops are optional but must be full-frame when set", () => {
  assert.equal(typeof shared.hasDiscoverCoverArt, "function");
  const crop = { x: 0, y: 0, zoom: 1, fit: "cover" };
  const ready = { thumbnailUrl: "portrait.jpg", landscapeCoverUrl: "wide.jpg", coverCrop: crop, landscapeCoverCrop: crop };
  assert.equal(shared.hasDiscoverCoverArt(ready), true);
  for (const patch of [{coverCrop: null}, {landscapeCoverCrop: undefined}]) {
    assert.equal(shared.hasDiscoverCoverArt({...ready,...patch}), true);
  }
  for (const patch of [{landscapeCoverUrl: null}, {landscapeCoverCrop: {...crop,fit:"contain"}}, {thumbnailUrl:""}]) {
    assert.equal(shared.hasDiscoverCoverArt({...ready,...patch}), false);
  }
});

test("artwork diagnostics list only missing images or unusable crops", () => {
  const crop = { x: 0, y: 0, zoom: 1, fit: "cover" };
  const ready = { thumbnailUrl: "portrait.jpg", landscapeCoverUrl: "wide.jpg", coverCrop: crop, landscapeCoverCrop: crop };
  assert.deepEqual(shared.getDiscoverCoverArtIssues(ready), []);
  assert.deepEqual(shared.getDiscoverCoverArtIssues({}), ["portraitImage", "landscapeImage"]);
  assert.deepEqual(shared.getDiscoverCoverArtIssues({ ...ready, landscapeCoverUrl: " " }), ["landscapeImage"]);
  // A crop nobody set is drawn centred and full-frame, so it does not block publishing.
  assert.deepEqual(shared.getDiscoverCoverArtIssues({ ...ready, coverCrop: null, landscapeCoverCrop: undefined }), []);
  for (const invalid of [{}, "centre", { ...crop, fit: "contain" }, { ...crop, zoom: 0.1 }, { ...crop, x: NaN }]) {
    assert.deepEqual(shared.getDiscoverCoverArtIssues({ ...ready, landscapeCoverCrop: invalid }), ["landscapeCrop"]);
  }
});


test("admin artwork updates preserve independent gallery frames and reject invalid nested fields", () => {
  const mobile = { x: 12, y: -9, zoom: .7, fit: "cover" };
  const desktop = { x: -21, y: 14, zoom: .4, fit: "cover" };
  const payload = { expectedRevision: "a".repeat(64), landscapeCoverCrop: { ...mobile, desktop } };
  assert.deepEqual(shared.adminWorldArtworkUpdateSchema.parse(payload), payload);
  assert.equal(shared.adminWorldArtworkUpdateSchema.safeParse({ ...payload, landscapeCoverCrop: { ...mobile, desktop: { ...desktop, zoom: .1 } } }).success, false);
  assert.equal(shared.adminWorldArtworkUpdateSchema.safeParse({ ...payload, landscapeCoverCrop: { ...mobile, desktop: { ...desktop, src: "untrusted" } } }).success, false);
});
