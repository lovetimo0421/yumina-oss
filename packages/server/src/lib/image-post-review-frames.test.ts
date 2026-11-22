import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { videoFrameGrid } from "./image-post-review.js";

const run = promisify(execFile);
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(() => true, () => false);

test("a video is looked at as three of its frames side by side", { skip: !hasFfmpeg && "no ffmpeg here" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "frames-test-"));
  try {
    const file = join(dir, "clip.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-pix_fmt", "yuv420p", file]);
    const grid = await videoFrameGrid(await readFile(file));
    assert.ok(grid, "a grid");
    const meta = await sharp(grid!).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(meta.width! >= 3 * 300 && meta.height! >= 200, `three frames wide (${meta.width}x${meta.height})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("anything that isn't a video gives no frames", async () => {
  assert.equal(await videoFrameGrid(Buffer.from("not a video at all")), null);
});
