import type { UiDoc, UiElement, UiPage } from "./types.js";
import { boxOn, type UiCanvas } from "./edit.js";

/**
 * Arranging parts the way a slide editor does: align, distribute, stack order,
 * nudge, copy and paste, and the snapping maths a drag uses.
 *
 * Everything here is pure and works in DESIGN px on one canvas at a time — the
 * phone arrangement and the wide one are separate sets of numbers, and an
 * "align left" the creator makes while looking at the desktop must not move
 * anything on the phone.
 *
 * Groups (a meter's label, value and track) are always one unit: aligning a
 * meter aligns its outer box and carries its parts along, rather than stacking
 * the three pieces on top of each other.
 */

export interface UiBox { x: number; y: number; w: number; h: number }

export interface UiArrangeUnit {
  /** Every element of the unit — a whole group, or one element. */
  ids: string[];
  /** The unit's outer box on the canvas being arranged. */
  box: UiBox;
}

const pageOf = (doc: UiDoc, pageId: string): UiPage | undefined =>
  (doc.pages ?? []).find((p) => p.id === pageId);

const union = (boxes: UiBox[]): UiBox => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const btm = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: btm - y };
};

/** The selection as units: each group once, each loose element once. Parts
 *  that are off this canvas (`desktop: null`) take no part. */
export function unitsOf(doc: UiDoc, pageId: string, ids: readonly string[], canvas: UiCanvas): UiArrangeUnit[] {
  const page = pageOf(doc, pageId);
  if (!page) return [];
  const wanted = new Set(ids);
  const byKey = new Map<string, { ids: string[]; boxes: UiBox[] }>();
  for (const el of page.elements) {
    if (!wanted.has(el.id)) continue;
    const b = boxOn(el, canvas);
    if (!b) continue;
    const key = el.group ? `g:${el.group}` : `e:${el.id}`;
    const entry = byKey.get(key) ?? { ids: [], boxes: [] };
    entry.ids.push(el.id);
    entry.boxes.push(b);
    byKey.set(key, entry);
  }
  return [...byKey.values()].map((u) => ({ ids: u.ids, box: union(u.boxes) }));
}

export type UiAlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

export interface UiDelta { dx: number; dy: number }

/**
 * How far each unit moves to line up. Two or more units align to the box
 * around them all, as in any slide editor; a single unit aligns to the page
 * (`page`), which is the only thing left for it to line up with.
 */
export function alignUnits(units: UiArrangeUnit[], mode: UiAlignMode, page?: UiBox): UiDelta[] {
  if (units.length === 0) return [];
  const bounds = units.length === 1 && page ? page : union(units.map((u) => u.box));
  return units.map(({ box }) => {
    switch (mode) {
      case "left": return { dx: bounds.x - box.x, dy: 0 };
      case "right": return { dx: bounds.x + bounds.w - (box.x + box.w), dy: 0 };
      case "hcenter": return { dx: Math.round(bounds.x + bounds.w / 2 - (box.x + box.w / 2)), dy: 0 };
      case "top": return { dx: 0, dy: bounds.y - box.y };
      case "bottom": return { dx: 0, dy: bounds.y + bounds.h - (box.y + box.h) };
      case "vcenter": return { dx: 0, dy: Math.round(bounds.y + bounds.h / 2 - (box.y + box.h / 2)) };
    }
  });
}

/**
 * Equal gaps between units along one axis. The two outermost units stay where
 * they are and the ones between them share the room — so it needs three to
 * mean anything, and with fewer every delta is zero.
 */
export function distributeUnits(units: UiArrangeUnit[], axis: "horizontal" | "vertical"): UiDelta[] {
  const out: UiDelta[] = units.map(() => ({ dx: 0, dy: 0 }));
  if (units.length < 3) return out;
  const pos = (b: UiBox) => (axis === "horizontal" ? b.x : b.y);
  const size = (b: UiBox) => (axis === "horizontal" ? b.w : b.h);
  const order = units.map((u, i) => ({ u, i })).sort((a, b) => pos(a.u.box) - pos(b.u.box) || a.i - b.i);
  const first = order[0]!.u.box;
  const last = order[order.length - 1]!.u.box;
  const span = pos(last) + size(last) - pos(first);
  const used = order.reduce((sum, { u }) => sum + size(u.box), 0);
  const gap = (span - used) / (order.length - 1);
  let cursor = pos(first);
  for (const { u, i } of order) {
    const target = Math.round(cursor);
    const d = target - pos(u.box);
    out[i] = axis === "horizontal" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    cursor += size(u.box) + gap;
  }
  return out;
}

