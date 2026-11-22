import type { WorldDefinition } from "../types/index.js";
import { deepEqual, movedIds } from "./merge.js";
import { stableHash } from "./text-merge.js";

/**
 * Field-level change sets for a WorldDefinition — what a save sends instead of
 * the whole world, and what the server broadcasts to everyone else editing it.
 *
 * Figma's model, not Google Docs': the server applies change sets in arrival
 * order. Two people editing different entries, or different fields of one
 * entry, never collide. An edit may carry `was`, a fingerprint of the value
 * its sender started from (see annotateChangeBase): the server then reports
 * the same field changed by someone else meanwhile as a conflict instead of
 * silently writing over it, and an edit to a row someone deleted as missing
 * (applyWorldChangesChecked). Pure; never mutates its inputs.
 */
export type WorldEdit =
  /** Add (or replace) a whole row in an id-keyed collection. `after` places a
   *  new row behind that id; null puts it first, absent appends it. */
  | { op: "row"; key: string; id: string; row: Record<string, unknown>; after?: string | null }
  /** Remove a row from an id-keyed collection. */
  | { op: "delete"; key: string; id: string }
  /** Set (or with `undefined`, remove) individual fields of one row. */
  | { op: "rowFields"; key: string; id: string; set: Record<string, unknown>; unset?: string[]; was?: Record<string, string> }
  /** A row's id changed (a variable renamed): every other field keeps what
   *  anyone else wrote to it meanwhile. */
  | { op: "rename"; key: string; from: string; to: string }
  /** One row dragged to just behind `after` (null: first). Like Figma's
   *  per-object position, two people reordering different rows both keep
   *  their move. */
  | { op: "move"; key: string; id: string; after: string | null }
  /** The collection's whole order, as ids (older clients). Rows the sender
   *  did not know about keep their place behind their previous neighbour. */
  | { op: "order"; key: string; ids: string[] }
  /** One frontend file in rootComponent.files; null deletes it. */
  | { op: "file"; name: string; content: string | null; was?: string | null }
  /** One rootComponent property other than its files. */
  | { op: "rootField"; field: string; value?: unknown; was?: string }
  /** A top-level field, replaced whole; an absent value removes it. */
  | { op: "field"; key: string; value?: unknown; was?: string }
  /** One value inside a top-level object field (the canvas layout, the
   *  interface document, settings…); an absent value removes it. */
  | { op: "set"; path: PathStep[]; value?: unknown; was?: string }
  /** Add a row to an id-keyed list inside a field, placed like `row`. */
  | { op: "addRow"; path: PathStep[]; row: Record<string, unknown>; after?: string | null }
  /** Remove a row from an id-keyed list inside a field. */
  | { op: "removeRow"; path: PathStep[]; id: string }
  /** One row of an id-keyed list inside a field, moved behind `after`. */
  | { op: "moveRow"; path: PathStep[]; id: string; after: string | null }
  /** The order of an id-keyed list inside a field, as ids (older clients). */
  | { op: "orderRows"; path: PathStep[]; ids: string[] };

/** A step into a field: an object key, or the row of a list with that id. */
export type PathStep = string | { id: string };

/** Collections diffed row by row. Every row must carry a string id; a
 *  collection where one doesn't is sent as a whole field instead. */
export const WORLD_ROW_COLLECTIONS = [
  "entries", "variables", "rules", "reactions", "audioTracks", "sceneImages",
  "backgrounds", "entryFolders", "customUI", "worldbooks", "scenes",
  "replyRules", "conditionalBGM", "characters",
] as const;

const ROW_KEYS = new Set<string>(WORLD_ROW_COLLECTIONS);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

function rowsWithIds(value: unknown): Row[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  for (const r of value) {
    if (!r || typeof r !== "object" || typeof (r as Row).id !== "string") return null;
  }
  // Duplicate ids can't be addressed one by one.
  const ids = new Set((value as Row[]).map((r) => r.id as string));
  return ids.size === value.length ? (value as Row[]) : null;
}

/** Collections whose ids people rename (a variable's id is its name in
 *  {{macros}}). A row that kept its place but changed id is sent as a rename,
 *  so what someone else wrote to it meanwhile survives. */
