import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { imageUploadError, prepareUploadedImage } from "./image-upload-policy.js";

// These are admission budgets for a separate, bounded decoder. They are not
// the files served to players. General uploads retain their existing policy.
export const COVER_INPUT_LIMIT = 64 * 1024 * 1024;
export const COVER_MOTION_LIMIT = 5 * 1024 * 1024;
export const COVER_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"] as const;
export const COVER_MOTION_SUFFIX = ".motion.anim.image";
export const COVER_ANIMATION_SUFFIX = ".normalized.anim.image";
export const coverMotionKey = (posterKey: string) => `${posterKey}.cover-previews/upload-v1.mp4`;

export function validateCoverUploadSize(size: unknown): number {
  if (!Number.isSafeInteger(size) || (size as number) < 1) return imageUploadError("A valid cover file size is required.");
  if ((size as number) > COVER_INPUT_LIMIT) return imageUploadError("Cover file too large (max 64 MB).", 413);
  return size as number;
}

export interface PreparedCover {
  image: Buffer;
  contentType: "image/webp" | "image/jpeg" | "image/png" | "image/gif";
  /** Opaque motion is a video with a small poster. Transparent motion stays WebP. */
  motion?: Buffer;
  animated: boolean;
  durationMs?: number;
  width: number;
  height: number;
}

let active = false;

/** Kill the entire owned process tree, and wait for close before removing files. */
async function runEncoder(source: string, directory: string, mime: string): Promise<void> {
  const systemKeys = new Set(["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "home", "userprofile", "appdata", "localappdata"]);
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toLowerCase())));
  // glibc otherwise reserves large per-thread arenas that can exhaust the
  // decoder's address-space ceiling even when its actual memory use is small.
  childEnv.MALLOC_ARENA_MAX = "2";
  await new Promise<void>((done, reject) => {
    const child = spawn(process.env.COVER_UPLOAD_PYTHON || (process.platform === "win32" ? "python" : "python3"),
      [resolve("scripts/cover-upload.py"), source, directory, mime], {
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32", env: childEnv,
      });
    let detail = "";
    let timedOut = false;
    child.stderr.on("data", data => { detail = (detail + String(data)).slice(-2000); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else if (child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill("SIGKILL"));
      }
    }, 90_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("COVER_TIMEOUT"));
      if (code === 0) return done();
      // Only fixed codes, never decoder output or local paths, reach the client.
      const codeMatch = detail.match(/COVER_(?:DURATION|DIMENSIONS|WORK|OUTPUT|FORMAT|INVALID|RUNTIME|ALPHA)/);
      reject(new Error(codeMatch?.[0] ?? "COVER_INVALID"));
    });
  });
}

const ERRORS: Record<string, string> = {
  COVER_DURATION: "Use a cover clip of 60 seconds or less.",
  COVER_DIMENSIONS: "This cover has unusually large dimensions. Resize the source and try again.",
  COVER_WORK: "This cover takes too much work to decode. Try a lower resolution or a shorter clip.",
  COVER_OUTPUT: "This cover could not be optimized within 5 MB. Try a shorter or simpler clip.",
  COVER_FORMAT: "Use a GIF, animated WebP, PNG, MP4 or WebM cover.",
  COVER_INVALID: "This cover could not be decoded. Re-export the file and try again.",
  COVER_TIMEOUT: "This cover took too long to process. Try a lower resolution or a shorter clip.",
  COVER_ALPHA: "For transparent motion, use an animated WebP or GIF so the cover keeps its transparency.",
};

/** No whole-animation Sharp decode in the website process. */
export async function prepareMotionCover(input: Buffer, mime: string): Promise<PreparedCover> {
  validateCoverUploadSize(input.length);
  if (!(COVER_UPLOAD_TYPES as readonly string[]).includes(mime)) return imageUploadError(ERRORS.COVER_FORMAT!);
  // Python and FFmpeg each have 512 MiB address-space ceilings. Reserve room
  // for both plus buffers and the HTTP server, including cgroup headroom.
  if (active || process.availableMemory() < 1280 * 1024 * 1024) return imageUploadError("Image processing is busy. Please try again shortly.", 503);
  active = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "yumina-cover-upload-"));
    const source = join(directory, "input");
    await writeFile(source, input);
    await runEncoder(source, directory, mime);
    const manifestFile = join(directory, "result.json");
    if ((await stat(manifestFile)).size > 4096) throw new Error("COVER_INVALID");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { kind: string; width: number; height: number; durationMs: number };
    if (!["video", "webp"].includes(manifest.kind)
      || !Number.isSafeInteger(manifest.width) || !Number.isSafeInteger(manifest.height)
      || manifest.width < 1 || manifest.height < 1 || manifest.width * manifest.height > 1920 * 1080
      || !Number.isFinite(manifest.durationMs) || manifest.durationMs <= 0 || manifest.durationMs > 60_000) throw new Error("COVER_INVALID");
    const readBounded = async (filename: string, limit: number) => {
      const file = join(directory!, filename);
      const size = (await stat(file)).size;
      if (size < 1 || size > limit) throw new Error("COVER_OUTPUT");
      return readFile(file);
    };
    const image = await readBounded("cover.webp", manifest.kind === "video" ? 1024 * 1024 : COVER_MOTION_LIMIT);
    const meta = await sharp(image).metadata();
    if (meta.format !== "webp" || meta.width !== manifest.width || (meta.pageHeight ?? meta.height) !== manifest.height) throw new Error("COVER_INVALID");
    const motion = manifest.kind === "video" ? await readBounded("cover.mp4", COVER_MOTION_LIMIT) : undefined;
    return { image, motion, contentType: "image/webp", animated: true, width: manifest.width, height: manifest.height, durationMs: manifest.durationMs };
  } catch (error) {
    const code = error instanceof Error ? error.message : "COVER_INVALID";
    // Missing runtime is an operational failure, never a reason to publish the source.
    if (code === "COVER_RUNTIME" || (error as NodeJS.ErrnoException)?.code === "ENOENT") return imageUploadError("Cover processing is unavailable. Please try again later.", 503);
    return imageUploadError(ERRORS[code] ?? ERRORS.COVER_INVALID!, code === "COVER_INVALID" || code === "COVER_FORMAT" ? 400 : 413);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    active = false;
  }
}

