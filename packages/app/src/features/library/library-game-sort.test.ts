import assert from "node:assert/strict";
import test from "node:test";
import type { LibraryItem } from "@/stores/library";
import { sortLibraryGameItems } from "./library-game-sort";

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
