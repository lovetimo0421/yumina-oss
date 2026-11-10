import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COVER_ANIMATION_SUFFIX, COVER_MOTION_LIMIT, COVER_MOTION_SUFFIX, coverMotionKey } from "./cover-upload.js";

export type CoverPreview = { kind: "static" | "original" | "pending" | "still" | "video"; key?: string };
type Head = { contentType: string; contentLength: number; etag: string | null };
export interface CoverPreviewStorage {
  head(key: string): Promise<Head>;
  read(key: string, maxBytes: number, headerOnly?: boolean): Promise<Buffer>;
  write(key: string, bytes: Buffer, mime: string): Promise<void>;
  remove(key: string): Promise<void>;
}
const MAX_BYTES = 64 * 1024 * 1024;
const SMALL_ANIMATION = 4 * 1024 * 1024;
const TTL = 300_000;

/** Byte inspection also covers old asset-picker uploads with no .anim marker. */
export function animatedCoverHeader(bytes: Buffer): boolean {
  if (bytes.subarray(0, 6).toString().match(/^GIF8[79]a$/)) return true;
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 16) === "WEBPVP8X") {
    return (bytes[20]! & 2) !== 0;
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset + 8 <= bytes.length;) {
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") return true;
      if (type === "IDAT" || type === "IEND") return false;
      offset += 12 + bytes.readUInt32BE(offset);
    }
  }
  return false;
}

export async function encodeCoverPreview(input: Buffer): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "yumina-cover-"));
  const source = join(directory, "input");
  const output = join(directory, "preview.mp4");
  try {
    await writeFile(source, input);
    await new Promise<void>((done, reject) => {
      const child = spawn(process.env.COVER_PREVIEW_PYTHON || "python3", [resolve("scripts/cover-preview.py"), source, output], {
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32",
      });
      let detail = "";
      child.stderr.on("data", data => { detail = (detail + String(data)).slice(-2000); });
      const timer = setTimeout(() => {
        if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
        else child.kill("SIGKILL");
        reject(new Error("Cover preview timed out"));
      }, 90_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); code === 0 ? done() : reject(new Error(`Cover preview failed: ${detail}`)); });
    });
    const bytes = await readFile(output);
    if (!bytes.length || bytes.length >= 12 * 1024 * 1024) throw new Error("Cover preview output too large");
    return bytes;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** One encoder per process, no unbounded job queue; derivatives never replace masters. */
export function createCoverPreviewService(storage: CoverPreviewStorage, encode = encodeCoverPreview, now = Date.now) {
  const cache = new Map<string, { until: number; value: CoverPreview }>();
  const lookups = new Map<string, Promise<CoverPreview>>();
  let encoding = false;
  const save = (key: string, value: CoverPreview, ttl = TTL) => {
    if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: now() + ttl, value });
    return value;
  };
  async function inspect(key: string): Promise<CoverPreview> {
    const head = await storage.head(key); // Also prevents serving derivatives after source deletion.
    // This bounded WebP intentionally preserves alpha or finite playback.
    // Legacy MP4 conversion would silently destroy those semantics above 4 MB.
    if (key.endsWith(COVER_ANIMATION_SUFFIX)) {
      return save(key, { kind: head.contentType === "image/webp" && head.contentLength > 0
        && head.contentLength <= COVER_MOTION_LIMIT ? "original" : "still" });
    }
    // New covers are already normalized at upload: the public key is a small
    // image poster, with its validated motion stored behind this route. Never
    // re-encode them or mistake the poster for an ordinary static cover.
    if (key.endsWith(COVER_MOTION_SUFFIX)) {
      try {
        const motionKey = coverMotionKey(key);
        const motion = await storage.head(motionKey);
        if (head.contentType === "image/webp" && head.contentLength > 0 && head.contentLength <= 1024 * 1024
          && motion.contentType === "video/mp4" && motion.contentLength > 0 && motion.contentLength <= COVER_MOTION_LIMIT) {
          return save(key, { kind: "video", key: motionKey });
        }
      } catch { /* An incomplete package displays its bounded poster only. */ }
      return save(key, { kind: "still" }, 5000);
    }
    if (!/^image\/(webp|gif|png|apng)$/i.test(head.contentType.split(";")[0]!)) return save(key, { kind: "static" });
    const header = await storage.read(key, 256 * 1024, true);
    if (!animatedCoverHeader(header)) return save(key, { kind: "static" });
    if (head.contentLength <= SMALL_ANIMATION) return save(key, { kind: "original" });
    if (head.contentLength > MAX_BYTES || !head.etag) return save(key, { kind: "still" });
    const hash = createHash("sha256").update(`${key}\n${head.etag}\nv1-480-720-crf20`).digest("hex");
    // Keep owner-prefix deletion effective, but deny this internal suffix on raw CDN routes.
    const outputKey = `${key}.cover-previews/v1-${hash}.mp4`;
    try {
      const output = await storage.head(outputKey);
      if (output.contentLength > 0 && output.contentLength < 12 * 1024 * 1024) return save(key, { kind: "video", key: outputKey });
    } catch { /* No derivative yet. */ }
    if (encoding) return save(key, { kind: "pending" }, 5000);
    encoding = true;
    save(key, { kind: "pending" });
    void (async () => {
      const bytes = await storage.read(key, MAX_BYTES);
      const output = await encode(bytes);
      await storage.write(outputKey, output, "video/mp4");
      try {
        if ((await storage.head(key)).etag !== head.etag) throw new Error("Cover source changed");
      } catch (error) { await storage.remove(outputKey); throw error; }
      save(key, { kind: "video", key: outputKey });
    })().catch(error => {
      console.warn("[cover-preview] keeping first frame", error instanceof Error ? error.message : String(error));
      save(key, { kind: "still" });
    }).finally(() => { encoding = false; });
    return { kind: "pending" };
  }
  return {
    get(key: string): Promise<CoverPreview> {
      const hit = cache.get(key);
      if (hit && hit.until > now()) return Promise.resolve(hit.value);
      const pending = lookups.get(key);
      if (pending) return pending;
      // Bound metadata requests as well as encoders on this public route.
      if (lookups.size >= 8) return Promise.resolve({ kind: "pending" });
      const result = inspect(key).finally(() => lookups.delete(key));
      lookups.set(key, result);
      return result;
    },
  };
}