const RENAMED_ROWS = new Set(["variables"]);

/** Old id → new id for rows that stayed at their index under a new id. */
function renamedRows(key: string, base: Row[], next: Row[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!RENAMED_ROWS.has(key) || base.length !== next.length) return out;
  const baseIds = new Set(base.map((r) => r.id as string));
  const nextIds = new Set(next.map((r) => r.id as string));
  base.forEach((b, i) => {
    const n = next[i]!;
    if (b.id === n.id || nextIds.has(b.id as string) || baseIds.has(n.id as string)) return;
    if (b.type !== undefined && b.type !== n.type) return;
    out.set(b.id as string, n.id as string);
  });
  return out;
}

function diffRows(key: string, baseValue: unknown, nextValue: unknown, out: WorldEdit[]): boolean {
  const base = rowsWithIds(baseValue);
  const next = rowsWithIds(nextValue);
  if (!base || !next || (nextValue === undefined) !== (baseValue === undefined)) return false;
  const renames = renamedRows(key, base, next);
  const renamedTo = new Map([...renames].map(([from, to]) => [to, from]));
  const baseById = new Map(base.map((r) => [r.id as string, r]));
  const nextIds = new Set(next.map((r) => r.id as string));
  for (const r of base) {
    if (!nextIds.has(r.id as string) && !renames.has(r.id as string)) out.push({ op: "delete", key, id: r.id as string });
  }
  for (const [from, to] of renames) out.push({ op: "rename", key, from, to });
  // A renamed row is the same row: it moves (or not) like one.
  const asBase = renames.size ? base.map((r) => (renames.has(r.id as string) ? { ...r, id: renames.get(r.id as string) } : r)) : base;
  const moved = movedIds(asBase, next);
  let prev: string | null = null;
  for (const r of next) {
    const id = r.id as string;
    const from = renamedTo.get(id);
    const b = from !== undefined ? { ...baseById.get(from)!, id } : baseById.get(id);
    // Moves go in list order, so each one's neighbour already stands where it ends up.
    if (moved.has(id)) out.push({ op: "move", key, id, after: prev });
    if (!b) {
      out.push({ op: "row", key, id, row: r, after: prev });
    } else if (!deepEqual(b, r)) {
      const set: Record<string, unknown> = {};
      const unset: string[] = [];
      for (const f of new Set([...Object.keys(b), ...Object.keys(r)])) {
        if (deepEqual(b[f], r[f])) continue;
        if (r[f] === undefined) unset.push(f);
        else set[f] = r[f];
      }
      out.push(unset.length ? { op: "rowFields", key, id, set, unset } : { op: "rowFields", key, id, set });
    }
    prev = id;
  }
  return true;
}

const isPlainObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Inside a field, down to the values that changed: two people moving
 * different nodes on the canvas, adding sticky notes, or editing different
 * pages of the interface each send only their own change. Plain objects go
 * key by key, lists whose items all carry an id go row by row, anything else
 * is replaced whole where it sits.
 */
function diffNested(path: PathStep[], b: unknown, n: unknown, out: WorldEdit[]): void {
  if (deepEqual(b, n)) return;
  // Something new where there was nothing: compare against an empty one, so
  // two people starting the same layout or list both keep what they added.
  if (b === undefined && isPlainObject(n)) b = {};
  else if (b === undefined && Array.isArray(n) && n.length > 0 && rowsWithIds(n)) b = [];
  if (isPlainObject(b) && isPlainObject(n)) {
    const keys = new Set([...Object.keys(b), ...Object.keys(n)]);
    // A key no path can name (empty, or one the server refuses) sends the
    // object whole, as before.
    if (![...keys].some((k) => k === "" || UNSAFE_KEYS.has(k))) {
      for (const k of keys) diffNested([...path, k], b[k], n[k], out);
      return;
    }
  }
  const base = Array.isArray(b) ? rowsWithIds(b) : null;
  const next = Array.isArray(n) ? rowsWithIds(n) : null;
  if (base && next) {
    const baseById = new Map(base.map((r) => [r.id as string, r]));
    const nextIds = new Set(next.map((r) => r.id as string));
    for (const r of base) if (!nextIds.has(r.id as string)) out.push({ op: "removeRow", path, id: r.id as string });
    const moved = movedIds(base, next);
    let prev: string | null = null;
    for (const r of next) {
      const id = r.id as string;
      const old = baseById.get(id);
      if (moved.has(id)) out.push({ op: "moveRow", path, id, after: prev });
      if (!old) out.push({ op: "addRow", path, row: r, after: prev });
      else diffNested([...path, { id }], old, r, out);
      prev = id;
    }
    return;
  }
  out.push(n === undefined ? { op: "set", path } : { op: "set", path, value: n });
}

