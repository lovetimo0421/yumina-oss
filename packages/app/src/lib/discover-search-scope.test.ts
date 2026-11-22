import assert from "node:assert/strict";
import test from "node:test";
import { keepsDiscoverSearch } from "./discover-search-scope.js";

test("search results' destinations keep the Discover query", () => {
  for (const path of ["/", "/app/hub", "/@aria/moonlit-court-12ab", "/@aria", "/app/users/u1", "/app/chat/s1", "/app/preview/w1"]) {
    assert.equal(keepsDiscoverSearch(path), true, path);
  }
});

test("other sections of the site end the Discover search", () => {
  for (const path of ["/app/library", "/app/profile", "/app/profile/ai", "/app/community", "/app/messages", "/app/settings", "/app/worlds/create", "/app/studio/w1", "/app/quests"]) {
    assert.equal(keepsDiscoverSearch(path), false, path);
  }
});
