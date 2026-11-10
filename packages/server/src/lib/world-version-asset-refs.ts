// What a saved version could be holding on to, read once when the version is
// written. Asset deletion asks these columns instead of turning every version's
// full content into text — by 2026-10 that was 2 GB per delete and every delete
// timed out.
//
// The lists are a superset on purpose: every place an asset id or storage path
// appears inside the content is covered, so "not listed" proves "not retained".

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Overlapping windows are read out of each run, so an id glued to other
// hex-and-dash text is still found.
const UUID_RUN = /[0-9a-f-]{36,}/gi;
// Characters no storage path contains. A path inside a string therefore sits
// whole inside one of the pieces between them.
const PATH_DELIMITERS = /[\s"'\\<>(){}[\],;|`]+/;
const PATH_ROOTS = ["users/", "worlds/"];

export interface VersionAssetRefs {
  assetIds: string[];
  assetPaths: string[];
}

export function versionAssetRefs(...docs: unknown[]): VersionAssetRefs {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const readString = (s: string) => {
    for (const [run] of s.matchAll(UUID_RUN)) {
      for (let i = 0; i + 36 <= run.length; i++) {
        const window = run.slice(i, i + 36);
        if (UUID.test(window)) ids.add(window);
      }
    }
    if (PATH_ROOTS.some((root) => s.includes(root))) {
      for (const piece of s.split(PATH_DELIMITERS)) {
        if (PATH_ROOTS.some((root) => piece.includes(root))) paths.add(piece);
      }
    }
  };
  const stack: unknown[] = [...docs];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") readString(value);
    else if (Array.isArray(value)) stack.push(...value);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        readString(key);
        stack.push(child);
      }
    }
  }
  return { assetIds: [...ids].sort(), assetPaths: [...paths].sort() };
}

/** Whether the extracted lists can answer for this asset. Anything shaped
 *  differently falls back to reading the full content. */
export function assetRefsCover(id: string, url: string): boolean {
  return UUID.test(id) && PATH_ROOTS.some((root) => url.startsWith(root)) && !PATH_DELIMITERS.test(url);
}