function diffRoot(baseValue: unknown, nextValue: unknown, out: WorldEdit[]): boolean {
  if (!baseValue || !nextValue || typeof baseValue !== "object" || typeof nextValue !== "object") return false;
  const b = baseValue as Json;
  const n = nextValue as Json;
  const bf = (b.files ?? {}) as Record<string, string>;
  const nf = (n.files ?? {}) as Record<string, string>;
  if (typeof bf !== "object" || typeof nf !== "object") return false;
  for (const name of new Set([...Object.keys(bf), ...Object.keys(nf)])) {
    if (bf[name] === nf[name]) continue;
    out.push({ op: "file", name, content: name in nf ? nf[name]! : null });
  }
  for (const field of new Set([...Object.keys(b), ...Object.keys(n)])) {
    // The compiled bundle is derived from the files and can be most of a
    // card's size: a save sends it beside the change set (rootCompiled), so
    // it never rides in the change sets everyone else is sent.
    if (field === "files" || field === "compiled" || deepEqual(b[field], n[field])) continue;
    out.push(n[field] === undefined ? { op: "rootField", field } : { op: "rootField", field, value: n[field] });
  }
  return true;
}

/** The change set that turns `base` into `next`. Empty when they are equal. */
export function diffWorld(base: WorldDefinition, next: WorldDefinition): WorldEdit[] {
  const b = base as unknown as Json;
  const n = next as unknown as Json;
  const out: WorldEdit[] = [];
  for (const key of new Set([...Object.keys(b), ...Object.keys(n)])) {
    if (deepEqual(b[key], n[key])) continue;
    if (ROW_KEYS.has(key) && diffRows(key, b[key], n[key], out)) continue;
    if (key === "rootComponent" && diffRoot(b[key], n[key], out)) continue;
    const bothObjects = isPlainObject(n[key]) && (isPlainObject(b[key]) || b[key] === undefined);
    const bothRowLists = Array.isArray(n[key]) && (Array.isArray(b[key]) || b[key] === undefined) && !!rowsWithIds(b[key]) && !!rowsWithIds(n[key]);
    if (!ROW_KEYS.has(key) && key !== "rootComponent" && (bothObjects || bothRowLists)) {
      diffNested([key], b[key], n[key], out);
      continue;
    }
    out.push(n[key] === undefined ? { op: "field", key } : { op: "field", key, value: n[key] });
  }
  return out;
}

function placeAfter(rows: Row[], row: Row, after: string | null | undefined): Row[] {
  if (after === undefined) return [...rows, row];
  if (after === null) return [row, ...rows];
  const i = rows.findIndex((r) => r.id === after);
  return i < 0 ? [...rows, row] : [...rows.slice(0, i + 1), row, ...rows.slice(i + 1)];
}

/** `rows` with `id` taken out and put back behind `after` (null: first).
 *  Missing either one (someone deleted it meanwhile), it stays put. */
function moveRow(rows: Row[], id: string, after: string | null): Row[] {
  const from = rows.findIndex((r) => r?.id === id);
  if (from < 0 || id === after) return rows;
  const rest = [...rows.slice(0, from), ...rows.slice(from + 1)];
  if (after === null) return [rows[from]!, ...rest];
  const i = rest.findIndex((r) => r?.id === after);
  return i < 0 ? rows : [...rest.slice(0, i + 1), rows[from]!, ...rest.slice(i + 1)];
}

function reorder(rows: Row[], ids: string[]): Row[] {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const listed = new Set(ids.filter((id) => byId.has(id)));
  const out: Row[] = ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  // Rows the sender didn't know about follow their previous neighbour.
  rows.forEach((r, i) => {
    if (listed.has(r.id as string)) return;
    const prevId = i > 0 ? (rows[i - 1]!.id as string) : null;
    const at = prevId === null ? -1 : out.findIndex((x) => x.id === prevId);
    out.splice(at + 1, 0, r);
  });
  return out;
}

