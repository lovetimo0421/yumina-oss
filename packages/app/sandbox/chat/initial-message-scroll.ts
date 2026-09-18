const anchoredTranscripts = new WeakSet<Element>();
const pendingScrolls = new WeakMap<Element, object>();

export function markTranscriptScroll(element: Element): void {
  const view = element.ownerDocument.defaultView;
  if (!view) return;
  const token = {};
  pendingScrolls.set(element, token);
  view.requestAnimationFrame(() => view.requestAnimationFrame(() => {
    if (pendingScrolls.get(element) === token) pendingScrolls.delete(element);
  }));
}

// Shared with the sandbox guard: native restoration must not be mistaken for
// a user scroll and permanently disable subsequent send-message scrolling.
export function isInitialTranscriptScroll(element: Element): boolean {
  return anchoredTranscripts.has(element) || pendingScrolls.has(element);
}

/** Keep the initial transcript at its end while the iframe and bubbles settle.
 * Stop on user intent, not scroll events: layout changes can emit scroll events
 * too. The caller also releases this anchor when messages change. */
export function anchorInitialTranscript(
  viewport: HTMLElement,
  setTop: (element: HTMLElement, top: number) => void,
  onAligned: () => void,
): () => void {
  const view = viewport.ownerDocument.defaultView;
  if (!view) return () => {};
  anchoredTranscripts.add(viewport);
  let stopped = false;
  let frame: number | null = null;
  const align = () => {
    frame = null;
    if (stopped || viewport.clientHeight === 0) return;
    markTranscriptScroll(viewport);
    setTop(viewport, viewport.scrollHeight);
    onAligned();
  };
  const schedule = () => {
    if (!stopped && frame === null) frame = view.requestAnimationFrame(align);
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    anchoredTranscripts.delete(viewport);
    pendingScrolls.delete(viewport);
    if (frame !== null) view.cancelAnimationFrame(frame);
    observer?.disconnect();
    viewport.removeEventListener("wheel", onUserInput, true);
    viewport.removeEventListener("touchmove", onUserInput, true);
    viewport.removeEventListener("pointerdown", onUserInput, true);
    viewport.ownerDocument.removeEventListener("keydown", onKey, true);
    view.removeEventListener("resize", schedule);
  };
  const onUserInput = () => {
    pendingScrolls.delete(viewport);
    stop();
  };
  const onKey = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) onUserInput();
  };
  viewport.addEventListener("wheel", onUserInput, { capture: true, passive: true });
  viewport.addEventListener("touchmove", onUserInput, { capture: true, passive: true });
  viewport.addEventListener("pointerdown", onUserInput, { capture: true, passive: true });
  viewport.ownerDocument.addEventListener("keydown", onKey, true);
  view.addEventListener("resize", schedule);
  observer?.observe(viewport);
  if (viewport.firstElementChild) observer?.observe(viewport.firstElementChild);
  align();
  schedule();
  return stop;
}
