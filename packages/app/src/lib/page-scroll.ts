/** The named page stays the history target when its mobile scroll owner is the document. */
export function isDocumentPageScroller(element: Element): boolean {
  const id = element.getAttribute?.("data-scroll-restoration-id");
  return Boolean(id && element.ownerDocument?.documentElement.getAttribute("data-mobile-page-scroll") === id);
}

export function getPageScrollTop(element: HTMLElement): number {
  return isDocumentPageScroller(element)
    ? element.ownerDocument.defaultView?.scrollY ?? 0
    : element.scrollTop;
}

/** Position a result below the sticky header, or at the top of a contained panel. */
export function getPageTargetTop(scroller: HTMLElement, target: HTMLElement): number {
  const inset = isDocumentPageScroller(scroller)
    ? Math.max(0, scroller.ownerDocument.querySelector(".topbar-shell")?.getBoundingClientRect().bottom ?? 0)
    : scroller.getBoundingClientRect().top;
  return Math.max(0, getPageScrollTop(scroller) + target.getBoundingClientRect().top - inset);
}

export function scrollPageTo(element: HTMLElement | null, top: number): void {
  if (!element) return;
  const view = element.ownerDocument.defaultView;
  const behavior = view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const options: ScrollToOptions = { top: Math.max(0, top), left: 0, behavior };
  if (isDocumentPageScroller(element)) view?.scrollTo(options);
  else element.scrollTo(options);
}
