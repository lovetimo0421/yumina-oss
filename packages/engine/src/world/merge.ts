import type { WorldDefinition } from "../types/index.js";

export interface WorldMergeConflict {
  /** Collection name ("entries", "variables", …, "rootComponent.files") or "field". */
  collection: string;
  /** Entity id, filename, or field name. */
  id: string;
  reason: "both-edited" | "edit-vs-delete" | "both-added";
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

/**
 * The rows that moved: everything outside the longest run that kept its
 * relative order. Sending those as moves (rather than the whole order)
 * means a reorder only touches what was dragged.
 */
export function movedIds(base: Row[], next: Row[]): Set<string> {
  const at = new Map(base.map((r, i) => [r.id as string, i]));
  const kept = next.map((r) => r.id as string).filter((id) => at.has(id));
  const seq = kept.map((id) => at.get(id)!);
  // Longest increasing subsequence, O(n log n), with back links.
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const stay = new Set<string>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) stay.add(kept[i]!);
  return new Set(kept.filter((id) => !stay.has(id)));
}

/**
 * The merged order of an id-keyed list: the server's order, with the rows
 * this side dragged (relative to the base) put back behind the neighbour
 * they were dragged to — so two people reordering different rows both keep
 * their move — and rows only this side has placed after their neighbour.
 */
