/**
 * Unsent chat-composer text, mirrored out of the sandbox iframe.
 *
 * Persistence across the reloads we cannot avoid — the user's own manual F5,
 * stale-chunk recovery, the refresh they take off the new-version toast, a
 * crash. The composer lives in an `allow-scripts` iframe with NO
 * `allow-same-origin`, so its origin is opaque and touching sessionStorage in
 * there throws. The host has to be the one that stores it.
 *
 * This started (2026-08-07, @haorenstalin: "有时候会导致输入到一半的消息丢失")
 * as half of a guard that also stopped the post-deploy auto-reload from firing
 * mid-draft. The auto-reload is gone entirely as of 2026-08-10, so only the
 * persistence half remains — and it matters more now, since every refresh a
 * user takes is one they chose while possibly holding a draft.
 *
 * sessionStorage, not localStorage: a draft belongs to the tab that typed it.
 * Two tabs on one session must not overwrite each other, and an abandoned draft
 * should die with the tab rather than resurface days later.
 */

const KEY_PREFIX = "yumina:composer-draft:";

/** Live mirror of the composer, for the synchronous reload guard. */
let currentDraft = "";

function keyFor(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/** True when the user has unsent text sitting in the composer. */
export function hasComposerDraft(): boolean {
  return currentDraft.trim().length > 0;
}

/** Mirror and persist the composer's current text. Empty clears the stored copy. */
export function setComposerDraft(sessionId: string, text: string): void {
  currentDraft = text;
  if (!sessionId) return;
  try {
    if (text.trim()) sessionStorage.setItem(keyFor(sessionId), text);
    else sessionStorage.removeItem(keyFor(sessionId));
  } catch {
    // Private mode or quota. The in-memory mirror still guards the reload;
    // only cross-reload recovery is lost.
  }
}

/** The draft saved for this session in this tab, or "" if there is none. */
export function loadComposerDraft(sessionId: string): string {
  if (!sessionId) return "";
  try {
    return sessionStorage.getItem(keyFor(sessionId)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Drop the in-memory mirror when the composer goes away (session switch, chat
 * unmount, navigation). Without this a draft left behind on a page the user has
 * navigated away from would block the deploy refresh for the rest of the tab's
 * life. The stored copy is deliberately kept — coming back to that session
 * should still restore what was typed.
 */
export function resetComposerDraftMirror(): void {
  currentDraft = "";
}
