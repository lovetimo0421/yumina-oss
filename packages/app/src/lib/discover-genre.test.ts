import assert from "node:assert/strict";
import test from "node:test";
import { genreDefaultSort, genreForPath, isDiscoverAddress, isGenreSelected } from "./discover-genre";
import { keepsDiscoverSearch } from "./discover-search-scope";
import { getDesktopSidebarOffset } from "./desktop-sidebar-layout";
import { getMobileReadingPageId } from "./mobile-reading-route";

test("each genre address stands for its tag and carries the server's title", () => {
  const rpg = genreForPath("/ai-rpg");
  assert.equal(rpg?.tag, "RPG");
  assert.equal(rpg?.page?.phrase, "AI RPG");
  assert.equal(rpg?.title, "AI RPG Games - Play Free Online");
  assert.equal(genreForPath("/ai-roleplay")?.tag, "Roleplay");
  assert.equal(genreForPath("/ai-text-adventure/")?.tag, "Adventure");
  // /ai-games lists every world: a genre without a tag.
  assert.equal(genreForPath("/ai-games")?.tag, null);
  assert.equal(genreForPath("/ai-games")?.page?.phrase, "AI games");
  // The newer five, each on a tag from the vocabulary.
  assert.equal(genreForPath("/ai-chat")?.tag, "角色卡");
  assert.equal(genreForPath("/multiplayer-ai-games")?.tag, "联机");
  assert.equal(genreForPath("/ai-visual-novel")?.tag, "Visual Novel");
  assert.equal(genreForPath("/ai-story-games")?.tag, "Scenario");
  assert.equal(genreForPath("/ai-dungeon-master/")?.tag, "DND");
  assert.equal(genreForPath("/ai-dungeon-master")?.title, "AI Dungeon Master - Play Tabletop RPGs Free Online");
});

test("a genre lists most played first for a visitor and recommended for a signed-in player", () => {
  assert.equal(genreDefaultSort(false), "popular");
  assert.equal(genreDefaultSort(true), "recommended");
});

test("a genre page may name the world its hero shows, by the id that ends the world's address", () => {
  assert.match(genreForPath("/ai-rpg")!.page!.heroWorld!, /^[0-9a-f]{8,32}$/);
  assert.equal(genreForPath("/ai-chat")!.page!.heroWorld, undefined);
});

test("a tag page stands for the stored tag and is titled with its English label", () => {
  const romance = genreForPath("/app/tag/romance");
  assert.equal(romance?.tag, "恋爱");
  assert.equal(romance?.page, undefined);
  assert.equal(romance?.title, "Romance AI Games & Roleplay");
  assert.equal(genreForPath("/app/tag/rpg")?.tag, "RPG");
});

test("other addresses, and a slug outside the tag vocabulary, are not genre addresses", () => {
  for (const path of ["/", "/app/hub", "/app/tag/not-a-tag-anyone-has", "/app/tag/", "/ai-rpg/extra", "/app/community/tag/rpg", "/pricing"]) {
    assert.equal(genreForPath(path), null, path);
  }
});

test("the genre view lasts only while the filter is the address's own tag", () => {
  const rpg = genreForPath("/ai-rpg")!;
  assert.equal(isGenreSelected(rpg, ["RPG"]), true);
  assert.equal(isGenreSelected(rpg, []), false, "cleared");
  assert.equal(isGenreSelected(rpg, ["Roleplay"]), false, "changed");
  assert.equal(isGenreSelected(rpg, ["RPG", "Roleplay"]), false, "narrowed");
  const games = genreForPath("/ai-games")!;
  assert.equal(isGenreSelected(games, []), true);
  assert.equal(isGenreSelected(games, ["RPG"]), false);
});

test("genre and tag addresses are Discover to the shell, like the home page", () => {
  for (const path of ["/", "/app/hub", "/ai-rpg", "/ai-games", "/ai-chat", "/multiplayer-ai-games", "/app/tag/rpg"]) {
    assert.equal(isDiscoverAddress(path), true, path);
    assert.equal(keepsDiscoverSearch(path), true, path);
    assert.equal(getMobileReadingPageId(path), "hub-main", path);
    assert.equal(getDesktopSidebarOffset(path, false), "var(--sidebar-collapsed-width)", path);
  }
  for (const path of ["/app/library", "/app/community", "/app/tag/not-a-tag-anyone-has", "/pricing"]) {
    assert.equal(isDiscoverAddress(path), false, path);
  }
});
