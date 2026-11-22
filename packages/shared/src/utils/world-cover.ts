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

export type DiscoverCoverArtIssue = "portraitImage" | "portraitCrop" | "landscapeImage" | "landscapeCrop";

/** Only failed requirements are returned; an absent image takes priority over its crop.
 * A crop that was never set is fine: Discover draws it centred and full-frame, which is
 * exactly what confirming the untouched crop editor saves, so asking for that click only
 * cost creators time (Jason, 11/10). A crop that is set but unusable still has to be fixed. */
export function getDiscoverCoverArtIssues(world: {
  thumbnailUrl?: string | null;
  landscapeCoverUrl?: string | null;
  coverCrop?: unknown;
  landscapeCoverCrop?: unknown;
}): DiscoverCoverArtIssue[] {
  const confirmed = (value: unknown) => {
    if (value === null || value === undefined) return true;
    if (typeof value !== "object") return false;
    const crop = value as { x?: unknown; y?: unknown; zoom?: unknown; fit?: unknown };
    return crop.fit !== "contain" && [crop.x, crop.y, crop.zoom].every(v => typeof v === "number" && Number.isFinite(v))
      && typeof crop.zoom === "number" && crop.zoom >= .25 && crop.zoom <= 1;
  };
  const issues: DiscoverCoverArtIssue[] = [];
  if (!hasPublishableCover(world.thumbnailUrl)) issues.push("portraitImage");
  else if (!confirmed(world.coverCrop)) issues.push("portraitCrop");
  if (!hasPublishableCover(world.landscapeCoverUrl)) issues.push("landscapeImage");
  else if (!confirmed(world.landscapeCoverCrop)) issues.push("landscapeCrop");
  return issues;
}

/** New publications need explicitly composed artwork for both Discover frames. */
export function hasDiscoverCoverArt(world: Parameters<typeof getDiscoverCoverArtIssues>[0]): boolean {
  return getDiscoverCoverArtIssues(world).length === 0;
}
