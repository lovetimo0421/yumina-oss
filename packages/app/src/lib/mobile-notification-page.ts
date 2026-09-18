import { suspendRouteScrollCapture } from "./route-scroll-restoration";

/** Give the phone inbox the actual document scrollport, including browser
 * chrome. Keep the underlying app mounted, and restore its position on close. */
export function installMobileNotificationPage(view: Window, panel: HTMLElement): () => void {
  const root = view.document.documentElement;
  const app = view.document.getElementById("root");
  const previousInert = app?.inert ?? false;
  const previousScroll = { left: view.scrollX, top: view.scrollY };
  const previousUrl = view.location.href;
  const resumeCapture = suspendRouteScrollCapture();
  const containedPositions = [...view.document.querySelectorAll<HTMLElement>('[data-scroll-restoration-id]')].map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }));
  const previousPage = root.getAttribute("data-mobile-page-scroll");
  const controls = panel.querySelector<HTMLElement>(".notification-panel-controls");
  if (app) app.inert = true;
  root.setAttribute("data-mobile-notification-page", "");
  view.scrollTo({ top: 0, left: 0, behavior: "instant" });
  const measure = () => {
    if (controls) panel.style.setProperty("--notification-controls-height", `${controls.getBoundingClientRect().height}px`);
  };
  measure();
  const observer = new ResizeObserver(measure);
  if (controls) observer.observe(controls);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    root.removeAttribute("data-mobile-notification-page");
    if (app) app.inert = previousInert;
    resumeCapture();
    // A route change owns its own restoration. Normal close restores before
    // React removes the portal, so no intermediate frame shows the page top.
    if (view.location.href === previousUrl) {
      for (const { element, top, left } of containedPositions) {
        if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; }
      }
      const scroller = previousPage && view.document.querySelector<HTMLElement>(`[data-scroll-restoration-id="${previousPage}"]`);
      if (scroller && !root.hasAttribute("data-mobile-page-scroll")) scroller.scrollTop = previousScroll.top;
      else view.scrollTo({ ...previousScroll, behavior: "instant" });
    }
    view.dispatchEvent(new view.document.defaultView!.Event("resize"));
  };
}
