import assert from "node:assert/strict";
import test from "node:test";
import { BANNER_ASPECT, LEGACY_BANNER_ASPECT } from "./banner-aspect";
import { convertCoverCrop, getCoverCropRect, normalizeCoverCrop } from "./cropping";
import { editableGalleryCrop, selectGalleryCrop, updateGalleryCrop, GALLERY_ASPECTS } from "./gallery-crop";
const mobile = { x: 12, y: -9, zoom: .7, fit: "cover" as const };
const desktop = { x: -21, y: 14, zoom: .4, fit: "cover" as const };
/** A rectangle in pixels of a picture `width` × `height`, rounded. */
const pixels = (rect: { left: number; top: number; width: number; height: number }, width: number, height: number) =>
  [rect.left * width / 100, rect.top * height / 100, rect.width * width / 100, rect.height * height / 100].map(Math.round);

test("editing either view preserves the other through normalization and JSON", () => {
  const saved = normalizeCoverCrop(JSON.parse(JSON.stringify(updateGalleryCrop(mobile, "desktop", desktop))));
  assert.deepEqual(selectGalleryCrop(saved, "mobile"), mobile);
  assert.deepEqual(selectGalleryCrop(saved, "desktop"), { ...desktop, aspect: BANNER_ASPECT });
  const next = updateGalleryCrop(saved, "mobile", { ...mobile, zoom: .3 });
  assert.deepEqual(selectGalleryCrop(next, "desktop"), { ...desktop, aspect: BANNER_ASPECT });
  assert.equal(selectGalleryCrop(next, "mobile").zoom, .3);
});
test("a mobile-only edit freezes the existing desktop fallback", () => {
  const next = updateGalleryCrop(mobile, "mobile", { ...mobile, y: 25 });
  assert.deepEqual(selectGalleryCrop(next, "desktop"), { ...mobile, aspect: BANNER_ASPECT });
});
test("the desktop banner is 21:9: taller than the old 16:5 strip, still well short of a 16:9 header", () => {
  assert.equal(GALLERY_ASPECTS.desktop, BANNER_ASPECT);
  assert.equal(BANNER_ASPECT, 21 / 9);
  assert.equal(Math.round(1440 / GALLERY_ASPECTS.desktop), 617);
  assert.equal(390 / GALLERY_ASPECTS.mobile, 219.375);
  assert.ok(1440 / GALLERY_ASPECTS.desktop > 1440 / LEGACY_BANNER_ASPECT * 1.3);
  assert.ok(1440 / GALLERY_ASPECTS.desktop < 1440 / GALLERY_ASPECTS.mobile * .8);
});

test("a banner crop saved before 21:9 reads as framed at 16:5, a new one as framed at 21:9", () => {
  const old = normalizeCoverCrop({ ...mobile, desktop });
  assert.equal(old.desktop!.aspect, LEGACY_BANNER_ASPECT);
  assert.equal(selectGalleryCrop(old, "desktop").aspect, LEGACY_BANNER_ASPECT);
  const fresh = normalizeCoverCrop(JSON.parse(JSON.stringify(updateGalleryCrop(old, "desktop", desktop))));
  assert.equal(fresh.desktop!.aspect, BANNER_ASPECT);
  // Only the banner crop carries a shape; the card crop above it never did.
  assert.equal("aspect" in selectGalleryCrop(old, "mobile"), false);
});
test("saving the card crop, or the banner crop untouched, leaves an old banner crop marked as old", () => {
  const old = { ...mobile, desktop };
  const afterMobile = updateGalleryCrop(old, "mobile", { ...mobile, x: 3 });
  assert.deepEqual(afterMobile.desktop, { ...desktop, aspect: LEGACY_BANNER_ASPECT });
  // The picture has not loaded, so its shape is unknown and the crop cannot be rewritten yet.
  const untouched = updateGalleryCrop(old, "desktop", editableGalleryCrop(old, "desktop", null));
  assert.deepEqual(untouched.desktop, { ...desktop, aspect: LEGACY_BANNER_ASPECT });
});

