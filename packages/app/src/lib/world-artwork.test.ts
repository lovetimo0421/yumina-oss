import assert from "node:assert/strict";
import { test } from "node:test";
import { selectWorldArtwork } from "./world-cover-crop";

const portrait = { x: 0, y: -20, zoom: .8, fit: "cover" as const };
const wide = { x: 12, y: -10, zoom: .9, fit: "cover" as const };

test("each card shape selects its own source and framing", () => {
  const world = { thumbnailUrl: "portrait.jpg", coverCrop: portrait, landscapeCoverUrl: "wide.jpg", landscapeCoverCrop: wide };
  assert.deepEqual(selectWorldArtwork(world, "portrait"), { src: "portrait.jpg", crop: portrait, dedicated: true });
  assert.deepEqual(selectWorldArtwork(world, "landscape"), { src: "wide.jpg", crop: wide, dedicated: true });
});

test("legacy cards fill the wide frame, preserve saved position, and do not become confirmed artwork", () => {
  const legacy = { thumbnailUrl: "old.jpg", coverCrop: portrait, galleryCoverCrop: { ...wide, fit: "contain" as const } };
  assert.deepEqual(selectWorldArtwork(legacy, "landscape"), { src: "old.jpg", crop: wide, dedicated: false });
  assert.equal(legacy.galleryCoverCrop.fit, "contain");
});

test("missing artwork remains missing; a wide source does not silently reuse a portrait crop", () => {
  assert.equal(selectWorldArtwork({}, "portrait").src, null);
  const artwork = selectWorldArtwork({ thumbnailUrl: "old.jpg", coverCrop: portrait, landscapeCoverUrl: "wide.jpg" }, "landscape");
  assert.equal(artwork.crop.x, 0);
  assert.equal(artwork.crop.y, 0);
  assert.equal(artwork.crop.zoom, 1);
});
