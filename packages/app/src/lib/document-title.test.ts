import assert from "node:assert/strict";
import test from "node:test";
import { getDocumentTitleOverride, setDocumentTitleOverride, titleForPath } from "./document-title";

test("the home page carries the search title, every other page is its own name", () => {
  assert.equal(titleForPath("/"), "Yumina: Play Free AI Games & AI Roleplay - Sign Up to Play!");
  assert.equal(titleForPath("/app/hub"), "Discover");
  assert.equal(titleForPath("/app/hub/"), "Discover");
  assert.equal(titleForPath("/app/hub/27483dff-e14f-49ec-864c-37bd85d7d9c4"), "Discover");
  assert.equal(titleForPath("/app/hub/bundles/abc"), "Bundles");
  assert.equal(titleForPath("/app/community"), "Community");
  assert.equal(titleForPath("/app/community/thread/xyz"), "Community");
  assert.equal(titleForPath("/app/bundles"), "Bundles");
  assert.equal(titleForPath("/app/worlds/create"), "Create");
  assert.equal(titleForPath("/login"), "Sign in");
  assert.equal(titleForPath("/register"), "Create account");
  assert.equal(titleForPath("/krew"), "Krew.io");
  assert.equal(titleForPath("/app/chat/abc"), "Yumina");
});

test("a genre or tag address keeps the title the server sent", () => {
  assert.equal(titleForPath("/ai-rpg"), "AI RPG Games - Play Free Online");
  assert.equal(titleForPath("/ai-roleplay"), "AI Roleplay - Free Roleplay With AI Characters");
  assert.equal(titleForPath("/ai-text-adventure"), "AI Text Adventure Games - Play Free Online");
  assert.equal(titleForPath("/ai-games"), "AI Games - Play Free in Your Browser");
  assert.equal(titleForPath("/ai-chat"), "AI Chat - Talk to AI Characters Free");
  assert.equal(titleForPath("/multiplayer-ai-games"), "Multiplayer AI Games - Play Free With Friends");
  assert.equal(titleForPath("/ai-visual-novel"), "AI Visual Novel Games - Play Free Online");
  assert.equal(titleForPath("/ai-story-games"), "AI Story Games - Play Free Online");
  assert.equal(titleForPath("/ai-dungeon-master"), "AI Dungeon Master - Play Tabletop RPGs Free Online");
  assert.equal(titleForPath("/app/tag/rpg"), "RPG AI Games & Roleplay");
  assert.equal(titleForPath("/app/tag/romance"), "Romance AI Games & Roleplay");
  assert.equal(titleForPath("/app/tag/not-a-tag-anyone-has"), "Yumina");
});

test("no title carries a brand suffix", () => {
  for (const path of ["/app/hub", "/app/community", "/app/bundles", "/app/worlds", "/login", "/register"]) {
    assert.doesNotMatch(titleForPath(path), /yumina/i);
  }
});

test("an overlay name beats the page name and hands it back on close", () => {
  setDocumentTitleOverride("A thread title", "page");
  assert.equal(getDocumentTitleOverride(), "A thread title");
  setDocumentTitleOverride("After the Bell", "overlay");
  assert.equal(getDocumentTitleOverride(), "After the Bell");
  setDocumentTitleOverride(null, "overlay");
  assert.equal(getDocumentTitleOverride(), "A thread title");
  setDocumentTitleOverride("   ", "page");
  assert.equal(getDocumentTitleOverride(), null);
});

test("every path maps to a named page key with an English word behind it", async () => {
  const { titleKeyForPath, TAB_TITLE_EN } = await import("./document-title");
  assert.equal(titleKeyForPath("/"), "root");
  assert.equal(titleKeyForPath("/app/quests"), "quests");
  assert.equal(titleKeyForPath("/app/plans"), "plans");
  assert.equal(titleKeyForPath("/creator"), "creator");
  assert.equal(titleKeyForPath("/app/nowhere"), "home");
  for (const key of Object.keys(TAB_TITLE_EN) as Array<keyof typeof TAB_TITLE_EN>) {
    assert.ok(TAB_TITLE_EN[key].length > 0, key);
  }
});

test("a world address is Discover underneath; a creator address is a page of its own", async () => {
  const { titleKeyForPath } = await import("./document-title");
  assert.equal(titleKeyForPath("/@windowseat/after-the-bell-27483dff"), "discover");
  assert.equal(titleKeyForPath("/@windowseat"), "home");
});
