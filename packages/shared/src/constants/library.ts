/** A player's own mark on a game in their library. "hidden" keeps it out of
 *  the library list without deleting saves (Steam's Hide). Organising games
 *  is done with collections, not shelves. */
export const LIBRARY_SHELVES = ["hidden"] as const;
export type LibraryShelf = (typeof LIBRARY_SHELVES)[number];

export function isLibraryShelf(value: unknown): value is LibraryShelf {
  return typeof value === "string" && (LIBRARY_SHELVES as readonly string[]).includes(value);
}

/** Collection names are a few words, like Steam's. */
export const LIBRARY_COLLECTION_NAME_MAX = 40;
/** Plenty for anyone organising by hand; bounds the list a client renders. */
export const LIBRARY_COLLECTIONS_PER_USER_MAX = 100;
