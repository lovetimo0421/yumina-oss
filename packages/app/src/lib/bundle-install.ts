import { COMPOSED_MARKER, USER_ROOT_PATH, type BundleSettingField, type YuminaBundle } from "@yumina/engine";

/** How a resource pack goes into a card (see mergeBundleIntoWorld). */
export interface MergeBundleOptions {
  /** Install into this situation: the pack's entries, folders and behaviours
   *  that have no situation of their own belong to it. */
  worldbookId?: string;
  /** The pack's interface: composed beside the card's (default), replacing
   *  the card's screen, or not taken at all. */
  interface?: "compose" | "replace" | "skip";
  /** Pack asset id → this card's copy, from the server's asset import. */
  assetMap?: Record<string, string>;
  /** A same-name variable already in the card, per pack variable id: use the
   *  card's ("merge"), or add the pack's beside it under `name` ("keep").
   *  Absent: the pack's is added as "name (1)". A "merge" with `targetId`
   *  points the pack's variable at that one of the card's, whatever its name. */
  variableConflicts?: Record<string, VariableConflictChoice>;
  /** Updating an install in place: keep its id (and colour) so its frame,
   *  layout and settings stay where they were. */
  installId?: string;
  colorKey?: string;
}

export type VariableConflictChoice = { mode: "merge"; targetId?: string } | { mode: "keep"; name?: string };

const ASSET_REF_GLOBAL = /@asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const bareAssetId = (id: string) => id.replace(/^@asset:/, "");

/** Every `@asset:<pack id>` the map knows, rewritten to this card's copy,
 *  anywhere in the pack (entries, variable defaults, interface files). */
export function remapBundleAssets(bundle: YuminaBundle, map: Record<string, string> | undefined): YuminaBundle {
  if (!map || Object.keys(map).length === 0) return bundle;
  const lookup = new Map(Object.entries(map).map(([from, to]) => [bareAssetId(from).toLowerCase(), bareAssetId(to)]));
  const text = JSON.stringify(bundle).replace(ASSET_REF_GLOBAL, (whole, id: string) => {
    const to = lookup.get(id.toLowerCase());
    return to ? `@asset:${to}` : whole;
  });
  return JSON.parse(text) as YuminaBundle;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pack's interface reads its variables by id. When the card keeps a
 *  variable under another id (merged into the card's own, or added beside a
 *  same-name one) the pack's own files are pointed at the id it now has:
 *  `variables.<id>`, and the id as a whole string literal. */
export function remapVariableIdsInCode(code: string, map: ReadonlyMap<string, string>): string {
  let out = code;
  for (const [from, to] of map) {
    if (from === to || from.length < 2) continue;
    const id = escapeRe(from);
    out = out
      .replace(new RegExp(`(["'\`])${id}\\1`, "g"), (_m, q: string) => `${q}${to}${q}`)
      .replace(new RegExp(`\\bvariables(\\?)?\\.${id}(?![\\w$])`, "g"), (_m, optional?: string) =>
        /^[A-Za-z_$][\w$]*$/.test(to)
          ? `variables${optional ? "?" : ""}.${to}`
          : `variables${optional ? "?." : ""}[${JSON.stringify(to)}]`);
  }
  return out;
}

/** The pack's settings, pointed at the variables as installed in this card. */
export function remapSettings(
  settings: readonly BundleSettingField[] | undefined,
  remapVar: (id: string) => string,
): BundleSettingField[] | undefined {
  if (!settings?.length) return undefined;
  return settings.map((field) => ({ ...field, variableId: remapVar(field.variableId) }));
}

// ── Settings values ─────────────────────────────────────────────────

const pathParts = (path: string | undefined) => (path ? path.split(".").filter(Boolean) : []);

/** The value a settings field shows: the variable's defaultValue, at `path`. */
export function readSettingValue(defaultValue: unknown, path?: string): unknown {
  let cur: unknown = defaultValue;
  for (const key of pathParts(path)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** `defaultValue` with `value` written at `path`, copied rather than changed. */
export function writeSettingValue(defaultValue: unknown, path: string | undefined, value: unknown): unknown {
  const parts = pathParts(path);
  if (parts.length === 0) return value;
  const base = defaultValue !== null && typeof defaultValue === "object" && !Array.isArray(defaultValue)
    ? (defaultValue as Record<string, unknown>)
    : {};
  const [head, ...rest] = parts;
  return { ...base, [head!]: writeSettingValue(base[head!], rest.join("."), value) };
}

/** What uploading `fileName` (now asset `assetId`) to an asset field writes:
 *  a list of (path, value) pairs, applied in order. */
export function assetFieldWrites(
  field: BundleSettingField,
  fileName: string,
  assetId: string,
): Array<{ path: string | undefined; value: unknown }> {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";
  const rule = (field.extensionRules ?? []).find((r) => r.ext.replace(/^\./, "").toLowerCase() === ext);
  const ref = `@asset:${assetId}`;
  if (!rule) return [{ path: field.path, value: ref }];
  return [{ path: rule.path ?? field.path, value: ref }, ...(rule.also ?? []).map((a) => ({ path: a.path, value: a.value }))];
}

// ── Export ──────────────────────────────────────────────────────────

/**
 * The part of a card's interface that is the author's own, for exporting as
 * a pack. A card that has packs installed has a generated composer as its
 * index and other packs under `_bundles/<slug>/`: exported whole, those
 * nested as `_bundles/_bundles/...` once the new pack was installed somewhere
 * else. The author's root (`__user-root.tsx`) is the pack's entry, with their
 * other files; other packs' folders and the composer stay behind.
 */
export function authorOwnInterface<T extends { entryFile: string; files: Record<string, string> }>(
  root: T,
): { root: T; leftOut: string[] } {
  const index = root.files["index.tsx"];
  const composed = typeof index === "string" && index.startsWith(COMPOSED_MARKER);
  const packFolders = new Set<string>();
  for (const path of Object.keys(root.files)) {
    const m = /^_bundles\/([^/]+)\//.exec(path);
    if (m) packFolders.add(m[1]!);
  }
  if (!composed && packFolders.size === 0) return { root, leftOut: [] };
  const files: Record<string, string> = {};
  for (const [path, code] of Object.entries(root.files)) {
    if (path.startsWith("_bundles/")) continue;
    if (composed && path === "index.tsx") continue;
    files[path] = code;
  }
  const entryFile = composed && files[USER_ROOT_PATH] !== undefined ? USER_ROOT_PATH : root.entryFile;
  return { root: { ...root, entryFile, files }, leftOut: [...packFolders].sort() };
}
