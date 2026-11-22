import { isDiscoverAddress } from "./discover-genre";

/**
 * Whether the Discover search query should survive a visit to `pathname`.
 *
 * It survives the places a search result leads to (a world's address, a play
 * page, a matching player's profile), so coming back lands on the same
 * results. Moving to another section of the site (Library, Community, your
 * own Profile, Messages, Studio...) ends the search: returning to Discover
 * then opens the main page, not the old results.
 */
export function keepsDiscoverSearch(pathname: string): boolean {
  return (
    isDiscoverAddress(pathname)
    || pathname.startsWith("/@")
    || pathname.startsWith("/app/users/")
    || pathname.startsWith("/app/chat/")
    || pathname.startsWith("/app/preview/")
  );
}