test("an old 16:5 crop keeps its width and centre and grows to 21:9", () => {
  // A 1920 × 1080 cover; the creator framed 1536 × 480, centred 432 px down.
  const old = normalizeCoverCrop({ x: 0, y: 0, zoom: 1, desktop: { x: 0, y: -10, zoom: .8 } });
  const source = 1920 / 1080;
  assert.deepEqual(pixels(getCoverCropRect({ ...old.desktop!, aspect: undefined }, source, LEGACY_BANNER_ASPECT), 1920, 1080), [192, 192, 1536, 480]);
  const rect = getCoverCropRect(selectGalleryCrop(old, "desktop"), source, BANNER_ASPECT);
  assert.deepEqual(pixels(rect, 1920, 1080), [192, 103, 1536, 658]);
  assert.ok(Math.abs(rect.centerY - 40) < 1e-9, "the same centre");
});
test("an old crop near the top edge is moved back inside the picture", () => {
  // Framed 1536 × 480 starting 30 px from the top: 21:9 around the same centre would start 59 px above the picture.
  const old = normalizeCoverCrop({ x: 0, y: 0, zoom: 1, desktop: { x: 0, y: -25, zoom: .8 } });
  const source = 1920 / 1080;
  assert.deepEqual(pixels(getCoverCropRect({ ...old.desktop!, aspect: undefined }, source, LEGACY_BANNER_ASPECT), 1920, 1080), [192, 30, 1536, 480]);
  assert.deepEqual(pixels(getCoverCropRect(selectGalleryCrop(old, "desktop"), source, BANNER_ASPECT), 1920, 1080), [192, 0, 1536, 658]);
  const bottom = normalizeCoverCrop({ x: 0, y: 0, zoom: 1, desktop: { x: 0, y: 27, zoom: .8 } });
  assert.deepEqual(pixels(getCoverCropRect(selectGalleryCrop(bottom, "desktop"), source, BANNER_ASPECT), 1920, 1080), [192, 422, 1536, 658]);
});
test("the width shrinks only when the picture is not tall enough", () => {
  // A 3000 × 1000 cover: the whole picture at 16:5 would need 1286 px of height at 21:9.
  const old = normalizeCoverCrop({ x: 0, y: 0, zoom: 1, desktop: { x: 0, y: 0, zoom: 1 } });
  assert.deepEqual(pixels(getCoverCropRect(selectGalleryCrop(old, "desktop"), 3, BANNER_ASPECT), 3000, 1000), [333, 0, 2333, 1000]);
  // A smaller frame on the same picture still fits, so it keeps its width: 1500 × 469 becomes 1500 × 643.
  const small = normalizeCoverCrop({ x: 0, y: 0, zoom: 1, desktop: { x: 10, y: 0, zoom: .5 } });
  assert.deepEqual(pixels(getCoverCropRect(selectGalleryCrop(small, "desktop"), 3, BANNER_ASPECT), 3000, 1000), [1050, 179, 1500, 643]);
});

test("convertCoverCrop rewrites an old crop as plain 21:9 coordinates for the same rectangle", () => {
  for (const source of [2 / 3, 1, 16 / 9, 2.5, 3, 4]) {
    for (const frame of [{ x: 0, y: 0, zoom: 1 }, { x: 31, y: -40, zoom: .25 }, { x: -18, y: 22, zoom: .63 }]) {
      const old = selectGalleryCrop({ x: 0, y: 0, zoom: 1, desktop: frame }, "desktop");
      const converted = convertCoverCrop(old, source, BANNER_ASPECT);
      assert.equal(converted.aspect, BANNER_ASPECT);
      assert.ok(converted.zoom >= .25 && converted.zoom <= 1);
      const wanted = getCoverCropRect(old, source, BANNER_ASPECT);
      // Read without any hint, as a crop saved today is.
      const actual = getCoverCropRect({ ...converted, aspect: undefined }, source, BANNER_ASPECT);
      for (const key of ["left", "top", "width", "height"] as const) {
        assert.ok(Math.abs(actual[key] - wanted[key]) < 1e-9, `source ${source}, ${key}: ${actual[key]} != ${wanted[key]}`);
      }
      assert.ok(actual.left >= -1e-9 && actual.top >= -1e-9 && actual.left + actual.width <= 100 + 1e-9 && actual.top + actual.height <= 100 + 1e-9);
      assert.ok(Math.abs(actual.width / actual.height * source - BANNER_ASPECT) < 1e-9, "exactly the banner shape");
      assert.deepEqual(convertCoverCrop(converted, source, BANNER_ASPECT), converted, "converting twice changes nothing");
    }
  }
});
test("a crop framed at 21:9, or one that names no shape, is left as it is", () => {
  const fresh = { ...desktop, aspect: BANNER_ASPECT };
  assert.equal(convertCoverCrop(fresh, 16 / 9, BANNER_ASPECT), fresh);
  assert.equal(convertCoverCrop(mobile, 16 / 9, BANNER_ASPECT), mobile);
  assert.equal(editableGalleryCrop({ ...mobile, desktop: fresh }, "desktop", 3).zoom, desktop.zoom);
  // The editor rewrites an old one once it knows the picture's shape, so its controls match the frame on screen:
  // on a 3:1 picture the same width is a larger share of the widest 21:9 frame than of the widest 16:5 one.
  const edited = editableGalleryCrop({ ...mobile, desktop }, "desktop", 3);
  assert.equal(edited.aspect, BANNER_ASPECT);
  assert.ok(Math.abs(edited.zoom - desktop.zoom / (BANNER_ASPECT / 3)) < 1e-9);
});
