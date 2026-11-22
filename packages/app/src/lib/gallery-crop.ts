import { BANNER_ASPECT } from "./banner-aspect";
import { convertCoverCrop, normalizeCoverCrop, type CoverCropSettings } from "./cropping";

export type GalleryDevice = "desktop" | "mobile";
export const GALLERY_ASPECTS = { desktop: BANNER_ASPECT, mobile: 16 / 9 } as const;

/**
 * Older crops remain usable until the author adjusts each view. A desktop crop
 * carries the shape it was framed in (`aspect`), so one saved for the older,
 * thinner banner is drawn re-framed for today's.
 */
export function selectGalleryCrop(crop: CoverCropSettings | null | undefined, device: GalleryDevice): CoverCropSettings {
  const normalized = normalizeCoverCrop(crop);
  const { desktop, aspect: _aspect, ...mobile } = normalized;
  return { ...(device === "desktop" ? desktop ?? mobile : mobile), fit: "cover" };
}

/**
 * The crop the editor starts from: as selectGalleryCrop, with a banner crop
 * framed for the older shape rewritten for today's once the picture's own
 * shape is known, so the zoom and position controls move the frame on screen.
 */
export function editableGalleryCrop(crop: CoverCropSettings | null | undefined, device: GalleryDevice, sourceAspect: number | null): CoverCropSettings {
  const selected = selectGalleryCrop(crop, device);
  return sourceAspect ? convertCoverCrop(selected, sourceAspect, GALLERY_ASPECTS[device]) : selected;
}

/** Save one view without changing the other, including its unedited fallback. */
export function updateGalleryCrop(crop: CoverCropSettings | null | undefined, device: GalleryDevice, next: CoverCropSettings): CoverCropSettings {
  const mobile = selectGalleryCrop(crop, "mobile");
  const desktop = selectGalleryCrop(crop, "desktop");
  const frame = selectGalleryCrop(next, "mobile");
  // The banner crop is saved with the shape it was framed in; an untouched older one keeps saying so.
  return device === "desktop"
    ? { ...mobile, desktop: { ...frame, aspect: next.aspect ?? BANNER_ASPECT } }
    : { ...frame, desktop: { ...desktop, aspect: desktop.aspect ?? BANNER_ASPECT } };
}
