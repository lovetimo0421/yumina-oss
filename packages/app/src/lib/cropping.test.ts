import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampCoverCropForAspect,
  getCoverCropRect,
  normalizeCoverCrop,
  type CropRect,
} from "./cropping";

const GALLERY = 16 / 9; // the dialog's "Gallery preview" frame
const PORTRAIT = 2 / 3; // the dialog's "Card cover" frame
const PROFILE_FRAMES = [4 / 3, 16 / 9, 2];
const EPS = 1e-9;

function assertRectClose(actual: CropRect, expected: CropRect) {
  for (const key of Object.keys(expected) as Array<keyof CropRect>) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < EPS,
      `${key}: ${actual[key]} should equal ${expected[key]}`,
    );
  }
}

function contains(outer: CropRect, inner: CropRect) {
  return (
    outer.left <= inner.left + EPS
    && outer.top <= inner.top + EPS
    && outer.left + outer.width >= inner.left + inner.width - EPS
    && outer.top + outer.height >= inner.top + inner.height - EPS
  );
}

function pixelAspect(rect: CropRect, sourceAspect: number) {
  return (rect.width / rect.height) * sourceAspect;
}

describe("cover crop re-framing", () => {
  it("keeps persisted crop shapes free of frame hints", () => {
    assert.deepEqual(normalizeCoverCrop({ x: 1, y: 2, zoom: 0.5 }), {
      x: 1,
      y: 2,
      zoom: 0.5,
      fit: "cover",
    });
    assert.equal(normalizeCoverCrop({ x: 1, y: 2, zoom: 0.5, aspect: GALLERY }).aspect, GALLERY);
    const reauthored = clampCoverCropForAspect(
      { x: 1, y: 2, zoom: 0.5, aspect: GALLERY },
      1.5,
      4 / 3,
    );
    assert.equal("aspect" in reauthored, false);
  });

  it("renders a crop exactly as before at the aspect it was authored in", () => {
    const crop = { x: -12, y: 18, zoom: 0.55 };
    for (const sourceAspect of [0.6, 1, 1.5, 2, 4]) {
      assertRectClose(
        getCoverCropRect({ ...crop, aspect: GALLERY }, sourceAspect, GALLERY),
        getCoverCropRect(crop, sourceAspect, GALLERY),
      );
      assertRectClose(
        getCoverCropRect({ ...crop, aspect: PORTRAIT }, sourceAspect, PORTRAIT),
        getCoverCropRect(crop, sourceAspect, PORTRAIT),
      );
    }
  });

  it("keeps the authored 16:9 region fully in view on a 4:3 profile card", () => {
    // Source between 4:3 and 16:9. Re-reading x/y/zoom against the 4:3 card
    // shrank the width and cut the sides of what the creator framed.
    const crop = { x: -20, y: 10, zoom: 0.6 };
    const sourceAspect = 1.5;
    const authored = getCoverCropRect(crop, sourceAspect, GALLERY);
    const shown = getCoverCropRect({ ...crop, aspect: GALLERY }, sourceAspect, 4 / 3);

    assert.ok(contains(shown, authored), `${JSON.stringify(shown)} should contain ${JSON.stringify(authored)}`);
    assert.ok(Math.abs(shown.centerX - authored.centerX) < EPS);
    assert.ok(Math.abs(shown.centerY - authored.centerY) < EPS);
    assert.ok(Math.abs(pixelAspect(shown, sourceAspect) - 4 / 3) < EPS);

    const reread = getCoverCropRect(crop, sourceAspect, 4 / 3);
    assert.ok(reread.width < authored.width, "the old reading cut the sides");
  });

  it("grows sideways when the card is wider than the authored frame", () => {
    const crop = { x: 0, y: -20, zoom: 0.5 };
    const sourceAspect = 1;
    const authored = getCoverCropRect(crop, sourceAspect, PORTRAIT);
    const shown = getCoverCropRect({ ...crop, aspect: PORTRAIT }, sourceAspect, 2);

    assert.ok(contains(shown, authored));
    assert.ok(Math.abs(shown.height - authored.height) < EPS);
    assert.ok(Math.abs(pixelAspect(shown, sourceAspect) - 2) < EPS);
  });

  it("never overflows the image and always matches the card frame", () => {
    const crops = [
      { x: 45, y: 45, zoom: 1 },
      { x: -45, y: -45, zoom: 1 },
      { x: 30, y: -30, zoom: 0.25 },
      { x: 0, y: 0, zoom: 0.7 },
    ];
    for (const crop of crops) {
      for (const sourceAspect of [0.5, 2 / 3, 1, 16 / 9, 2, 3]) {
        for (const targetAspect of PROFILE_FRAMES) {
          const shown = getCoverCropRect({ ...crop, aspect: GALLERY }, sourceAspect, targetAspect);
          assert.ok(shown.left >= -EPS && shown.top >= -EPS);
          assert.ok(shown.left + shown.width <= 100 + EPS);
          assert.ok(shown.top + shown.height <= 100 + EPS);
          assert.ok(Math.abs(pixelAspect(shown, sourceAspect) - targetAspect) < 1e-6);
        }
      }
    }
  });

  it("leaves untouched worlds on the plain fit for every card shape", () => {
    for (const sourceAspect of [0.6, 1, 1.5, 2, 4]) {
      for (const targetAspect of PROFILE_FRAMES) {
        assertRectClose(
          getCoverCropRect({ x: 0, y: 0, zoom: 1, aspect: GALLERY }, sourceAspect, targetAspect),
          getCoverCropRect(null, sourceAspect, targetAspect),
        );
      }
    }
  });
});
