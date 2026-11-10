import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { transform } from "sucrase";
import { readObjectBodyLimited } from "./read-object-limited.js";

// Exercise the public processor facade and Sharp, replacing only object transport.
function optimizer(read: (key: string, maxBytes: number) => Promise<Buffer>) {
  const writes: { key: string; bytes: Buffer; mime: string }[] = [];
  const file = new URL("./image-resize.ts", import.meta.url);
  const require = createRequire(file);
  const module = { exports: {} as { publishStoredImage(key: string, prefix: string, mime: string): Promise<unknown> } };
  const mocks: Record<string, unknown> = {
    "./s3.js": {
      headObject: async (key: string) => {
        if (key.startsWith("processed/")) throw Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
        return { contentType: "image/png", contentLength: 1 };
      },
      getObjectBufferLimited: read,
      putObject: async (key: string, bytes: Buffer, mime: string) => { writes.push({ key, bytes, mime }); },
      deleteObject: async () => {},
    },
  };
  new Function("require", "module", "exports",
    transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code,
  )((id: string) => mocks[id] ?? require(id), module, module.exports);
  return { run: (key: string, mime: string) => module.exports.publishStoredImage(key, "processed", mime), writes };
}

// A valid one-bit grayscale PNG represents 120M pixels with only ~15 MiB of
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
  header.writeUInt32BE(12000, 0);
  header.writeUInt32BE(10000, 4);
  header[8] = 1;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    // A legal ancillary chunk keeps the input above the optimization threshold.
    chunk("tEXt", Buffer.concat([Buffer.from("padding\0"), Buffer.alloc(512 * 1024, 32)])),
    chunk("IDAT", deflateSync(Buffer.alloc((12000 / 8 + 1) * 10000))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("image optimization rejects inputs above 20 MiB without reading or publishing the original", async () => {
  let closed = false, reads = 0;
  const task = optimizer(async (_key, maxBytes) => {
    assert.equal(maxBytes, 20 * 1024 * 1024);
    return readObjectBodyLimited({
      destroy() { closed = true; },
      async *[Symbol.asyncIterator]() { reads++; yield Buffer.from("must not read"); },
    }, 20 * 1024 * 1024 + 1, maxBytes);
  });
  await assert.rejects(task.run("original.png", "image/png"), (error: unknown) => (error as { status?: number }).status === 413);
  assert.equal(reads, 0);
  assert.equal(closed, true);
  assert.deepEqual(task.writes, []);
});

test("image optimization rejects stills above 100M pixels without publishing", async () => {
  const input = largePixelPng();
  const metadata = await sharp(input, { limitInputPixels: false }).metadata();
  assert.equal(metadata.width! * metadata.height!, 120_000_000);
  const task = optimizer(async () => input);
  await assert.rejects(task.run("large.png", "image/png"), (error: unknown) => (error as { status?: number }).status === 413);
  assert.deepEqual(task.writes, []);
});

test("a normal large PNG is optimized to an immutable key with alpha and format preserved", async () => {
  const input = await sharp({ create: { width: 3000, height: 100, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 0.5 } } })
    .png({ compressionLevel: 0 }).toBuffer();
  assert.ok(input.length > 512 * 1024);
  const task = optimizer(async () => input);
  await task.run("normal.png", "image/png");
  assert.equal(task.writes.length, 1);
  const [output] = task.writes;
  assert.notEqual(output!.key, "normal.png");
  assert.ok(output!.key.startsWith("processed/"));
  assert.equal(output!.mime, "image/png");
  assert.ok(output!.bytes.length < input.length);
  const metadata = await sharp(output!.bytes).metadata();
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.format, "png");
  assert.equal(metadata.hasAlpha, true);
});
