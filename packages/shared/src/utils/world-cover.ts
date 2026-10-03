/**
 * Publishing rule (2026-09-05): a card must carry a cover image before it can
 * enter review. Worlds that were already published before the rule stay as they
 * are — the gate only runs on new submissions.
 *
 * Shared by the server's COVER_REQUIRED submit check and the publish modal's
 * pre-submit guard so the two can never disagree about what "has a cover" means.
 * The value is whatever `worlds.thumbnail_url` holds: a storage key or a resolved
 * CDN URL. Anything blank is treated as "no cover".
 */
export function hasPublishableCover(thumbnailUrl: string | null | undefined): boolean {
  return typeof thumbnailUrl === "string" && thumbnailUrl.trim().length > 0;
}

/** New publications need explicitly composed artwork for both Discover frames. */
export function hasDiscoverCoverArt(world: {
  thumbnailUrl?: string | null;
  landscapeCoverUrl?: string | null;
  coverCrop?: unknown;
  landscapeCoverCrop?: unknown;
}): boolean {
  const confirmed = (value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const crop = value as { x?: unknown; y?: unknown; zoom?: unknown; fit?: unknown };
    return crop.fit !== "contain" && [crop.x, crop.y, crop.zoom].every(v => typeof v === "number" && Number.isFinite(v))
      && typeof crop.zoom === "number" && crop.zoom >= .25 && crop.zoom <= 1;
  };
  return hasPublishableCover(world.thumbnailUrl) && hasPublishableCover(world.landscapeCoverUrl)
    && confirmed(world.coverCrop) && confirmed(world.landscapeCoverCrop);
}
