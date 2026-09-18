import sharp from "sharp";
import { eq } from "drizzle-orm";
import { getObjectBuffer, putObject } from "./s3.js";
import { db } from "../db/index.js";
import { userAssets } from "../db/schema.js";

// Longest-edge cap for stored image "masters". Deliberately generous: full-screen
// in-game art stays crisp on a retina display, and Cloudflare still downsizes
// per-surface on delivery, so this is only a ceiling on the stored original.
const MAX_EDGE = 2560;

// Below this we don't bother — the re-encode payoff isn't worth the work.
const MIN_BYTES_TO_PROCESS = 512 * 1024; // 512 KB

// Formats we will touch. Skip gif (animation), svg (vector), avif (already
// efficient) — resizing those risks flattening animation or rasterizing vectors.
const RESIZABLE_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

// Cap concurrent resizes so a burst of large uploads can't spike heap (each
// buffers + decodes a full image). Over the cap we simply skip — delivery-side
// Cloudflare resizing still serves a small image; the master just stays full-size.
const MAX_CONCURRENT = 3;
let inFlight = 0;

/**
 * Cap a just-uploaded image in place to bound stored size — WITHOUT changing its
 * URL, format, or transparency.
 *
 * Safety contract (this is why it won't break existing in-game assets):
 * - Runs on NEW uploads only (called from register handlers). It never sweeps
 *   existing content — every already-uploaded image keeps its exact bytes.
 * - Overwrites the SAME S3 key, so the /cdn URL and asset id are unchanged.
 * - Preserves the original format and alpha channel (a transparent PNG stays a
 *   transparent PNG — no white-box behind sprites).
 * - Skips animated / vector / already-small / already-within-bounds images.
 * - Only writes back if the result is actually smaller.
 * - Fully fail-soft: any error leaves the original object untouched.
 *
 * Fire-and-forget — never blocks or fails the caller's request.
 */
export function resizeUploadedImageInBackground(
  key: string,
  mimeType: string,
  assetId?: string,
): void {
  if (!RESIZABLE_MIME.has(mimeType.toLowerCase())) return; // cheap pre-check
  if (inFlight >= MAX_CONCURRENT) return; // bound memory — skip under load
  inFlight++;
  void resizeUploadedImage(key, mimeType, assetId)
    .catch((err) => {
      console.warn(
        "[image-resize] skipped",
        key,
        err instanceof Error ? err.message : String(err),
      );
    })
    .finally(() => {
      inFlight--;
    });
}

async function resizeUploadedImage(
  key: string,
  mimeType: string,
  assetId?: string,
): Promise<void> {
  if (!RESIZABLE_MIME.has(mimeType.toLowerCase())) return;

  const { buffer, contentType } = await getObjectBuffer(key);
  if (buffer.byteLength < MIN_BYTES_TO_PROCESS) return; // small enough already

  // failOn:"none" → be lenient with slightly-malformed uploads instead of throwing.
  const pipeline = sharp(buffer, { failOn: "none" });
  const meta = await pipeline.metadata();

  // Defensively skip multi-frame (animated) images even if mislabeled.
  if ((meta.pages ?? 1) > 1) return;

  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longest === 0) return; // couldn't read dimensions → leave it alone
  if (longest <= MAX_EDGE) return; // already within bounds → nothing to do

  const resized = pipeline
    .rotate() // bake in EXIF orientation before metadata is stripped
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true });

  // Re-encode in the SAME format, preserving alpha. Metadata is stripped by
  // default (sharp doesn't copy EXIF/ICC unless asked), which also trims size.
  let out: Buffer;
  switch (meta.format) {
    case "png":
      out = await resized.png({ compressionLevel: 9 }).toBuffer();
      break;
    case "webp":
      out = await resized.webp({ quality: 82 }).toBuffer();
      break;
    default: // jpeg
      out = await resized.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      break;
  }

  if (out.byteLength >= buffer.byteLength) return; // no real win → keep original

  await putObject(key, out, contentType);

  // Keep storage accounting honest (best-effort; only user_assets tracks bytes).
  if (assetId) {
    try {
      await db
        .update(userAssets)
        .set({ sizeBytes: out.byteLength })
        .where(eq(userAssets.id, assetId));
    } catch {
      /* accounting is best-effort — never fail the resize over it */
    }
  }
}
