import { useEffect, useRef } from "react";

type Viewport = { x: number; y: number; zoom: number };

/**
 * Wheel zoom that glides instead of stepping.
 *
 * The board's own wheel handler (d3-zoom's) applies each wheel event at once,
 * so a mouse wheel — which reports in notches of ~100px — moved the board in
 * 15% jumps, one per notch. Here each event only moves the TARGET zoom; the
 * board eases toward it over the next frames, keeping the point under the
 * pointer where it is. A trackpad's stream of small deltas lands the same way,
 * it just never gets far ahead of the board.
 *
 * Anything marked `nowheel` (a scrolling editor, the floating card) keeps its
 * own wheel.
 */
export function useSmoothWheelZoom({ container, getViewport, setViewport, minZoom, maxZoom, enabled, onGlide, onSettle, clampScroll }: {
  container: React.RefObject<HTMLElement | null>;
  getViewport: () => Viewport;
  setViewport: (viewport: Viewport) => void;
  minZoom: number;
  maxZoom: number;
  enabled: boolean;
  /** Every frame of a glide (the board is moving under its own power). */
  onGlide?: () => void;
  /** The glide came to rest; `point` is where the pointer was, in client px. */
  onSettle?: (zoom: number, point: { x: number; y: number }) => void;
  /** Keeps a wheel scroll on the board: given where it would land, where it
   *  may land. */
  clampScroll?: (viewport: Viewport) => Viewport;
}) {
  const live = useRef({ getViewport, setViewport, minZoom, maxZoom, enabled, onGlide, onSettle, clampScroll });
  live.current = { getViewport, setViewport, minZoom, maxZoom, enabled, onGlide, onSettle, clampScroll };

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let raf = 0;
    let target = 0;
    let anchor = { x: 0, y: 0 };
    let client = { x: 0, y: 0 };
    let last = 0;
    let scrollRest: ReturnType<typeof setTimeout> | 0 = 0;

    const step = (now: number) => {
      const { getViewport, setViewport, onGlide, onSettle } = live.current;
      const vp = getViewport();
      // Frame-rate independent: ~30% of the way per 60Hz frame.
      const dt = Math.min(64, now - (last || now - 16.7));
      last = now;
      const alpha = 1 - Math.pow(0.7, dt / 16.7);
      let zoom = vp.zoom + (target - vp.zoom) * alpha;
      const done = Math.abs(target - zoom) < target * 0.002;
      if (done) zoom = target;
      const fx = (anchor.x - vp.x) / vp.zoom;
      const fy = (anchor.y - vp.y) / vp.zoom;
      setViewport({ x: anchor.x - fx * zoom, y: anchor.y - fy * zoom, zoom });
      onGlide?.();
      if (done) {
        raf = 0;
        last = 0;
        onSettle?.(zoom, client);
        return;
      }
      raf = requestAnimationFrame(step);
    };

    const onWheel = (event: WheelEvent) => {
      const { enabled, getViewport, minZoom, maxZoom } = live.current;
      if (!enabled) return;
      const el = event.target as Element | null;
      if (!el?.closest(".react-flow")) return;
      // The wheel scrolls, the way Figma and PowerPoint do (owner, 10/6): up
      // and down moves the board up and down, Shift + wheel moves it sideways,
      // and Ctrl/⌘ + wheel — or a trackpad pinch, which arrives as Ctrl —
      // zooms.
      const explicitZoom = event.ctrlKey || event.metaKey;
      const zooming = explicitZoom;
      // Something on the board that scrolls (an editor, a list) keeps the
      // wheel while it can still move that way; a scroll that has nowhere to
      // go inside it carries on down the board, the way nested page regions
      // hand off. The interface preview is marked `nowheel` and rarely
      // scrolls, and over it the board used to stand still.
      if (el.closest(".nowheel")) {
        if (explicitZoom) return;
        const path = event.composedPath();
        for (const node of path) {
          if (!(node instanceof HTMLElement) || node.classList.contains("react-flow")) break;
          const style = getComputedStyle(node);
          if (!/(auto|scroll)/.test(style.overflowY + style.overflowX)) continue;
          if (event.deltaY > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : event.deltaY < 0 && node.scrollTop > 0) return;
        }
      }
      const flowEl = el.closest<HTMLElement>(".react-flow")!;
      event.preventDefault();
      event.stopPropagation();
      // A trackpad swipe (or Shift + wheel) moves the board. The board still
      // opens at 100%, so a wheel that zooms no longer meets a thumbnail.
      if (!zooming) {
        if (raf) { cancelAnimationFrame(raf); raf = 0; last = 0; }
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode ? flowEl.clientHeight : 1;
        const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
        const dy = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
        const vp = getViewport();
        const next = { x: vp.x - dx, y: vp.y - dy, zoom: vp.zoom };
        live.current.setViewport(live.current.clampScroll ? live.current.clampScroll(next) : next);
        live.current.onGlide?.();
        if (scrollRest) clearTimeout(scrollRest);
        const at = { x: event.clientX, y: event.clientY };
        scrollRest = setTimeout(() => { scrollRest = 0; live.current.onSettle?.(getViewport().zoom, at); }, 140);
        return;
      }
      // d3-zoom's own scale, so a notch is still the step people know. A
      // trackpad pinch arrives as Ctrl + small deltas and is boosted tenfold
      // (d3-zoom does the same); a mouse notch with Ctrl held is ~100px and,
      // boosted too, zoomed 4x per notch — two notches went from the largest
      // size to the smallest. A notch is a notch, Ctrl or not.
      const pinch = event.ctrlKey && event.deltaMode === 0 && Math.abs(event.deltaY) < 50;
      const delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * (pinch ? 10 : 1);
      const from = raf ? target : getViewport().zoom;
      target = Math.max(minZoom, Math.min(maxZoom, from * Math.pow(2, delta)));
      const box = flowEl.getBoundingClientRect();
      anchor = { x: event.clientX - box.left, y: event.clientY - box.top };
      client = { x: event.clientX, y: event.clientY };
      if (!raf) raf = requestAnimationFrame(step);
    };

    // Capture, ahead of d3-zoom's listener on the pane below; not passive,
    // or the page would scroll as well.
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    // Any press stops a glide: grabbing the board has to hold it.
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; last = 0; } };
    root.addEventListener("pointerdown", stop, true);
    return () => {
      root.removeEventListener("wheel", onWheel, true);
      root.removeEventListener("pointerdown", stop, true);
      if (scrollRest) clearTimeout(scrollRest);
      stop();
    };
  }, [container]);
}
