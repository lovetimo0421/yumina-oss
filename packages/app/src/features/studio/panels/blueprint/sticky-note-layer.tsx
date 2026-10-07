import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReactFlow } from "@xyflow/react";
import { Link2Off, Minus, X } from "lucide-react";
import type { GraphLayout } from "@yumina/engine";
import { cn } from "@/lib/utils";

/**
 * Sticky notes (便签) on the canvas.
 *
 * A note is a square of paper stuck onto the things it is about — one entry,
 * a variable, a behaviour, an AI, a block, a scenario, or several of them at
 * once — with a thread to each. It folds down to a small square and opens
 * again. The creator explains a part to the assistant and to outside AIs this
 * way: every note reaches them with what it is stuck to.
 *
 * Gestures, all the same idea: add a note with things selected and it sticks
 * to all of them; drag a note onto a thing and it sticks to that thing — or,
 * when that thing is part of a selection, to the whole selection.
 */

type Note = NonNullable<GraphLayout["notes"]>[number];
type Rect = { x1: number; y1: number; x2: number; y2: number };

export const NOTE_COLORS = {
  yellow: { paper: "linear-gradient(170deg,#fff6b8 0%,#ffe98a 100%)", ink: "#4a3a10", line: "rgba(120,90,20,0.13)", thread: "#e0b83a" },
  pink: { paper: "linear-gradient(170deg,#ffe0e9 0%,#ffc4d6 100%)", ink: "#5b2234", line: "rgba(140,40,70,0.12)", thread: "#e47b9c" },
  blue: { paper: "linear-gradient(170deg,#e0f0ff 0%,#c3e1ff 100%)", ink: "#1d3956", line: "rgba(30,70,120,0.12)", thread: "#6aa8e2" },
  green: { paper: "linear-gradient(170deg,#e6f7d2 0%,#cdeeaf 100%)", ink: "#2b4818", line: "rgba(50,100,30,0.12)", thread: "#7cc052" },
} as const;
export type NoteColor = keyof typeof NOTE_COLORS;

const NOTE_MIN_W = 160;
const NOTE_MIN_H = 40;
/** How tall a note grows by itself to show its words. */
const NOTE_MAX_FIT_H = 160;
/** A new note: one line of words under a thin bar. */
export const NOTE_SIZE = { w: 200, h: 44 };
/** Notes made at an earlier default size take today's. */
const heightOf = (n: { h: number }) => (n.h === 150 || n.h === 78 ? NOTE_SIZE.h : n.h);
/** Above every block on the board (an entry block lifts itself to ~1000). */
const Z_THREADS = 3000;
const Z_NOTE = 3001;

const HAND = '"Segoe Print","Bradley Hand","Comic Sans MS","KaiTi","STKaiti","Kaiti SC",cursive';

/** What a note is stuck to (older notes carry one `on`). */
export const noteTargets = (n: Note): string[] => n.targets?.length ? n.targets : n.on ? [n.on] : [];

function tiltOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 5) - 2) * 0.8;
}

const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'));

/** The element on the board a canvas id is drawn as. */
function elementFor(root: Element, id: string): Element | null {
  if (id.startsWith("ai:")) return root.querySelector(`[data-place-ai="${esc(id.slice(3))}"]`);
  return root.querySelector(`.react-flow__node[data-id="${esc(id)}"]`)
    ?? root.querySelector(`[data-row-anchor="${esc(id)}"]`)
    ?? root.querySelector(`[data-canvas-writing-object="${esc(id)}"]`);
}

/** The canvas id of whatever is under the pointer, if it is something a note can stick to. */
export function targetIdAt(x: number, y: number): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest("[data-sticky-note]")) continue;
    const hit = el.closest("[data-row-anchor],[data-canvas-writing-object],[data-place-ai],.react-flow__node");
    if (!hit) continue;
    const h = hit as HTMLElement;
    if (h.dataset.rowAnchor) return h.dataset.rowAnchor;
    if (h.dataset.canvasWritingObject) return h.dataset.canvasWritingObject;
    if (h.dataset.placeAi) return `ai:${h.dataset.placeAi}`;
    const id = h.getAttribute("data-id");
    if (id && !id.startsWith("situation-group") && !id.startsWith("piece-slot")) return id;
  }
  return null;
}

