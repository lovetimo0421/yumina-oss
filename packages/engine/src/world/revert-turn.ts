import type { WorldDefinition } from "../types/index.js";
import { deepEqual } from "./merge.js";

/**
 * Take back one assistant turn without taking the author's later work with it.
 *
 * The Studio assistant edits the card, and the canvas offers to undo that
 * turn. Rolling back to the card as it was before the turn also wipes
 * everything the author did after it, and the offer stays up until dismissed,
 * so "after it" can be a lot. Three versions say who did what:
 *
 *   before — the card before the turn (the server's pre-turn snapshot)
 *   end    — the card as the turn left it
 *   now    — the card in the editor
 *
 * before→end is the assistant's work; end→now is the author's. Everything the
 * assistant touched and the author has not is put back the way it was; what
 * both touched stays as the author left it and is reported, never overwritten.
 * Pure; never mutates its inputs.
 */

export interface TurnRevertResult {
  /** `now` with the turn taken back. The very same object when nothing could be. */
  world: WorldDefinition;
  /** What the turn changed and the author has changed since, left as the
   *  author has it: "entries/e1", "settings.temperature", "rootComponent.files/index.tsx". */
  kept: string[];
}

/**
 * Not the turn's to take back: the board's arrangement lives outside the
 * undo history (frames and sticky notes stay where the author put them), and
 * the cover is the world row's, not the schema's — the pre-turn snapshot does
 * not hold the cover the card had then.
 */
const KEEP_NOW = new Set(["graphLayout", "avatar"]);

/**
 * Fields an item gets from where it stands rather than from what it says.
 * The editor renumbers an entry's `position` whenever a sibling comes or
 * goes, so a turn that inserts one entry shifts every entry after it; judged
 * with `position`, each of those would read as the assistant's edit, and any
 * the author later touched as a clash. Compared without it — the caller
 * renumbers from the order this returns.
 */
const ITEM_KEYS_IGNORED: Record<string, readonly string[]> = { entries: ["position"] };

/**
 * Derived from their siblings, not written by anyone: always the author's
 * copy, never counted as a clash. A compiled interface built from another
 * mix of files is dropped below so it is rebuilt rather than trusted.
 */
const DERIVED = new Set(["rootComponent.compiled", "rootComponent.updatedAt"]);

/**
 * How far down the merge looks before it treats a value as one thing: the
 * card's own fields, then one level into each (a setting, a page, a file),
 * then one more (a theme token, a file in `rootComponent.files`). Items of an
 * id-keyed list are never split — an entry is one object, and half of one
 * author's entry glued to half of the assistant's is nobody's entry.
 */
const MAX_DEPTH = 3;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown, ignore?: readonly string[]): boolean {
  if (ignore && isRec(a) && isRec(b)) {
    const strip = (r: Rec) => {
      const out: Rec = { ...r };
      for (const k of ignore) delete out[k];
      return out;
    };
    return deepEqual(strip(a), strip(b));
  }
  return deepEqual(a, b);
}

/** A list every item of which is an object with its own unique string id. */
function isIdList(v: unknown): v is Rec[] {
  if (!Array.isArray(v)) return false;
  const seen = new Set<string>();
  for (const item of v) {
    if (!isRec(item) || typeof item.id !== "string" || seen.has(item.id)) return false;
    seen.add(item.id);
  }
  return true;
}

interface Ctx {
  kept: string[];
}

function merge3(b: unknown, e: unknown, n: unknown, path: string, depth: number, ctx: Ctx, ignore?: readonly string[]): unknown {
  if (same(b, e, ignore)) return n; // the turn left it alone
  if (same(n, e, ignore)) return b; // the author left the turn's version alone
  if (same(n, b, ignore)) return n; // the author already put it back
  if (depth < MAX_DEPTH) {
    const all = [b, e, n];
    if (all.every((v) => v === undefined || isRec(v))) return mergeRecord(b as Rec | undefined, e as Rec | undefined, n as Rec | undefined, path, depth, ctx);
    if (all.every((v) => v === undefined || isIdList(v))) return mergeIdList(b as Rec[] | undefined, e as Rec[] | undefined, n as Rec[] | undefined, path, ctx);
  }
  ctx.kept.push(path);
  return n;
}

