/** Recover body locks only after modal exit animations have settled. */
export function installOverlayRecovery(view: Window, onRecovery?: () => void): () => void {
  const document = view.document;
  const body = document.body;
  let timer: number | null = null;
  let disposed = false;
  let diagnosticsLeft = 3;
  const hasLocks = () => body.style.pointerEvents === "none" || body.hasAttribute("data-scroll-locked");
  const recover = () => {
    timer = null;
    if (disposed || document.visibilityState === "hidden" || !hasLocks()) return;
    // A closed/empty popper wrapper is not a live modal. Include custom and
    // native dialogs as well as Radix; never unlock underneath an open layer.
    const openOverlay = [...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [data-state="open"][role="menu"], [data-state="open"][role="listbox"], dialog[open]',
    )].some((element) =>
      !element.closest('[data-state="closed"], [aria-hidden="true"], [hidden], [inert]') &&
      !element.matches("dialog:not([open])"),
    );
    if (openOverlay) return;
    if (body.style.pointerEvents === "none") body.style.pointerEvents = "";
    body.removeAttribute("data-scroll-locked");
    if (diagnosticsLeft-- > 0) onRecovery?.();
  };
  const schedule = () => {
    if (!disposed && document.visibilityState !== "hidden" && hasLocks() && timer === null) {
      timer = view.setTimeout(recover, 400);
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      if (timer !== null) view.clearTimeout(timer);
      timer = null;
    } else schedule();
  };
  // Closing a menu does not change the route. Observe its removal/state and
  // body lock changes, with no polling or layout reads on the normal tap path.
  const Observer = document.defaultView?.MutationObserver;
  const observer = Observer ? new Observer((records) => {
    if (!hasLocks()) return;
    if (records.some((record) => record.type === "childList" || record.target === body || record.attributeName !== "style")) schedule();
  }) : null;
  observer?.observe(body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "data-scroll-locked", "style", "aria-hidden", "hidden", "inert", "open"],
  });
  document.addEventListener("visibilitychange", onVisibility);
  view.addEventListener("pageshow", schedule);
  view.addEventListener("focus", schedule);
  schedule();
  return () => {
    disposed = true;
    if (timer !== null) view.clearTimeout(timer);
    observer?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    view.removeEventListener("pageshow", schedule);
    view.removeEventListener("focus", schedule);
  };
}
