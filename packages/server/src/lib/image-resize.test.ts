import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { transform } from "sucrase";
import { readObjectBodyLimited } from "./read-object-limited.js";

// Exercise the actual optimizer and Sharp, replacing only storage/database I/O.
function optimizer(read: (key: string, maxBytes: number) => Promise<Buffer>) {
  const writes: { key: string; bytes: Buffer; mime: string }[] = [];
  const warnings: string[] = [];
  const file = new URL("./image-resize.ts", import.meta.url);
  const require = createRequire(file);
  const module = { exports: {} as { resizeUploadedImageInBackground(key: string, mime: string): void } };
  const mocks: Record<string, unknown> = {
    "./s3.js": {
      getObjectBufferLimited: read,
      putObject: async (key: string, bytes: Buffer, mime: string) => { writes.push({ key, bytes, mime }); },
    },
    "../db/index.js": { db: { update: () => { throw new Error("Unexpected database access"); } } },
    "../db/schema.js": { userAssets: {} },
  };
  new Function("require", "module", "exports", "console",
    transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code,
  )((id: string) => mocks[id] ?? require(id), module, module.exports, {
    warn: (...parts: unknown[]) => { warnings.push(parts.join(" ")); },
  });
  return { run: module.exports.resizeUploadedImageInBackground, writes, warnings };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), "background optimization did not settle");
}

// A valid one-bit grayscale PNG represents 42M pixels with only ~5 MiB of
// uncompressed scanlines, so the test itself avoids a huge decoded RGBA image.
function largePixelPng() {
  const chunk = (type: string, data: Buffer) => {
    const named = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of named) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    named.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(7000, 0);
  header.writeUInt32BE(6000, 4);
  header[8] = 1;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    // A legal ancillary chunk keeps the input above the optimization threshold.
    chunk("tEXt", Buffer.concat([Buffer.from("padding\0"), Buffer.alloc(512 * 1024, 32)])),
    chunk("IDAT", deflateSync(Buffer.alloc((7000 / 8 + 1) * 6000))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("image optimization rejects inputs above 64 MiB without reading or overwriting the original", async () => {
  let closed = false, reads = 0;
  const task = optimizer(async (_key, maxBytes) => {
    assert.equal(maxBytes, 64 * 1024 * 1024);
    return readObjectBodyLimited({
      destroy() { closed = true; },
      async *[Symbol.asyncIterator]() { reads++; yield Buffer.from("must not read"); },
    }, 64 * 1024 * 1024 + 1, maxBytes);
  });
  assert.doesNotThrow(() => task.run("original.png", "image/png"));
  await until(() => task.warnings.length > 0);
  assert.match(task.warnings[0]!, /MEDIA_INVALID_SIZE/);
  assert.equal(reads, 0);
  assert.equal(closed, true);
  assert.deepEqual(task.writes, []);
});

test("image optimization rejects more than 40M pixels and leaves the original untouched", async () => {
  const input = largePixelPng();
  const metadata = await sharp(input, { limitInputPixels: false }).metadata();
  assert.equal(metadata.width! * metadata.height!, 42_000_000);
  const task = optimizer(async () => input);
  task.run("large.png", "image/png");
  await until(() => task.warnings.length > 0);
  assert.match(task.warnings[0]!, /pixel limit/i);
  assert.deepEqual(task.writes, []);
});

test("a normal large PNG is optimized at the same key with its alpha and format preserved", async () => {
  const input = await sharp({ create: { width: 3000, height: 100, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 0.5 } } })
    .png({ compressionLevel: 0 }).toBuffer();
  assert.ok(input.length > 512 * 1024);
  const task = optimizer(async () => input);
  task.run("normal.png", "image/png");
  await until(() => task.writes.length > 0 || task.warnings.length > 0);
  assert.deepEqual(task.warnings, []);
  assert.equal(task.writes.length, 1);
  const [output] = task.writes;
  assert.equal(output!.key, "normal.png");
  assert.equal(output!.mime, "image/png");
  assert.ok(output!.bytes.length < input.length);
  const metadata = await sharp(output!.bytes).metadata();
  assert.equal(metadata.width, 2560);
  assert.equal(metadata.format, "png");
  assert.equal(metadata.hasAlpha, true);
});
