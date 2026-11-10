import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import sharp from "sharp";
import { HTTPException } from "hono/http-exception";
import { prepareUploadedImage } from "./image-upload-policy.js";
import { COVER_INPUT_LIMIT, COVER_MOTION_LIMIT, COVER_MOTION_SUFFIX, coverMotionKey,
  createCoverUploadProcessor, prepareCover, prepareMotionCover, validateCoverUploadSize,
  type CoverUploadStorage, type PreparedCover } from "./cover-upload.js";
import { isPublicCdnKey } from "./cdn-key-policy.js";

const execute = promisify(execFile);

async function animation(width: number, height: number, frames: number, delay: number, alpha = false, loop = 0) {
  const raw = Buffer.alloc(width * height * frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    for (let at = frame * width * height * 4; at < (frame + 1) * width * height * 4; at += 4) {
      raw[at] = frame * 53 % 256; raw[at + 1] = frame * 79 % 256; raw[at + 2] = 120;
      raw[at + 3] = alpha && at % 16 === 0 ? 0 : 255;
    }
  }
  return sharp(raw, { raw: { width, height: height * frames, channels: 4, pageHeight: height } })
    .webp({ lossless: true, delay: Array(frames).fill(delay), loop }).toBuffer();
}

test("cover admission accepts large source files but remains bounded", () => {
  assert.equal(validateCoverUploadSize(50 * 1024 * 1024), 50 * 1024 * 1024);
  for (const size of [0, -1, 1.5, null, "20", Infinity, COVER_INPUT_LIMIT + 1]) {
    assert.throws(() => validateCoverUploadSize(size), HTTPException);
  }
});

test("a 720p two-second animation rejected by the old pixel budget becomes a small complete video", async () => {
  const input = await animation(1280, 720, 48, 40);
  await assert.rejects(prepareUploadedImage(input, "image/webp"), /40.0 MP/);
  const result = await prepareCover(input, "image/webp");
  assert.equal(result.animated, true);
  assert.equal(result.durationMs, 1920);
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
  assert.ok(result.motion && result.motion.length < COVER_MOTION_LIMIT);
  assert.equal((await sharp(result.image).metadata()).pages ?? 1, 1, "the still is a poster, never the lost animation");
});

test("121 transparent frames retain alpha, all delays and finite loop instead of being rejected", async () => {
  const input = await animation(48, 48, 121, 40, true, 2);
  await assert.rejects(prepareUploadedImage(input, "image/webp"), /121 frames/);
  const result = await prepareCover(input, "image/webp");
  assert.equal(result.motion, undefined);
  const meta = await sharp(result.image, { animated: true }).metadata();
  assert.equal(meta.pages, 121); assert.equal(meta.loop, 2); assert.equal(meta.hasAlpha, true);
  assert.deepEqual(meta.delay, Array(121).fill(40));
  assert.equal(result.durationMs, 4840);
});

test("motion longer than 15 seconds keeps its full duration", async () => {
  const result = await prepareCover(await animation(32, 32, 2, 8000), "image/webp");
  assert.equal(result.durationMs, 16_000);
  assert.ok(result.motion);
});

test("opaque finite animations are not changed into endlessly looping videos", async () => {
  const result = await prepareCover(await animation(32, 32, 121, 40, false, 3), "image/webp");
  assert.equal(result.motion, undefined);
  assert.equal((await sharp(result.image, { animated: true }).metadata()).loop, 3);
});

