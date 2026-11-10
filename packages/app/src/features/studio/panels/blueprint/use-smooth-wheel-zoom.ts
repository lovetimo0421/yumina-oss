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
 * own wheel. A text box keeps it only once it has been clicked into.
 *
 * Touch moves and pinches the board here too, blocks included.
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

    // The text box the creator clicked (or tapped) into. Only that one scrolls
    // under a swipe; any other is just text on the board, and the swipe moves
    // the board. Focus alone does not count: an entry opened from its chevron
    // takes focus by itself, and then filled the screen with a scroller.
    let engaged: HTMLElement | null = null;
    const textOf = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLElement>("textarea, [contenteditable=true]") : null;
    const idleText = (node: Element) =>
      (node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable))
      && !(engaged && (node === engaged || node.contains(engaged) || engaged.contains(node)));
    const onClick = (event: MouseEvent) => {
      const text = textOf(event.target);
      if (text) engaged = text;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (engaged && event.target === engaged) engaged = null;
    };

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
      // A zoom gesture over one of them zooms the board: let through, the
      // browser zoomed the whole page instead.
      if (el.closest(".nowheel") && !explicitZoom) {
        const path = event.composedPath();
        for (const node of path) {
          if (!(node instanceof Element) || node.classList.contains("react-flow")) break;
          // An icon's <svg>/<path> under the pointer is not the end of the
          // way up: stopping there handed a scroll over a form's icon to the
          // board.
          if (!(node instanceof HTMLElement)) continue;
          // Text that is only being looked at is not being read line by line:
          // the board moves. Swiping across an open lore entry of 8,000
          // characters scrolled the entry, a screen of it per swipe, and the
          // board would not budge until it ran out (owner's demo, 10/17).
          if (idleText(node)) continue;
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

    // Touch. React Flow marks every block it can drag `nopan`, and d3-zoom
    // drops a touch that starts on one: on a touch screen a swipe or a pinch
    // that landed on a block did nothing, and a block taller than the screen
    // (a long 条件设定) left nowhere else to put a finger. The board takes
    // its touches itself, on a block or off one: one finger moves it, two
    // pinch it about the point between them. A finger in a field, on a wire's
    // handle, or on something that scrolls keeps its own gesture.
    let fingers: { x: number; y: number }[] = [];
    let base: { vp: Viewport; mid: { x: number; y: number }; dist: number } | null = null;
    let owned = false;
    let moved = false;
    const flowBox = () => root.querySelector<HTMLElement>(".react-flow")?.getBoundingClientRect();
    const midOf = (box: DOMRect) => ({
      x: fingers.reduce((sum, p) => sum + p.x, 0) / fingers.length - box.left,
      y: fingers.reduce((sum, p) => sum + p.y, 0) / fingers.length - box.top,
    });
    const distOf = () => (fingers.length > 1 ? Math.hypot(fingers[0]!.x - fingers[1]!.x, fingers[0]!.y - fingers[1]!.y) : 0);
    const track = (list: TouchList) => { fingers = Array.from(list, (t) => ({ x: t.clientX, y: t.clientY })); };
    // Every change in the number of fingers starts the gesture again from
    // where the board is now, so lifting one finger of a pinch doesn't jump.
    const rebase = () => {
      const box = flowBox();
      base = box && fingers.length ? { vp: live.current.getViewport(), mid: midOf(box), dist: distOf() } : null;
    };
    const keepsOwnTouch = (event: TouchEvent) => {
      const el = event.target as Element;
      if (el.closest("input, select, .react-flow__handle")) return true;
      // Text keeps the finger once it is being edited; until then a finger
      // dragged across it moves the board, and a tap still puts the caret in.
      const text = el.closest<HTMLElement>("textarea, [contenteditable=true]");
      if (text && !idleText(text)) return true;
      for (const node of event.composedPath()) {
        if (!(node instanceof HTMLElement) || node.classList.contains("react-flow")) break;
        if (idleText(node)) continue;
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return true;
        if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
      }
      return false;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (!live.current.enabled) return;
      if (!(event.target as Element | null)?.closest?.(".react-flow")) return;
      if (!owned && event.touches.length === 1 && keepsOwnTouch(event)) return;
      // Ahead of d3-zoom and d3-drag below: neither sees the touch, so a
      // block is not dragged by it and the pane does not move twice. A tap
      // still clicks — nothing here cancels the touch.
      event.stopPropagation();
      if (!owned) moved = false;
      owned = true;
      stop();
      track(event.touches);
      rebase();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!owned) return;
      event.stopPropagation();
      track(event.touches);
      const box = flowBox();
      if (!base || !box || !fingers.length) return;
      const mid = midOf(box);
      // A finger that has hardly moved is a tap on its way to a click.
      if (!moved && fingers.length === 1 && Math.hypot(mid.x - base.mid.x, mid.y - base.mid.y) < 6) return;
      moved = true;
      if (event.cancelable) event.preventDefault();
      const { setViewport, clampScroll, onGlide, minZoom, maxZoom } = live.current;
      if (fingers.length === 1 || !base.dist) {
        const next = { x: base.vp.x + mid.x - base.mid.x, y: base.vp.y + mid.y - base.mid.y, zoom: base.vp.zoom };
        setViewport(clampScroll ? clampScroll(next) : next);
      } else {
        const zoom = Math.max(minZoom, Math.min(maxZoom, base.vp.zoom * (distOf() / base.dist)));
        const fx = (base.mid.x - base.vp.x) / base.vp.zoom;
        const fy = (base.mid.y - base.vp.y) / base.vp.zoom;
        setViewport({ x: mid.x - fx * zoom, y: mid.y - fy * zoom, zoom });
      }
      onGlide?.();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!owned) return;
      event.stopPropagation();
      const lastAt = fingers[0];
      track(event.touches);
      if (fingers.length) { rebase(); return; }
      owned = false;
      base = null;
      if (moved && lastAt) live.current.onSettle?.(live.current.getViewport().zoom, lastAt);
    };
    root.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    root.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    root.addEventListener("touchend", onTouchEnd, true);
    root.addEventListener("touchcancel", onTouchEnd, true);
    root.addEventListener("click", onClick, true);
    root.addEventListener("focusout", onFocusOut, true);
    return () => {
      root.removeEventListener("wheel", onWheel, true);
      root.removeEventListener("pointerdown", stop, true);
      root.removeEventListener("touchstart", onTouchStart, true);
      root.removeEventListener("touchmove", onTouchMove, true);
      root.removeEventListener("touchend", onTouchEnd, true);
      root.removeEventListener("touchcancel", onTouchEnd, true);
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("focusout", onFocusOut, true);
      if (scrollRest) clearTimeout(scrollRest);
      stop();
    };
  }, [container]);
}
