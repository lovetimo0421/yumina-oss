import assert from "node:assert/strict";
import test from "node:test";
import { animatedCoverHeader, createCoverPreviewService, type CoverPreviewStorage } from "./cover-preview.js";
import { isPublicCdnKey } from "./cdn-key-policy.js";
import { COVER_MOTION_LIMIT, coverMotionKey } from "./cover-upload.js";

function webp(animated = true) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0); bytes.write("WEBPVP8X", 8); bytes[20] = animated ? 2 : 0;
  return bytes;
}
function fixture(size = 44_267_738) {
  const objects = new Map<string, { contentType: string; contentLength: number; etag: string }>();
  objects.set("worlds/one/image/unmarked.webp", { contentType: "image/webp", contentLength: size, etag: "source" });
  const writes: string[] = [], reads: { key: string; headerOnly?: boolean }[] = [], removed: string[] = [];
  const storage: CoverPreviewStorage = {
    head: async key => { const item = objects.get(key); if (!item) throw new Error("missing"); return item; },
    read: async (key, _limit, headerOnly) => { reads.push({ key, headerOnly }); return webp(); },
    write: async (key, bytes, mime) => { writes.push(key); objects.set(key, { contentType: mime, contentLength: bytes.length, etag: "preview" }); },
    remove: async key => { removed.push(key); objects.delete(key); },
  };
  return { storage, objects, writes, reads, removed, key: "worlds/one/image/unmarked.webp" };
}
async function settle() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

test("animation detection reads actual WebP/GIF/PNG bytes, not the upload filename", () => {
  assert.equal(animatedCoverHeader(webp()), true);
  assert.equal(animatedCoverHeader(webp(false)), false);
  assert.equal(animatedCoverHeader(Buffer.from("GIF89a")), true);
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from([0,0,0,8]), Buffer.from("acTL")]);
  assert.equal(animatedCoverHeader(png), true);
  assert.equal(animatedCoverHeader(Buffer.from("not an image ANIM acTL")), false);
});

test("legacy 44MB animated WebP becomes one deduplicated derivative, never an original fallback", async () => {
  const f = fixture(); let calls = 0;
  const service = createCoverPreviewService(f.storage, async () => { calls++; return Buffer.from("bounded video"); });
  const results = await Promise.all([service.get(f.key), service.get(f.key)]);
  assert.ok(results.every(result => result.kind === "pending"));
  await settle();
  const ready = await service.get(f.key);
  assert.equal(ready.kind, "video"); assert.equal(calls, 1); assert.equal(f.writes.length, 1);
  assert.notEqual(ready.key, f.key);
  assert.ok(ready.key!.startsWith(f.key + ".cover-previews/"));
  assert.equal(isPublicCdnKey(ready.key!), false, "raw CDN must not bypass source existence checks");
});

test("small animations keep their original behavior and oversized inputs never reach the encoder", async () => {
  for (const [size, kind] of [[1024, "original"], [65 * 1024 * 1024, "still"]] as const) {
    const f = fixture(size);
    const service = createCoverPreviewService(f.storage, async () => assert.fail("must not encode"));
    assert.equal((await service.get(f.key)).kind, kind);
    assert.ok(f.reads.every(read => read.headerOnly));
  }
});

test("one encoder runs at a time; failed encoding keeps the still instead of retrying the huge master", async () => {
  const f = fixture();
  f.objects.set("worlds/two.webp", f.objects.get(f.key)!);
  let fail!: (reason: Error) => void;
  const service = createCoverPreviewService(f.storage, () => new Promise((_resolve, reject) => { fail = reject; }));
  assert.equal((await service.get(f.key)).kind, "pending");
  assert.equal((await service.get("worlds/two.webp")).kind, "pending");
  assert.equal(f.reads.filter(read => !read.headerOnly).length, 1);
  fail(new Error("expected encoder failure")); await settle();
  assert.equal((await service.get(f.key)).kind, "still");
  assert.equal(f.writes.length, 0);
});

test("deleting the master during encoding removes the late derivative and cache expiry rechecks existence", async () => {
  const f = fixture(); let clock = 0;
  const service = createCoverPreviewService(f.storage, async () => { f.objects.delete(f.key); return Buffer.from("video"); }, () => clock);
  await service.get(f.key); await settle();
  assert.equal(f.removed.length, 1);
  assert.equal((await service.get(f.key)).kind, "still");
  clock = 300_001;
  await assert.rejects(service.get(f.key), /missing/);
});

test("persistent derivatives are reused without another encoding job", async () => {
  const f = fixture();
  await createCoverPreviewService(f.storage, async () => Buffer.from("video")).get(f.key); await settle();
  const service = createCoverPreviewService(f.storage, async () => assert.fail("existing derivative"));
  assert.equal((await service.get(f.key)).kind, "video");
});

test("normalized video covers serve their prebuilt motion without reading or re-encoding the poster", async () => {
  const f = fixture();
  const key = "worlds/card/thumbnail/processed/digest.motion.anim.image";
  f.objects.set(key, { contentType: "image/webp", contentLength: 1000, etag: "poster" });
  f.objects.set(coverMotionKey(key), { contentType: "video/mp4", contentLength: 50_000, etag: "motion" });
  const service = createCoverPreviewService(f.storage, async () => assert.fail("already prepared"));
  assert.deepEqual(await service.get(key), { kind: "video", key: coverMotionKey(key) });
  assert.deepEqual(f.reads, []);
  assert.equal(isPublicCdnKey(coverMotionKey(key)), false);
});

test("missing, oversized or wrong-type motion never falls back to an unverified movie", async () => {
  const key = "worlds/card/thumbnail/processed/digest.motion.anim.image";
  for (const motion of [null, { contentType: "video/mp4", contentLength: COVER_MOTION_LIMIT + 1 },
    { contentType: "text/html", contentLength: 100 }]) {
    const f = fixture();
    f.objects.set(key, { contentType: "image/webp", contentLength: 1000, etag: "poster" });
    if (motion) f.objects.set(coverMotionKey(key), { ...motion, etag: "motion" });
    const service = createCoverPreviewService(f.storage, async () => assert.fail("must not encode"));
    assert.deepEqual(await service.get(key), { kind: "still" });
  }
});

test("a motion sidecar alone cannot be served after its public poster is removed", async () => {
  const f = fixture();
  const key = "worlds/card/thumbnail/processed/digest.motion.anim.image";
  f.objects.set(coverMotionKey(key), { contentType: "video/mp4", contentLength: 50_000, etag: "motion" });
  await assert.rejects(createCoverPreviewService(f.storage).get(key), /missing/);
});

test("normalized animations above the legacy threshold keep alpha and finite playback without another encode", async () => {
  for (const [size, kind] of [[COVER_MOTION_LIMIT, "original"], [COVER_MOTION_LIMIT + 1, "still"]] as const) {
    const f = fixture();
    const key = "worlds/card/thumbnail/processed/digest.normalized.anim.image";
    f.objects.set(key, { contentType: "image/webp", contentLength: size, etag: "alpha" });
    const service = createCoverPreviewService(f.storage, async () => assert.fail("must retain original playback"));
    assert.deepEqual(await service.get(key), { kind });
    assert.deepEqual(f.reads, []);
  }
});
