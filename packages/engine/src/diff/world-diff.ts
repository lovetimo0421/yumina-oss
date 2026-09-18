import type { WorldDefinition } from "../types/index.js";

export type WorldChangeKind =
  | "entry" | "variable" | "rule" | "reaction" | "audio" | "customUI" | "meta";

export interface WorldFieldChange {
  field: string;
  before: string;
  after: string;
}

export interface WorldChange {
  kind: WorldChangeKind;
  op: "added" | "removed" | "modified";
  /** Stable identity of the changed item (entity id, filename, or scalar field name). */
  id?: string;
  /** Human label — entity name, falls back to id. */
  name?: string;
  /** Field-level before/after; only populated when opts.detail is true. */
  fields?: WorldFieldChange[];
}

export interface WorldDiff {
  changes: WorldChange[];
  counts: { added: number; removed: number; modified: number };
}

type Row = Record<string, unknown>;

interface CollectionSpec {
  kind: Exclude<WorldChangeKind, "customUI" | "meta">;
  get: (w: Partial<WorldDefinition>) => Row[];
  /** Fields compared to decide "modified" and emitted as before/after when detail=true. */
  fields: string[];
}

const COLLECTIONS: CollectionSpec[] = [
  // Entry fields that affect WHAT the AI is fed or HOW/WHEN an entry fires — all
  // are material and must trigger re-review. Deliberately excludes id (the match
  // key), position (in-section ordering — diffs are order-independent), and
  // purely organizational metadata (tags, folderId, presetId). Keep in sync with
  // the WorldEntry interface: a new AI-affecting field added there should be
  // added here too, or it would change LIVE on a published card with no review.
  { kind: "entry",    get: (w) => (w.entries as unknown as Row[]) ?? [],     fields: ["name", "content", "role", "apiRole", "depth", "alwaysSend", "keywords", "conditions", "conditionLogic", "matchWholeWords", "secondaryKeywords", "secondaryKeywordLogic", "preventRecursion", "excludeRecursion", "section", "enabled"] },
  { kind: "variable", get: (w) => (w.variables as unknown as Row[]) ?? [],   fields: ["name", "type", "defaultValue", "description", "behaviorRules"] },
  { kind: "rule",     get: (w) => (w.rules as unknown as Row[]) ?? [],       fields: ["name", "enabled"] },
  { kind: "reaction", get: (w) => (w.reactions as unknown as Row[]) ?? [],   fields: ["name"] },
  { kind: "audio",    get: (w) => (w.audioTracks as unknown as Row[]) ?? [], fields: ["name", "url"] },
];

const META_FIELDS = ["name", "description"] as const;

function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function indexById(rows: Row[]): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const r of rows) {
    const id = typeof r.id === "string" ? r.id : undefined;
    if (id) map.set(id, r);
  }
  return map;
}

function labelOf(row: Row, id: string): string {
  return typeof row.name === "string" && row.name ? row.name : id;
}

function diffFields(prev: Row, next: Row, fields: string[]): WorldFieldChange[] {
  const out: WorldFieldChange[] = [];
  for (const f of fields) {
    const before = asText(prev[f]);
    const after = asText(next[f]);
    if (before !== after) out.push({ field: f, before, after });
  }
  return out;
}

export function diffWorldSchemas(
  prev: WorldDefinition,
  next: WorldDefinition,
  opts: { detail?: boolean } = {},
): WorldDiff {
  const detail = opts.detail === true;
  const changes: WorldChange[] = [];

  for (const spec of COLLECTIONS) {
    const prevMap = indexById(spec.get(prev));
    const nextMap = indexById(spec.get(next));
    for (const [id, row] of nextMap) {
      if (!prevMap.has(id)) {
        changes.push({ kind: spec.kind, op: "added", id, name: labelOf(row, id) });
      } else {
        const fields = diffFields(prevMap.get(id)!, row, spec.fields);
        if (fields.length > 0) {
          changes.push({ kind: spec.kind, op: "modified", id, name: labelOf(row, id), ...(detail ? { fields } : {}) });
        }
      }
    }
    for (const [id, row] of prevMap) {
      if (!nextMap.has(id)) changes.push({ kind: spec.kind, op: "removed", id, name: labelOf(row, id) });
    }
  }

  // customUI — rootComponent.files keyed by filename
  const prevFiles = ((prev.rootComponent as unknown as Row | undefined)?.files as Record<string, string> | undefined) ?? {};
  const nextFiles = ((next.rootComponent as unknown as Row | undefined)?.files as Record<string, string> | undefined) ?? {};
  for (const name of Object.keys(nextFiles)) {
    if (!(name in prevFiles)) {
      changes.push({ kind: "customUI", op: "added", id: name, name });
    } else if (prevFiles[name] !== nextFiles[name]) {
      changes.push({ kind: "customUI", op: "modified", id: name, name, ...(detail ? { fields: [{ field: name, before: prevFiles[name]!, after: nextFiles[name]! }] } : {}) });
    }
  }
  for (const name of Object.keys(prevFiles)) {
    if (!(name in nextFiles)) changes.push({ kind: "customUI", op: "removed", id: name, name });
  }

  // meta scalars
  for (const f of META_FIELDS) {
    const before = asText((prev as unknown as Row)[f]);
    const after = asText((next as unknown as Row)[f]);
    if (before !== after) {
      changes.push({ kind: "meta", op: "modified", id: f, name: f, ...(detail ? { fields: [{ field: f, before, after }] } : {}) });
    }
  }

  const counts = { added: 0, removed: 0, modified: 0 };
  for (const c of changes) counts[c.op]++;
  return { changes, counts };
}