export async function prepareCover(input: Buffer, mime: string): Promise<PreparedCover> {
  validateCoverUploadSize(input.length);
  if (mime.startsWith("video/")) return prepareMotionCover(input, mime);
  if (!(COVER_UPLOAD_TYPES as readonly string[]).includes(mime)) return imageUploadError(ERRORS.COVER_FORMAT!);
  let meta;
  try { meta = await sharp(input, { animated: true, limitInputPixels: false }).metadata(); }
  catch { return imageUploadError(ERRORS.COVER_INVALID!); }
  // APNG needs Pillow: Sharp reports it as a still. The worker verifies the bytes.
  let apng = false;
  if (mime === "image/png" && meta.format === "png") {
    for (let offset = 8; offset + 12 <= input.length;) {
      const length = input.readUInt32BE(offset);
      if (offset + length + 12 > input.length) break;
      const type = input.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") { apng = true; break; }
      if (type === "IDAT" || type === "IEND") break;
      offset += length + 12;
    }
  }
  if ((meta.pages ?? 1) > 1 || apng) return prepareMotionCover(input, mime);
  const still = await prepareUploadedImage(input, mime);
  const output = await sharp(still.buffer).metadata();
  return { image: still.buffer, contentType: still.contentType as PreparedCover["contentType"], animated: false, width: output.width!, height: output.height! };
}

export interface CoverUploadStorage {
  head(key: string): Promise<{ contentType: string; contentLength: number }>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  write(key: string, bytes: Buffer, mime: string): Promise<void>;
}

/** Prepare first, then publish an immutable poster+motion pair. Never overwrite library assets. */
export function createCoverUploadProcessor(storage: CoverUploadStorage, prepare = prepareCover) {
  let reading = false;
  return {
    async publish(sourceKey: string, prefix: string) {
      if (reading) return imageUploadError("Image processing is busy. Please try again shortly.", 503);
      reading = true;
      try {
        // Source upload keys are unique; library asset keys are immutable. A
        // stable destination lets a lost confirm response be retried even
        // after the temporary upload has been removed.
        const digest = createHash("sha256").update(`cover-upload-v1\n${sourceKey}`).digest("hex");
        const base = `${prefix}/${digest}`;
        const existingHead = async (key: string) => {
          try { return await storage.head(key); }
          catch (error) {
            const cause = error as { code?: string; $metadata?: { httpStatusCode?: number } };
            if (cause.$metadata?.httpStatusCode === 404 || ["NoSuchKey", "NotFound", "ENOENT"].includes(cause.code ?? "")) return null;
            throw error;
          }
        };
        for (const suffix of [COVER_MOTION_SUFFIX, COVER_ANIMATION_SUFFIX, ".image"]) {
          const key = base + suffix;
          const image = await existingHead(key);
          if (!image || image.contentLength < 1 || image.contentLength > COVER_MOTION_LIMIT
            || !["image/webp", "image/jpeg", "image/png", "image/gif"].includes(image.contentType)) continue;
          const motion = suffix === COVER_MOTION_SUFFIX ? await existingHead(coverMotionKey(key)) : null;
          if (suffix === COVER_MOTION_SUFFIX && (!motion || motion.contentType !== "video/mp4"
            || motion.contentLength < 1 || motion.contentLength > COVER_MOTION_LIMIT || image.contentLength > 1024 * 1024)) continue;
          return { key, contentType: image.contentType, sizeBytes: image.contentLength + (motion?.contentLength ?? 0), animated: suffix !== ".image" };
        }
        const info = await storage.head(sourceKey);
        validateCoverUploadSize(info.contentLength);
        if (!(COVER_UPLOAD_TYPES as readonly string[]).includes(info.contentType)) return imageUploadError(ERRORS.COVER_FORMAT!);
        const input = await storage.read(sourceKey, COVER_INPUT_LIMIT);
        if (input.length !== info.contentLength) return imageUploadError("The uploaded cover changed. Upload it again.");
        const result = await prepare(input, info.contentType);
        const key = `${base}${result.motion ? COVER_MOTION_SUFFIX : result.animated ? COVER_ANIMATION_SUFFIX : ".image"}`;
        // Publishing the poster last is the commit point: readers never see an
        // advertised motion cover before its complete, bounded video exists.
        if (result.motion) await storage.write(coverMotionKey(key), result.motion, "video/mp4");
        await storage.write(key, result.image, result.contentType);
        return { key, contentType: result.contentType, sizeBytes: result.image.length + (result.motion?.length ?? 0),
          animated: result.animated, durationMs: result.durationMs };
      } finally { reading = false; }
    },
  };
}
