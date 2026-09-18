/** Drives `<link rel="preload">` / `<link rel="prefetch">` tags in the parent
 *  document head so the browser starts downloading session assets BEFORE the
 *  sandbox iframe mounts. By the time the iframe's MutationObserver picks up
 *  `@asset:` references and calls img.src = …, the resource is (ideally)
 *  already in the HTTP cache. Critical for heavy-asset worlds where an
 *  unoptimized boot would spin through dozens of sequential CDN round-trips.
 *
 *  The parent owns these tags (not the sandbox iframe) for two reasons:
 *  1. The parent head is long-lived across route navigations — preload links
 *     added here remain effective even if the iframe re-mounts.
 *  2. Browsers fetch preload resources immediately on parse — the earlier
 *     the link tag exists, the more overlap with JS/CSS fetches we get. */

import { getAssetCdnUrl } from "./asset-url";

const PRELOAD_MARKER = "data-yumina-asset-preload";

export interface AssetManifest {
  priority: string[];
  deferred: string[];
}

/** Install preload+prefetch tags for the given manifest. Clears any tags from
 *  a previous manifest first so we don't leak across session switches.
 *  Idempotent: re-running with the same manifest is a no-op. */
export function primeAssetManifest(manifest: AssetManifest | null | undefined): void {
  if (typeof document === "undefined") return;
  clearAssetManifest();
  if (!manifest) return;

  const head = document.head;
  const frag = document.createDocumentFragment();

  // Priority: <link rel="preload"> — high-priority, parallel with other critical JS/CSS.
  // `as="image"` is correct for most heavy assets; audio preload would use
  // `as="audio"` but audio is almost always user-triggered so we don't prime it
  // in the priority tier. If a world embeds audio into its custom UI to autoplay,
  // creators can @asset it inline which is caught by the image preload path (the
  // browser still caches the response even with a mismatched `as`).
  for (const id of manifest.priority) {
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = getAssetCdnUrl(id);
    link.setAttribute(PRELOAD_MARKER, "priority");
    // crossorigin="" makes the preload reusable when the iframe fetches it too,
    // otherwise Safari treats preload + actual fetch as distinct requests.
    link.crossOrigin = "";
    frag.appendChild(link);
  }

  // Deferred: <link rel="prefetch"> — low priority, fills idle bandwidth.
  for (const id of manifest.deferred) {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "image";
    link.href = getAssetCdnUrl(id);
    link.setAttribute(PRELOAD_MARKER, "deferred");
    link.crossOrigin = "";
    frag.appendChild(link);
  }

  head.appendChild(frag);
}

export function clearAssetManifest(): void {
  if (typeof document === "undefined") return;
  const existing = document.head.querySelectorAll(`link[${PRELOAD_MARKER}]`);
  for (const el of existing) el.remove();
}
