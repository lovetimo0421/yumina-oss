import { setTimeout as wait } from "node:timers/promises";
import sharp, { type Metadata } from "sharp";
import { HTTPException } from "hono/http-exception";

export const IMAGE_INPUT_LIMIT = 20 * 1024 * 1024;
export const IMAGE_OUTPUT_LIMIT = 5 * 1024 * 1024;
// Stills resize with shrink-on-load, so 48/108 MP phone photos and long screenshots stay cheap.
// Animations decode every frame, so they keep the tighter total.
const MAX_STILL_PIXELS = 100_000_000;
const MAX_ANIMATED_PIXELS = 40_000_000;
const MAX_FRAMES = 120;
const MIMES: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const FORMAT_NAMES: Record<string, string> = { jpeg: "JPEG", png: "PNG", webp: "WebP", gif: "GIF", heif: "HEIC/HEIF", avif: "AVIF", tiff: "TIFF", svg: "SVG", jp2k: "JPEG 2000", jxl: "JPEG XL", pdf: "PDF" };
const formatName = (format: string, compression?: string) => compression === "av1" ? "AVIF" : FORMAT_NAMES[format] ?? format.toUpperCase();
const mimeName = (mime: string) => formatName(Object.keys(MIMES).find((key) => MIMES[key] === mime) ?? mime.replace(/^image\//, ""));
const megapixels = (pixels: number) => `${(pixels / 1_000_000).toFixed(1)} MP`;
/** Same aspect ratio, scaled down to fit the pixel budget. */
function fitWithin(width: number, height: number, limit: number) {
  const scale = Math.sqrt(limit / (width * height));
  return `${Math.floor(width * scale)}×${Math.floor(height * scale)}`;
}
let active = 0;

// libvips reads APNG as a still PNG. Refuse it rather than silently removing animation.
function isAnimatedPng(input: Buffer): boolean {
  if (!input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= input.length;) {
    const length = input.readUInt32BE(offset);
    if (offset + length + 12 > input.length) return false;
    const type = input.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") break;
    offset += length + 12;
  }
  return false;
}

export function imageUploadError(message: string, status: 400 | 413 | 503 = 400): never {
  throw new HTTPException(status, {
    message,
    res: Response.json({ error: message, ...(status === 503 ? { code: "IMAGE_PROCESSOR_BUSY" } : {}) }, { status, headers: status === 503 ? { "Retry-After": "3" } : {} }),
  });
}

export function validateImageUploadSize(size: unknown): number {
  if (!Number.isSafeInteger(size) || (size as number) < 1) return imageUploadError("A valid image file size is required. Refresh and try again.");
  if ((size as number) > IMAGE_INPUT_LIMIT) return imageUploadError("Image too large (max 20 MB).", 413);
  return size as number;
}

/** Preserve format, transparency, animation timing and loop. No unsafe original fallback. */
export async function prepareUploadedImage(input: Buffer, mimeType: string) {
  validateImageUploadSize(input.length);
  if (active >= 2) return imageUploadError("Image processing is busy. Please try again shortly.", 503);
  active++;
  try {
    if (isAnimatedPng(input)) return imageUploadError("Animated PNG (APNG) isn't supported. For animated images, use GIF or animated WebP.");
    let meta: Metadata;
    try { meta = await sharp(input, { animated: true, limitInputPixels: false }).metadata(); }
    catch { return imageUploadError("This file couldn't be read as an image. It may be damaged or not actually an image. Open it and re-save it as JPEG or PNG, then try again."); }
    if (!meta.format || !meta.width || !meta.height) return imageUploadError("This file couldn't be read as an image. Re-save it as JPEG or PNG, then try again.");
    if (!MIMES[meta.format]) return imageUploadError(`${formatName(meta.format, meta.compression)} images aren't supported. Convert it to JPEG, PNG, WebP or GIF, then try again.`);
    if (MIMES[meta.format] !== mimeType) return imageUploadError(`This file is actually a ${formatName(meta.format)} image but is named as ${mimeName(mimeType)}. Rename it to .${meta.format === "jpeg" ? "jpg" : meta.format} or re-save it, then try again.`);
    const pages = meta.pages ?? 1;
    const height = meta.pageHeight ?? meta.height;
    const pixels = meta.width * height * pages;
    if (pages > MAX_FRAMES) return imageUploadError(`This animation has ${pages} frames. The limit is ${MAX_FRAMES} frames.`, 413);
    if (pages > 1 && pixels > MAX_ANIMATED_PIXELS) return imageUploadError(`This animation is ${meta.width}×${height} with ${pages} frames (${megapixels(pixels)} in total). The limit is ${megapixels(MAX_ANIMATED_PIXELS)} across all frames. Make it smaller or use fewer frames.`, 413);
    if (pages === 1 && pixels > MAX_STILL_PIXELS) return imageUploadError(`This image is ${meta.width}×${height} (${megapixels(pixels)}). The limit is ${megapixels(MAX_STILL_PIXELS)}. Resize it to about ${fitWithin(meta.width, height, MAX_STILL_PIXELS)} or smaller, then try again.`, 413);
    const duration = (meta.delay ?? []).reduce((sum, delay) => sum + Math.max(20, delay), 0);
    if (pages > 1 && duration > 15_000) return imageUploadError(`This animation is ${(duration / 1000).toFixed(1)} seconds long. The limit is 15 seconds.`, 413);
    const options = { animated: true, limitInputPixels: pages > 1 ? MAX_ANIMATED_PIXELS : MAX_STILL_PIXELS, failOn: "warning" as const };
    const image = sharp(input, options);
    const rotated = pages === 1 && [5, 6, 7, 8].includes(meta.orientation ?? 1);
    const width = rotated ? height : meta.width;
    const orientedHeight = rotated ? meta.width : height;
    const landscape = width >= orientedHeight;
    // Rotation of multi-page images is unsupported by libvips. Keep their timing intact.
    const resized = (pages === 1 ? image.rotate() : image)
      .resize(landscape ? 1920 : 1080, landscape ? 1080 : 1920, { fit: "inside", withoutEnlargement: true })
      .timeout({ seconds: 15 });
    let output: Buffer;
    try {
      switch (meta.format) {
        case "png": output = await resized.png({ compressionLevel: 9 }).toBuffer(); break;
        case "webp": output = await resized.webp({ quality: 82, effort: 3, loop: meta.loop, delay: meta.delay }).toBuffer(); break;
        case "gif": output = await resized.gif({ effort: 3, loop: meta.loop, delay: meta.delay }).toBuffer(); break;
        default: output = await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn("[image-upload] decode failed", meta.format, `${meta.width}x${height}x${pages}`, reason);
      if (/timeout/i.test(reason)) return imageUploadError("This image took too long to process. Try a smaller or simpler image.", 413);
      return imageUploadError(`This ${formatName(meta.format)} file is damaged or incomplete, so it couldn't be decoded. Open it and re-save it, or download it again, then try again.`);
    }
    if (output.length > IMAGE_OUTPUT_LIMIT) {
      const tip = pages > 1 ? "Shorten the animation or use fewer colors." : meta.format === "png" ? "Photos compress far better as JPEG; re-save it as JPEG and try again." : "Reduce the image detail and try again.";
      return imageUploadError(`Even after resizing, this image is ${(output.length / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB. ${tip}`, 413);
    }
    return { buffer: output, contentType: mimeType, sizeBytes: output.length, animated: pages > 1 };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.warn("[image-upload] processing failed", error instanceof Error ? error.message : String(error));
    return imageUploadError("Image could not be processed. Use a valid JPEG, PNG, WebP or GIF under 20 MB.");
  } finally { active--; }
}


/** Archive workers share decoder capacity with direct uploads; wait within a bounded budget. */
export async function prepareImportedImage(input: Buffer, mimeType: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await prepareUploadedImage(input, mimeType); }
    catch (error) {
      if (!(error instanceof HTTPException) || error.status !== 503 || attempt >= 10) throw error;
      await wait(3000, undefined, { signal });
    }
  }
}