const MISSING = Symbol("missing");

/** `value` with the thing at `path` replaced by `fn` of it, or MISSING when
 *  the path no longer leads anywhere (someone removed what it pointed into). */
function updateAt(value: unknown, path: PathStep[], fn: (v: unknown) => unknown): unknown {
  if (path.length === 0) return fn(value);
  const [step, ...rest] = path;
  if (typeof step === "string") {
    if (!isPlainObject(value)) return MISSING;
    // A key someone else hasn't made yet is made on the way down.
    const here = value[step] === undefined && typeof rest[0] === "string" ? {} : value[step];
    const child = updateAt(here, rest, fn);
    if (child === MISSING) return MISSING;
    const out = { ...value };
    if (child === undefined) delete out[step];
    else out[step] = child;
    return out;
  }
  if (!Array.isArray(value)) return MISSING;
  const i = value.findIndex((r) => (r as Row | null)?.id === step!.id);
  if (i < 0) return MISSING;
  const child = updateAt(value[i], rest, fn);
  if (child === MISSING || child === undefined) return MISSING;
  return value.map((r, j) => (j === i ? child : r));
}

const onRows = (fn: (rows: Row[]) => Row[]) => (v: unknown) => (Array.isArray(v) ? fn(v as Row[]) : v === undefined ? fn([]) : MISSING);

/** An edit that found nothing to land on: its row (or file, or the row a
 *  nested path runs through) is gone — someone deleted it meanwhile. */
export interface MissingChange {
  op: WorldEdit["op"];
  /** The collection ("entries"…), "rootComponent.files", or a path's first key. */
  key: string;
  /** The row id or file name the edit was for. */
  id: string;
}

/** An edit to a value someone else changed since the sender read it. */
export interface ChangeConflict {
  op: WorldEdit["op"];
  /** "entries", "rootComponent.files", "rootComponent", "field"… */
  key: string;
  /** The row id, file name, field or dotted path. */
  id: string;
  /** For a row: the fields both sides changed. */
  fields?: string[];
  reason: "both-edited" | "both-added";
}

export interface CheckedChanges {
  world: WorldDefinition;
  missing: MissingChange[];
  conflicts: ChangeConflict[];
}

/** What a path points at; MISSING when it runs through a row that is gone. */
function valueAt(value: unknown, path: PathStep[]): unknown {
  let at: unknown = value;
  for (const step of path) {
    if (typeof step === "string") {
      if (!isPlainObject(at)) return undefined;
      at = at[step];
    } else {
      if (!Array.isArray(at)) return MISSING;
      const row = (at as Row[]).find((r) => r?.id === step.id);
      if (!row) return MISSING;
      at = row;
    }
  }
  return at;
}

const pathLabel = (path: PathStep[]) => path.map((s) => (typeof s === "string" ? s : `[${s.id}]`)).join(".");

/** The id of the first row a nested path runs through. */
const firstRowId = (path: PathStep[]) => {
  const step = path.find((s) => typeof s !== "string");
  return step && typeof step !== "string" ? step.id : "";
};

/** Changed by someone else since `was`, to something other than what this edit writes. */
const clashes = (was: string | null | undefined, current: unknown, next: unknown) =>
  typeof was === "string" && stableHash(current) !== was && !deepEqual(current, next);