function mergedOrder(baseArr: unknown, localArr: unknown, serverArr: unknown): string[] {
  const ids = (arr: unknown) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of (Array.isArray(arr) ? arr : []) as Row[]) {
      const id = idOf(r);
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  };
  const base = ids(baseArr);
  const local = ids(localArr);
  const order = ids(serverArr);
  const moved = movedIds(base.map((id) => ({ id })), local.map((id) => ({ id })));
  for (let i = 0; i < local.length; i++) {
    const id = local[i]!;
    // Dragged here, or a row the server list doesn't have (added here, or
    // kept here after the server deleted it).
    if (!moved.has(id) && order.includes(id)) continue;
    const at = order.indexOf(id);
    if (at >= 0) order.splice(at, 1);
    // Behind the nearest earlier local row the merged list has.
    let place = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(local[j]!);
      if (k >= 0) { place = k + 1; break; }
    }
    order.splice(place, 0, id);
  }
  return order;
}

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
 *  - changed on both              → merge field by field; a field changed both
 *                                   ways keeps LOCAL + records a conflict (caller stashes the other)
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
  renameClashes = false,
): Row[] {
  const baseM = indexById(baseArr);
  const localM = indexById(localArr);
  const serverM = indexById(serverArr);

  // The server's order with this side's drags and additions placed where
  // they were made (a merge used to put every local reorder back).
  const orderedIds = mergedOrder(baseArr, localArr, serverArr);
  const taken = new Set([...serverM.keys(), ...localM.keys()]);

  const out: Row[] = [];
  for (const id of orderedIds) {
    const inBase = baseM.has(id);
    const b = baseM.get(id);
    const l = localM.get(id);
    const s = serverM.get(id);

    if (l && s) {
      if (!inBase) {
        if (deepEqual(l, s)) { out.push(l); continue; }
        if (renameClashes) {
          // Two people named a new row alike (a variable): both are kept,
          // ours under the next free id.
          let n = 2;
          while (taken.has(`${id}_${n}`)) n++;
          taken.add(`${id}_${n}`);
          conflicts.push({ collection, id, reason: "both-added" });
          out.push(s, { ...l, id: `${id}_${n}` });
          continue;
        }
        // Both sides added the same id: keep ours, report that theirs differs.
        conflicts.push({ collection, id, reason: "both-edited" });
        out.push(l);
        continue;
      }
      // Field by field: two people editing different fields of one entry
      // (a name here, the text there; a background portrait landing while the
      // creator types) both keep their change. Only the same field changed
      // two different ways is a conflict, and there the local edit wins.
      const row: Row = {};
      const clashes: WorldMergeConflict[] = [];
      for (const field of new Set([...Object.keys(b!), ...Object.keys(l), ...Object.keys(s)])) {
        const value = mergeValue(field, b![field], l[field], s[field], clashes);
        if (value !== undefined) row[field] = value;
      }
      if (clashes.length > 0) conflicts.push({ collection, id, reason: "both-edited" });
      out.push(row);
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
  assetLoading?: "automatic" | "on-demand";
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
  const localLoadingChanged = local.assetLoading !== base?.assetLoading;
  const serverLoadingChanged = server.assetLoading !== base?.assetLoading;
  if (localLoadingChanged && serverLoadingChanged && local.assetLoading !== server.assetLoading) {
    conflicts.push({ collection: "rootComponent", id: "assetLoading", reason: "both-edited" });
  }
  const assetLoading = localLoadingChanged ? local.assetLoading : server.assetLoading;
  // Drop the cached compile output — files changed, so it must be recompiled on
  // save (the editor recompiles rootComponent before persisting).
  return { ...server, ...local, entryFile, assetLoading, files: mergedFiles, compiled: undefined };
}

/**
 * Three-way merge of one value. Whichever side changed it wins; changed both
 * ways, plain objects go key by key and id-keyed lists row by row — two
 * people moving different nodes on the canvas, adding sticky notes, or
 * editing different pages of the interface both keep theirs. A value changed
 * both ways below that keeps LOCAL and is reported at its dotted path.
 */
function mergeValue(path: string, bv: unknown, lv: unknown, sv: unknown, conflicts: WorldMergeConflict[]): unknown {
  if (deepEqual(lv, bv)) return sv;
  if (deepEqual(sv, bv) || deepEqual(lv, sv)) return lv;
  const isObject = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
  // Both started the same thing from nothing: merge them as additions.
  if (bv === undefined && isObject(lv) && isObject(sv)) bv = {};
  else if (bv === undefined && Array.isArray(lv) && Array.isArray(sv)) bv = [];
  if (isObject(bv) && isObject(lv) && isObject(sv)) {
    const out: Row = {};
    for (const k of new Set([...Object.keys(bv), ...Object.keys(lv), ...Object.keys(sv)])) {
      const value = mergeValue(`${path}.${k}`, bv[k], lv[k], sv[k], conflicts);
      if (value !== undefined) out[k] = value;
    }
    return out;
  }
  if (Array.isArray(bv) && Array.isArray(lv) && Array.isArray(sv) && allRowsHaveIds(bv, lv, sv)) {
    return mergeById(path, bv, lv, sv, conflicts);
  }
  conflicts.push({ collection: "field", id: path, reason: "both-edited" });
  return lv;
}

/** Three-way merge of one value of a world (see mergeWorldDefinition). */
export function mergeWorldValue(path: string, base: unknown, local: unknown, server: unknown): { value: unknown; conflicts: WorldMergeConflict[] } {
  const conflicts: WorldMergeConflict[] = [];
  return { value: mergeValue(path, base, local, server, conflicts), conflicts };
}

/** Collections merged by entity `id`. */
const ID_COLLECTIONS = [
  "entries",
  "variables",
  "rules",
  "reactions",
  "audioTracks",
  "sceneImages",
  "backgrounds",
  "entryFolders",
  "customUI",
  "worldbooks",
  "scenes",
  "replyRules",
  "conditionalBGM",
  "characters",
] as const;

/** Every row carries a string id — otherwise an id-keyed merge would drop rows. */
function allRowsHaveIds(...arrs: unknown[]): boolean {
  return arrs.every((arr) => arr === undefined || (Array.isArray(arr) && (arr as Row[]).every((r) => idOf(r) !== undefined)));
}

/**
 * Every other top-level field is merged base-aware: a field only the other
 * side changed flows through; a field only the user changed is preserved;
 * changed on both sides, it is merged inside (mergeValue) and whatever both
 * changed differently is reported so the caller retains the other value for
 * recovery, just as it does for an id-keyed entity.
 */
const HANDLED_KEYS = new Set<string>([...ID_COLLECTIONS, "rootComponent"]);

function mergeField(
  key: string,
  bv: unknown,
  lv: unknown,
  sv: unknown,
  merged: Record<string, unknown>,
  conflicts: WorldMergeConflict[],
): void {
  const value = mergeValue(key, bv, lv, sv, conflicts);
  if (value === undefined) delete merged[key];
  else merged[key] = value;
}

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
    if (!allRowsHaveIds(bb, ll, ss)) {
      mergeField(key, bb, ll, ss, merged, conflicts);
      continue;
    }
    merged[key] = mergeById(key, bb, ll, ss, conflicts, key === "variables");
  }

  merged.rootComponent = mergeRootComponent(
    (b as { rootComponent?: RootComponentLike }).rootComponent,
    (local as { rootComponent?: RootComponentLike }).rootComponent,
    (server as { rootComponent?: RootComponentLike }).rootComponent,
    conflicts,
  );

  // Every remaining key, including ones added to WorldDefinition later — a
  // fixed list here once let unsaved worldbooks/uiDoc/replyRules edits be
  // replaced by the server copy on any merge.
  const lo = local as unknown as Record<string, unknown>;
  const so = server as unknown as Record<string, unknown>;
  const bo = b as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(bo), ...Object.keys(lo), ...Object.keys(so)])) {
    if (HANDLED_KEYS.has(key)) continue;
    mergeField(key, bo[key], lo[key], so[key], merged, conflicts);
  }

  return { merged: merged as unknown as WorldDefinition, conflicts };
}
