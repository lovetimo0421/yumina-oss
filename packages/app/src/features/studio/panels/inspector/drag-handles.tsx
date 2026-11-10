import { useCallback, useEffect, useRef, useState } from "react";
import type { Rect } from "./use-inspector";

/**
 * Moving and resizing a selected part by dragging it.
 *
 * The panel's number fields are exact and slow; this is the other half. It
 * draws over the selection highlight, so the geometry it works in is screen
 * pixels — and the document's geometry is design pixels on a canvas that is
 * being scaled to fit. The conversion is not a constant to look up:
 *
 *   scale = the selection's width on screen ÷ its width in the document
 *
 * which is measured from the two things already in hand, and so is right for
 * whichever canvas is in force without either side being told which that is.
 *
 * ── Why a pointer capture rather than window listeners ──
 *
 * The card underneath is a live frontend in a shadow root with its own
 * handlers. `setPointerCapture` routes every move to this element until the
 * button comes up, so a drag that passes over a button in the card does not
 * hover it, and one that leaves the stage entirely does not stop mid-gesture.
 */

export type DragEdge = "move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "w" | "e";

export interface DragDelta {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** What each grip does to the box, in design px, given a pointer delta. */
function deltaFor(edge: DragEdge, dx: number, dy: number): DragDelta {
  switch (edge) {
    case "move": return { dx, dy, dw: 0, dh: 0 };
    case "nw": return { dx, dy, dw: -dx, dh: -dy };
    case "ne": return { dx: 0, dy, dw: dx, dh: -dy };
    case "sw": return { dx, dy: 0, dw: -dx, dh: dy };
    case "se": return { dx: 0, dy: 0, dw: dx, dh: dy };
    case "n": return { dx: 0, dy, dw: 0, dh: -dy };
    case "s": return { dx: 0, dy: 0, dw: 0, dh: dy };
    case "w": return { dx, dy: 0, dw: -dx, dh: 0 };
    case "e": return { dx: 0, dy: 0, dw: dx, dh: 0 };
  }
}

interface Grip {
  edge: DragEdge;
  style: React.CSSProperties;
  cursor: string;
  /** The dimension this grip consumes. Below the threshold it would sit on top
   *  of the body instead of beside it, so it is not drawn. */
  needs?: "width" | "height";
}

const GRIPS: Grip[] = [
  { edge: "nw", style: { left: -4, top: -4 }, cursor: "nwse-resize" },
  { edge: "ne", style: { right: -4, top: -4 }, cursor: "nesw-resize" },
  { edge: "sw", style: { left: -4, bottom: -4 }, cursor: "nesw-resize" },
  { edge: "se", style: { right: -4, bottom: -4 }, cursor: "nwse-resize" },
  // A top/bottom grip eats HEIGHT, so it is the one a short element cannot
  // afford; a left/right grip eats WIDTH. Naming the dimension each one costs
  // rather than the one it resizes — the first attempt had these the wrong way
  // round, and a 6px-tall meter kept a grip across its middle that turned
  // every drag into a stretch.
  { edge: "n", style: { left: "50%", top: -4, marginLeft: -4 }, cursor: "ns-resize", needs: "height" },
  { edge: "s", style: { left: "50%", bottom: -4, marginLeft: -4 }, cursor: "ns-resize", needs: "height" },
  { edge: "w", style: { left: -4, top: "50%", marginTop: -4 }, cursor: "ew-resize", needs: "width" },
  { edge: "e", style: { right: -4, top: "50%", marginTop: -4 }, cursor: "ew-resize", needs: "width" },
];

/**
 * A meter's track is six design-px tall. At that size the eight grips cover the
 * element completely, so a press meant to MOVE it lands on a resize grip and
 * the thing refuses to budge — which is exactly what it did.
 *
 * So an edge grip appears only when there is room for it beside the corners.
 * Below that the corners still resize and the whole element is a drag handle,
 * which is the behaviour that matters on something too thin to aim at.
 */
const ROOM_FOR_EDGE_GRIP = 34;

/**
 * A grip's hit area and its drawn square, in screen px. A mouse aims at an
 * 8px square fine; a finger needs 24px or more to land on anything (WCAG's
 * minimum target), so on a coarse pointer the grip is a 28px invisible pad
 * around a 12px square.
 */
export function gripSizes(coarse: boolean): { hit: number; dot: number } {
  return coarse ? { hit: 28, dot: 12 } : { hit: 8, dot: 8 };
}

const coarsePointer = (): boolean => {
  try { return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches; } catch { return false; }
};

/** Re-express a grip's anchor (written for an 8px grip at -4px) for a grip of
 *  `hit` px, so its centre stays on the corner or edge it belongs to. */
function gripStyle(style: React.CSSProperties, hit: number): React.CSSProperties {
  const half = hit / 2;
  const out: React.CSSProperties = { width: hit, height: hit };
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const v = style[side];
    if (v === undefined) continue;
    out[side] = typeof v === "number" ? -half : v;
  }
  if (style.marginLeft !== undefined) out.marginLeft = -half;
  if (style.marginTop !== undefined) out.marginTop = -half;
  return out;
}

