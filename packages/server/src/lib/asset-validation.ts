/**
 * Shared inline-asset detection.
 *
 * Every write path into world.schema uses these helpers to reject inline base64
 * data URIs (images/audio/video/fonts) so the world JSON stays clean — the
 * canonical form is @asset:{id} (resolved via our S3/CloudFront CDN) or an
 * external https:// URL. Inline data URIs defeat CDN caching, bloat the JSON
 * for every LLM read, and ship on every page load.
 *
 * Used by:
 *  - packages/server/src/lib/studio-tools/tool-executor.ts (agent write tools)
 *  - packages/server/src/routes/worlds.ts (editor PATCH /api/worlds/:id)
 *
 * Threshold of 200 chars lets tiny SVG placeholders through — anything larger
 * is an actual embedded binary that should be an uploaded asset.
 */

export const INLINE_DATA_URI_RE = /data:(?:image|audio|video|font)\/[^;,]+;base64,[A-Za-z0-9+/=]{200,}/g;

export interface InlineAssetMatch {
  /** Where in the schema it was found (for user-facing error messages) */
  location: string;
  /** How many data URIs in this one text blob */
  count: number;
  /** Total byte length of the base64 (approximate size cost) */
  totalBytes: number;
}

/** Quick boolean: does this string contain at least one inline base64 data URI over threshold? */
export function hasInlineDataUri(text: string): boolean {
  return INLINE_DATA_URI_RE.test(text);
}

/** Count + size inline data URIs in one string. Returns null if none found. */
export function scanTextForInlineDataUris(text: string): { count: number; totalBytes: number } | null {
  const matches = text.match(INLINE_DATA_URI_RE);
  if (!matches || matches.length === 0) return null;
  return { count: matches.length, totalBytes: matches.reduce((sum, m) => sum + m.length, 0) };
}

/** Human-readable error for a rejected write. Used by both agent tools and the editor route. */
export function formatInlineAssetRejection(contextLabel: string, match: { count: number; totalBytes: number }): string {
  const kb = Math.max(1, Math.round(match.totalBytes / 1024));
  const plural = match.count > 1 ? "s" : "";
  return `${contextLabel} rejected: contains ${match.count} inline base64 data URI${plural} totaling ~${kb}KB. Yumina uses @asset:{assetId} refs (resolved via CDN) or external https:// URLs for images and audio. Upload each embedded asset via the asset picker in Library, then reference it with @asset:{assetId}. For legacy components already containing data URIs, replace each one with an @asset:placeholder ref.`;
}

/** Convenience helper for the agent executor: scan + format in one step. Returns null if clean. */
export function assertNoInlineDataUris(text: string, contextLabel: string): string | null {
  const match = scanTextForInlineDataUris(text);
  if (!match) return null;
  return formatInlineAssetRejection(contextLabel, match);
}

/**
 * Scan a full world schema for every inline asset. Returns one InlineAssetMatch
 * per offending entity. Used by the editor PATCH route to reject schema saves
 * that contain bloat anywhere in the tree.
 */
export function scanWorldSchemaForInlineAssets(schema: unknown): InlineAssetMatch[] {
  const found: InlineAssetMatch[] = [];
  if (!schema || typeof schema !== "object") return found;
  const s = schema as Record<string, unknown>;

  // customUI[*].tsxCode
  const customUI = (s.customUI as Array<{ id?: string; tsxCode?: string }> | undefined) ?? [];
  for (const ui of customUI) {
    const match = scanTextForInlineDataUris(ui.tsxCode ?? "");
    if (match) found.push({ location: `customUI "${ui.id ?? "?"}" tsxCode`, ...match });
  }

  // rootComponent.files[*]
  const rc = s.rootComponent as { files?: Record<string, string> } | undefined;
  if (rc?.files) {
    for (const [filename, code] of Object.entries(rc.files)) {
      const match = scanTextForInlineDataUris(code);
      if (match) found.push({ location: `rootComponent file "${filename}"`, ...match });
    }
  }

  // entries[*].content (markdown images)
  const entries = (s.entries as Array<{ id?: string; content?: string }> | undefined) ?? [];
  for (const e of entries) {
    const match = scanTextForInlineDataUris(e.content ?? "");
    if (match) found.push({ location: `entry "${e.id ?? "?"}" content`, ...match });
  }

  // audioTracks[*].url (starts with data:)
  const audio = (s.audioTracks as Array<{ id?: string; url?: string }> | undefined) ?? [];
  for (const a of audio) {
    if (typeof a.url === "string" && a.url.startsWith("data:")) {
      found.push({ location: `audioTracks "${a.id ?? "?"}" url`, count: 1, totalBytes: a.url.length });
    }
  }

  return found;
}
