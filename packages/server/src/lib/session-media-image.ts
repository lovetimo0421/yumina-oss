import sharp from "sharp";
import { createHash } from "node:crypto";
export const MEDIA_INPUT_LIMIT = 16 * 1024 * 1024;
export const MEDIA_OUTPUT_LIMIT = 2 * 1024 * 1024;
export const MEDIA_THUMB_LIMIT = 128 * 1024;
export const MEDIA_RESERVATION = MEDIA_OUTPUT_LIMIT + MEDIA_THUMB_LIMIT;
export const MEDIA_MIMES = ["image/jpeg", "image/png", "image/webp"];
let active = 0;
/** Bounded, fail-closed decoding. No small-file or busy-server bypass. */
export async function prepareSessionImage(input: Buffer) {
    if (!input.length || input.length > MEDIA_INPUT_LIMIT)
        throw new Error("MEDIA_INVALID_SIZE");
    if (active >= 2)
        throw new Error("MEDIA_PROCESSOR_BUSY");
    active++;
    try {
        const options = { limitInputPixels: 40000000, failOn: "warning" as const, animated: true };
        const info = await sharp(input, options).metadata();
        if (!["jpeg", "png", "webp"].includes(info.format ?? "") || (info.pages ?? 1) !== 1) {
            throw new Error("MEDIA_UNSUPPORTED_IMAGE");
        }
        // Rotation consumes EXIF orientation; default sharp output strips EXIF/GPS.
        const image = await sharp(input, options).rotate()
            .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 86, effort: 3 }).timeout({ seconds: 15 }).toBuffer({ resolveWithObject: true });
        const thumb = await sharp(image.data).resize(320, 320, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 72, effort: 2 }).timeout({ seconds: 5 }).toBuffer();
        if (image.data.length > MEDIA_OUTPUT_LIMIT || thumb.length > MEDIA_THUMB_LIMIT)
            throw new Error("MEDIA_OUTPUT_TOO_LARGE");
        return { main: image.data, thumbnail: thumb, width: image.info.width, height: image.info.height,
            size: image.data.length + thumb.length, hash: createHash("sha256").update(image.data).digest("hex") };
    }
    finally {
        active--;
    }
}
