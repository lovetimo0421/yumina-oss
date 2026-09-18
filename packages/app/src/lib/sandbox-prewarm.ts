/** Warm the browser cache with the sandbox iframe's bundle BEFORE the first
 *  iframe mount. On a cold cache, sandbox boot serializes behind ~1.2MB of JS +
 *  333K of CSS, which is the dominant cost for entering a heavy-asset world.
 *
 *  Approach: after the main app is idle, fetch the sandbox document, parse the
 *  script/link URLs it references (these are Vite-generated hash paths we
 *  can't hardcode), and fetch each one. Response bodies land in the browser
 *  HTTP cache under their exact URLs — the iframe's later load is a cache hit.
 *
 *  Why not just `<link rel="prefetch">` in the parent HTML? Browsers fetch the
 *  HTML itself when idle, but follow-through to sub-resources is inconsistent
 *  across Safari / Chrome / Firefox. This one-shot active prefetch guarantees
 *  the entire bundle graph is warmed. It also warms the document itself, which
 *  a prefetch tag could not: the URL is content-hashed at build time and so
 *  cannot be written into static HTML. */

import { SANDBOX_DOC_URL } from "./sandbox-doc-url";

let started = false;

const PARSE = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"']+)["']/g;

export function prewarmSandbox(sandboxEntryUrl: string = SANDBOX_DOC_URL): void {
  if (started) return;
  started = true;
  if (typeof window === "undefined") return;

  const schedule =
    (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 400));

  schedule(async () => {
    try {
      const res = await fetch(sandboxEntryUrl, { credentials: "omit", cache: "force-cache" });
      if (!res.ok) return;
      const html = await res.text();

      const urls = new Set<string>();
      urls.add(sandboxEntryUrl);
      let match: RegExpExecArray | null;
      PARSE.lastIndex = 0;
      while ((match = PARSE.exec(html))) {
        const raw = match[1];
        if (!raw) continue;
        if (raw.startsWith("data:") || raw.startsWith("http")) continue;
        const normalized = raw.startsWith("/") ? raw : `/sandbox/${raw.replace(/^\.\//, "")}`;
        urls.add(normalized);
      }

      // Fire parallel low-priority fetches. 6-connection HTTP/1.1 limit doesn't
      // apply to HTTP/2+, but even on HTTP/1.1 this is done during idle time so
      // it doesn't compete with the main app's critical requests.
      for (const url of urls) {
        fetch(url, { credentials: "omit", cache: "force-cache" }).catch(() => {});
      }

      // Also warm the parent-side TSX compiler chunk. WorldRenderer dynamic-imports
      // it after the iframe handshake; on a cold cache that's a serial chunk fetch
      // on the critical path (the one that used to cost ~956K of Sucrase, plus
      // lucide-react via tsx-component-builder). Pulling it during idle removes
      // that cost from the first chat entry.
      import("@/features/studio/lib/tsx-compiler").catch(() => {});
      import("@/features/studio/lib/tsx-bundler").catch(() => {});
    } catch {
      // Best-effort — if prewarm fails the sandbox still works, just slower.
    }
  }, { timeout: 2000 });
}
