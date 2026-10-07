import { createHash } from "node:crypto";

// Only creator-owned content belongs to a release. Identity, counters, moderation
// decisions and player state must never travel backwards with a version.
export const VERSION_METADATA_FIELDS = [
  "name", "description", "thumbnailUrl", "galleryImages", "tags", "announcement",
  "approxTime", "ageRating", "targetAudience", "blurCover",
] as const;

export type VersionMetadata = Partial<{
  name: string;
  description: string;
  thumbnailUrl: string | null;
  galleryImages: string[] | null;
  tags: string[];
  announcement: string | null;
  approxTime: string | null;
  ageRating: string;
  targetAudience: string;
  blurCover: boolean | null;
}>;

export function versionMetadata(row: Record<string, unknown>): VersionMetadata {
  return Object.fromEntries(VERSION_METADATA_FIELDS
    .filter(key => row[key] !== undefined)
    .map(key => [key, row[key]])) as VersionMetadata;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, v]) => v !== undefined).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Hash content, ignoring only regenerable custom-UI compilation metadata. */
export function worldVersionHash(schema: Record<string, unknown>, metadata: VersionMetadata): string {
  const content = { ...schema };
  if (content.rootComponent && typeof content.rootComponent === "object") {
    const { compiled: _compiled, updatedAt: _updatedAt, ...root } = content.rootComponent as Record<string, unknown>;
    content.rootComponent = root;
  }
  return createHash("sha256").update(JSON.stringify(canonical({ schema: content, metadata }))).digest("hex");
}
