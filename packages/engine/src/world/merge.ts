import type { WorldDefinition } from "../types/index.js";

export interface WorldMergeConflict {
  /** Collection name ("entries", "variables", …, "rootComponent.files") or "field". */
  collection: string;
  /** Entity id, filename, or field name. */
  id: string;
  reason: "both-edited" | "edit-vs-delete";
}

export interface WorldMergeResult {
  merged: WorldDefinition;
  /** Non-empty when both sides touched the same entity/file/field. Caller should
   *  stash the alternative + surface a banner; NOTHING is dropped silently. */
  conflicts: WorldMergeConflict[];
}

/**
 * Order-insensitive structural equality for the plain-JSON values that make up a
 * WorldDefinition. Treats a key whose value is `undefined` as absent (JSON drops
 * it on the wire), so a field set to undefined locally equals an absent field on
 * the server — avoids spurious "changed" classifications.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== (b as unknown[]).length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], (b as unknown[])[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

type Row = Record<string, unknown>;

function idOf(r: Row | undefined): string | undefined {
  return r && typeof r.id === "string" ? r.id : undefined;
}

function indexById(arr: unknown): Map<string, Row> {
  const m = new Map<string, Row>();
  if (Array.isArray(arr)) {
    for (const r of arr as Row[]) {
      const id = idOf(r);
      if (id) m.set(id, r);
    }
  }
  return m;
}

/**
 * id-keyed 3-way merge of one collection.
 *
 * Conservative by construction — it NEVER drops a side silently:
 *  - changed on exactly one side  → take that side
 *  - changed on both, differently → keep LOCAL + record a conflict (caller stashes the other)
 *  - added on one side only        → keep it
 *  - deleted on one side, edited on the other → keep the EDIT + record a conflict
 *  - deleted on one side, untouched on the other → honor the delete
 */
function mergeById(
  collection: string,
  baseArr: unknown,
  localArr: unknown,
  serverArr: unknown,
  conflicts: WorldMergeConflict[],
): Row[] {
  const baseM = indexById(baseArr);
  const localM = indexById(localArr);
  const serverM = indexById(serverArr);

  // Preserve server order first (the agent's/server layout), then append rows
  // that exist only locally (the user's additions) so nothing reorders away.
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const r of (Array.isArray(serverArr) ? serverArr : []) as Row[]) {
    const id = idOf(r);
    if (id && !seen.has(id)) { seen.add(id); orderedIds.push(id); }
  }
  for (const r of (Array.isArray(localArr) ? localArr : []) as Row[]) {
    const id = idOf(r);
    if (id && !seen.has(id)) { seen.add(id); orderedIds.push(id); }
  }

  const out: Row[] = [];
  for (const id of orderedIds) {
    const inBase = baseM.has(id);
    const b = baseM.get(id);
    const l = localM.get(id);
    const s = serverM.get(id);

    if (l && s) {
      const localChanged = !inBase || !deepEqual(l, b);
      const serverChanged = !inBase || !deepEqual(s, b);
      if (localChanged && serverChanged && !deepEqual(l, s)) {
        conflicts.push({ collection, id, reason: "both-edited" });
        out.push(l); // keep the user's version; caller stashes server's
      } else if (localChanged) {
        out.push(l);
      } else {
        out.push(s);
      }
    } else if (l && !s) {
      if (!inBase) {
        out.push(l); // user added
      } else if (!deepEqual(l, b)) {
        conflicts.push({ collection, id, reason: "edit-vs-delete" });
        out.push(l); // server deleted but user edited → keep the edit
      }
      // else: server deleted, user untouched → honor delete
    } else if (!l && s) {
      if (!inBase) {
        out.push(s); // server/agent added
      } else if (!deepEqual(s, b)) {
        conflicts.push({ collection, id, reason: "edit-vs-delete" });
        out.push(s); // user deleted but server edited → keep the change
      }
      // else: user deleted, server untouched → honor delete
    }
  }
  return out;
}

interface RootComponentLike {
  entryFile?: string;
  files?: Record<string, string>;
  compiled?: unknown;
  [k: string]: unknown;
}