function apply(world: WorldDefinition, changes: WorldEdit[], report: CheckedChanges | null): WorldDefinition {
  const w = { ...(world as unknown as Json) };
  const missing = (c: WorldEdit, key: string, id: string) => { report?.missing.push({ op: c.op, key, id }); };
  for (const c of changes) {
    switch (c.op) {
      case "field":
        if (report && clashes(c.was, w[c.key], c.value)) report.conflicts.push({ op: c.op, key: "field", id: c.key, reason: "both-edited" });
        if (c.value === undefined) delete w[c.key];
        else w[c.key] = c.value;
        break;
      case "row": {
        const rows = Array.isArray(w[c.key]) ? (w[c.key] as Row[]) : [];
        const i = rows.findIndex((r) => r?.id === c.id);
        // A row this sender is adding that someone else already added under
        // the same id (two people naming a new variable alike).
        if (report && i >= 0 && !deepEqual(rows[i], c.row)) report.conflicts.push({ op: c.op, key: c.key, id: c.id, reason: "both-added" });
        w[c.key] = i >= 0 ? rows.map((r, j) => (j === i ? c.row : r)) : placeAfter(rows, c.row, c.after);
        break;
      }
      case "delete": {
        if (!Array.isArray(w[c.key])) break;
        w[c.key] = (w[c.key] as Row[]).filter((r) => r?.id !== c.id);
        break;
      }
      case "rowFields": {
        const rows = Array.isArray(w[c.key]) ? (w[c.key] as Row[]) : null;
        const row = rows?.find((r) => r?.id === c.id);
        if (!rows || !row) { missing(c, c.key, c.id); break; }
        if (report && c.was) {
          const both = [...Object.keys(c.set), ...(c.unset ?? [])].filter((f) => clashes(c.was![f], row[f], c.set[f]));
          if (both.length) report.conflicts.push({ op: c.op, key: c.key, id: c.id, fields: both, reason: "both-edited" });
        }
        w[c.key] = rows.map((r) => {
          if (r?.id !== c.id) return r;
          const next: Row = { ...r, ...c.set };
          for (const f of c.unset ?? []) delete next[f];
          return next;
        });
        break;
      }
      case "rename": {
        const rows = Array.isArray(w[c.key]) ? (w[c.key] as Row[]) : null;
        const i = rows ? rows.findIndex((r) => r?.id === c.from) : -1;
        if (!rows || i < 0) {
          // Already renamed (a retried request) is done; gone is missing.
          if (!rows?.some((r) => r?.id === c.to)) missing(c, c.key, c.from);
          break;
        }
        if (rows.some((r) => r?.id === c.to)) {
          report?.conflicts.push({ op: c.op, key: c.key, id: c.to, reason: "both-added" });
          break;
        }
        w[c.key] = rows.map((r, j) => (j === i ? { ...r, id: c.to } : r));
        break;
      }
      case "order":
        if (Array.isArray(w[c.key])) w[c.key] = reorder(w[c.key] as Row[], c.ids);
        break;
      case "move":
        if (Array.isArray(w[c.key])) w[c.key] = moveRow(w[c.key] as Row[], c.id, c.after);
        break;
      case "file": {
        const root = { ...((w.rootComponent ?? {}) as Json) };
        const files = { ...((root.files ?? {}) as Record<string, string>) };
        if (report && c.was !== undefined) {
          const had = Object.prototype.hasOwnProperty.call(files, c.name);
          if (c.was !== null && !had && c.content !== null) {
            // Edited a file someone else deleted: this edit brings it back.
            missing(c, "rootComponent.files", c.name);
          } else if (c.was === null ? had && files[c.name] !== c.content : clashes(c.was, had ? files[c.name] : undefined, c.content ?? undefined)) {
            report.conflicts.push({ op: c.op, key: "rootComponent.files", id: c.name, reason: c.was === null ? "both-added" : "both-edited" });
          }
        }
        if (c.content === null) delete files[c.name];
        else files[c.name] = c.content;
        root.files = files;
        w.rootComponent = root;
        break;
      }
      case "rootField": {
        const root = { ...((w.rootComponent ?? {}) as Json) };
        if (report && clashes(c.was, root[c.field], c.value)) report.conflicts.push({ op: c.op, key: "rootComponent", id: c.field, reason: "both-edited" });
        if (c.value === undefined) delete root[c.field];
        else root[c.field] = c.value;
        w.rootComponent = root;
        break;
      }
      case "set":
      case "addRow":
      case "removeRow":
      case "moveRow":
      case "orderRows": {
        if (report && c.op === "set" && c.was !== undefined) {
          const current = valueAt(w, c.path);
          if (current !== MISSING && clashes(c.was, current, c.value)) report.conflicts.push({ op: c.op, key: "field", id: pathLabel(c.path), reason: "both-edited" });
        }
        const fn = c.op === "set" ? () => c.value
          : c.op === "addRow" ? onRows((rows) => {
            const i = rows.findIndex((r) => r?.id === c.row.id);
            return i >= 0 ? rows.map((r, j) => (j === i ? c.row : r)) : placeAfter(rows, c.row, c.after);
          })
          : c.op === "removeRow" ? onRows((rows) => rows.filter((r) => r?.id !== c.id))
          : c.op === "moveRow" ? onRows((rows) => moveRow(rows, c.id, c.after))
          : onRows((rows) => reorder(rows, c.ids));
        const next = updateAt(w, c.path, fn);
        if (next === MISSING) {
          // Removing or moving something already gone is done; writing into it is not.
          if (c.op === "set" || c.op === "addRow") missing(c, String(c.path[0]), firstRowId(c.path));
          break;
        }
        for (const k of Object.keys(w)) if (!(k in (next as Json))) delete w[k];
        Object.assign(w, next);
        break;
      }
    }
  }
  return w as unknown as WorldDefinition;
}

