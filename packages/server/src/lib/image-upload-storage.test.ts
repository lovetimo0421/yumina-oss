import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { HTTPException } from "hono/http-exception";
import { createImageUploadProcessor, type ImageUploadStorage } from "./image-upload-storage.js";
import { IMAGE_INPUT_LIMIT } from "./image-upload-policy.js";

test("publication uses an immutable destination, cleans only direct uploads, and retries after source removal", async () => {
  const source = "worlds/alice/thumbnail/upload.png";
  const original = await sharp({ create: { width: 3840, height: 2160, channels: 4, background: "#12345680" } }).png().toBuffer();
  const objects = new Map<string, Buffer>([[source, original], ["users/alice/image/original.png", original]]);
  let writes = 0;
  const store: ImageUploadStorage = {
    head: async key => {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
      return { contentType: "image/png", contentLength: bytes.length };
    },
    read: async (key, limit) => { const bytes = objects.get(key)!; assert(bytes.length <= limit); return bytes; },
    write: async (key, bytes) => { writes++; objects.set(key, bytes); },
    remove: async key => { objects.delete(key); },
  };
  const processor = createImageUploadProcessor(store);
  const result = await processor.publishStoredImage(source, "worlds/alice/thumbnail/processed", "image/png");
  assert.notEqual(result.key, source);
  const meta = await sharp(objects.get(result.key)!).metadata();
  assert.deepEqual([meta.width, meta.height, meta.hasAlpha], [1920, 1080, true]);
  assert.equal(result.sizeBytes, objects.get(result.key)!.length);
  // An old PUT changes only the temporary source, never the normalized bytes.
  objects.set(source, Buffer.from("replaced"));
  await processor.discardDirectImageUpload(source, "worlds/alice/thumbnail/");
  assert(!objects.has(source));
  const retry = await processor.publishStoredImage(source, "worlds/alice/thumbnail/processed", "image/png");
  assert.deepEqual(retry, result);
  assert.equal(writes, 1);
  await processor.discardDirectImageUpload(result.key, "worlds/alice/thumbnail/");
  await processor.discardDirectImageUpload("users/alice/image/original.png", "worlds/alice/thumbnail/");
  assert(objects.has(result.key));
  assert(objects.has("users/alice/image/original.png"));
});

test("oversize or invalid stored images never publish; storage errors never fall back to originals", async () => {
  let reads = 0, writes = 0;
  const storage: ImageUploadStorage = {
    head: async () => ({ contentType: "image/png", contentLength: IMAGE_INPUT_LIMIT + 1 }),
    read: async () => { reads++; return Buffer.from("invalid"); },
    write: async () => { writes++; }, remove: async () => {},
  };
  const processor = createImageUploadProcessor(storage);
  await assert.rejects(processor.prepareStoredImage("large"), HTTPException);
  assert.equal(reads, 0);
  storage.head = async key => {
    if (key.includes("processed/")) throw Object.assign(new Error(), { $metadata: { httpStatusCode: 404 } });
    return { contentType: "image/png", contentLength: 7 };
  };
  await assert.rejects(processor.publishStoredImage("invalid", "processed"), HTTPException);
  assert.equal(writes, 0);
  storage.head = async () => { throw new Error("offline"); };
  await assert.rejects(processor.publishStoredImage("invalid", "processed"), /offline/);
  assert.equal(writes, 0);
});

test("concurrent reads are bounded before buffering uploaded bytes", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const processor = createImageUploadProcessor({
    head: async () => { await wait; return { contentType: "image/png", contentLength: 0 }; },
    read: async () => { throw new Error("must not read"); },
    write: async () => {}, remove: async () => {},
  });
  const results = Promise.allSettled([processor.prepareStoredImage("one"), processor.prepareStoredImage("two")]);
  await assert.rejects(processor.prepareStoredImage("three"), (error: unknown) => error instanceof HTTPException && error.status === 503);
  release();
  assert((await results).every(result => result.status === "rejected"));
});


test("normalized animated covers keep the marker recognized by the existing cover renderer", async () => {
  const pixels = Buffer.alloc(16 * 32 * 4, 255);
  pixels.fill(64, 0, 16 * 16 * 4);
  const gif = await sharp(pixels, { raw: { width: 16, height: 32, channels: 4, pageHeight: 16 } }).gif({ delay: [100, 100] }).toBuffer();
  const objects = new Map<string, Buffer>([["pending/source.gif", gif]]);
  const processor = createImageUploadProcessor({
    head: async key => {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error(), { $metadata: { httpStatusCode: 404 } });
      return { contentType: "image/gif", contentLength: bytes.length };
    },
    read: async key => objects.get(key)!,
    write: async (key, bytes) => { objects.set(key, bytes); },
    remove: async key => { objects.delete(key); },
  });
  const result = await processor.publishStoredImage("pending/source.gif", "processed");
  assert.match(result.key, /\.anim\.[a-z0-9]+$/);
  assert.equal((await sharp(objects.get(result.key)!, { animated: true }).metadata()).pages, 2);
  objects.delete("pending/source.gif");
  assert.deepEqual(await processor.publishStoredImage("pending/source.gif", "processed"), result);
});
