const DEFAULT_VISUAL_STRENGTH = 100;

export function normalizeVisualStrength(
  value: unknown,
  fallback = DEFAULT_VISUAL_STRENGTH
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(200, Math.max(0, Math.round(parsed)));
}

export function getWallpaperOpacityScale(value: unknown): number {
  return normalizeVisualStrength(value, DEFAULT_VISUAL_STRENGTH) / 100;
}

export function getCloudyGlassBrightnessScale(value: unknown): number {
  const normalized = normalizeVisualStrength(value, DEFAULT_VISUAL_STRENGTH);
  return 0.2 + (normalized / 200) * 1.6;
}
