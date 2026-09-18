import assert from "node:assert/strict";
import test from "node:test";
import {
  hasComposerDraft,
  setComposerDraft,
  loadComposerDraft,
  resetComposerDraftMirror,
} from "./composer-draft";

type Global = Record<string, unknown>;

function installFakeSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Global).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return store;
}

/** Opaque-origin iframes and private mode both make storage access throw. */
function installThrowingSessionStorage(): void {
  const boom = () => {
    throw new Error("SecurityError");
  };
  (globalThis as Global).sessionStorage = {
    getItem: boom,
    setItem: boom,
    removeItem: boom,
  };
}

// The reported bug (@haorenstalin, 2026-08-07): a deploy landed while a message
// was half-typed, and refocusing the tab reloaded the page out from under it.
// An unsent message must read as work-in-progress so the deploy check backs off.
test("a half-typed message blocks the deploy auto-reload", () => {
  installFakeSessionStorage();
  resetComposerDraftMirror();

  assert.equal(hasComposerDraft(), false);

  setComposerDraft("session-1", "写到一半的消息");
  assert.equal(hasComposerDraft(), true);

  // Sending empties the composer, which must unblock the refresh immediately —
  // otherwise one message would suppress deploy updates for the tab's life.
  setComposerDraft("session-1", "");
  assert.equal(hasComposerDraft(), false);
});

// A stray space or newline left in the box is not work worth blocking a deploy
// refresh over, and would otherwise block it indefinitely.
test("whitespace alone is not a draft", () => {
  installFakeSessionStorage();
  resetComposerDraftMirror();

  setComposerDraft("session-1", "   \n\t ");
  assert.equal(hasComposerDraft(), false);
});

test("a draft survives the reloads we cannot avoid", () => {
  installFakeSessionStorage();
  resetComposerDraftMirror();

  setComposerDraft("session-1", "half a sentence");

  // A reload wipes module state but not sessionStorage.
  resetComposerDraftMirror();
  assert.equal(loadComposerDraft("session-1"), "half a sentence");
});

test("drafts are scoped per session", () => {
  installFakeSessionStorage();
  resetComposerDraftMirror();

  setComposerDraft("session-1", "for the first world");
  setComposerDraft("session-2", "for the second world");

  assert.equal(loadComposerDraft("session-1"), "for the first world");
  assert.equal(loadComposerDraft("session-2"), "for the second world");
  assert.equal(loadComposerDraft("session-never-typed-in"), "");
});

// Navigating away from the chat has to release the block — a draft on a page
// the user has left must not suppress deploy refreshes for the rest of the
// tab's life — while still being there when they come back to that session.
test("navigating away unblocks the refresh but keeps the draft", () => {
  installFakeSessionStorage();
  resetComposerDraftMirror();

  setComposerDraft("session-1", "typed, then walked away");
  assert.equal(hasComposerDraft(), true);

  resetComposerDraftMirror();
  assert.equal(hasComposerDraft(), false);
  assert.equal(loadComposerDraft("session-1"), "typed, then walked away");
});

// Persistence is best-effort; the reload guard is not. If storage is unusable
// we still must not reload over a message the user is typing.
test("the reload guard still holds when storage is unavailable", () => {
  installThrowingSessionStorage();
  resetComposerDraftMirror();

  setComposerDraft("session-1", "typed with storage blocked");
  assert.equal(hasComposerDraft(), true);
  assert.equal(loadComposerDraft("session-1"), "");
});

// An empty sessionId (guest preview, session not yet created) must not throw
// and must not write a key with an empty scope.
test("a missing session id degrades to guard-only", () => {
  const store = installFakeSessionStorage();
  resetComposerDraftMirror();

  setComposerDraft("", "typed before the session existed");
  assert.equal(hasComposerDraft(), true);
  assert.equal(store.size, 0);
  assert.equal(loadComposerDraft(""), "");
});
