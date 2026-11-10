import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { IMAGE_INPUT_LIMIT, prepareImportedImage, prepareUploadedImage, validateImageUploadSize } from "./image-upload-policy.js";

const image = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: "#34567880" } });

test("upload length is required, finite, positive and capped at 20 MiB", () => {
  for (const size of [undefined, 0, -1, NaN, Infinity, "123", 1.5, IMAGE_INPUT_LIMIT + 1]) {
    assert.throws(() => validateImageUploadSize(size), HTTPException);
  }
  assert.equal(validateImageUploadSize(IMAGE_INPUT_LIMIT), IMAGE_INPUT_LIMIT);
});

test("small compressed originals cannot bypass dimension limits; alpha survives", async () => {
  const input = await image(3840, 2160).png().toBuffer();
  assert(input.length < 512 * 1024);
  const result = await prepareUploadedImage(input, "image/png");
  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
  assert.equal(meta.hasAlpha, true);
  const { data } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
  assert(data[3]! > 120 && data[3]! < 136);
});

test("portrait, square, EXIF orientation and small originals retain their proportions", async () => {
  for (const [width, height, expectedWidth, expectedHeight] of [[2160, 3840, 1080, 1920], [2200, 2200, 1080, 1080], [64, 32, 64, 32]]) {
    const result = await prepareUploadedImage(await image(width!, height!).jpeg().toBuffer(), "image/jpeg");
    const meta = await sharp(result.buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [expectedWidth, expectedHeight]);
  }
  const rotated = await image(2160, 3840).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const result = await prepareUploadedImage(rotated, "image/jpeg");
  const meta = await sharp(result.buffer).metadata();
  assert.deepEqual([meta.width, meta.height, meta.orientation], [1920, 1080, undefined]);
});

async function animation(format: "gif" | "webp", frames: number, delay: number) {
  const width = 16, pageHeight = 16;
  const raw = Buffer.alloc(width * pageHeight * frames * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = Math.floor(i / (width * pageHeight * 4)) % 2 ? 255 : 0;
    raw[i + 1] = 128; raw[i + 2] = 64; raw[i + 3] = 255;
  }
  return sharp(raw, { raw: { width, height: pageHeight * frames, channels: 4, pageHeight } })
    .toFormat(format, { delay: Array(frames).fill(delay), loop: 2 }).toBuffer();
}

test("GIF and animated WebP keep frames, delays and loop count", async () => {
  for (const format of ["gif", "webp"] as const) {
    const result = await prepareUploadedImage(await animation(format, 2, 100), `image/${format}`);
    const meta = await sharp(result.buffer, { animated: true }).metadata();
    assert.equal(meta.pages, 2);
    assert.equal(meta.loop, 2);
    assert.deepEqual(meta.delay, [100, 100]);
  }
});

test("corrupt files, lying formats, excessive frames, duration and decoded pixels are refused", async () => {
  await assert.rejects(prepareUploadedImage(Buffer.from("not an image"), "image/png"), HTTPException);
  await assert.rejects(prepareUploadedImage(await image(32, 32).png().toBuffer(), "image/jpeg"), HTTPException);
  await assert.rejects(prepareUploadedImage(await animation("gif", 121, 100), "image/gif"), HTTPException);
  await assert.rejects(prepareUploadedImage(await animation("webp", 2, 8000), "image/webp"), HTTPException);
  const oversized = await image(12000, 9000).png().toBuffer();
  await assert.rejects(prepareUploadedImage(oversized, "image/png"), HTTPException);
});

