import assert from "node:assert/strict";
import test from "node:test";
import type { LibraryItem } from "@/stores/library";
import { collectionFilter, filterCollectionId, filterLibraryGameItems, formatLastPlayed, sortLibraryGameItems } from "./library-game-sort";

function libraryItem(worldId: string, recentAt: string): LibraryItem {
  return {
    libraryId: `library-${worldId}`,
    worldId,
    worldName: worldId,
    worldDescription: "",
    worldThumbnailUrl: null,
    worldStatus: "published",
    worldTags: [],
    worldIsNsfw: false,
    worldDownloadCount: 0,
    worldMessageCount: 0,
    creatorId: "creator",
    creatorName: "Creator",
    creatorUsername: null,
    creatorImage: null,
    addedAt: recentAt,
    lastPlayedAt: null,
    lastSeenUpdateAt: null,
    hasUpdate: false,
  };
}

test("favorite ordering changes only when the page receives a new snapshot", () => {
  const items = [
    libraryItem("recent", "2026-08-27T03:00:00.000Z"),
    libraryItem("new-favorite", "2026-08-27T02:00:00.000Z"),
    libraryItem("existing-favorite", "2026-08-27T01:00:00.000Z"),
  ];
  const pageLoadFavorites = new Set(["existing-favorite"]);

  assert.deepEqual(
    sortLibraryGameItems(items, "recent", pageLoadFavorites).map((item) => item.worldId),
    ["existing-favorite", "recent", "new-favorite"],
    "the existing favorite starts at the top",
  );

  // The live favorite store can now include new-favorite, but this mounted
  // page intentionally keeps using pageLoadFavorites so the tapped card stays put.
  assert.deepEqual(
    sortLibraryGameItems(items, "recent", pageLoadFavorites).map((item) => item.worldId),
    ["existing-favorite", "recent", "new-favorite"],
    "the newly favorited card does not move during the current page visit",
  );

  const nextPageLoadFavorites = new Set(["existing-favorite", "new-favorite"]);
  assert.deepEqual(
    sortLibraryGameItems(items, "recent", nextPageLoadFavorites).map((item) => item.worldId),
    ["new-favorite", "existing-favorite", "recent"],
    "the next page refresh applies the new favorite-first order",
  );
});

test("library filters keep favorites, updated cards, or never-played cards", () => {
  const played = { ...libraryItem("played", "2026-10-01T00:00:00Z"), lastPlayedAt: "2026-11-01T00:00:00Z" };
  const updated = { ...libraryItem("updated", "2026-10-02T00:00:00Z"), lastPlayedAt: "2026-10-20T00:00:00Z", hasUpdate: true };
  const fresh = libraryItem("fresh", "2026-10-03T00:00:00Z");
  const items = [played, updated, fresh];
  const ids = (list: LibraryItem[]) => list.map((item) => item.worldId);
  assert.deepEqual(ids(filterLibraryGameItems(items, "all", new Set())), ["played", "updated", "fresh"]);
  assert.deepEqual(ids(filterLibraryGameItems(items, "favorites", new Set(["fresh", "played"]))), ["played", "fresh"]);
  assert.deepEqual(ids(filterLibraryGameItems(items, "updates", new Set())), ["updated"]);
  assert.deepEqual(ids(filterLibraryGameItems(items, "unplayed", new Set())), ["fresh"]);
});

test("last-played dates name the year only when it is not this year", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  assert.equal(formatLastPlayed("2026-11-03T12:00:00Z", "en-US", now), "Nov 3");
  assert.equal(formatLastPlayed("2025-12-30T12:00:00Z", "en-US", now), "Dec 30, 2025");
});

test("collections and Hide: hidden games show only under Hidden", () => {
  const inA = { ...libraryItem("in-a", "2026-11-01T00:00:00Z"), collectionIds: ["a"] };
  const inAB = { ...libraryItem("in-ab", "2026-11-01T00:00:00Z"), collectionIds: ["a", "b"], lastPlayedAt: "2026-11-02T00:00:00Z" };
  const hiddenInA = { ...libraryItem("hidden-in-a", "2026-11-01T00:00:00Z"), collectionIds: ["a"], shelf: "hidden" as const };
  const loose = libraryItem("loose", "2026-11-01T00:00:00Z");
  const all = [inA, inAB, hiddenInA, loose];
  const ids = (filter: Parameters<typeof filterLibraryGameItems>[1], favorites = new Set<string>()) =>
    filterLibraryGameItems(all, filter, favorites).map((i) => i.worldId);
  assert.deepEqual(ids("all"), ["in-a", "in-ab", "loose"]);
  assert.deepEqual(ids(collectionFilter("a")), ["in-a", "in-ab"]);
  assert.deepEqual(ids(collectionFilter("b")), ["in-ab"]);
  assert.deepEqual(ids("hidden"), ["hidden-in-a"]);
  assert.deepEqual(ids("unplayed"), ["in-a", "loose"]);
  assert.deepEqual(ids("favorites", new Set(["hidden-in-a", "loose"])), ["loose"]);
  assert.equal(filterCollectionId(collectionFilter("a")), "a");
  assert.equal(filterCollectionId("favorites"), null);
});
