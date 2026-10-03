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
 *  across Safari / Chrome / Firefox. Warm the document's directly referenced
 *  resources without evaluating editor/compiler modules in the parent page.
 *  This is best-effort; the iframe still loads normally on a cache miss. */

import { SANDBOX_DOC_URL } from "./sandbox-doc-url";
import { warmSandboxResources } from "./sandbox-resource-prewarm";

let started = false;

export function prewarmSandbox(sandboxEntryUrl: string = SANDBOX_DOC_URL): void {
  if (started) return;
  started = true;
  if (typeof window === "undefined") return;

  const schedule =
    (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 400));

  schedule(async () => {
    try {
      await warmSandboxResources(sandboxEntryUrl);
    } catch {
      // Best-effort — if prewarm fails the sandbox still works, just slower.
    }
  }, { timeout: 2000 });
}