function mergeRootComponent(
  base: RootComponentLike | undefined,
  local: RootComponentLike | undefined,
  server: RootComponentLike | undefined,
  conflicts: WorldMergeConflict[],
): RootComponentLike | undefined {
  if (!local && !server) return server;
  if (!local) return server;
  if (!server) return local;

  const bFiles = base?.files ?? {};
  const lFiles = local.files ?? {};
  const sFiles = server.files ?? {};
  const filenames = new Set([...Object.keys(lFiles), ...Object.keys(sFiles)]);
  const mergedFiles: Record<string, string> = {};

  for (const fn of filenames) {
    const inB = Object.prototype.hasOwnProperty.call(bFiles, fn);
    const inL = Object.prototype.hasOwnProperty.call(lFiles, fn);
    const inS = Object.prototype.hasOwnProperty.call(sFiles, fn);
    const bv = bFiles[fn];
    const lv = lFiles[fn];
    const sv = sFiles[fn];
    if (inL && inS) {
      const lc = !inB || lv !== bv;
      const sc = !inB || sv !== bv;
      if (lc && sc && lv !== sv) {
        conflicts.push({ collection: "rootComponent.files", id: fn, reason: "both-edited" });
        mergedFiles[fn] = lv!;
      } else if (lc) {
        mergedFiles[fn] = lv!;
      } else {
        mergedFiles[fn] = sv!;
      }
    } else if (inL && !inS) {
      if (!inB) mergedFiles[fn] = lv!;
      else if (lv !== bv) { conflicts.push({ collection: "rootComponent.files", id: fn, reason: "edit-vs-delete" }); mergedFiles[fn] = lv!; }
    } else if (!inL && inS) {
      if (!inB) mergedFiles[fn] = sv!;
      else if (sv !== bv) { conflicts.push({ collection: "rootComponent.files", id: fn, reason: "edit-vs-delete" }); mergedFiles[fn] = sv!; }
    }
  }

  const entryFile = base && local.entryFile === base.entryFile ? server.entryFile : local.entryFile;
  // Drop the cached compile output — files changed, so it must be recompiled on
  // save (the editor recompiles rootComponent before persisting).
  return { ...server, ...local, entryFile, files: mergedFiles, compiled: undefined };
}

/** Collections merged by entity `id`. */
const ID_COLLECTIONS = [
  "entries",
  "variables",
  "rules",
  "reactions",
  "audioTracks",
  "entryFolders",
  "customUI",
] as const;

/**
 * Other top-level fields, merged with base-aware "local wins if the user changed
 * it, else take server". Coarse but safe: a field only the agent changed flows
 * through from server; a field the user changed is preserved.
 */
const FIELD_KEYS = [
  "name",
  "description",
  "author",
  "avatar",
  "coverCrop",
  "galleryCoverCrop",
  "characters",
  "components",
  "uiBlueprint",
  "bgmPlaylist",
  "conditionalBGM",
  "lorebookEntries",
  "customTags",
  "editorMode",
  "settings",
  "version",
  "id",
] as const;

/**
 * 3-way merge of two WorldDefinitions that diverged from a common ancestor
 * (`base`): `local` = the editor's unsaved draft, `server` = the current
 * persisted state (e.g. the Studio agent's writes). Combines both instead of
 * one overwriting the other. Pure; never mutates its inputs.
 *
 * NOTE: the result still needs `normalizeFolders()` + position normalization
 * applied by the caller (folder lifecycle is a cross-entity reference the
 * id-keyed pass doesn't reconcile on its own).
 */
export function mergeWorldDefinition(
  base: WorldDefinition | null | undefined,
  local: WorldDefinition,
  server: WorldDefinition,
): WorldMergeResult {
  const conflicts: WorldMergeConflict[] = [];
  // No ancestor → we can't tell who changed what; degrade to a safe union that
  // still keeps the user's local view as the base and layers server adds in.
  const b = (base ?? local) as WorldDefinition;

  const merged = { ...server } as Record<string, unknown>;

  for (const key of ID_COLLECTIONS) {
    const bb = (b as unknown as Record<string, unknown>)[key];
    const ll = (local as unknown as Record<string, unknown>)[key];
    const ss = (server as unknown as Record<string, unknown>)[key];
    if (ll === undefined && ss === undefined && bb === undefined) {
      merged[key] = ss;
      continue;
    }
    merged[key] = mergeById(key, bb, ll, ss, conflicts);
  }

  merged.rootComponent = mergeRootComponent(
    (b as { rootComponent?: RootComponentLike }).rootComponent,
    (local as { rootComponent?: RootComponentLike }).rootComponent,
    (server as { rootComponent?: RootComponentLike }).rootComponent,
    conflicts,
  );

  for (const key of FIELD_KEYS) {
    const lv = (local as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    const sv = (server as unknown as Record<string, unknown>)[key];
    merged[key] = deepEqual(lv, bv) ? sv : lv;
  }

  return { merged: merged as unknown as WorldDefinition, conflicts };
}
