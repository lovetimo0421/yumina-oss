import type { LibraryItem } from "@/stores/library";

export type LibraryGameSort = "title" | "recent" | "added";

export function sortLibraryGameItems(
  items: readonly LibraryItem[],
  sortBy: LibraryGameSort,
  favoriteIds: ReadonlySet<string>,
): LibraryItem[] {
  return [...items].sort((a, b) => {
    const aFavorite = favoriteIds.has(a.worldId);
    const bFavorite = favoriteIds.has(b.worldId);
    if (aFavorite && !bFavorite) return -1;
    if (!aFavorite && bFavorite) return 1;

    switch (sortBy) {
      case "title":
        return a.worldName.localeCompare(b.worldName);
      case "recent": {
        // Most recent activity first = the later of (last played, added to
        // library). A freshly (re-)added card has addedAt=now, so it floats to
        // the top even if it was played long ago or never played — matching
        // the server-side recency sort in dedupeLibraryByLanguageGroup.
        const aRecent = Math.max(
          a.lastPlayedAt ? new Date(a.lastPlayedAt).getTime() : 0,
          new Date(a.addedAt).getTime(),
        );
        const bRecent = Math.max(
          b.lastPlayedAt ? new Date(b.lastPlayedAt).getTime() : 0,
          new Date(b.addedAt).getTime(),
        );
        return bRecent - aRecent;
      }
      case "added":
        return new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime();
    }
  });
}
