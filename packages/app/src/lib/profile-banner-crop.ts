import {
  DEFAULT_COVER_CROP,
  normalizeCoverCrop,
  type CoverCropSettings,
} from "./cover-crop";

export interface ProfileBannerCropSettings {
  desktop: CoverCropSettings;
  mobile: CoverCropSettings;
}

export const DEFAULT_PROFILE_BANNER_CROP: ProfileBannerCropSettings = {
  desktop: DEFAULT_COVER_CROP,
  mobile: DEFAULT_COVER_CROP,
};

export function getMobileProfileBannerDisplayCrop(
  crop?: CoverCropSettings | null,
): CoverCropSettings {
  return { ...normalizeCoverCrop(crop), fit: "cover" };
}

export function normalizeProfileBannerCrop(value: unknown): ProfileBannerCropSettings {
  if (!value || typeof value !== "object") return DEFAULT_PROFILE_BANNER_CROP;
  const raw = value as Partial<Record<keyof ProfileBannerCropSettings, unknown>>;
  return {
    desktop: normalizeCoverCrop(raw.desktop),
    mobile: getMobileProfileBannerDisplayCrop(raw.mobile as CoverCropSettings | null | undefined),
  };
}