const withBox = (el: UiElement, canvas: UiCanvas, b: UiBox): UiElement =>
  canvas === "desktop" ? { ...el, desktop: b } : { ...el, x: b.x, y: b.y, w: b.w, h: b.h };

/** Shift each unit by its delta on one canvas. */
export function moveUnits(doc: UiDoc, pageId: string, units: UiArrangeUnit[], deltas: UiDelta[], canvas: UiCanvas): UiDoc {
  const shift = new Map<string, UiDelta>();
  units.forEach((u, i) => {
    const d = deltas[i];
    if (!d || (d.dx === 0 && d.dy === 0)) return;
    for (const id of u.ids) shift.set(id, d);
  });
  if (shift.size === 0) return doc;
  return {
    ...doc,
    pages: doc.pages.map((page) => page.id !== pageId ? page : {
      ...page,
      elements: page.elements.map((el) => {
        const d = shift.get(el.id);
        const b = d ? boxOn(el, canvas) : null;
        return d && b ? withBox(el, canvas, { ...b, x: b.x + d.dx, y: b.y + d.dy }) : el;
      }),
    }),
  };
}

/** Align the selection in one step. `page` is the canvas box a lone unit
 *  aligns to. */
export function alignElements(
  doc: UiDoc, pageId: string, ids: readonly string[], canvas: UiCanvas, mode: UiAlignMode, page?: UiBox,
): UiDoc {
  const units = unitsOf(doc, pageId, ids, canvas);
  return moveUnits(doc, pageId, units, alignUnits(units, mode, page), canvas);
}

export function distributeElements(
  doc: UiDoc, pageId: string, ids: readonly string[], canvas: UiCanvas, axis: "horizontal" | "vertical",
): UiDoc {
  const units = unitsOf(doc, pageId, ids, canvas);
  return moveUnits(doc, pageId, units, distributeUnits(units, axis), canvas);
}

/** Move the selection by a few px — the arrow keys. */
export function nudgeElements(
  doc: UiDoc, pageId: string, ids: readonly string[], canvas: UiCanvas, dx: number, dy: number,
): UiDoc {
  const units = unitsOf(doc, pageId, ids, canvas);
  return moveUnits(doc, pageId, units, units.map(() => ({ dx, dy })), canvas);
}

// ── Stacking order ─────────────────────────────────────────────────────────

export type UiZOrderOp = "forward" | "backward" | "front" | "back";

/** Paint order, bottom first: the compiler sorts by `z` and keeps document
 *  order among equals, so this is exactly what is drawn. */
export function paintOrder(page: UiPage): UiElement[] {
  return page.elements
    .map((el, i) => ({ el, i }))
    .sort((a, b) => (a.el.z ?? 0) - (b.el.z ?? 0) || a.i - b.i)
    .map(({ el }) => el);
}

/**
 * 上移一层 / 下移一层 / 置顶 / 置底.
 *
 * The result is written back as document order. When nothing on the page used
 * `z`, the order alone is the stacking and no `z` is introduced; when some part
 * did, every part gets `z` = its new rank so the two can never disagree.
 */
export function reorderElements(doc: UiDoc, pageId: string, ids: readonly string[], op: UiZOrderOp): UiDoc {
  const page = pageOf(doc, pageId);
  if (!page) return doc;
  const picked = new Set(ids);
  const order = paintOrder(page);
  if (!order.some((el) => picked.has(el.id))) return doc;
  let next: UiElement[];
  if (op === "front") next = [...order.filter((el) => !picked.has(el.id)), ...order.filter((el) => picked.has(el.id))];
  else if (op === "back") next = [...order.filter((el) => picked.has(el.id)), ...order.filter((el) => !picked.has(el.id))];
  else {
    next = [...order];
    // Each picked part hops over the nearest unpicked one in the direction of
    // travel. Walking against that direction keeps a group contiguous.
    if (op === "forward") {
      for (let i = next.length - 2; i >= 0; i--) {
        if (picked.has(next[i]!.id) && !picked.has(next[i + 1]!.id)) {
          // Hop the whole run of picked parts ending here.
          let start = i;
          while (start > 0 && picked.has(next[start - 1]!.id)) start--;
          const run = next.slice(start, i + 1);
          const over = next[i + 1]!;
          next.splice(start, run.length + 1, over, ...run);
          i = start;
        }
      }
    } else {
      for (let i = 1; i < next.length; i++) {
        if (picked.has(next[i]!.id) && !picked.has(next[i - 1]!.id)) {
          let end = i;
          while (end < next.length - 1 && picked.has(next[end + 1]!.id)) end++;
          const run = next.slice(i, end + 1);
          const under = next[i - 1]!;
          next.splice(i - 1, run.length + 1, ...run, under);
          i = end;
        }
      }
    }
  }
  const usesZ = page.elements.some((el) => el.z !== undefined);
  const elements = usesZ ? next.map((el, i) => ({ ...el, z: i })) : next;
  if (!usesZ && elements.every((el, i) => el === page.elements[i])) return doc;
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? { ...p, elements } : p)) };
}

