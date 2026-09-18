import type { CSSProperties } from "react";

export interface CoverCropSettings {
  x: number;
  y: number;
  zoom: number;
  fit?: "cover" | "contain";
}

export const DEFAULT_COVER_CROP: CoverCropSettings = {
  x: 0,
  y: 0,
  zoom: 1,
  fit: "cover",
};

export const MIN_CROP_SIZE = 0.25;
export const MAX_CROP_SIZE = 1;
const MAX_PAN = 45;

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface CropImageRenderInput {
  crop?: CoverCropSettings | null;
  sourceAspect: number | null;
  targetAspect: number | null;
}

export interface CropImageRenderer {
  getImageStyle(input: CropImageRenderInput): CSSProperties;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function normalizeCoverCrop(value: unknown): CoverCropSettings {
  if (!value || typeof value !== "object") return DEFAULT_COVER_CROP;
  const raw = value as Partial<CoverCropSettings>;
  const fit = raw.fit === "contain" ? "contain" : "cover";
  const zoom = clamp(Number(raw.zoom ?? 1), MIN_CROP_SIZE, MAX_CROP_SIZE);
  return {
    x: clamp(Number(raw.x ?? 0), -MAX_PAN, MAX_PAN),
    y: clamp(Number(raw.y ?? 0), -MAX_PAN, MAX_PAN),
    zoom,
    fit,
  };
}

export function clampCoverCrop(crop: CoverCropSettings): CoverCropSettings {
  return normalizeCoverCrop(crop);
}

export function getCoverCropRect(
  crop: CoverCropSettings | null | undefined,
  sourceAspect: number,
  targetAspect: number,
): CropRect {
  const safeCrop = normalizeCoverCrop(crop);
  const safeSourceAspect = Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : targetAspect;
  const safeTargetAspect = Number.isFinite(targetAspect) && targetAspect > 0 ? targetAspect : 1;
  const baseWidth = safeSourceAspect > safeTargetAspect ? safeTargetAspect / safeSourceAspect : 1;
  const baseHeight = safeSourceAspect > safeTargetAspect ? 1 : safeSourceAspect / safeTargetAspect;
  const width = baseWidth * safeCrop.zoom * 100;
  const height = baseHeight * safeCrop.zoom * 100;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = clamp(50 + safeCrop.x, halfWidth, 100 - halfWidth);
  const centerY = clamp(50 + safeCrop.y, halfHeight, 100 - halfHeight);

  return {
    left: centerX - halfWidth,
    top: centerY - halfHeight,
    width,
    height,
    centerX,
    centerY,
  };
}

export function clampCoverCropForAspect(
  crop: CoverCropSettings,
  sourceAspect: number,
  targetAspect: number,
): CoverCropSettings {
  const safeCrop = normalizeCoverCrop(crop);
  const rect = getCoverCropRect(safeCrop, sourceAspect, targetAspect);
  return {
    ...safeCrop,
    x: rect.centerX - 50,
    y: rect.centerY - 50,
  };
}

export function coverCropImageStyle(crop?: CoverCropSettings | null): CSSProperties {
  const safeCrop = normalizeCoverCrop(crop);
  return {
    objectFit: safeCrop.fit ?? "cover",
    objectPosition: `${50 - safeCrop.x}% ${50 - safeCrop.y}%`,
    transform: `scale(${safeCrop.zoom})`,
    transformOrigin: "center",
  };
}

export function coverCropImageLayoutStyle(
  crop: CoverCropSettings | null | undefined,
  sourceAspect: number | null,
  targetAspect: number | null,
): CSSProperties {
  const safeCrop = normalizeCoverCrop(crop);
  if (!sourceAspect || !targetAspect) {
    return {
      height: "100%",
      inset: 0,
      objectFit: safeCrop.fit === "contain" ? "contain" : "cover",
      objectPosition: `${50 - safeCrop.x}% ${50 - safeCrop.y}%`,
      width: "100%",
    };
  }

  if (safeCrop.fit === "contain") {
    const safeSourceAspect = sourceAspect > 0 ? sourceAspect : targetAspect;
    const safeTargetAspect = targetAspect > 0 ? targetAspect : 1;
    const containWidth =
      safeSourceAspect > safeTargetAspect ? 100 : (safeSourceAspect / safeTargetAspect) * 100;
    const containHeight =
      safeSourceAspect > safeTargetAspect ? (safeTargetAspect / safeSourceAspect) * 100 : 100;
    const scale = 1 / Math.max(safeCrop.zoom, MIN_CROP_SIZE);

    return {
      height: `${containHeight * scale}%`,
      left: `${50 - safeCrop.x - (containWidth * scale) / 2}%`,
      objectFit: "fill",
      top: `${50 - safeCrop.y - (containHeight * scale) / 2}%`,
      width: `${containWidth * scale}%`,
    };
  }

  const rect = getCoverCropRect(safeCrop, sourceAspect, targetAspect);
  const widthRatio = rect.width / 100;
  const heightRatio = rect.height / 100;

  return {
    height: `${100 / heightRatio}%`,
    left: `${-rect.left / widthRatio}%`,
    objectFit: "fill",
    top: `${-rect.top / heightRatio}%`,
    width: `${100 / widthRatio}%`,
  };
}

export class DefaultCropImageRenderer implements CropImageRenderer {
  getImageStyle({ crop, sourceAspect, targetAspect }: CropImageRenderInput): CSSProperties {
    return coverCropImageLayoutStyle(crop, sourceAspect, targetAspect);
  }
}

export const defaultCropImageRenderer = new DefaultCropImageRenderer();
