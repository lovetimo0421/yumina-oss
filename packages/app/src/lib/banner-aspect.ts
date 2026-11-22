/**
 * The wide banner's shape (width / height), one number for every place that
 * shows one: the world preview and Library detail headers, event and invite
 * art, the cover editor's desktop crop, and the least height of Discover's hero.
 */
export const BANNER_ASPECT = 21 / 9;
export const BANNER_ASPECT_LABEL = "21:9";

/** The shape banners had until 2026-11. A desktop crop saved without a shape was framed in this one. */
export const LEGACY_BANNER_ASPECT = 16 / 5;

/** The size artists are asked for: 1920 wide, the width the hero and the image pipeline top out at. */
export const BANNER_SIZE = { width: 1920, height: Math.round(1920 / BANNER_ASPECT) } as const;

const UPLOAD_MIN_WIDTH = 1600;
const UPLOAD_ASPECT_TOLERANCE = 0.03;

/**
 * What an uploaded picture is as a banner: the shape itself, the older 16:5
 * (still accepted, drawn with its sides cropped), or neither.
 */
export function bannerUploadShape(width: number, height: number): "banner" | "legacy" | null {
  if (!(width >= UPLOAD_MIN_WIDTH && height > 0)) return null;
  const aspect = width / height;
  if (Math.abs(aspect - BANNER_ASPECT) <= UPLOAD_ASPECT_TOLERANCE) return "banner";
  if (Math.abs(aspect - LEGACY_BANNER_ASPECT) <= UPLOAD_ASPECT_TOLERANCE) return "legacy";
  return null;
}
