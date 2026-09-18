import assert from "node:assert/strict";
import test from "node:test";
import {
  closestAspect,
  computeImagePrice,
  getPlatformStyle,
  PLATFORM_STYLES,
} from "../dist/index.js";

test("closestAspect snaps to SDXL-native sizes", () => {
  assert.equal(closestAspect(1000, 1500).id, "portrait"); // 0.667 → 832×1216
  assert.equal(closestAspect(1920, 1080).id, "wide");
  assert.equal(closestAspect(1024, 1024).id, "square");
  assert.equal(closestAspect(700, 1400).id, "tall");
});

test("platform style surcharge adds to the image price", () => {
  const base = computeImagePrice({
    width: 832,
    height: 1216,
    steps: 28,
    loraCount: 0,
    customCheckpoint: false,
  });
  assert.equal(base, 10); // default recipe = listed template price
  assert.equal(base + getPlatformStyle("realistic").surchargeMushies, 20);
  assert.equal(getPlatformStyle("anime").surchargeMushies, 0);
});

// The batch-shortfall refund in service.ts pays back base*0.8 per undelivered
// image. These pin the two properties that makes it correct: the marginal rate
// really is base*0.8, and flat add-ons are never part of it.
test("marginal batch image costs base*0.8", () => {
  const recipe = { width: 832, height: 1216, steps: 28, loraCount: 0, customCheckpoint: false };
  const base = computeImagePrice({ ...recipe, batchSize: 1 });
  for (const batch of [2, 3, 4]) {
    const delta =
      computeImagePrice({ ...recipe, batchSize: batch }) -
      computeImagePrice({ ...recipe, batchSize: batch - 1 });
    assert.ok(
      Math.abs(delta - base * 0.8) <= 1, // ceil() rounding, nothing more
      `batch ${batch}: marginal ${delta} vs expected ${base * 0.8}`,
    );
  }
});

test("shortfall refund excludes flat surcharges", () => {
  const recipe = { width: 832, height: 1216, steps: 28, loraCount: 0, customCheckpoint: false };
  const base = computeImagePrice({ ...recipe, batchSize: 1 });
  // Paid for 4 with a custom checkpoint, got 1 back.
  const paid = computeImagePrice({ ...recipe, batchSize: 4, customCheckpoint: true });
  const owed = base * 0.8 * 3;
  assert.equal(base, 10);
  assert.equal(paid, 94); // ceil(10*3.4) = 34, + 60 checkpoint
  assert.equal(owed, 24);
  // The old formula derived the rate from the total, dragging the 60-mushie
  // checkpoint fee into it and refunding ~66 of a 94-mushie job.
  const naive = (paid / (1 + 3 * 0.8)) * 0.8 * 3;
  assert.ok(naive > 60, `naive formula should over-refund, got ${naive}`);
  // What the user keeps must still cover one image plus the checkpoint load.
  assert.ok(paid - owed >= base + 60, `${paid - owed} must cover base+checkpoint`);
});

test("every platform style has a unique filename and a valid dialect", () => {
  const filenames = new Set(PLATFORM_STYLES.map((s) => s.checkpointFilename));
  assert.equal(filenames.size, PLATFORM_STYLES.length);
  for (const style of PLATFORM_STYLES) {
    assert.ok(["danbooru", "prose"].includes(style.dialect), style.slug);
  }
});
