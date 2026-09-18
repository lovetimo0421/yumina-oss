/** Where the sandbox iframe's document lives.
 *
 *  Cloudflare only has a cache rule for /assets/* (and /cdn/*), so the sandbox
 *  document at its authored path came back cf-cache-status: DYNAMIC: every
 *  custom-UI card load fetched it live from the single LA origin, and a deploy
 *  swap turned that fetch into a 503 the iframe could never recover from. The
 *  2026-08-25 fix meant to solve this but cached /assets/index-<hash>.html —
 *  a dead artifact Vite emitted from a <link rel="prefetch"> in the app shell,
 *  still holding `src="./main.tsx"` and referenced by nothing. The document the
 *  iframe actually loads stayed uncached for another four days.
 *
 *  So the build now emits the real, built document under a content-hashed name
 *  in /assets/ and the sentinel below is rewritten to point at it. See
 *  `vite-plugins/sandbox-doc-asset.ts`; the plugin fails the build if it cannot
 *  find the document or the sentinel, because a silently wrong URL here breaks
 *  every custom-UI card at once.
 */

/** Replaced at build time with `/assets/sandbox-doc-<hash>.html`, which is
 *  exactly as long, so the swap never shifts sourcemap offsets. */
const SANDBOX_DOC_BUILD_URL = "__YUMINA_SANDBOX_DOC_URL_SENTINEL";

/** The authored path. Never content-hashed, so it cannot 404 — which makes it
 *  both the dev-server URL and the retry target when the hashed copy is gone
 *  (a tab that sat open across a deploy that changed the document). */
export const SANDBOX_DOC_FALLBACK_URL = "/sandbox/index.html";

declare global {
  interface Window {
    /** Injected into index.html by vite-plugins/sandbox-doc-asset.ts. */
    __YUMINA_SANDBOX_DOC_URL?: string;
  }
}

/** Preferred over the sentinel swap below: this chunk's NAME is identical
 *  across builds (the equal-length swap happens after Vite hashed it), so
 *  immutable-cached copies of it go stale and point at a document the server
 *  no longer has — the 2026-08-31 every-desktop boot outage. index.html is
 *  no-store everywhere, so a value read from it is always this deploy's. */
const injectedDocUrl =
  typeof window !== "undefined" ? window.__YUMINA_SANDBOX_DOC_URL : undefined;

export const SANDBOX_DOC_URL: string =
  (import.meta.env.VITE_SANDBOX_URL as string | undefined) ??
  injectedDocUrl ??
  (import.meta.env.DEV ? SANDBOX_DOC_FALLBACK_URL : SANDBOX_DOC_BUILD_URL);

/** Where a retry re-fetches from. Same-origin builds drop back to the authored
 *  path so a hash this bundle knows but the server no longer has still has
 *  somewhere to land. A dedicated sandbox origin retries itself instead:
 *  crossing origins mid-retry would fail the handshake's origin check. */
export const SANDBOX_DOC_RETRY_URL: string =
  (import.meta.env.VITE_SANDBOX_URL as string | undefined) ?? SANDBOX_DOC_FALLBACK_URL;
