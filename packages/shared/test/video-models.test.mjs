import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDEO_MODELS,
  getVideoModel,
  computeVideoModelPrice,
  videoDimensions,
  videoRequestProblem,
  videoDurationOptions,
} from "../dist/index.js";

const base = { aspectRatio: "16:9", durationSeconds: 5 };

test("OpenRouter video is charged at the provider's per-second price", () => {
  const max = getVideoModel("h3-max");
  assert.equal(computeVideoModelPrice(max, { ...base, resolution: "768p" }), 400); // $0.08/s × 5
  assert.equal(computeVideoModelPrice(max, { ...base, resolution: "480p" }), 250); // $0.05/s × 5
  assert.equal(computeVideoModelPrice(max, { ...base, resolution: "768p", durationSeconds: 15 }), 1200);
  const h3 = getVideoModel("h3");
  assert.equal(computeVideoModelPrice(h3, { ...base, resolution: "2K", referenceAssetIds: ["a", "b"] }), 650 + 80);
});

test("Comfy video price scales with length, steps, pixels and LoRAs", () => {
  const wan = getVideoModel("wan-2.2");
  const dflt = computeVideoModelPrice(wan, { ...base, resolution: "480p" });
  assert.equal(dflt, wan.fast.basePrice, "Lightning is the default recipe");
  assert.equal(computeVideoModelPrice(wan, { ...base, resolution: "480p", fast: false }), wan.basePrice);
  assert.ok(computeVideoModelPrice(wan, { ...base, resolution: "480p", fast: false, steps: 40 }) > wan.basePrice);
  assert.ok(computeVideoModelPrice(wan, { ...base, resolution: "720p" }) > dflt);
  assert.ok(computeVideoModelPrice(wan, { ...base, resolution: "480p", durationSeconds: 8 }) > dflt);
  assert.equal(computeVideoModelPrice(wan, { ...base, resolution: "480p", loras: [{ modelId: "x", weight: 1 }] }), dflt + 2);
});

test("dimensions keep the aspect and land on multiples of 16", () => {
  assert.deepEqual(videoDimensions("16:9", "480p"), { width: 848, height: 480 });
  assert.deepEqual(videoDimensions("9:16", "720p"), { width: 720, height: 1280 });
  assert.deepEqual(videoDimensions("1:1", "512p"), { width: 512, height: 512 });
  for (const m of VIDEO_MODELS) for (const r of m.resolutions) {
    const d = videoDimensions("21:9", r);
    assert.equal(d.width % 16, 0); assert.equal(d.height % 16, 0);
  }
});

test("a request a model cannot take is named, not silently trimmed", () => {
  const max = getVideoModel("h3-max");
  const ok = { model: "h3-max", aspectRatio: "16:9", resolution: "768p", durationSeconds: 5 };
  assert.equal(videoRequestProblem(max, ok), null);
  assert.equal(videoRequestProblem(max, { ...ok, firstFrameAssetId: "a", lastFrameAssetId: "b" }), "VIDEO_ONE_FRAME_ONLY");
  assert.equal(videoRequestProblem(max, { ...ok, referenceAssetIds: ["a"] }), "VIDEO_TOO_MANY_REFERENCES");
  assert.equal(videoRequestProblem(max, { ...ok, steps: 20 }), "VIDEO_NO_TUNING");
  assert.equal(videoRequestProblem(max, { ...ok, resolution: "2K" }), "VIDEO_BAD_RESOLUTION");
  assert.equal(videoRequestProblem(max, { ...ok, durationSeconds: 16 }), "VIDEO_BAD_DURATION");
  assert.equal(videoRequestProblem(max, { ...ok, sound: true }), "VIDEO_NO_SOUND");
  const wan = getVideoModel("wan-2.2");
  const w = { model: "wan-2.2", aspectRatio: "16:9", resolution: "480p", durationSeconds: 5 };
  assert.equal(videoRequestProblem(wan, { ...w, steps: 30 }), "VIDEO_FAST_FIXED", "steps need full sampling");
  assert.equal(videoRequestProblem(wan, { ...w, fast: false, steps: 30, seed: 7 }), null);
  assert.equal(videoRequestProblem(wan, { ...w, durationSeconds: 4 }), "VIDEO_BAD_DURATION");
});

test("duration menus: ranges expand, fixed menus stay as listed", () => {
  assert.deepEqual(videoDurationOptions(getVideoModel("h3")), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(videoDurationOptions(getVideoModel("wan-2.2")), [3, 5, 8]);
});

test("a style draws Wan's first frame: text only, priced as one more picture", () => {
  const wan = getVideoModel("wan-2.2");
  const w = { model: "wan-2.2", aspectRatio: "16:9", resolution: "480p", durationSeconds: 5 };
  assert.equal(videoRequestProblem(wan, { ...w, style: "guofeng" }), null);
  assert.equal(videoRequestProblem(wan, { ...w, style: "nope" }), "VIDEO_BAD_STYLE");
  assert.equal(videoRequestProblem(wan, { ...w, style: "anime", firstFrameAssetId: "a" }), "VIDEO_STYLE_WITH_FRAME");
  assert.equal(videoRequestProblem(getVideoModel("h3-max"), { model: "h3-max", aspectRatio: "16:9", resolution: "768p", durationSeconds: 5, style: "anime" }), "VIDEO_NO_STYLE");
  const plain = computeVideoModelPrice(wan, w);
  assert.equal(computeVideoModelPrice(wan, { ...w, style: "anime" }), plain + 10);
  assert.equal(computeVideoModelPrice(wan, { ...w, style: "realistic" }), plain + 20, "a style's surcharge rides along");
});
