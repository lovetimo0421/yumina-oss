import type { LibraryItem } from "@/stores/library";

export type LibraryGameSort = "title" | "recent" | "added";
/** Built-in filters, or one of the player's collections ("collection:<id>"). */
export type LibraryGameFilter = "all" | "favorites" | "updates" | "unplayed" | "hidden" | `collection:${string}`;

export const collectionFilter = (id: string): LibraryGameFilter => `collection:${id}`;
export const filterCollectionId = (filter: LibraryGameFilter): string | null =>
  filter.startsWith("collection:") ? filter.slice("collection:".length) : null;

/** Hidden games only show under "Hidden"; every other filter leaves them out. */
export function filterLibraryGameItems(
  items: readonly LibraryItem[],
  filter: LibraryGameFilter,
  favoriteIds: ReadonlySet<string>,
): LibraryItem[] {
  if (filter === "hidden") return items.filter((item) => item.shelf === "hidden");
  const shown = items.filter((item) => item.shelf !== "hidden");
  const collectionId = filterCollectionId(filter);
  if (collectionId) return shown.filter((item) => item.collectionIds?.includes(collectionId) ?? false);
  switch (filter) {
    case "favorites": return shown.filter((item) => favoriteIds.has(item.worldId));
    case "updates": return shown.filter((item) => item.hasUpdate);
    case "unplayed": return shown.filter((item) => !item.lastPlayedAt);
    default: return shown;
  }
}

/** "Last played Nov 3" — the year only when it is not this year. */
export function formatLastPlayed(iso: string, language: string, now = new Date()): string {
  const date = new Date(iso);
  return date.toLocaleDateString(language, date.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

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