/**
 * Apply a change set. Changes to rows that no longer exist are dropped (the
 * row was deleted by someone else); everything else is last-write-wins. The
 * editor's own bookkeeping uses this; the server checks first
 * (applyWorldChangesChecked).
 */
export function applyWorldChanges(world: WorldDefinition, changes: WorldEdit[]): WorldDefinition {
  return apply(world, changes, null);
}

/**
 * Apply a change set and say what did not land cleanly: edits whose row is
 * gone (missing) and edits to a value someone else changed since the sender
 * read it (conflicts, only for edits carrying `was`). The server refuses a
 * save with either, so the sender merges instead of silently losing its
 * edit or someone else's.
 */
export function applyWorldChangesChecked(world: WorldDefinition, changes: WorldEdit[]): CheckedChanges {
  const report: CheckedChanges = { world, missing: [], conflicts: [] };
  report.world = apply(world, changes, report);
  return report;
}

/** Top-level fields where the last write simply wins (the board's layout:
 *  two people nudging one frame is not worth a conflict). */
const LAST_WRITE_WINS = new Set(["graphLayout"]);

/**
 * Each checkable edit of a change set with a fingerprint of the value it
 * started from in `base` (see applyWorldChangesChecked). Left unchecked:
 * timestamps, the board layout, a frontend generated from the interface
 * document (every editor regenerates it), and the text fields `skipText`
 * names (textFieldKey) — text kept in step live, where whichever save comes
 * last is never a conflict.
 */
export function annotateChangeBase(
  base: WorldDefinition,
  changes: WorldEdit[],
  skipText?: (textKey: string) => boolean,
): WorldEdit[] {
  const b = base as unknown as Json;
  const root = (b.rootComponent ?? {}) as Json;
  const skip = (key: string) => !!skipText?.(key);
  return changes.map((c): WorldEdit => {
    switch (c.op) {
      case "rowFields": {
        const row = Array.isArray(b[c.key]) ? (b[c.key] as Row[]).find((r) => r?.id === c.id) : undefined;
        if (!row) return c;
        const was: Record<string, string> = {};
        for (const f of [...Object.keys(c.set), ...(c.unset ?? [])]) {
          if (f === "updatedAt" || skip(`r:${c.key}:${encodeURIComponent(c.id)}:${f}`)) continue;
          was[f] = stableHash(row[f]);
        }
        return Object.keys(was).length ? { ...c, was } : c;
      }
      case "field":
        if (LAST_WRITE_WINS.has(c.key) || skip(`t:${c.key}`)) return c;
        return { ...c, was: stableHash(b[c.key]) };
      case "file": {
        if (root.generatedFrom === "uiDoc" || skip(`f:${encodeURIComponent(c.name)}`)) return c;
        const files = (root.files ?? {}) as Record<string, string>;
        return { ...c, was: Object.prototype.hasOwnProperty.call(files, c.name) ? stableHash(files[c.name]) : null };
      }
      case "rootField":
        if (c.field === "updatedAt" || c.field === "compiled" || c.field === "generatedFrom") return c;
        return { ...c, was: stableHash(root[c.field]) };
      case "set": {
        const top = c.path[0] as string;
        if (LAST_WRITE_WINS.has(top) || (c.path.length === 1 && skip(`t:${top}`))) return c;
        const current = valueAt(b, c.path);
        return current === MISSING ? c : { ...c, was: stableHash(current) };
      }
      default:
        return c;
    }
  });
}

