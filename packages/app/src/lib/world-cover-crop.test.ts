import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coverCropImageLayoutStyle } from "./cropping";
import { discoveryCoverImageRenderer, getWorldGalleryDisplayCrop, HEAD_SAFE_GALLERY_HERO_CROP } from "./world-cover-crop";

function numericPercent(value: unknown) {
  if (typeof value !== "string") {
    throw new TypeError(`Expected a percentage string, received ${typeof value}`);
  }
  return Number.parseFloat(value);
}

describe("head-safe gallery hero crop", () => {
  it("keeps the complete source inside heroes at different monitor widths", () => {
    for (const sourceAspect of [3 / 4, 1, 16 / 9, 3]) {
      for (const targetAspect of [1.6, 2.4, 16 / 5, 3.6]) {
        const style = coverCropImageLayoutStyle(
          HEAD_SAFE_GALLERY_HERO_CROP,
          sourceAspect,
          targetAspect,
        );
        const width = numericPercent(style.width);
        const height = numericPercent(style.height);
        const left = numericPercent(style.left);
        const top = numericPercent(style.top);

        assert.ok(width <= 100);
        assert.ok(height <= 100);
        assert.ok(left >= 0);
        assert.ok(top >= 0);
        assert.ok(left + width <= 100.000001);
        assert.ok(top + height <= 100.000001);
      }
    }
  });

  it("uses neutral, full-image contain framing", () => {
    assert.deepEqual(HEAD_SAFE_GALLERY_HERO_CROP, {
      x: 0,
      y: 0,
      zoom: 1,
      fit: "contain",
    });
  });
});


describe("Discover framing defaults", () => {
  it("fills every Discover frame with uncropped artwork, accepting edge cropping", () => {
    for (const sourceAspect of [1 / 3, 2 / 3, 3 / 4, 1]) {
      for (const targetAspect of [16 / 10, 16 / 9, 3]) {
        const style = discoveryCoverImageRenderer.getImageStyle({ crop: null, sourceAspect, targetAspect });
        const height = numericPercent(style.height), top = numericPercent(style.top);
        const width = numericPercent(style.width), left = numericPercent(style.left);
        assert.ok(top <= 0 && top + height >= 99.999999, `${sourceAspect} into ${targetAspect}: no vertical gaps`);
        assert.ok(left <= 0 && left + width >= 99.999999, "no horizontal gaps");
      }
    }
  });

  it("does not discard a creator's whole-image setting", () => {
    assert.deepEqual(getWorldGalleryDisplayCrop(HEAD_SAFE_GALLERY_HERO_CROP), HEAD_SAFE_GALLERY_HERO_CROP);
  });

  it("preserves explicit creator framing, including centered crops", () => {
    for (const crop of [{ x: 0, y: 0, zoom: 1 }, { x: 20, y: 30, zoom: .6 }]) {
      assert.deepEqual(discoveryCoverImageRenderer.getImageStyle({ crop, sourceAspect: 2 / 3, targetAspect: 1.6 }), coverCropImageLayoutStyle(crop, 2 / 3, 1.6));
    }
  });

  it("fills legacy contain-mode cards without changing the stored crop or detail-view framing", () => {
    const crop = { x: 12, y: -10, zoom: .8, fit: "contain" as const };
    assert.deepEqual(discoveryCoverImageRenderer.getImageStyle({ crop, sourceAspect: 2 / 3, targetAspect: 16 / 9 }),
      coverCropImageLayoutStyle({ ...crop, fit: "cover" }, 2 / 3, 16 / 9));
    assert.equal(crop.fit, "contain");
    assert.deepEqual(getWorldGalleryDisplayCrop(crop), crop);
  });

  it("retains centered composition for landscape artwork and incomplete image dimensions", () => {
    for (const [sourceAspect, targetAspect] of [[16 / 9, 6 / 7], [2 / 3, 2 / 3], [2, 3], [null, null]]) {
      assert.deepEqual(discoveryCoverImageRenderer.getImageStyle({ crop: null, sourceAspect, targetAspect }), coverCropImageLayoutStyle(undefined, sourceAspect, targetAspect));
    }
  });
});