test("rejections name the actual reason: format, dimensions, frames, damage", async () => {
  const jpeg = await image(3000, 2000).jpeg().toBuffer();
  const cases: [() => Promise<unknown>, RegExp][] = [
    [async () => prepareUploadedImage(Buffer.from("not an image"), "image/png"), /couldn't be read as an image/],
    [async () => prepareUploadedImage(await image(32, 32).avif().toBuffer(), "image/jpeg"), /AVIF images aren't supported/],
    [async () => prepareUploadedImage(jpeg, "image/png"), /actually a JPEG image but is named as PNG\. Rename it to \.jpg/],
    [async () => prepareUploadedImage(jpeg.subarray(0, Math.floor(jpeg.length * 0.8)), "image/jpeg"), /JPEG file is damaged or incomplete/],
    [async () => prepareUploadedImage(await image(12000, 9000).png().toBuffer(), "image/png"), /12000×9000 \(108\.0 MP\)\. The limit is 100\.0 MP\. Resize it to about 11547×8660/],
    [async () => prepareUploadedImage(await animation("gif", 121, 100), "image/gif"), /121 frames\. The limit is 120/],
    [async () => prepareUploadedImage(await animation("webp", 2, 8000), "image/webp"), /16\.0 seconds long/],
  ];
  for (const [upload, message] of cases) await assert.rejects(upload(), message);
});

test("48 MP phone photos and long screenshots are resized instead of refused", async () => {
  const photo = await prepareUploadedImage(await image(8064, 6048).jpeg().toBuffer(), "image/jpeg");
  assert.deepEqual([(await sharp(photo.buffer).metadata()).width, (await sharp(photo.buffer).metadata()).height], [1440, 1080]);
  const screenshot = await prepareUploadedImage(await image(1290, 40000).png().toBuffer(), "image/png");
  assert.equal((await sharp(screenshot.buffer).metadata()).height, 1920);
});

test("already-small dimensions cannot bypass the optimized byte ceiling", async () => {
  const input = await sharp(randomBytes(1920 * 1080 * 4), { raw: { width: 1920, height: 1080, channels: 4 } }).png().toBuffer();
  await assert.rejects(prepareUploadedImage(input, "image/png"), (error: unknown) => {
    assert(error instanceof HTTPException);
    assert.equal(error.status, 413);
    assert.match(error.message, /5 MB/);
    return true;
  });
});

test("APNG is refused before a decoder can silently flatten its animation", async () => {
  const png = await image(16, 16).png().toBuffer();
  const control = Buffer.alloc(20);
  control.writeUInt32BE(8, 0);
  control.write("acTL", 4);
  control.writeUInt32BE(2, 8);
  const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
  await assert.rejects(prepareUploadedImage(apng, "image/png"), /GIF or animated WebP/);
});

test("busy processor fails closed with retry guidance; capacity is released afterwards", async () => {
  const input = await image(1000, 1000).png().toBuffer();
  const first = prepareUploadedImage(input, "image/png");
  const second = prepareUploadedImage(input, "image/png");
  await assert.rejects(prepareUploadedImage(input, "image/png"), (error: unknown) => {
    assert(error instanceof HTTPException);
    assert.equal(error.status, 503);
    assert.equal(error.getResponse().headers.get("Retry-After"), "3");
    return true;
  });
  await Promise.all([first, second]);
  await prepareUploadedImage(input, "image/png");
});

test("validation errors are JSON client errors through Hono", async () => {
  const app = new Hono();
  app.get("/", () => { validateImageUploadSize(IMAGE_INPUT_LIMIT + 1); return new Response(); });
  const response = await app.request("/");
  assert.equal(response.status, 413);
  assert.match(((await response.json()) as { error: string }).error, /20 MB/);
});


test("archive normalization waits for busy decoders and obeys worker cancellation", async () => {
  const input = await image(1000, 1000).png().toBuffer();
  const first = prepareUploadedImage(input, "image/png");
  const second = prepareUploadedImage(input, "image/png");
  const controller = new AbortController();
  const cancelled = prepareImportedImage(input, "image/png", controller.signal);
  const rejection = assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === "AbortError");
  controller.abort();
  await rejection;
  const imported = prepareImportedImage(input, "image/png", new AbortController().signal);
  await Promise.all([first, second]);
  const result = await imported;
  assert.equal((await sharp(result.buffer).metadata()).width, 1000);
});
