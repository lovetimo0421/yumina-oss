import { IMAGE_INPUT_LIMIT, imageUploadError, prepareUploadedImage, validateImageUploadSize } from "./image-upload-policy.js";
import { createHash } from "node:crypto";
export interface ImageUploadStorage {
  head(key: string): Promise<{ contentType: string; contentLength: number }>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  write(key: string, bytes: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createImageUploadProcessor(storage: ImageUploadStorage) {
  let reading = 0;

  /** Bounded decoding; callers publish only the validated result. */
  async function prepareStoredImage(sourceKey: string, mimeType?: string) {
    if (reading >= 2) return imageUploadError("Image processing is busy. Please try again shortly.", 503);
    reading++;
    try {
      const info = await storage.head(sourceKey);
      validateImageUploadSize(info.contentLength);
      const contentType = info.contentType.toLowerCase();
      if (mimeType && contentType !== mimeType) return imageUploadError("Uploaded image type does not match.");
      let input: Buffer;
      try { input = await storage.read(sourceKey, IMAGE_INPUT_LIMIT); }
      catch (error) {
        if (error instanceof Error && error.message === "MEDIA_INVALID_SIZE") return imageUploadError("Image too large (max 20 MB).", 413);
        throw error;
      }
      const result = await prepareUploadedImage(input, contentType);
      return { ...result, inputBytes: input.length };
    } finally { reading--; }
  }

  /** NEW key: a still-live presigned PUT can never overwrite the normalized image. */
  async function publishStoredImage(sourceKey: string, destinationPrefix: string, mimeType?: string) {
    const base = `${destinationPrefix}/${createHash("sha256").update(sourceKey).digest("hex")}`;
    // The app recognizes .anim.<extension> to retain animated-cover loading.
    // Two stable candidates also make confirmation retryable after source cleanup.
    for (const key of [`${base}.image`, `${base}.anim.image`]) {
      try {
        const existing = await storage.head(key);
        if (existing.contentLength > 0) return { key, sizeBytes: existing.contentLength, contentType: existing.contentType };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      }
    }
    const result = await prepareStoredImage(sourceKey, mimeType);
    const key = `${base}${result.animated ? ".anim" : ""}.image`;
    await storage.write(key, result.buffer, result.contentType);
    return { key, sizeBytes: result.sizeBytes, contentType: result.contentType };
  }

  /** Only remove a direct upload, never an existing asset selected from a library. */
  async function discardDirectImageUpload(key: string, prefix: string) {
    if (!key.startsWith(prefix) || key.slice(prefix.length).includes("/")) return;
    try { await storage.remove(key); }
    catch { console.warn("[image-upload] temporary upload cleanup failed"); }
  }

  return { prepareStoredImage, publishStoredImage, discardDirectImageUpload };
}
