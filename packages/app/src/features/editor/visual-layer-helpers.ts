/** Helpers shared between the simple editor's "Visual Layer" card and any
 *  other tools that classify / rewrite rootComponent.files. All of this could
 *  live in editor.ts but extracting keeps the store skinny. */

import {
  BUNDLE_NS_RE,
  COMPOSED_MARKER,
  USER_ROOT_PATH,
  generateComposedIndex,
} from "@/stores/editor";

export { BUNDLE_NS_RE, COMPOSED_MARKER, USER_ROOT_PATH, generateComposedIndex };

/** Default body for a fresh __user-root.tsx — does nothing extra, just hands
 *  off to Chat. Used when we need to create the file so the composer's
 *  `import UserRoot` resolves. */
export const DEFAULT_USER_ROOT_TSX =
  `export default function UserRoot() {\n  return <Chat />;\n}\n`;

/** Default index when there's no composer and no user-root yet. */
export const DEFAULT_INDEX_TSX =
  `export default function MyWorld() {\n  return <Chat />;\n}\n`;

export interface FileClassification {
  /** "__user-root.tsx" if present, else null */
  userRoot: string | null;
  /** "index.tsx" if it's the auto-generated composer, else null */
  composerIndex: string | null;
  /** Sorted bundle folder slugs (no path prefix) */
  bundleFolders: string[];
  /** Map slug -> files belonging to that bundle (sorted, index.tsx first) */
  bundleFiles: Map<string, string[]>;
  /** Top-level files that aren't __user-root.tsx, aren't composer index.tsx,
   *  and aren't inside _bundles/. The "manually-created" files. */
  otherFiles: string[];
}

export function classifyFiles(files: Record<string, string>): FileClassification {
  const userRoot = USER_ROOT_PATH in files ? USER_ROOT_PATH : null;
  const indexContent = files["index.tsx"];
  const composerIndex =
    indexContent && indexContent.startsWith(COMPOSED_MARKER) ? "index.tsx" : null;

  const bundleFiles = new Map<string, string[]>();
  for (const path of Object.keys(files)) {
    const m = path.match(/^_bundles\/([^/]+)\/(.+)$/);
    if (m) {
      const slug = m[1]!;
      if (!bundleFiles.has(slug)) bundleFiles.set(slug, []);
      bundleFiles.get(slug)!.push(path);
    }
  }
  // Sort bundle files: index.tsx first, then config.tsx, then alphabetical.
  for (const arr of bundleFiles.values()) {
    arr.sort((a, b) => {
      if (a.endsWith("/index.tsx")) return -1;
      if (b.endsWith("/index.tsx")) return 1;
      if (a.endsWith("/config.tsx")) return -1;
      if (b.endsWith("/config.tsx")) return 1;
      return a.localeCompare(b);
    });
  }
  const bundleFolders = [...bundleFiles.keys()].sort();

  const otherFiles = Object.keys(files)
    .filter(
      (p) =>
        p !== USER_ROOT_PATH &&
        p !== composerIndex &&
        !p.startsWith("_bundles/")
    )
    .sort();

  return { userRoot, composerIndex, bundleFolders, bundleFiles, otherFiles };
}

/** Recompute `index.tsx` based on the current presence of __user-root.tsx
 *  and any bundles. Three cases:
 *    - No __user-root.tsx and no bundles → restore DEFAULT_INDEX_TSX.
 *    - Otherwise → emit composer index.tsx; auto-create an empty
 *      __user-root.tsx if it's missing (so the composer's import resolves). */
export function recomposeIndex(
  files: Record<string, string>
): Record<string, string> {
  const next = { ...files };
  const bundleFolders = new Set<string>();
  for (const path of Object.keys(next)) {
    const m = path.match(BUNDLE_NS_RE);
    if (m) bundleFolders.add(m[1]!);
  }
  const hasUserRoot = USER_ROOT_PATH in next;

  if (!hasUserRoot && bundleFolders.size === 0) {
    // Strip composer leftovers; restore default.
    next["index.tsx"] = DEFAULT_INDEX_TSX;
    return next;
  }

  if (!hasUserRoot) {
    // Bundles exist but no user-root → create a minimal one so the import
    // statement in the composer resolves.
    next[USER_ROOT_PATH] = DEFAULT_USER_ROOT_TSX;
  }

  next["index.tsx"] = generateComposedIndex([...bundleFolders].sort());
  return next;
}

/** Write content to __user-root.tsx and ensure index.tsx is the composer.
 *  Used when the simple editor creates / edits the user's main UI. */
export function setUserRoot(
  files: Record<string, string>,
  content: string
): Record<string, string> {
  const next = { ...files };
  if (content) {
    next[USER_ROOT_PATH] = content;
  } else {
    delete next[USER_ROOT_PATH];
  }
  return recomposeIndex(next);
}

/** Remove every file under `_bundles/<slug>/` and recompose index.tsx. */
export function uninstallBundle(
  files: Record<string, string>,
  slug: string
): Record<string, string> {
  const next: Record<string, string> = {};
  const prefix = `_bundles/${slug}/`;
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix)) next[path] = content;
  }
  return recomposeIndex(next);
}

/** Migrate the v1 `_simple-css.tsx` shim into `__user-root.tsx`. Run lazily
 *  the first time the user touches the visual layer; idempotent. */
const LEGACY_CSS_FILE = "_simple-css.tsx";
const LEGACY_CSS_MARKER = "@yumina:simple-css-mounted";

export function migrateLegacySimpleCss(
  files: Record<string, string>
): Record<string, string> {
  const legacy = files[LEGACY_CSS_FILE];
  if (!legacy) return files;
  // Extract the CSS string out of the legacy file's dangerouslySetInnerHTML.
  const match = legacy.match(/__html:\s*("(?:[^"\\]|\\.)*")/);
  let css = "";
  if (match) {
    try {
      css = JSON.parse(match[1]!) as string;
    } catch {
      /* fall through */
    }
  }

  const next: Record<string, string> = { ...files };
  delete next[LEGACY_CSS_FILE];

  // Restore index.tsx to default if the legacy mount-marker is the only thing
  // there; recomposeIndex will then re-emit it if needed.
  const indexContent = next["index.tsx"] ?? "";
  if (indexContent.includes(LEGACY_CSS_MARKER)) {
    next["index.tsx"] = DEFAULT_INDEX_TSX;
  }

  // Stash the CSS into __user-root.tsx — but only if user-root doesn't
  // already exist (don't clobber).
  if (!(USER_ROOT_PATH in next) && css.trim()) {
    next[USER_ROOT_PATH] = wrapCssAsUserRoot(css);
  }

  return recomposeIndex(next);
}

/** Convenience wrapper to package raw CSS into a __user-root.tsx body. */
export function wrapCssAsUserRoot(css: string): string {
  const safe = JSON.stringify(css);
  return (
    `export default function UserRoot() {\n` +
    `  return (\n` +
    `    <>\n` +
    `      <style dangerouslySetInnerHTML={{ __html: ${safe} }} />\n` +
    `      <Chat />\n` +
    `    </>\n` +
    `  );\n` +
    `}\n`
  );
}

/** Display-name lookup for known marketplace bundles. Falls back to a
 *  prettified slug for unknown ones. */
export function bundleDisplayName(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
