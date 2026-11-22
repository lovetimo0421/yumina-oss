import type { CSSProperties } from "react";
import { LEGACY_BANNER_ASPECT } from "./banner-aspect";

export interface CoverCropSettings {
  /**
   * Independent desktop banner crop. Top-level coordinates remain the 16:9 mobile/card crop.
   * `aspect` is the banner shape it was framed in and is saved with it; one saved
   * without (before the banner became 21:9) was framed at 16:5.
   */
  desktop?: { x: number; y: number; zoom: number; fit?: "cover" | "contain"; aspect?: number };
  x: number;
  y: number;
  zoom: number;
  fit?: "cover" | "contain";
  /**
   * Aspect ratio (width / height) of the frame this crop was authored in.
   * Display-time hint only — never persisted (the engine schema strips it).
   * When a surface renders at a different aspect, the view is derived from
   * the authored region instead of re-reading x/y/zoom against the new frame,
   * so what the creator framed in the crop dialog stays in view.
   */
  aspect?: number;
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
/** Relative difference under which a frame counts as the authored aspect. */
const ASPECT_TOLERANCE = 0.01;

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
  const aspect = Number(raw.aspect);
  return {
    x: clamp(Number(raw.x ?? 0), -MAX_PAN, MAX_PAN),
    y: clamp(Number(raw.y ?? 0), -MAX_PAN, MAX_PAN),
    zoom,
    fit,
    // A banner crop always says which shape it was framed in, so every reader
    // re-frames an older one the same way (getCoverCropRect, convertCoverCrop).
    ...(raw.desktop && typeof raw.desktop === "object" ? { desktop: normalizeCoverCrop({
      x: raw.desktop.x, y: raw.desktop.y, zoom: raw.desktop.zoom, fit: raw.desktop.fit,
      aspect: Number(raw.desktop.aspect) > 0 ? raw.desktop.aspect : LEGACY_BANNER_ASPECT,
    }) } : {}),
    ...(Number.isFinite(aspect) && aspect > 0 ? { aspect } : {}),
  };
}

export function clampCoverCrop(crop: CoverCropSettings): CoverCropSettings {
  return normalizeCoverCrop(crop);
}

function safeAspects(sourceAspect: number, targetAspect: number) {
  const safeTargetAspect = Number.isFinite(targetAspect) && targetAspect > 0 ? targetAspect : 1;
  const safeSourceAspect =
    Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : safeTargetAspect;
  return { safeSourceAspect, safeTargetAspect };
}

/** The region x/y/zoom describe when read against a frame of `targetAspect`. */
function resolveCropRect(
  crop: CoverCropSettings,
  sourceAspect: number,
  targetAspect: number,
): CropRect {
  const baseWidth = sourceAspect > targetAspect ? targetAspect / sourceAspect : 1;
  const baseHeight = sourceAspect > targetAspect ? 1 : sourceAspect / targetAspect;
  const width = baseWidth * crop.zoom * 100;
  const height = baseHeight * crop.zoom * 100;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = clamp(50 + crop.x, halfWidth, 100 - halfWidth);
  const centerY = clamp(50 + crop.y, halfHeight, 100 - halfHeight);

  return {
    left: centerX - halfWidth,
    top: centerY - halfHeight,
    width,
    height,
    centerX,
    centerY,
  };
}

/**
 * Re-frame a region authored at one aspect for display at another. The
 * authored region stays fully visible and centered where the creator put it;
 * the frame grows along one axis to reach the target shape and only shrinks
 * when it would otherwise overflow the image.
 */
function reframeCropRect(
  authored: CropRect,
  sourceAspect: number,
  targetAspect: number,
): CropRect {
  // Rect sizes are % of the source image, so pixel aspect = (w / h) * source.
  const authoredAspect = (authored.width / authored.height) * sourceAspect;
  let width: number;
  let height: number;
  if (targetAspect >= authoredAspect) {
    height = authored.height;
    width = (height * targetAspect) / sourceAspect;
    if (width > 100) {
      width = 100;
      height = (100 * sourceAspect) / targetAspect;
    }
  } else {
    width = authored.width;
    height = (width * sourceAspect) / targetAspect;
    if (height > 100) {
      height = 100;
      width = (100 * targetAspect) / sourceAspect;
    }
  }
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = clamp(authored.centerX, halfWidth, 100 - halfWidth);
  const centerY = clamp(authored.centerY, halfHeight, 100 - halfHeight);

  return {
    left: centerX - halfWidth,
    top: centerY - halfHeight,
    width,
    height,
    centerX,
    centerY,
  };
}

export function getCoverCropRect(
  crop: CoverCropSettings | null | undefined,
  sourceAspect: number,
  targetAspect: number,
): CropRect {
  const safeCrop = normalizeCoverCrop(crop);
  const { safeSourceAspect, safeTargetAspect } = safeAspects(sourceAspect, targetAspect);
  const authoredAspect = safeCrop.aspect;
  if (
    authoredAspect
    && Math.abs(authoredAspect - safeTargetAspect) > safeTargetAspect * ASPECT_TOLERANCE
  ) {
    const authored = resolveCropRect(safeCrop, safeSourceAspect, authoredAspect);
    return reframeCropRect(authored, safeSourceAspect, safeTargetAspect);
  }
  return resolveCropRect(safeCrop, safeSourceAspect, safeTargetAspect);
}

/**
 * A crop framed for another shape, rewritten as x/y/zoom for `targetAspect`:
 * the framed region keeps its width and centre and grows up and down (or its
 * height and centre, growing sideways) to the new shape, moves back inside the
 * picture where it would cross an edge, and shrinks only when the picture is
 * too small to hold it. A crop already framed for `targetAspect`, or one that
 * does not say what it was framed for, is returned as it is.
 */
export function convertCoverCrop(
  crop: CoverCropSettings,
  sourceAspect: number,
  targetAspect: number,
): CoverCropSettings {
  const authoredAspect = normalizeCoverCrop(crop).aspect;
  if (!authoredAspect || Math.abs(authoredAspect - targetAspect) <= targetAspect * ASPECT_TOLERANCE) return crop;
  const rect = getCoverCropRect(crop, sourceAspect, targetAspect);
  const full = getCoverCropRect(DEFAULT_COVER_CROP, sourceAspect, targetAspect);
  return {
    x: rect.centerX - 50,
    y: rect.centerY - 50,
    zoom: clamp(rect.width / full.width, MIN_CROP_SIZE, MAX_CROP_SIZE),
    fit: "cover",
    aspect: targetAspect,
  };
}

export function clampCoverCropForAspect(
  crop: CoverCropSettings,
  sourceAspect: number,
  targetAspect: number,
): CoverCropSettings {
  // Re-authors the crop for `targetAspect`, so any earlier frame hint is dropped.
  const { aspect: _authoredAspect, ...safeCrop } = normalizeCoverCrop(crop);
  const { safeSourceAspect, safeTargetAspect } = safeAspects(sourceAspect, targetAspect);
  const rect = resolveCropRect(safeCrop, safeSourceAspect, safeTargetAspect);
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