// ── Copy and paste ─────────────────────────────────────────────────────────

/** A deep copy of the picked parts, in paint order, for the clipboard. */
export function copyElements(doc: UiDoc, pageId: string, ids: readonly string[]): UiElement[] {
  const page = pageOf(doc, pageId);
  if (!page) return [];
  const picked = new Set(ids);
  return JSON.parse(JSON.stringify(paintOrder(page).filter((el) => picked.has(el.id)))) as UiElement[];
}

/**
 * How far a paste has to step so the copy is visibly a copy: 0 when nothing on
 * the page sits where the copy would land — pasting onto another page, or
 * after a cut — and one more step for each copy already stacked there. So the
 * first paste of a part onto its own page lands 12px off the original, the
 * second 24px, and a paste onto a different page lands exactly where the part
 * was, which is where the creator arranged it.
 */
export function pasteOffset(page: UiPage, clip: readonly UiElement[], canvas: UiCanvas, step = 12): number {
  const taken = new Set(
    page.elements
      .map((el) => boxOn(el, canvas))
      .filter((b): b is UiBox => b !== null)
      .map((b) => `${b.x},${b.y},${b.w},${b.h}`),
  );
  const boxes = clip.map((el) => boxOn(el, canvas)).filter((b): b is UiBox => b !== null && b.w > 0 && b.h > 0);
  if (boxes.length === 0) return 0;
  for (let k = 0; k < 50; k++) {
    const d = k * step;
    if (!boxes.some((b) => taken.has(`${b.x + d},${b.y + d},${b.w},${b.h}`))) return d;
  }
  return 50 * step;
}

/**
 * Put copied parts onto a page with fresh ids, offset so the copy is visibly a
 * copy (see `pasteOffset`; an explicit `offset` moves only `canvas`). Each copied group becomes a NEW group (so the copy and the original are
 * two things, not one six-part thing), and parts that were one group stay one.
 * The pasted parts go on top.
 */
export function pasteElements(
  doc: UiDoc,
  pageId: string,
  clip: readonly UiElement[],
  stem: string,
  canvas: UiCanvas = "phone",
  offset?: number,
): { doc: UiDoc; ids: string[] } {
  const page = pageOf(doc, pageId);
  if (!page || clip.length === 0) return { doc, ids: [] };
  // Both arrangements step, each by what it needs: a part copied while the
  // desktop is in view would otherwise land exactly on its original on the
  // phone.
  const shift: Record<UiCanvas, number> = offset !== undefined
    ? { phone: canvas === "phone" ? offset : 0, desktop: canvas === "desktop" ? offset : 0 }
    : { phone: pasteOffset(page, clip, "phone"), desktop: pasteOffset(page, clip, "desktop") };
  const groups = new Map<string, string>();
  const taken = new Set(page.elements.map((el) => el.id));
  const ids: string[] = [];
  const topZ = page.elements.reduce((m, el) => Math.max(m, el.z ?? 0), 0);
  const usesZ = page.elements.some((el) => el.z !== undefined);
  const copies = clip.map((src, i) => {
    let id = `${stem}-${i}`;
    for (let n = 2; taken.has(id); n++) id = `${stem}-${i}-${n}`;
    taken.add(id);
    ids.push(id);
    const copy = JSON.parse(JSON.stringify(src)) as UiElement;
    copy.id = id;
    if (src.group) {
      if (!groups.has(src.group)) groups.set(src.group, `g-${stem}-${groups.size}`);
      copy.group = groups.get(src.group)!;
    }
    if (usesZ) copy.z = topZ + 1 + i;
    else delete copy.z;
    let moved = copy;
    for (const c of ["phone", "desktop"] as const) {
      const b = boxOn(moved, c);
      if (!b || !shift[c]) continue;
      // A desktop box that is absent follows the phone numbers already.
      if (c === "desktop" && !moved.desktop && offset === undefined) continue;
      if (b.w <= 0 && b.h <= 0) continue;
      moved = withBox(moved, c, { ...b, x: b.x + shift[c], y: b.y + shift[c] });
    }
    return moved;
  });
  return {
    doc: { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? { ...p, elements: [...p.elements, ...copies] } : p)) },
    ids,
  };
}

