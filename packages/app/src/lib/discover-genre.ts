/**
 * Discover opened for one genre or tag.
 *
 * The genre addresses (/ai-rpg, /ai-chat and the rest of GENRE_PAGES) and
 * every tag page (/app/tag/<slug>) show Discover itself. On them the hero
 * names the genre instead of a featured world, and the genre's worlds follow
 * directly. This file says which addresses those are and what
 * each one stands for; the hero is HeroBanner in the Discover layout.
 */
import { GENRE_PAGES, TAG_PAGE_PREFIX, findTagBySlug, tagPageTitle, type GenrePage } from "@yumina/shared";

export interface DiscoverGenre {
  /** The tag the address selects, or null for /ai-games, which lists every world. */
  tag: string | null;
  /** The copy of a genre address. A plain tag page has none. */
  page?: GenrePage;
  /** The browser tab title, the same one the server sends for the address. */
  title: string;
}

/** What the address opens Discover for, or null when it is not a genre or tag address. */
export function genreForPath(pathname: string): DiscoverGenre | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const page = GENRE_PAGES.find((p) => `/${p.slug}` === path);
  if (page) return { tag: page.discoverTag, page, title: page.title };
  if (!path.startsWith(TAG_PAGE_PREFIX)) return null;
  const entry = findTagBySlug(path.slice(TAG_PAGE_PREFIX.length));
  return entry ? { tag: entry.canonical, title: tagPageTitle(entry.labels.en) } : null;
}

/**
 * The genre view lasts while the tag filter is still the one the address
 * chose. Once the visitor clears or changes it, the page is the ordinary
 * Discover again.
 */
export function isGenreSelected(genre: DiscoverGenre, filterTags: readonly string[]): boolean {
  return genre.tag === null ? filterTags.length === 0 : filterTags.length === 1 && filterTags[0] === genre.tag;
}

/**
 * The order a genre or tag address first lists its worlds in. The visitor can
 * change it under Filters, as on any Discover page.
 *
 * A signed-out visitor gets most played. With a tag and no history,
 * "recommended" is one fixed ranking that puts little-played worlds in the
 * first rows (on /ai-chat its first ten had a median of 11k messages against
 * 43k for most played, and Fantasy listed two versions of one world side by
 * side). Most played is also the order of the list the server writes for
 * search engines on the same address (server lib/public-pages.ts), so a
 * visitor and a crawler see the same worlds first. A signed-in player keeps
 * recommended, which knows what they have played.
 */
export function genreDefaultSort(signedIn: boolean): "recommended" | "popular" {
  return signedIn ? "recommended" : "popular";
}

/** Addresses that show Discover's main page: home, /app/hub, and the genre and tag addresses. */
export function isDiscoverAddress(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/app/hub") || genreForPath(pathname) !== null;
}
