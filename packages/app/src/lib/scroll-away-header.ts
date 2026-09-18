import { hasTextEntryFocus } from "./mobile-viewport";
import { createHeaderMotion } from "./header-motion";

const HIDE_INTENT_PX = 12;
const REVEAL_INTENT_PX = 8;
const TOP_REVEAL_PX = 24;

/** Observe the document; never change its height, focus, or scroll position.
 * Only visibility transitions reach React, not every scroll frame. */
export function installScrollAwayHeader(
  view: Window,
  header: HTMLElement,
  onHiddenChange: (hidden: boolean) => void,
): () => void {
  const doc = view.document;
  const root = doc.documentElement;
  const motion = createHeaderMotion(view, header);
  let hidden = false;
  let publishedHidden = false;
  let pendingFrame: number | null = null;
  let keyboardNavigation = false;
  let disposed = false;
  const scrollY = () => Math.min(Math.max(0, view.scrollY), Math.max(0, root.scrollHeight - root.clientHeight));
  let previousY = scrollY();
  let previousWidth = view.innerWidth;
  let distance = 0;

  const publish = () => {
    if (publishedHidden === hidden) return;
    publishedHidden = hidden;
    motion.setHidden(hidden);
    onHiddenChange(hidden);
  };
  const setHidden = (value: boolean) => {
    hidden = value;
    if (pendingFrame !== null || disposed) return;
    pendingFrame = view.requestAnimationFrame(() => {
      pendingFrame = null;
      if (!disposed) publish();
    });
  };
  const reveal = () => {
    distance = 0;
    previousY = scrollY();
    if (pendingFrame !== null) view.cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
    hidden = false;
    publish();
    motion.reveal();
  };
  const isReading = () => root.hasAttribute("data-mobile-page-scroll") && view.innerWidth < 768;
  const isInteracting = () => hasTextEntryFocus(doc.activeElement)
    || (keyboardNavigation && header.contains(doc.activeElement))
    || header.hasAttribute("data-preview-open")
    || Boolean(header.querySelector('[aria-expanded="true"]'))
    || doc.body.hasAttribute("data-scroll-locked")
    || Boolean(doc.querySelector(".mobile-nav-drawer--open"));
  const onScroll = (event: Event) => {
    // Nested popovers, carousels and editors must not drive the page header.
    if (event.target !== view && event.target !== doc && event.target !== root) return;
    // Clamp both ends: the rebound from iOS rubber-banding is not a reversal.
    const y = scrollY();
    const delta = y - previousY;
    previousY = y;
    if (!isReading() || doc.visibilityState === "hidden" || (view.visualViewport?.scale ?? 1) !== 1 || isInteracting()) {
      reveal();
      return;
    }
    if (y <= TOP_REVEAL_PX) { reveal(); return; }
    if (delta === 0) return;
    distance = Math.sign(delta) === Math.sign(distance) ? distance + delta : delta;
    if (distance >= HIDE_INTENT_PX) setHidden(true);
    else if (distance <= -REVEAL_INTENT_PX) setHidden(false);
  };
  const onPointerDown = () => { keyboardNavigation = false; };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab") { keyboardNavigation = true; reveal(); }
  };
  const onFocus = () => { if (isInteracting()) reveal(); };
  const reset = reveal;
  const onResize = () => {
    // Safari/Chrome collapse their own controls during a swipe. A height-only
    // resize must not reveal our header or change its direction.
    if (view.innerWidth !== previousWidth || !isReading()) reset();
    previousWidth = view.innerWidth;
  };
  view.addEventListener("scroll", onScroll, { passive: true });
  view.addEventListener("resize", onResize, { passive: true });
  view.addEventListener("pageshow", reset);
  doc.addEventListener("visibilitychange", reset);
  doc.addEventListener("touchstart", onPointerDown, { passive: true });
  doc.addEventListener("pointerdown", onPointerDown, { passive: true });
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("focusin", onFocus);
  // Portalled menus retain their anchor while open. Also reveal immediately
  // when the viewport controller hands scrolling to a contained desktop pane.
  const observer = new (view as Window & typeof globalThis).MutationObserver(() => {
    if (!isReading() || isInteracting()) reveal();
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-mobile-page-scroll"] });
  observer.observe(header, { subtree: true, attributes: true, attributeFilter: ["aria-expanded", "data-preview-open"] });
  observer.observe(doc.body, { attributes: true, attributeFilter: ["data-scroll-locked"] });

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    view.removeEventListener("scroll", onScroll);
    view.removeEventListener("resize", onResize);
    view.removeEventListener("pageshow", reset);
    doc.removeEventListener("visibilitychange", reset);
    doc.removeEventListener("touchstart", onPointerDown);
    doc.removeEventListener("pointerdown", onPointerDown);
    doc.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("focusin", onFocus);
    reveal();
    motion.dispose();
  };
}