/** A guide the drag is currently snapped to, in SCREEN px relative to the stage. */
export interface Guide {
  vertical?: { x: number; from: number; to: number };
  horizontal?: { y: number; from: number; to: number };
}

export function DragHandles({
  rect, designWidth, onDrag, onCommit, onCancel, onSnap, guide, onDoubleClick, keepAspect = false,
}: {
  /** A picture: corners keep its proportions unless Shift is held. */
  keepAspect?: boolean;
  /** The selection, in screen px, relative to the stage. */
  rect: Rect;
  /** The same box's width in DESIGN px — the other half of the scale. */
  designWidth: number;
  /** Fires continuously during the gesture, in design px. */
  onDrag: (delta: DragDelta) => void;
  /** Fires once when the pointer comes up, so one drag is one undo step. */
  onCommit: () => void;
  /** Fires when Escape abandons the gesture, after the boxes have been put
   *  back — the host still has a drag to close (its undo batch, its origin). */
  onCancel?: () => void;
  /** Adjusts a move or a resize so the edges it drags land on a neighbour's
   *  edge or centre, or the page's. Alt held means "exactly where I put it". */
  onSnap?: (delta: DragDelta, edge: DragEdge, free: boolean) => DragDelta;
  /** What to draw for the snap currently in force. */
  guide?: Guide | null;
  /** Double-clicking the selection — edit its words in place. */
  onDoubleClick?: () => void;
}) {
  const [dragging, setDragging] = useState<DragEdge | null>(null);
  const start = useRef({ x: 0, y: 0, scale: 1, ratio: 0 });
  const [coarse] = useState(coarsePointer);
  const { hit, dot } = gripSizes(coarse);
  // Edge grips need room beside the corners, and a finger's corners take more.
  const roomForEdge = Math.max(ROOM_FOR_EDGE_GRIP, hit * 2 + 12);

  // A zero-width selection would make the scale infinite; a zero scale would
  // make every drag a no-op. Neither is a state worth dragging in.
  const scale = designWidth > 0 ? rect.width / designWidth : 0;

  const onPointerDown = useCallback(
    (edge: DragEdge) => (event: React.PointerEvent) => {
      if (event.button !== 0 || scale <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      (event.target as Element).setPointerCapture(event.pointerId);
      start.current = { x: event.clientX, y: event.clientY, scale, ratio: rect.height > 0 ? rect.width / rect.height : 0 };
      setDragging(edge);
    },
    [scale, rect.width, rect.height],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging) return;
      event.preventDefault();
      const { x, y, scale: s, ratio } = start.current;
      let mx = Math.round((event.clientX - x) / s);
      let my = Math.round((event.clientY - y) / s);
      // As in Slides: Shift while moving keeps to one axis; a corner keeps
      // the box's proportions (always for a picture, Shift frees it there).
      if (dragging === "move" && event.shiftKey) {
        if (Math.abs(mx) >= Math.abs(my)) my = 0; else mx = 0;
      }
      const corner = dragging === "nw" || dragging === "ne" || dragging === "sw" || dragging === "se";
      if (corner && ratio > 0 && (keepAspect ? !event.shiftKey : event.shiftKey)) {
        const sx = dragging === "nw" || dragging === "sw" ? -1 : 1;
        const sy = dragging === "nw" || dragging === "ne" ? -1 : 1;
        // Follow whichever way the pointer went further, the other side to match.
        const dw = Math.abs(mx) >= Math.abs(my) * ratio ? sx * mx : sy * my * ratio;
        mx = sx * dw;
        my = sy * Math.round(dw / ratio);
      }
      const raw = deltaFor(dragging, mx, my);
      onDrag(onSnap ? onSnap(raw, dragging, event.altKey) : raw);
    },
    [dragging, onDrag, onSnap, keepAspect],
  );

  const end = useCallback(() => {
    if (!dragging) return;
    setDragging(null);
    onCommit();
  }, [dragging, onCommit]);

  // Escape abandons a drag the way it abandons everything else on this page.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onDrag({ dx: 0, dy: 0, dw: 0, dh: 0 });
      setDragging(null);
      onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging, onDrag, onCancel]);

  // A grip sits inside the body, so without this its pointer events bubble on
  // to the body's own handlers: every move applied twice, and the release
  // committed twice.
  const gripMove = useCallback((event: React.PointerEvent) => {
    event.stopPropagation();
    onPointerMove(event);
  }, [onPointerMove]);
  const gripEnd = useCallback((event: React.PointerEvent) => {
    event.stopPropagation();
    end();
  }, [end]);

  return (
    <>
      {/* Guides are drawn outside the handle box so they can run the length of
          the stage rather than being clipped to the selection. */}
      {dragging && guide?.vertical && (
        <div
          className="pointer-events-none absolute w-px bg-sky-400"
          style={{ left: guide.vertical.x, top: guide.vertical.from, height: Math.max(1, guide.vertical.to - guide.vertical.from) }}
        />
      )}
      {dragging && guide?.horizontal && (
        <div
          className="pointer-events-none absolute h-px bg-sky-400"
          style={{ top: guide.horizontal.y, left: guide.horizontal.from, width: Math.max(1, guide.horizontal.to - guide.horizontal.from) }}
        />
      )}
    <div
      className="pointer-events-auto absolute"
      // touch-action: none — a finger on the selection moves the part instead
      // of scrolling the page under it.
      style={{ ...rect, cursor: dragging === "move" || !dragging ? "move" : undefined, touchAction: "none" }}
      onPointerDown={onPointerDown("move")}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onDoubleClick ? (e) => { e.stopPropagation(); onDoubleClick(); } : undefined}
    >
      {GRIPS.filter((grip) =>
        grip.needs === "width" ? rect.width >= roomForEdge
        : grip.needs === "height" ? rect.height >= roomForEdge
        : true,
      ).map((grip) => (
        <div
          key={grip.edge}
          role="presentation"
          aria-label={grip.edge}
          onPointerDown={onPointerDown(grip.edge)}
          onPointerMove={gripMove}
          onPointerUp={gripEnd}
          onPointerCancel={gripEnd}
          data-grip={grip.edge}
          className="absolute flex items-center justify-center"
          style={{ ...gripStyle(grip.style, hit), cursor: grip.cursor, touchAction: "none" }}
        >
          <span className="pointer-events-none rounded-[2px] border border-primary bg-background" style={{ width: dot, height: dot }} />
        </div>
      ))}
    </div>
    </>
  );
}
