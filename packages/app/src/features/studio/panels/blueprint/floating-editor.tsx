import { useEffect, useLayoutEffect, useRef } from "react";
import { STUDIO_BACK_EVENT } from "../../lib/studio-back";

/** Where a floating editor stands: the row it edits, and the block that row
 *  lives in (the card stands beside the block, level with the row). */
export type FloatingAnchor = { row: DOMRect | null; host: DOMRect | null };

/** A few settings. */
export const FLOATING_WIDTH = 360;
/** A whole form — the card, a situation, an AI — which has sections of its own. */
export const FLOATING_WIDE = 440;
const GAP = 12;
const EDGE = 8;

/**
 * Object forms use an unscaled dialog contained by the canvas. Relationship
 * and wire popovers still follow their anchor without re-rendering each frame.
 * Neither presentation takes the assistant's space or traps focus away from it.
 */
export function FloatingEditor({ container, anchor, onClose, width = FLOATING_WIDTH, dialog = false, label, children }: {
  container: HTMLElement | null;
  anchor: () => FloatingAnchor;
  onClose: () => void;
  width?: number;
  /** A readable, unscaled editor bounded by the canvas, below the AI tools. */
  dialog?: boolean;
  label?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !container || dialog) return;
    let raf = 0;
    let last = "";
    let lastSide: "left" | "right" | "below" | "above" = "right";
    const place = () => {
      const c = container.getBoundingClientRect();
      // Never wider than the board leaves room for.
      const WIDTH = Math.min(width, c.width - EDGE * 2);
      if (el.style.width !== `${WIDTH}px`) el.style.width = `${WIDTH}px`;
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
        // A situation zoomed in until it fills the board leaves no side
        // and no gap above or below it: stand at the board's right edge,
        // full height, over the situation rather than squeezed to a sliver.
        if (room < 240) { x = c.width - EDGE - WIDTH; y = EDGE; room = c.height - EDGE * 2; side = "left"; }
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
  }, [container, width, dialog]);

  useLayoutEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement;
    const card = ref.current;
    card?.focus({ preventScroll: true });
    return () => {
      // Keep focus in the assistant if the author moved there while editing.
      if ((document.activeElement === document.body || card?.contains(document.activeElement)) && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [dialog]);

  useEffect(() => {
    const back = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLElement && ref.current?.contains(active)) active.blur();
      closeRef.current();
    };
    // Claim the entry's back step before the shell considers leaving Studio.
    window.addEventListener(STUDIO_BACK_EVENT, back, true);
    return () => window.removeEventListener(STUDIO_BACK_EVENT, back, true);
  }, []);

  // The card stands outside the board's own wheel handling, so a pinch or
  // Ctrl + wheel over it reached the browser and zoomed the whole page. It
  // does nothing here; the board zooms where the board is.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // Escape is this card's only when it is pressed in the card or on the
      // board. In the search box, the assistant or a menu it clears that, not
      // the card the creator is working in.
      const target = event.target instanceof Node ? event.target : null;
      const card = ref.current;
      const page = !target || target === document.body || target === document.documentElement;
      const inCard = !!target && !!card?.contains(target);
      const onBoard = !!target && !!container?.contains(target) && !(target instanceof Element && target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])"));
      if (!page && !inCard && !onBoard) return;
      event.preventDefault();
      // Fields here save on blur, and closing unmounts them first: blur the
      // one being typed in so a value typed and then Escaped is kept.
      const active = document.activeElement;
      if (active instanceof HTMLElement && card?.contains(active)) active.blur();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [container]);

  const card = (
    <div
      ref={ref}
      data-floating-editor=""
      role={dialog ? "dialog" : undefined}
      aria-label={dialog ? label : undefined}
      tabIndex={dialog ? -1 : undefined}
      className={`nowheel flex flex-col overflow-hidden rounded-xl border border-white/[0.09] bg-[#131118] shadow-[0_18px_50px_rgba(0,0,0,0.55)] ${dialog ? "relative h-full min-h-0 w-full max-w-[840px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-400/50" : "absolute left-0 top-0 z-40"}`}
      style={dialog ? undefined : { width }}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="floating-editor-enter flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
  return dialog ? (
    <div data-canvas-entry-overlay className="absolute inset-0 z-40 flex items-center justify-center overflow-hidden modal-backdrop p-3" onWheel={event => event.stopPropagation()} onMouseDown={event => { if (event.target === event.currentTarget) closeRef.current(); }}>
      {card}
    </div>
  ) : card;
}