function mergeRecord(b: Rec | undefined, e: Rec | undefined, n: Rec | undefined, path: string, depth: number, ctx: Ctx): Rec | undefined {
  const keys = new Set([...Object.keys(n ?? {}), ...Object.keys(e ?? {}), ...Object.keys(b ?? {})]);
  const out: Rec = {};
  let changed = false;
  for (const key of keys) {
    const at = path ? `${path}.${key}` : key;
    const nv = n?.[key];
    const v = depth === 0 && KEEP_NOW.has(key) ? nv
      : DERIVED.has(at) ? nv
      : merge3(b?.[key], e?.[key], nv, at, depth + 1, ctx);
    if (v !== nv) changed = true;
    if (v !== undefined) out[key] = v;
  }
  if (!changed) return n;
  if (path === "rootComponent" && n && isRec(out.files) && out.files !== n.files) delete out.compiled;
  return out;
}

function ids(list: Rec[] | undefined): string[] {
  return (list ?? []).map((r) => r.id as string);
}

function mergeIdList(b: Rec[] | undefined, e: Rec[] | undefined, n: Rec[] | undefined, path: string, ctx: Ctx): Rec[] | undefined {
  const bm = new Map((b ?? []).map((r) => [r.id as string, r]));
  const em = new Map((e ?? []).map((r) => [r.id as string, r]));
  const nm = new Map((n ?? []).map((r) => [r.id as string, r]));
  const ignore = ITEM_KEYS_IGNORED[path];

  // Each item on its own: created, deleted or changed by the turn, and
  // touched or not by the author since, all fall out of the same three checks.
  const result = new Map<string, Rec>();
  for (const id of new Set([...nm.keys(), ...em.keys(), ...bm.keys()])) {
    const v = merge3(bm.get(id), em.get(id), nm.get(id), `${path}/${id}`, MAX_DEPTH, ctx, ignore);
    if (v !== undefined) result.set(id, v as Rec);
  }

  // Order. If the author has not rearranged the list since the turn, any
  // rearranging was the turn's and goes back with it: the old order leads.
  // If they have, theirs leads. Whatever the leading order lacks goes in
  // beside its neighbours from the other one, so a restored entry lands where
  // it used to stand and an author's new one where they put it.
  const nIds = ids(n);
  const eIds = ids(e);
  const authorReordered = !sameSequence(nIds.filter((id) => em.has(id)), eIds.filter((id) => nm.has(id)));
  const lead = authorReordered ? nIds : ids(b);
  const follow = authorReordered ? ids(b) : nIds;
  const order = lead.filter((id) => result.has(id));
  // Everything the leading order lacks is in the other one, by construction
  // (an item comes out as either its old or its current self).
  for (const id of follow) {
    if (!result.has(id) || order.includes(id)) continue;
    const at = follow.indexOf(id);
    let index = -1;
    for (let i = at - 1; i >= 0 && index < 0; i--) {
      const anchor = order.indexOf(follow[i]!);
      if (anchor >= 0) index = anchor + 1;
    }
    for (let i = at + 1; i < follow.length && index < 0; i++) {
      const anchor = order.indexOf(follow[i]!);
      if (anchor >= 0) index = anchor;
    }
    order.splice(index < 0 ? order.length : index, 0, id);
  }

  const out = order.map((id) => result.get(id)!);
  if (n && out.length === n.length && out.every((r, i) => r === n[i])) return n;
  return out;
}

function sameSequence(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function revertTurn(before: WorldDefinition, end: WorldDefinition, now: WorldDefinition): TurnRevertResult {
  const ctx: Ctx = { kept: [] };
  const world = mergeRecord(
    before as unknown as Rec,
    end as unknown as Rec,
    now as unknown as Rec,
    "",
    0,
    ctx,
  ) as unknown as WorldDefinition;
  return { world, kept: ctx.kept };
}