test("APNG's separate poster is excluded and GIF repeat counts retain their playback meaning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yumina-cover-timing-"));
  try {
    await execute(process.platform === "win32" ? "python" : "python3", ["-c", [
      "from PIL import Image", "import sys", "from pathlib import Path", "p = Path(sys.argv[1])",
      "frames = [Image.new('RGBA', (24,24), c) for c in ['red', 'green', 'blue']]",
      "frames[0].save(p/'source.png', save_all=True, append_images=frames[1:], default_image=True, duration=[150,250], loop=2)",
      "frames[0].save(p/'source.gif', save_all=True, append_images=frames[1:], duration=100, loop=2)",
    ].join("\n"), directory]);
    const apng = await prepareCover(await readFile(join(directory, "source.png")), "image/png");
    const meta = await sharp(apng.image, { animated: true }).metadata();
    assert.equal(apng.durationMs, 400); assert.equal(meta.pages, 2);
    assert.deepEqual(meta.delay, [150, 250]); assert.equal(meta.loop, 2);
    const gif = await prepareCover(await readFile(join(directory, "source.gif")), "image/gif");
    assert.equal((await sharp(gif.image, { animated: true }).metadata()).loop, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("independent requests cannot start two cover decoders", async () => {
  const input = await animation(32, 32, 2, 100);
  const first = prepareMotionCover(input, "image/webp");
  await assert.rejects(prepareMotionCover(input, "image/webp"), error => error instanceof HTTPException && error.status === 503);
  await first;
  await prepareMotionCover(input, "image/webp");
});

test("low memory defers motion without blocking a small static cover", async t => {
  const input = await animation(16,16,2,100);
  t.mock.method(process,"availableMemory",()=>512*1024**2);
  await assert.rejects(prepareMotionCover(input,"image/webp"),error => error instanceof HTTPException && error.status===503);
  const still = await sharp({create:{width:16,height:16,channels:3,background:"red"}}).png().toBuffer();
  assert.equal((await prepareCover(still,"image/png")).animated,false);
});

test("a normal generated 32fps MP4 is accepted as cover input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yumina-cover-test-"));
  try {
    const file = join(directory, "source.mp4");
    await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=size=848x480:rate=32:duration=5", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-y", file]);
    const result = await prepareCover(await readFile(file), "video/mp4");
    assert.equal(result.durationMs, 5000);
    assert.ok(result.motion && result.motion.length < COVER_MOTION_LIMIT);
    assert.equal(result.width, 848); assert.equal(result.height, 480);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a variable-rate WebM with an unknown average frame rate uses its nominal rate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yumina-cover-webm-"));
  try {
    const file = join(directory, "source.webm");
    await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=size=128x128:rate=30:duration=2", "-vf", "setpts=N*N/(600*TB)", "-fps_mode", "vfr",
      "-c:v", "libvpx-vp9", "-threads", "2", "-y", file]);
    // Matroska DefaultDuration is optional for variable-rate recordings. Swap
    // that element for equal-length Void padding to model such a recording.
    await execute(process.platform === "win32" ? "python" : "python3", ["-c", [
      "from pathlib import Path",
      "import sys",
      "p = Path(sys.argv[1]); b = p.read_bytes(); pos = b.index(bytes.fromhex('23e383')); n = b[pos+3] & 127",
      "p.write_bytes(b[:pos] + bytes([0xec, 0x80+2+n]) + bytes(2+n) + b[pos+4+n:])",
    ].join("\n"), file]);
    const probe = await execute("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]);
    assert.equal(JSON.parse(probe.stdout).streams[0].avg_frame_rate, "0/0");
    const result = await prepareCover(await readFile(file), "video/webm");
    assert.ok(result.motion && result.durationMs! > 5000 && result.durationMs! < 6000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid files, mismatched formats and excessive duration never fall back to the source", async () => {
  await assert.rejects(prepareMotionCover(Buffer.from("not video"), "video/mp4"), /decoded/);
  const input = await animation(16, 16, 2, 100);
  await assert.rejects(prepareMotionCover(input, "image/gif"), /Use a GIF/);
  await assert.rejects(prepareMotionCover(await animation(16, 16, 2, 31_000), "image/webp"), /60 seconds/);
});

test("static image dimensions, transparency and existing admission behavior are unchanged", async () => {
  const input = await sharp({ create: { width: 30, height: 60, channels: 4, background: "transparent" } }).png().toBuffer();
  const result = await prepareCover(input, "image/png");
  assert.equal(result.animated, false); assert.equal(result.motion, undefined);
  assert.equal(result.contentType, "image/png");
  assert.equal((await sharp(result.image).metadata()).hasAlpha, true);
});

function storageFixture() {
  const objects = new Map<string, { bytes: Buffer; type: string }>([["users/one/source", { bytes: Buffer.from("source"), type: "video/mp4" }]]);
  const writes: string[] = [];
  const storage: CoverUploadStorage = {
    head: async key => { const value = objects.get(key); if (!value) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } }); return { contentLength: value.bytes.length, contentType: value.type }; },
    read: async key => objects.get(key)!.bytes,
    write: async (key, bytes, type) => { writes.push(key); objects.set(key, { bytes, type }); },
  };
  const result: PreparedCover = { image: Buffer.from("poster"), motion: Buffer.from("video"), contentType: "image/webp", animated: true, width: 640, height: 960, durationMs: 5000 };
  return { storage, objects, writes, result };
}

test("publication writes motion before its poster, preserves the library source, and retries at the same immutable key", async () => {
  const f = storageFixture();
  const service = createCoverUploadProcessor(f.storage, async () => f.result);
  const first = await service.publish("users/one/source", "worlds/card/thumbnail/processed");
  assert.ok(first.key.endsWith(COVER_MOTION_SUFFIX));
  assert.deepEqual(f.writes, [coverMotionKey(first.key), first.key]);
  assert.equal(first.sizeBytes, 11);
  assert.equal(f.objects.get("users/one/source")!.bytes.toString(), "source");
  assert.equal(isPublicCdnKey(coverMotionKey(first.key)), false, "motion is served only through the source-checking preview route");
  f.objects.delete("users/one/source");
  assert.equal((await service.publish("users/one/source", "worlds/card/thumbnail/processed")).key, first.key);
  assert.equal(f.writes.length, 2, "a retry needs neither the deleted upload nor another encode/write");
});

