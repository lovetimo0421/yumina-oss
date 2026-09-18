import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PROFILE_BANNER_CROP,
  getMobileProfileBannerDisplayCrop,
  normalizeProfileBannerCrop,
} from "./profile-banner-crop";

describe("profile banner crop", () => {
  it("uses cover fitting for the default mobile banner crop", () => {
    assert.equal(DEFAULT_PROFILE_BANNER_CROP.mobile.fit, "cover");
  });

  it("normalizes old mobile contain crops to cover while preserving framing", () => {
    const crop = getMobileProfileBannerDisplayCrop({
      x: 12,
      y: -8,
      zoom: 0.75,
      fit: "contain",
    });

    assert.deepEqual(crop, {
      x: 12,
      y: -8,
      zoom: 0.75,
      fit: "cover",
    });
  });

  it("normalizes saved profile banner crops for mobile cover rendering", () => {
    const crop = normalizeProfileBannerCrop({
      mobile: {
        x: -20,
        y: 10,
        zoom: 0.5,
        fit: "contain",
      },
    });

    assert.deepEqual(crop.mobile, {
      x: -20,
      y: 10,
      zoom: 0.5,
      fit: "cover",
    });
  });
});