/**
 * Rebase local unsent edits onto a newer server copy: the server's changes
 * land, and every field this client changed since `base` keeps the local
 * value — the client's pending write wins until the server orders it. A row
 * edited here that someone else deleted comes back with the local edits (an
 * edit beats a delete, as in the 3-way merge); `restored` names them.
 */
export function rebaseWorldDetailed(
  base: WorldDefinition,
  local: WorldDefinition,
  server: WorldDefinition,
): { world: WorldDefinition; restored: Array<{ key: string; id: string }> } {
  const checked = applyWorldChangesChecked(server, diffWorld(base, local));
  const restored: Array<{ key: string; id: string }> = [];
  let world = checked.world;
  const l = local as unknown as Json;
  for (const m of checked.missing) {
    if (!ROW_KEYS.has(m.key) || !m.id || restored.some((r) => r.key === m.key && r.id === m.id)) continue;
    const rows = Array.isArray(l[m.key]) ? (l[m.key] as Row[]) : [];
    const i = rows.findIndex((r) => r?.id === m.id);
    if (i < 0) continue;
    world = applyWorldChanges(world, [{ op: "row", key: m.key, id: m.id, row: rows[i]!, after: i > 0 ? (rows[i - 1]!.id as string) : null }]);
    restored.push({ key: m.key, id: m.id });
  }
  return { world, restored };
}

export function rebaseWorld(base: WorldDefinition, local: WorldDefinition, server: WorldDefinition): WorldDefinition {
  return rebaseWorldDetailed(base, local, server).world;
}

function isPath(value: unknown): value is PathStep[] {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === "string" && value.every((step) =>
    typeof step === "string"
      ? step.length > 0 && !UNSAFE_KEYS.has(step)
      : !!step && typeof step === "object" && typeof (step as Json).id === "string" && Object.keys(step).length === 1);
}

/** Is this a well-formed change set? (Server-side input check.) */
export function isWorldChangeList(value: unknown): value is WorldEdit[] {
  if (!Array.isArray(value)) return false;
  return value.every((c) => {
    if (!c || typeof c !== "object") return false;
    const o = c as Json;
    const str = (k: string) => typeof o[k] === "string" && (o[k] as string).length > 0 && !UNSAFE_KEYS.has(o[k] as string);
    const wasOk = o.was === undefined || typeof o.was === "string";
    switch (o.op) {
      case "field": return str("key") && wasOk;
      case "row": return str("key") && str("id") && !!o.row && typeof o.row === "object" && (o.row as Row).id === o.id
        && (o.after === undefined || o.after === null || typeof o.after === "string");
      case "delete": return str("key") && str("id");
      case "rowFields": return str("key") && str("id") && !!o.set && typeof o.set === "object" && !("id" in (o.set as Json))
        && (o.unset === undefined || (Array.isArray(o.unset) && o.unset.every((f) => typeof f === "string" && f !== "id")))
        && (o.was === undefined || (isPlainObject(o.was) && Object.values(o.was).every((h) => typeof h === "string")));
      case "rename": return str("key") && str("from") && str("to");
      case "order": return str("key") && Array.isArray(o.ids) && o.ids.every((id) => typeof id === "string");
      case "move": return str("key") && str("id") && (o.after === null || typeof o.after === "string");
      case "file": return str("name") && (o.content === null || typeof o.content === "string") && (o.was === null || wasOk);
      case "rootField": return str("field") && o.field !== "files" && wasOk;
      case "set": return isPath(o.path) && wasOk;
      case "addRow": return isPath(o.path) && !!o.row && typeof o.row === "object" && typeof (o.row as Row).id === "string"
        && (o.after === undefined || o.after === null || typeof o.after === "string");
      case "removeRow": return isPath(o.path) && str("id");
      case "orderRows": return isPath(o.path) && Array.isArray(o.ids) && o.ids.every((id) => typeof id === "string");
      case "moveRow": return isPath(o.path) && str("id") && (o.after === null || typeof o.after === "string");
      default: return false;
    }
  });
}