// ── Snapping ───────────────────────────────────────────────────────────────

export interface UiGuide {
  /** A vertical line at x (design px), from y `from` to `to`. */
  vertical?: { x: number; from: number; to: number };
  /** A horizontal line at y, from x `from` to `to`. */
  horizontal?: { y: number; from: number; to: number };
}

interface Line { at: number; from: number; to: number }

/** The lines a box can snap to: every other part's edges and centre, and the
 *  page's edges and centre. */
function lines(others: UiBox[], page: UiBox) {
  const xs: Line[] = [];
  const ys: Line[] = [];
  const add = (b: UiBox) => {
    for (const x of [b.x, b.x + b.w / 2, b.x + b.w]) xs.push({ at: x, from: b.y, to: b.y + b.h });
    for (const y of [b.y, b.y + b.h / 2, b.y + b.h]) ys.push({ at: y, from: b.x, to: b.x + b.w });
  };
  add(page);
  for (const o of others) if (o.w > 0 && o.h > 0) add(o);
  return { xs, ys };
}

function nearest(anchors: number[], candidates: Line[], threshold: number) {
  let best: { shift: number; line: Line } | null = null;
  for (const line of candidates) {
    for (const a of anchors) {
      const shift = line.at - a;
      if (Math.abs(shift) <= threshold && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, line };
    }
  }
  return best;
}

/**
 * Where a moving box lands: its left/centre/right onto the nearest vertical
 * line within `threshold`, its top/middle/bottom onto the nearest horizontal.
 * Returns the snapped box and the guides to draw.
 */
export function snapMove(moving: UiBox, others: UiBox[], page: UiBox, threshold: number): { box: UiBox; guide: UiGuide } {
  const { xs, ys } = lines(others, page);
  const bx = nearest([moving.x, moving.x + moving.w / 2, moving.x + moving.w], xs, threshold);
  const by = nearest([moving.y, moving.y + moving.h / 2, moving.y + moving.h], ys, threshold);
  const box = { ...moving, x: moving.x + (bx?.shift ?? 0), y: moving.y + (by?.shift ?? 0) };
  const guide: UiGuide = {};
  if (bx) guide.vertical = { x: bx.line.at, from: Math.min(box.y, bx.line.from), to: Math.max(box.y + box.h, bx.line.to) };
  if (by) guide.horizontal = { y: by.line.at, from: Math.min(box.x, by.line.from), to: Math.max(box.x + box.w, by.line.to) };
  return { box, guide };
}

export interface UiResizeEdges { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }

/** Snap the edges a resize is dragging; the opposite edges stay put. */
export function snapResize(box: UiBox, edges: UiResizeEdges, others: UiBox[], page: UiBox, threshold: number): { box: UiBox; guide: UiGuide } {
  const { xs, ys } = lines(others, page);
  const out = { ...box };
  const guide: UiGuide = {};
  if (edges.left || edges.right) {
    const edgeX = edges.left ? box.x : box.x + box.w;
    const hit = nearest([edgeX], xs, threshold);
    if (hit) {
      if (edges.left) { out.x = box.x + hit.shift; out.w = Math.max(1, box.w - hit.shift); }
      else out.w = Math.max(1, box.w + hit.shift);
      guide.vertical = { x: hit.line.at, from: Math.min(out.y, hit.line.from), to: Math.max(out.y + out.h, hit.line.to) };
    }
  }
  if (edges.top || edges.bottom) {
    const edgeY = edges.top ? box.y : box.y + box.h;
    const hit = nearest([edgeY], ys, threshold);
    if (hit) {
      if (edges.top) { out.y = box.y + hit.shift; out.h = Math.max(1, box.h - hit.shift); }
      else out.h = Math.max(1, box.h + hit.shift);
      guide.horizontal = { y: hit.line.at, from: Math.min(out.x, hit.line.from), to: Math.max(out.x + out.w, hit.line.to) };
    }
  }
  return { box: out, guide };
}

/** Parts a marquee touches. Units are returned whole: brushing a meter's label
 *  picks the meter. */
export function marqueeHits(rect: UiBox, units: UiArrangeUnit[]): string[] {
  const out: string[] = [];
  for (const u of units) {
    const b = u.box;
    if (b.x < rect.x + rect.w && rect.x < b.x + b.w && b.y < rect.y + rect.h && rect.y < b.y + b.h) out.push(...u.ids);
  }
  return out;
}
