// WebKit can move a long-press selection to the page when a menu portal opens.
// Lock selection before Radix's long-press timer, and retain it until dismissal.
export function createContextMenuTouchGuard() {
  let release: (() => void) | undefined;
  let open = false;
  const finish = () => {
    if (!open) {
      release?.();
      release = undefined;
    }
  };
  return {
    start(doc: Document) {
      release?.();
      const style = doc.createElement("style");
      style.textContent = "html, body, body * { -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }";
      doc.head.append(style);
      const clear = () => {
        const selection = doc.getSelection();
        if (selection?.rangeCount) selection.removeAllRanges();
      };
      const prevent = (event: Event) => { event.preventDefault(); clear(); };
      doc.addEventListener("selectstart", prevent, true);
      doc.addEventListener("selectionchange", clear, true);
      for (const type of ["pointerup", "pointercancel", "pointermove"]) doc.addEventListener(type, finish, true);
      // Do not cancel contextmenu: Radix still needs that event to open the menu.
      clear();
      release = () => {
        style.remove();
        doc.removeEventListener("selectstart", prevent, true);
        doc.removeEventListener("selectionchange", clear, true);
        for (const type of ["pointerup", "pointercancel", "pointermove"]) doc.removeEventListener(type, finish, true);
        clear();
      };
    },
    setOpen(value: boolean) { open = value; finish(); },
    dispose() { open = false; finish(); },
  };
}

export function viewportMenuShift(left: number, width: number, viewportLeft: number, viewportWidth: number) {
  return Math.max(viewportLeft + 8, Math.min(left, viewportLeft + viewportWidth - width - 8)) - left;
}

// Radix flips side menus, but cannot shift them horizontally. A submenu may
// need to overlap its parent on a phone when neither side has enough space.
export function keepMenuInViewport(element: HTMLElement) {
  const win = element.ownerDocument.defaultView!;
  let correction = 0;
  const update = () => {
    const viewport = win.visualViewport;
    element.style.maxWidth = `${(viewport?.width ?? win.innerWidth) - 16}px`;
    const rect = element.getBoundingClientRect();
    correction = viewportMenuShift(rect.left - correction, rect.width, viewport?.offsetLeft ?? 0, viewport?.width ?? win.innerWidth);
    element.style.translate = `${correction}px 0`;
  };
  const resize = new win.ResizeObserver(update);
  resize.observe(element);
  // Floating UI writes placement to the portal wrapper after layout/scroll.
  const placement = new win.MutationObserver(update);
  if (element.parentElement) placement.observe(element.parentElement, { attributes: true, attributeFilter: ["style"] });
  win.addEventListener("resize", update);
  element.addEventListener("animationend", update);
  win.visualViewport?.addEventListener("resize", update);
  win.visualViewport?.addEventListener("scroll", update);
  update();
  return () => {
    resize.disconnect();
    placement.disconnect();
    win.removeEventListener("resize", update);
    element.removeEventListener("animationend", update);
    win.visualViewport?.removeEventListener("resize", update);
    win.visualViewport?.removeEventListener("scroll", update);
    element.style.translate = "";
    element.style.maxWidth = "";
  };
}
