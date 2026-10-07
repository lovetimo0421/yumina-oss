import {
  DEFAULT_COVER_CROP,
  normalizeCoverCrop,
  coverCropImageLayoutStyle,
  type CropImageRenderer,
  type CoverCropSettings,
} from "./cropping";

export interface WorldCoverCropSettings {
  cover: CoverCropSettings;
  gallery: CoverCropSettings;
}

export const DEFAULT_WORLD_COVER_CROP: WorldCoverCropSettings = {
  cover: DEFAULT_COVER_CROP,
  gallery: DEFAULT_COVER_CROP,
};

/** Full-image framing for wide gallery heroes. */
export const HEAD_SAFE_GALLERY_HERO_CROP: CoverCropSettings = {
  x: 0,
  y: 0,
  zoom: 1,
  fit: "contain",
};

export function getWorldGalleryDisplayCrop(
  crop?: CoverCropSettings | null,
): CoverCropSettings {
  return normalizeCoverCrop(crop);
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

/** The editor and Discover use these exact card frames. */
export const DISCOVER_COVER_ASPECTS = { cover: 2 / 3, gallery: 16 / 9 } as const;

export interface WorldArtwork {
  thumbnailUrl?: string | null;
  coverCrop?: CoverCropSettings | null;
  galleryCoverCrop?: CoverCropSettings | null;
  landscapeCoverUrl?: string | null;
  landscapeCoverCrop?: CoverCropSettings | null;
}

/** One source-selection contract for Discover, Library and author previews.
 * A legacy fallback is displayable, but is not confirmation of a wide crop. */
export function selectWorldArtwork(world: WorldArtwork, shape: "portrait" | "landscape") {
  const portrait = shape === "portrait";
  const dedicated = portrait ? !!world.thumbnailUrl : !!world.landscapeCoverUrl;
  return {
    src: (portrait ? world.thumbnailUrl : world.landscapeCoverUrl || world.thumbnailUrl) || null,
    crop: resolveDiscoveryCoverCrop(portrait ? world.coverCrop : dedicated ? world.landscapeCoverCrop : world.galleryCoverCrop),
    dedicated,
  };
}

/** Discover artwork fills its frame, including legacy single-cover worlds.
 * Preserve authored position/zoom without inheriting detail-view letterboxing. */
export function resolveDiscoveryCoverCrop(
  crop: CoverCropSettings | null | undefined,
): CoverCropSettings {
  return { ...normalizeCoverCrop(crop), fit: "cover" };
}

export const discoveryCoverImageRenderer: CropImageRenderer = {
  getImageStyle({ crop, sourceAspect, targetAspect }) {
    return coverCropImageLayoutStyle(
      resolveDiscoveryCoverCrop(crop), sourceAspect, targetAspect,
    );
  },
};
