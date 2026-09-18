import assert from "node:assert/strict";
import test from "node:test";
import { getPlayNavigationSearch } from "./story-return-url";

const source = { returnTo: "/app/users/creator?tab=works", returnKey: "original-return-key" };

test("play entry captures profile, library detail, editor and session manager origins", () => {
  for (const pathname of ["/app/users/creator", "/app/library", "/app/worlds/create", "/app/worlds/story/edit"]) {
    let captures = 0;
    const search = getPlayNavigationSearch(pathname, {}, undefined, () => { captures++; return source; });
    assert.deepEqual(search, { ...source, moderationGroupKey: undefined });
    assert.equal(captures, 1);
  }
});

test("session and branch switches preserve the original return target and moderation context", () => {
  for (const pathname of ["/app/chat/old-session", "/app/preview/story"]) {
    const current = { ...source, moderationGroupKey: "moderation-1", unrelated: "drop" };
    assert.deepEqual(getPlayNavigationSearch(pathname, current, { returnTo: pathname }, () => assert.fail("must not capture an intermediate session")), {
      ...source, moderationGroupKey: "moderation-1",
    });
  }
});

test("deep-link previews can pass their saved origin through the play picker", () => {
  assert.deepEqual(getPlayNavigationSearch("/app/hub", {}, source, () => assert.fail("must use the saved origin")), {
    ...source, moderationGroupKey: undefined,
  });
});

test("direct sessions keep a safe fallback and never inherit untrusted return URLs", () => {
  for (const returnTo of [undefined, "//evil.test", "https://evil.test/", "/\\evil.test"]) {
    assert.deepEqual(getPlayNavigationSearch("/app/chat/session", { returnTo, returnKey: "../invalid" }, undefined, () => assert.fail("must not create a self-return loop")), {
      moderationGroupKey: undefined, returnTo: undefined, returnKey: undefined,
    });
  }
});
