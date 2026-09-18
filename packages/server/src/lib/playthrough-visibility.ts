export type PlaythroughGalleryVisibility = "all" | "safe" | "safe-and-own";

/** Decide which age-rating rows a gallery request may see. */
export function playthroughGalleryVisibility(input: {
  wantsSensitive: boolean;
  currentUserId?: string | null;
  worldCreatorId: string;
}): PlaythroughGalleryVisibility {
  // Guests are hard-locked to safe regardless of the contentLevel param —
  // Limitless playthroughs are full chat transcripts and must never be
  // reachable logged-out (payment-network crawlers browse unauthenticated).
  if (!input.currentUserId) return "safe";
  if (input.wantsSensitive) return "all";
  if (input.currentUserId === input.worldCreatorId) return "all";
  return "safe-and-own";
}

type SortablePlaythrough = {
  id: string;
  likeCount: number;
  createdAt: Date | null;
};

/** Merge primary-owned rows into replica browse rows without changing sort semantics. */
export function mergePlaythroughGalleryRows<T extends SortablePlaythrough>(
  replicaRows: T[],
  primaryOwnedRows: T[],
  sort: "newest" | "popular",
  limit = 60,
): T[] {
  const byId = new Map(replicaRows.map((row) => [row.id, row]));
  for (const row of primaryOwnedRows) byId.set(row.id, row);

  return [...byId.values()]
    .sort((a, b) =>
      sort === "popular"
        ? b.likeCount - a.likeCount
        : (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    )
    .slice(0, limit);
}
