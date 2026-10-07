import { useEffect, useLayoutEffect, useRef } from "react";

/** Where a floating editor stands: the row it edits, and the block that row
 *  lives in (the card stands beside the block, level with the row). */
export type FloatingAnchor = { row: DOMRect | null; host: DOMRect | null };

const WIDTH = 360;
const GAP = 12;
const EDGE = 8;

/**
 * A small object's editor, standing on the canvas beside the thing clicked.
 *
 * A variable, a behaviour, a track, a wire's condition: a few settings each.
 * They used to open the right-hand column, which took the eye from the row
 * to the far edge of the screen and took 400px from the board while it was
 * open. Here the editor stands next to the row, follows it while the board
 * pans and zooms, and the board itself does not move at all.
 *
 * The position is written straight to the element every frame rather than
 * through React state: the anchor moves with every pan, glide and relayout,
 * and a render per frame to follow it would be the jank this is meant to
 * remove.
 */
export function FloatingEditor({ container, anchor, onClose, children }: {
  container: HTMLElement | null;
  anchor: () => FloatingAnchor;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !container) return;
    let raf = 0;
    let last = "";
    let lastSide: "left" | "right" | "below" | "above" = "right";
    const place = () => {
      const c = container.getBoundingClientRect();
      const { row, host } = anchorRef.current();
      const box = host ?? row;
      const line = row ?? box;
      const h = el.offsetHeight;
      let x: number;
      let y: number;
      let side: typeof lastSide;
      let room = c.height - EDGE * 2;
      const clampY = (v: number) => Math.max(EDGE, Math.min(v, c.height - EDGE - h));
      const clampX = (v: number) => Math.max(EDGE, Math.min(v, c.width - EDGE - WIDTH));
      if (box && box.right + GAP + WIDTH <= c.right - EDGE) { x = box.right + GAP - c.left; y = clampY((line?.top ?? c.top) - 6 - c.top); side = "right"; }
      else if (box && box.left - GAP - WIDTH >= c.left + EDGE) { x = box.left - GAP - WIDTH - c.left; y = clampY((line?.top ?? c.top) - 6 - c.top); side = "left"; }
      else {
        // No room beside the block: hang under the row like a menu, flush
        // with its right end (where its chips are), never over the row itself
        // — so the card gets the height of the side it hangs on and scrolls.
        x = clampX((line ? Math.min(line.right, c.right) : c.right) - WIDTH - c.left);
        const below = Math.max(EDGE, (line?.bottom ?? c.top) + 6 - c.top);
        const spaceBelow = c.height - EDGE - below;
        const spaceAbove = (line?.top ?? c.top) - 6 - c.top - EDGE;
        if (spaceBelow >= Math.min(h, 320) || spaceBelow >= spaceAbove) { room = spaceBelow; y = below; side = "below"; }
        else { room = spaceAbove; y = EDGE + spaceAbove - Math.min(h, spaceAbove); side = "above"; }
      }
      const key = `${Math.round(x)}|${Math.round(y)}|${Math.round(room)}`;
      if (key !== last) {
        last = key;
        el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        el.style.maxHeight = `${Math.max(160, Math.round(room))}px`;
      }
      if (side !== lastSide) {
        lastSide = side;
        el.style.transformOrigin = side === "left" ? "right top" : side === "right" ? "left top" : side === "below" ? "right top" : "right bottom";
      }
      raf = requestAnimationFrame(place);
    };
    place();
    el.dataset.ready = "";
    return () => cancelAnimationFrame(raf);
  }, [container]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      ref={ref}
      data-floating-editor=""
      className="nowheel absolute left-0 top-0 z-40 flex flex-col overflow-hidden rounded-xl border border-white/[0.09] shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
      style={{ width: WIDTH }}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="floating-editor-enter flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
