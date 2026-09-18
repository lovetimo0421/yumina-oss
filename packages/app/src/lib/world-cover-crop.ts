import {
  DEFAULT_COVER_CROP,
  normalizeCoverCrop,
  type CoverCropSettings,
} from "./cover-crop";

export interface WorldCoverCropSettings {
  cover: CoverCropSettings;
  gallery: CoverCropSettings;
}

export const DEFAULT_WORLD_COVER_CROP: WorldCoverCropSettings = {
  cover: DEFAULT_COVER_CROP,
  gallery: DEFAULT_COVER_CROP,
};

export function getWorldGalleryDisplayCrop(
  crop?: CoverCropSettings | null,
): CoverCropSettings {
  return { ...normalizeCoverCrop(crop), fit: "cover" };
}

export function normalizeWorldCoverCrop(value: {
  coverCrop?: unknown;
  galleryCoverCrop?: unknown;
} | null | undefined): WorldCoverCropSettings {
  if (!value || typeof value !== "object") return DEFAULT_WORLD_COVER_CROP;
  return {
    cover: normalizeCoverCrop(value.coverCrop),
    gallery: getWorldGalleryDisplayCrop(value.galleryCoverCrop as CoverCropSettings | null | undefined),
  };
}
