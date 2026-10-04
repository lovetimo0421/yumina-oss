import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Hono } from "hono";
import sharp from "sharp";
import { cdnRoutes, streamS3Object } from "./cdn.js";
import { db } from "../db/index.js";
import { getLocalDiskStorage, storageKind } from "../lib/s3.js";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

const jpeg = await sharp(Buffer.from([127, 127, 255]), {
  raw: { width: 1, height: 1, channels: 3 },
}).jpeg().toBuffer();
const cachePolicy = "public, max-age=0, s-maxage=300, must-revalidate";

function assetFixture(t: TestContext, key = "worlds/example/normal.jpg") {
  assert.equal(storageKind(), "local"); // Never allow a test to reach S3.
  const id = randomUUID();
  const lookup = t.mock.method(db, "execute", async () => ({ rows: [{ url: key }] }));
  const read = t.mock.method(getLocalDiskStorage(), "getObject", async () => ({
    body: Readable.from([jpeg]), contentType: "image/jpeg",
    contentLength: jpeg.length, contentRange: null, etag: '"original"',
  }));
  return { id, lookup, read };
}

test("the registered original endpoint uses the ordinary asset lookup and not-found response", async (t) => {
  t.mock.method(db, "execute", async () => ({ rows: [] }));
  const ordinary = await cdnRoutes.request("/test-image");
  const original = await cdnRoutes.request("/test-image/original");
  assert.equal(ordinary.status, 404);
  assert.equal(original.status, 404);
  assert.equal(await original.text(), await ordinary.text());
});

test("original streaming preserves JPEG bytes and adds only no-transform to its cache policy", async () => {
  const app = new Hono();
  app.get("/image", c => streamS3Object(c, "worlds/example/normal.jpg", "fixture",
    async () => ({ body: Readable.from([jpeg]), contentType: "image/jpeg",
      contentLength: jpeg.length, contentRange: null, etag: '"original"' }),
    { preserveBytes: true }));
  const response = await app.request("/image");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), cachePolicy + ", no-transform");
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
});

test("both registered paths share lookup/cache/CORS/MIME and differ only in no-transform", async (t) => {
  const { id, lookup, read } = assetFixture(t);
  const ordinary = await cdnRoutes.request(`/${id}?raw=1`, {
    headers: { Origin: "null", "Cache-Control": "no-transform", Via: "image-resizing" },
  });
  const original = await cdnRoutes.request(`/${id}/original`, { headers: { Origin: "null" } });
  assert.equal(ordinary.status, 200);
  assert.equal(original.status, 200);
  assert.equal(ordinary.headers.get("cache-control"), cachePolicy);
  assert.equal(original.headers.get("cache-control"), cachePolicy + ", no-transform");
  for (const response of [ordinary, original]) {
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("content-length"), String(jpeg.length));
    assert.equal(response.headers.get("etag"), '"original"');
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("location"), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
  }
  assert.equal(lookup.mock.callCount(), 1); // Original shares the validated ID cache.
  assert.equal(read.mock.callCount(), 2);
  const originalHeaders = new Headers(original.headers);
  originalHeaders.set("cache-control", cachePolicy);
  assert.deepEqual([...originalHeaders], [...ordinary.headers]);
});

test("original HEAD keeps representation headers and returns no response body", async (t) => {
  const { id } = assetFixture(t);
  const get = await cdnRoutes.request(`/${id}/original`);
  await get.arrayBuffer();
  const head = await cdnRoutes.request(`/${id}/original`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.equal(await head.text(), "");
});

test("original range requests keep the storage range, 206 bytes and range headers", async (t) => {
  const { id, read } = assetFixture(t);
  read.mock.mockImplementation(async () => ({
    body: Readable.from([jpeg.subarray(1, 4)]), contentType: "image/jpeg",
    contentLength: 3, contentRange: `bytes 1-3/${jpeg.length}`, etag: '"original"',
  }));
  const response = await cdnRoutes.request(`/${id}/original`, { headers: { Range: "bytes=1-3" } });
  assert.equal(response.status, 206);
  assert.deepEqual(read.mock.calls[0]!.arguments, ["worlds/example/normal.jpg", { range: "bytes=1-3" }]);
  assert.equal(response.headers.get("content-range"), `bytes 1-3/${jpeg.length}`);
  assert.equal(response.headers.get("content-length"), "3");
  assert.equal(response.headers.get("cache-control"), cachePolicy + ", no-transform");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg.subarray(1, 4));
});

test("original delivery does not widen private-key or traversal access", async (t) => {
  for (const key of ["private-session-media/player/image", "users/../private/image", "users/player\\image"]) {
    const { id, read } = assetFixture(t, key);
    for (const suffix of ["", "/original"]) {
      const response = await cdnRoutes.request(`/${id}${suffix}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Asset not found" });
    }
    assert.equal(read.mock.callCount(), 0);
  }
  const arbitraryKey = await cdnRoutes.request("/worlds/example/image.jpg/original");
  assert.equal(arbitraryKey.status, 404);
});

test("deleting the stored object is visible through either path despite a cached asset ID", async (t) => {
  const { id, read, lookup } = assetFixture(t);
  const first = await cdnRoutes.request(`/${id}/original`);
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  read.mock.mockImplementation(async () => { throw Object.assign(new Error("deleted"), { name: "NoSuchKey" }); });
  for (const suffix of ["", "/original"]) {
    const response = await cdnRoutes.request(`/${id}${suffix}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Asset file not found in storage" });
    assert.equal(response.headers.get("cache-control"), null);
  }
  assert.equal(lookup.mock.callCount(), 1);
});

test("original errors retain ordinary 416/502 status, body and headers", async (t) => {
  t.mock.method(console, "error", () => {});
  const { id, read } = assetFixture(t);
  for (const [status, error] of [
    [416, { $metadata: { httpStatusCode: 416 } }],
    [502, new Error("storage failed")],
  ] as const) {
    read.mock.mockImplementation(async () => { throw error; });
    const ordinary = await cdnRoutes.request(`/${id}`, { headers: { Range: "bytes=99999-" } });
    const original = await cdnRoutes.request(`/${id}/original`, { headers: { Range: "bytes=99999-" } });
    assert.equal(original.status, status);
    assert.equal(original.status, ordinary.status);
    assert.deepEqual([...original.headers], [...ordinary.headers]);
    assert.equal(await original.text(), await ordinary.text());
  }
});

test("original streaming preserves existing transfer encoding rather than repacking data", async () => {
  const compressed = gzipSync(jpeg), app = new Hono();
  app.get("/original", c => streamS3Object(c, "worlds/example/normal.jpg", "fixture",
    async () => ({ body: Readable.from([compressed]), contentType: "image/jpeg",
      contentLength: compressed.length, contentRange: null, etag: '"encoded"', contentEncoding: "gzip" }),
    { preserveBytes: true }));
  const response = await app.request("/original");
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("content-length"), String(compressed.length));
  assert.equal(response.headers.get("cache-control"), cachePolicy + ", no-transform");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);
});