export function StickyNoteLayer({
  notes,
  write,
  readOnly,
  editingId,
  onEdited,
  multi,
  hostOf,
  layoutKey,
}: {
  notes: Note[];
  write: (next: Note[]) => void;
  readOnly: boolean;
  editingId: string | null;
  onEdited: () => void;
  /** What is selected right now: a note dropped on one of these sticks to all. */
  multi: ReadonlySet<string>;
  /** Where a target that is not drawn (a row in a folded block) stands instead. */
  hostOf: (id: string) => string | null;
  /** Changes when the board lays itself out again, so threads follow. */
  layoutKey: unknown;
}) {
  const { t } = useTranslation("editor");
  const rf = useReactFlow();
  const [rects, setRects] = useState<Record<string, Rect>>({});
  /** Every block on the board: a note stands clear of all of them. */
  const [blocks, setBlocks] = useState<Rect[]>([]);
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "size"; dx: number; dy: number; over?: Rect[] } | null>(null);
  const draggingRef = useRef(false);

  const flowRectOf = useCallback((el: Element): Rect | null => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    const a = rf.screenToFlowPosition({ x: r.left, y: r.top });
    const b = rf.screenToFlowPosition({ x: r.right, y: r.bottom });
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }, [rf]);
  const allTargets = useMemo(() => [...new Set(notes.flatMap(noteTargets))], [notes]);
  const measure = useCallback(() => {
    const root = document.querySelector(".react-flow");
    if (!root) return;
    const next: Record<string, Rect> = {};
    for (const id of allTargets) {
      const el = elementFor(root, id) ?? (() => { const h = hostOf(id); return h ? elementFor(root, h) : null; })();
      const r = el && flowRectOf(el);
      if (r) next[id] = r;
    }
    setRects((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    const all = [...root.querySelectorAll(".react-flow__node")].map(flowRectOf).filter((r): r is Rect => r !== null);
    setBlocks((prev) => (JSON.stringify(prev) === JSON.stringify(all) ? prev : all));
  }, [allTargets, hostOf, flowRectOf]);
  useLayoutEffect(() => {
    measure();
    // The board glides into a new layout; measure again once it has.
    const a = window.setTimeout(measure, 120);
    const b = window.setTimeout(measure, 420);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, [measure, layoutKey, notes]);

  const update = (id: string, patch: Partial<Note>) => write(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));

  /** Where each note stands on the board. A stuck note stands just outside
   *  the block its first target is in, level with the target, and never on
   *  top of a block or another note: a block in the way pushes it right, a
   *  note in the way pushes it down. */
  const places = new Map<string, { x: number; y: number; anchor: Rect | null }>();
  const taken: Rect[] = [];
  const GAP = 18;
  for (const n of notes) {
    const anchor = noteTargets(n).map((id) => rects[id]).find(Boolean) ?? null;
    const w = n.collapsed ? 34 : Math.max(NOTE_MIN_W, n.w);
    const h = n.collapsed ? 34 : Math.max(NOTE_MIN_H, heightOf(n));
    if (!anchor) {
      places.set(n.id, { x: n.x, y: n.y, anchor: null });
      taken.push({ x1: n.x, y1: n.y, x2: n.x + w, y2: n.y + h });
      continue;
    }
    // The outermost block holding the target (the frame it sits in).
    const cx = (anchor.x1 + anchor.x2) / 2;
    const cy = (anchor.y1 + anchor.y2) / 2;
    const outer = blocks
      .filter((b) => b.x1 <= cx && cx <= b.x2 && b.y1 <= cy && cy <= b.y2)
      .reduce<Rect>((best, b) => ((b.x2 - b.x1) * (b.y2 - b.y1) > (best.x2 - best.x1) * (best.y2 - best.y1) ? b : best), anchor);
    const free = (x: number, y: number) => ![...blocks, ...taken].some((b) =>
      x < b.x2 + GAP && x + w + GAP > b.x1 && y < b.y2 + GAP && y + h + GAP > b.y1);
    // The nearest clear spot: beside the frame level with the target, then a
    // little lower or higher, then the frame's other side, then further out.
    const y0 = anchor.y1 - 8;
    const right = outer.x2 + GAP + 10;
    const left = outer.x1 - GAP - 10 - w;
    let p: { x: number; y: number; anchor: Rect } | null = null;
    // The right side first, well up and down; the left only when the right is full.
    for (const x of [right, left]) {
      for (let step = 0; step <= 50 && !p; step++) {
        const dy = (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 24;
        if (free(x, y0 + dy)) p = { x, y: y0 + dy, anchor };
      }
      if (p) break;
    }
    if (!p) {
      p = { x: right, y: y0, anchor };
      for (let guard = 0; guard < 80 && !free(p.x, p.y); guard++) p.x += 120;
    }
    taken.push({ x1: p.x, y1: p.y, x2: p.x + w, y2: p.y + h });
    places.set(n.id, p);
  }
  const placeOf = (n: Note) => places.get(n.id) ?? { x: n.x, y: n.y, anchor: null };

  /** What a note carried to here would stick to, outlined while it is carried. */
  const overAt = (ev: PointerEvent, note: Note): Rect[] | undefined => {
    const hit = targetIdAt(ev.clientX, ev.clientY);
    if (!hit || noteTargets(note).includes(hit)) return undefined;
    const root = document.querySelector(".react-flow");
    if (!root) return undefined;
    const ids = multi.has(hit) && multi.size > 1 ? [...multi] : [hit];
    return ids.map((id) => { const el = elementFor(root, id); return el ? flowRectOf(el) : null; }).filter((r): r is Rect => r !== null);
  };

  const startDrag = (event: React.PointerEvent<HTMLElement>, note: Note, mode: "move" | "size") => {
    if (readOnly || event.button !== 0 || (event.target as Element).closest("button,textarea")) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const zoom = rf.getZoom() || 1;
    const start = { x: event.clientX, y: event.clientY };
    const delta = (ev: PointerEvent) => ({ dx: (ev.clientX - start.x) / zoom, dy: (ev.clientY - start.y) / zoom });
    handle.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    const move = (ev: PointerEvent) => setDrag({ id: note.id, mode, ...delta(ev), over: mode === "move" ? overAt(ev, note) : undefined });
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      draggingRef.current = false;
      setDrag(null);
      const { dx, dy } = delta(ev);
      if (Math.abs(dx) + Math.abs(dy) < 3) {
        // A tap on a folded note opens it.
        if (mode === "move" && note.collapsed) update(note.id, { collapsed: undefined });
        return;
      }
      if (mode === "size") {
        update(note.id, { w: Math.max(NOTE_MIN_W, Math.round(note.w + dx)), h: Math.max(NOTE_MIN_H, Math.round(heightOf(note) + dy)) });
        return;
      }
      // Dropped on something: stuck to it (or to the whole selection it is
      // part of). Dropped anywhere else, or back on its own: just moved.
      const current = noteTargets(note);
      const hit = targetIdAt(ev.clientX, ev.clientY);
      if (hit && !current.includes(hit)) {
        const targets = multi.has(hit) && multi.size > 1 ? [...multi] : [hit];
        update(note.id, { targets, on: undefined, x: 0, y: 0 });
        return;
      }
      // A stuck note keeps its place beside what it is stuck to; a loose one moves.
      if (current.length === 0) update(note.id, { x: Math.round(note.x + dx), y: Math.round(note.y + dy) });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
    <>
      {/* The threads: from each note to every thing it is stuck to. */}
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} style={{ zIndex: Z_THREADS }} aria-hidden>
        {drag?.over?.map((r, i) => (
          <rect key={`over-${i}`} x={r.x1 - 3} y={r.y1 - 3} width={r.x2 - r.x1 + 6} height={r.y2 - r.y1 + 6} rx={7}
            fill="rgba(255,214,90,0.16)" stroke="#f5c542" strokeWidth={2.5} />
        ))}
        {notes.map((n) => {
          const d = drag?.id === n.id && drag.mode === "move" ? drag : null;
          const p = placeOf(n);
          const nx = p.x + (d?.dx ?? 0);
          const nw = n.collapsed ? 34 : Math.max(NOTE_MIN_W, n.w);
          const color = NOTE_COLORS[(n.color as NoteColor) ?? "yellow"]?.thread ?? NOTE_COLORS.yellow.thread;
          return noteTargets(n).map((id) => {
            const r = rects[id];
            if (!r) return null;
            // From the note's near edge to the target's near edge.
            const onRight = nx >= (r.x1 + r.x2) / 2;
            const from = { x: onRight ? nx + 6 : nx + nw - 6, y: p.y + (d?.dy ?? 0) + 16 };
            const to = { x: onRight ? r.x2 : r.x1, y: (r.y1 + r.y2) / 2 };
            const mid = Math.max(30, Math.abs(from.x - to.x) / 2) * (onRight ? 1 : -1);
            return (
              <g key={`${n.id}:${id}`} opacity={0.75}>
                <path d={`M ${from.x} ${from.y} C ${from.x - mid} ${from.y}, ${to.x + mid} ${to.y}, ${to.x} ${to.y}`} fill="none" stroke={color} strokeWidth={1.6} strokeDasharray="5 4" />
                <circle cx={to.x} cy={to.y} r={3.2} fill={color} />
              </g>
            );
          });
        })}
      </svg>
      {notes.map((n) => {
        const d = drag?.id === n.id ? drag : null;
        const p = placeOf(n);
        const left = p.x + (d?.mode === "move" ? d.dx : 0);
        const top = p.y + (d?.mode === "move" ? d.dy : 0);
        const palette = NOTE_COLORS[(n.color as NoteColor) ?? "yellow"] ?? NOTE_COLORS.yellow;
        const count = noteTargets(n).length;
        const tilt = tiltOf(n.id);
        if (n.collapsed) {
          // Folded: a small square of the same paper, a pin, how many things.
          return (
            <div
              key={n.id}
              data-sticky-note={n.id}
              data-collapsed=""
              title={n.text}
              onPointerDown={(e) => startDrag(e, n, "move")}
              className={cn("nodrag nopan nowheel pointer-events-auto absolute select-none", !readOnly && "cursor-pointer")}
              style={{ left, top, width: 34, height: 34, transform: `rotate(${tilt * 2}deg)`, zIndex: d ? Z_NOTE + 1 : Z_NOTE, opacity: d ? 0.85 : 1 }}
            >
              <div className="relative h-full w-full rounded-[3px] shadow-[0_6px_14px_rgba(0,0,0,0.45)]" style={{ background: palette.paper }}>
                <span className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border border-black/20 shadow" style={{ background: palette.thread }} />
                <span className="absolute bottom-0 right-0 h-2.5 w-2.5" style={{ background: "linear-gradient(135deg, transparent 50%, rgba(0,0,0,0.18) 50%)" }} />
                {count > 1 && <span className="absolute -bottom-1.5 -right-1.5 rounded-full bg-black/70 px-1 text-[9px] font-bold leading-[14px] text-white">{count}</span>}
              </div>
            </div>
          );
        }
        const w = Math.max(NOTE_MIN_W, n.w + (d?.mode === "size" ? d.dx : 0));
        const h = Math.max(NOTE_MIN_H, heightOf(n) + (d?.mode === "size" ? d.dy : 0));
        return (
          <div
            key={n.id}
            data-sticky-note={n.id}
            className="nodrag nopan nowheel pointer-events-auto absolute select-text"
            style={{ left, top, width: w, height: h, transform: `rotate(${tilt}deg)`, zIndex: d ? Z_NOTE + 1 : Z_NOTE, opacity: d?.mode === "move" ? 0.88 : 1 }}
          >
            {/* The tape it hangs from: also where it is carried. */}
            <div
              onPointerDown={(e) => startDrag(e, n, "move")}
              className={cn("absolute -top-2 left-1/2 z-10 h-3.5 w-12 -translate-x-1/2 rounded-[2px] border border-white/40 shadow-sm backdrop-blur-[1px]", !readOnly && "cursor-grab active:cursor-grabbing")}
              style={{ transform: "translateX(-50%) rotate(-4deg)", background: "linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.32))" }}
            />
            <div
              className="relative flex h-full w-full flex-col overflow-hidden rounded-[3px] shadow-[0_14px_28px_rgba(0,0,0,0.45),0_2px_4px_rgba(0,0,0,0.25)]"
              style={{ background: palette.paper, color: palette.ink }}
            >
              <div onPointerDown={(e) => startDrag(e, n, "move")} className={cn("flex h-4 items-center gap-0.5 px-1.5 pt-1", !readOnly && "cursor-grab active:cursor-grabbing")}>
                {count > 0 && (
                  <span className="rounded-full px-1 text-[9px] font-semibold leading-[12px]" style={{ background: "rgba(0,0,0,0.08)" }} title={t("blueprint.notes.stuckTo", { count })}>
                    📌 {count}
                  </span>
                )}
                <span className="flex-1" />
                {!readOnly && (Object.keys(NOTE_COLORS) as NoteColor[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    onClick={() => update(n.id, { color: c === "yellow" ? undefined : c })}
                    className={cn("h-2 w-2 rounded-full border border-black/15", ((n.color ?? "yellow") === c) && "ring-1 ring-black/40")}
                    style={{ background: NOTE_COLORS[c].thread }}
                  />
                ))}
                {!readOnly && count > 0 && (
                  <button type="button" title={t("blueprint.notes.unstick")} onClick={() => update(n.id, { targets: undefined, on: undefined, x: Math.round(p.x), y: Math.round(p.y) })} className="rounded p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100">
                    <Link2Off className="h-2.5 w-2.5" />
                  </button>
                )}
                <button type="button" title={t("blueprint.notes.fold")} onClick={() => update(n.id, { collapsed: true })} className="rounded p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100">
                  <Minus className="h-2.5 w-2.5" />
                </button>
                {!readOnly && (
                  <button type="button" title={t("blueprint.insp.delete")} data-note-delete="" onClick={() => write(notes.filter((x) => x.id !== n.id))} className="rounded p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100">
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
              <textarea
                autoFocus={editingId === n.id}
                defaultValue={n.text}
                readOnly={readOnly}
                placeholder={t("blueprint.notePlaceholder")}
                onBlur={(e) => {
                  onEdited();
                  // Done writing: the note grows to show what was written (up to
                  // a point) and reads from its first line again.
                  const ta = e.target;
                  const extra = ta.scrollHeight - ta.clientHeight;
                  ta.scrollTop = 0;
                  const grown = extra > 2 ? Math.min(NOTE_MAX_FIT_H, heightOf(n) + extra) : undefined;
                  if (ta.value !== n.text || (grown && grown > heightOf(n))) update(n.id, { text: ta.value, ...(grown && grown > heightOf(n) ? { h: Math.round(grown) } : {}) });
                }}
                className="min-h-0 w-full flex-1 resize-none bg-transparent px-2.5 pb-1 pt-0.5 text-[13px] leading-[20px] outline-none placeholder:opacity-40"
                style={{
                  color: palette.ink,
                  fontFamily: HAND,
                  backgroundImage: `repeating-linear-gradient(transparent 0 19px, ${palette.line} 19px 20px)`,
                  backgroundAttachment: "local",
                }}
              />
              {/* The folded corner, which sizes it. */}
              {!readOnly && (
                <span
                  aria-hidden
                  onPointerDown={(e) => startDrag(e, n, "size")}
                  className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize"
                  style={{ background: "linear-gradient(135deg, transparent 50%, rgba(0,0,0,0.16) 50%, rgba(0,0,0,0.05) 100%)" }}
                />
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
