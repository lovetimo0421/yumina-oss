/** Scans a world definition + session messages for `@asset:<id>` references and
 *  partitions them into a priority set (needed for first paint) and a deferred
 *  set (needed later during play). The client uses this to emit
 *  `<link rel="preload">` tags on the parent document BEFORE the sandbox iframe
 *  boots — by the time the iframe mounts and its MutationObserver wakes up,
 *  priority assets are already cached. Critical for heavy-asset worlds (many
 *  images / long audio tracks / large sprite sets).
 *
 *  Tuning rationale:
 *  - Cap priority at MAX_PRIORITY (30) — browsers open ~6 concurrent connections
 *    per origin, so more preload hints past that point serialize anyway and just
 *    compete with the critical JS/CSS for early bandwidth.
 *  - First 10 messages only (most sessions render those initially; the rest load
 *    lazily as the user scrolls). Deferred tier handles the rest.
 */

import type { WorldDefinition } from "@yumina/engine";

/** Asset IDs are UUIDv4 or base64url of an S3 key. Tight enough to avoid matching
 *  accidental text like "@asset:TODO" but loose enough to handle both formats. */
const ASSET_REF_PATTERN = /@asset:([A-Za-z0-9_-]{8,})/g;

const MAX_PRIORITY = 30;
const MAX_DEFERRED = 200;
const MESSAGE_SCAN_DEPTH = 10;
const VISIBLE_COMPONENT_PRIORITY = 3;

export interface AssetManifest {
  /** Load these immediately via <link rel="preload"> — used by first paint. */
  priority: string[];
  /** Load these via <link rel="prefetch"> — used later in the session. */
  deferred: string[];
}

export function extractAssetRefs(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = [...text.matchAll(ASSET_REF_PATTERN)];
  return matches.map((m) => m[1]!).filter(Boolean);
}

interface ScannableMessage {
  content?: string | null;
}

export function scanAssets(
  world: WorldDefinition | null | undefined,
  messages: ScannableMessage[] = [],
): AssetManifest {
  const priority = new Set<string>();
  const deferred = new Set<string>();

  const addTo = (set: Set<string>, ids: string[]) => {
    for (const id of ids) {
      if (priority.has(id) || deferred.has(id)) continue;
      if (set === priority && priority.size >= MAX_PRIORITY) {
        deferred.add(id);
      } else if (set === deferred && deferred.size >= MAX_DEFERRED) {
        return;
      } else {
        set.add(id);
      }
    }
  };

  if (!world) return { priority: [], deferred: [] };

  // Priority tier 1: root component entry file (v2 Card UI runtime) — always on
  // screen as soon as the sandbox mounts
  if (world.rootComponent?.entryFile && world.rootComponent.files) {
    const entryCode = world.rootComponent.files[world.rootComponent.entryFile];
    addTo(priority, extractAssetRefs(entryCode));
  }

  // Priority tier 2: first session message (or greeting if no messages yet)
  if (messages.length > 0) {
    addTo(priority, extractAssetRefs(messages[0]?.content));
  } else {
    const greeting = (world.entries ?? []).find((e) => e.role === "greeting" && e.enabled);
    if (greeting) addTo(priority, extractAssetRefs(greeting.content));
  }

  // Priority tier 3: first few visible v1 customUI components (rendered on mount)
  const visibleUI = (world.customUI ?? []).filter((c) => c.visible !== false);
  for (const comp of visibleUI.slice(0, VISIBLE_COMPONENT_PRIORITY)) {
    addTo(priority, extractAssetRefs(comp.tsxCode));
  }

  // Deferred tier: remaining visible components, all entries, non-entry root files,
  // audio tracks, and messages 2-MESSAGE_SCAN_DEPTH
  for (const comp of visibleUI.slice(VISIBLE_COMPONENT_PRIORITY)) {
    addTo(deferred, extractAssetRefs(comp.tsxCode));
  }
  for (const entry of world.entries ?? []) {
    addTo(deferred, extractAssetRefs(entry.content));
  }
  if (world.rootComponent?.files) {
    for (const [filename, code] of Object.entries(world.rootComponent.files)) {
      if (filename === world.rootComponent.entryFile) continue;
      addTo(deferred, extractAssetRefs(code));
    }
  }
  for (const track of world.audioTracks ?? []) {
    if (typeof track.url === "string" && track.url.startsWith("@asset:")) {
      const id = track.url.slice("@asset:".length);
      if (id) addTo(deferred, [id]);
    }
  }
  for (let i = 1; i < Math.min(messages.length, MESSAGE_SCAN_DEPTH); i++) {
    addTo(deferred, extractAssetRefs(messages[i]?.content));
  }

  return {
    priority: [...priority],
    deferred: [...deferred],
  };
}