test("storage failure never publishes a poster pointing at a missing video", async () => {
  const f = storageFixture();
  f.storage.write = async () => { throw new Error("offline"); };
  const service = createCoverUploadProcessor(f.storage, async () => f.result);
  await assert.rejects(service.publish("users/one/source", "worlds/card/thumbnail/processed"), /offline/);
  assert.equal(f.objects.size, 1);
});

test("one cover job at a time; capacity returns after failure", async () => {
  const f = storageFixture(); let reject!: (error: Error) => void;
  const service = createCoverUploadProcessor(f.storage, () => new Promise((_resolve, fail) => { reject = fail; }));
  const first = service.publish("users/one/source", "worlds/card/thumbnail/processed");
  await assert.rejects(service.publish("users/one/source", "worlds/card/thumbnail/processed"), error => error instanceof HTTPException && error.status === 503);
  for (let n = 0; n < 10; n++) await Promise.resolve();
  reject(new Error("decode failure"));
  await assert.rejects(first, /decode failure/);
  f.storage.head = async () => { throw new Error("new request reached storage"); };
  await assert.rejects(service.publish("users/one/source", "worlds/card/thumbnail/processed"), /new request/);
});

test("a declared oversized source is rejected before reading or decoding", async () => {
  const f = storageFixture();
  f.storage.head = async () => ({ contentLength: COVER_INPUT_LIMIT + 1, contentType: "video/mp4" });
  f.storage.read = async () => assert.fail("must not read");
  await assert.rejects(createCoverUploadProcessor(f.storage).publish("users/one/source", "worlds/card/thumbnail/processed"), /64 MB/);
});

test("a timed-out decoder kills its child, removes its files and releases capacity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "yumina-cover-worker-test-"));
  const originalCwd = process.cwd();
  const originalTimeout = globalThis.setTimeout;
  let childPid: number | undefined;
  // A killed Linux descendant can briefly remain a zombie until init reaps it.
  const childRunning = async (pid: number) => {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    if (process.platform === "linux") {
      try { if (/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }
    return true;
  };
  t.mock.method(process, "availableMemory", () => 4 * 1024 ** 3);
  const timeoutMock = t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    originalTimeout(callback, delay === 90_000 ? 1000 : delay, ...args)) as typeof setTimeout);
  try {
    await mkdir(join(directory, "scripts"));
    await writeFile(join(directory, "scripts", "cover-upload.py"), [
      "import json, subprocess, sys, time",
      "from pathlib import Path",
      "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])",
      "Path('worker.json').write_text(json.dumps({'pid': child.pid, 'directory': sys.argv[2]}))",
      "time.sleep(120)",
    ].join("\n"));
    process.chdir(directory);
    await assert.rejects(prepareMotionCover(Buffer.from("fixture"), "video/mp4"),
      error => error instanceof HTTPException && error.status === 413 && /too long to process/.test(error.message));
    const marker = JSON.parse(await readFile(join(directory, "worker.json"), "utf8")) as { pid: number; directory: string };
    childPid = marker.pid;
    for (let attempt = 0; attempt < 40 && await childRunning(childPid); attempt++) await wait(50);
    assert.equal(await childRunning(childPid), false, "the decoder must terminate its owned descendant");
    await assert.rejects(stat(marker.directory), { code: "ENOENT" }, "decoder files are removed only after the worker closes");
  } finally {
    process.chdir(originalCwd);
    timeoutMock.mock.restore();
    // Also clean up the fixture if an assertion catches a lifecycle regression.
    if (childPid === undefined) {
      try { childPid = JSON.parse(await readFile(join(directory, "worker.json"), "utf8")).pid; } catch {}
    }
    if (childPid !== undefined && await childRunning(childPid)) process.kill(childPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
  const recovered = await prepareCover(await animation(16, 16, 2, 100), "image/webp");
  assert.ok(recovered.motion, "a timed-out job must not leave decoder capacity locked");
});

test("a missing decoder runtime returns unavailable and releases capacity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "yumina-cover-runtime-test-"));
  const originalPython = process.env.COVER_UPLOAD_PYTHON;
  t.mock.method(process, "availableMemory", () => 4 * 1024 ** 3);
  try {
    process.env.COVER_UPLOAD_PYTHON = join(directory, "nonexistent-python");
    await assert.rejects(prepareMotionCover(Buffer.from("fixture"), "video/mp4"),
      error => error instanceof HTTPException && error.status === 503 && /unavailable/.test(error.message));
  } finally {
    if (originalPython === undefined) delete process.env.COVER_UPLOAD_PYTHON;
    else process.env.COVER_UPLOAD_PYTHON = originalPython;
    await rm(directory, { recursive: true, force: true });
  }
  assert.ok((await prepareCover(await animation(16, 16, 2, 100), "image/webp")).motion);
});
