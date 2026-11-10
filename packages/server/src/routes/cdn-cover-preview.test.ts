import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { transform } from "sucrase";
import type { Hono } from "hono";

function routes() {
  const requests: { key: string; range?: string }[] = [];
  const source = "worlds/one/image/unmarked.webp";
  const artifact = `${source}.cover-previews/v1-test.mp4`;
  const file = new URL("./cdn.ts", import.meta.url);
  const require = createRequire(file);
  const module = { exports: {} as { cdnRoutes: Hono } };
  const mocks: Record<string, unknown> = {
    "../db/index.js": { db: {} },
    "../lib/s3.js": {
      isS3Configured: () => true,
      getObject: async (key: string, options?: { range?: string }) => {
        requests.push({ key, range: options?.range });
        return { body: Readable.from(Buffer.from("mp4")), contentType: "video/mp4", contentLength: 3,
          contentRange: options?.range ? "bytes 0-2/100" : null, etag: "test" };
      },
    },
    "../lib/cover-preview.js": { createCoverPreviewService: () => ({ get: async (key: string) => {
      assert.equal(key, source); return { kind: "video", key: artifact };
    } }) },
  };
  new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)(
    (id: string) => mocks[id] ?? require(id), module, module.exports,
  );
  return { app: module.exports.cdnRoutes, requests, source, artifact, path: "/key/" + Buffer.from(source).toString("base64url") };
}

test("public cover manifest omits internal storage keys and video delivery honors byte ranges", async () => {
  const f = routes();
  const manifest = await f.app.request(f.path + "/cover-preview");
  assert.equal(manifest.status, 200);
  assert.deepEqual(await manifest.json(), { kind: "video" });
  assert.equal(manifest.headers.get("cache-control"), "no-store");
  const video = await f.app.request(f.path + "/cover-preview.mp4", { headers: { range: "bytes=0-2" } });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get("content-type"), "video/mp4");
  assert.equal(video.headers.get("content-range"), "bytes 0-2/100");
  assert.equal(await video.text(), "mp4");
  assert.deepEqual(f.requests, [{ key: f.artifact, range: "bytes=0-2" }]);
});

test("private sources and direct derivative keys cannot use preview or raw CDN paths", async () => {
  const f = routes();
  for (const key of ["private-session-media/user/image", f.artifact, "worlds/../private/image"]) {
    const path = "/key/" + Buffer.from(key).toString("base64url");
    assert.equal((await f.app.request(path + "/cover-preview")).status, 404);
    assert.equal((await f.app.request(path + "/cover-preview.mp4")).status, 404);
    assert.equal((await f.app.request(path)).status, 400);
  }
  assert.equal(f.requests.length, 0);
});
