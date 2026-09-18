import { postToParentWindow, wrapMessage } from "../protocol";
import { isInitialTranscriptScroll, markTranscriptScroll } from "./initial-message-scroll";
import { isTranscriptPosition, type TranscriptPosition } from "./transcript-position-types";

const RESTORE_EVENT = "yumina:restore-transcript-position";
const ACTIVE_EVENT = "yumina:transcript-active";
const RESTORE_SETTLE_MS = 4000;
const pendingRestores = new Map<string, TranscriptPosition>();

export function restoreTranscriptPosition(position: TranscriptPosition): void {
  if (!isTranscriptPosition(position)) return;
  pendingRestores.set(position.sessionId, position);
  if (pendingRestores.size > 8) pendingRestores.delete(pendingRestores.keys().next().value!);
  window.dispatchEvent(new CustomEvent(RESTORE_EVENT, { detail: position }));
}

export function setTranscriptActive(active: boolean): void {
  window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, { detail: active }));
}

/** A resume anchor is independent of live-stream auto-scrolling. It survives
 * data/geometry updates during restoration, but any reader interaction wins. */
export function trackTranscriptPosition(options: {
  sessionId: string;
  list: HTMLElement;
  viewport: () => HTMLElement;
  setTop: (element: HTMLElement, top: number) => void;
  expanded: () => boolean;
  loadedCount?: () => number;
  reveal: (position: TranscriptPosition, signal: AbortSignal) => void | Promise<void>;
  releaseInitial: () => void;
  persist?: boolean;
}) {
  const { list, sessionId } = options;
  const doc = list.ownerDocument;
  const view = doc.defaultView!;
  let active = true;
  let stopped = false;
  let saved: TranscriptPosition | null = null;
  let restoring: TranscriptPosition | null = null;
  let frame: number | null = null;
  let settleTimer: number | null = null;
  let userMovingUntil = 0;
  let lastPublished = "";
  let resumed = false;
  let userCapturePending = false;
  let restoreController: AbortController | null = null;
  let revealPending: Promise<void> | null = null;
  const visible = () => active && !doc.hidden && options.viewport().clientHeight > 0;
  // getBoundingClientRect uses screen pixels; scrollTop uses layout pixels.
  const relativeTop = (row: Element, viewport: HTMLElement) => {
    const rect = viewport.getBoundingClientRect();
    const scale = viewport.offsetHeight > 0 && rect.height > 0 ? rect.height / viewport.offsetHeight : 1;
    return (row.getBoundingClientRect().top - rect.top) / scale;
  };
  const publish = () => {
    if (!saved || options.persist === false) return;
    const serialized = JSON.stringify(saved);
    if (serialized === lastPublished) return;
    lastPublished = serialized;
    postToParentWindow(wrapMessage({ type: "transcript-position", position: saved }));
  };
  const capture = () => {
    if (!visible() || restoring) return;
    const viewport = options.viewport();
    if (saved && !userCapturePending && !isInitialTranscriptScroll(viewport)) return;
    userCapturePending = false;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-mid]"));
    const top = viewport.getBoundingClientRect().top;
    const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > top);
    saved = {
      version: 1, sessionId,
      mode: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 80 ? "latest" : "reading",
      anchorId: row?.dataset.mid ?? null,
      offset: row ? relativeTop(row, viewport) : 0,
      top: Math.max(0, viewport.scrollTop), expanded: options.expanded(),
      loadedCount: options.loadedCount?.() ?? 0,
    };
    publish();
  };
  const cancel = () => {
    restoring = null;
    resumed = false;
    restoreController?.abort();
    restoreController = null;
    revealPending = null;
    if (settleTimer !== null) view.clearTimeout(settleTimer);
    settleTimer = null;
  };
  const align = () => {
    frame = null;
    if (stopped || !visible()) return;
    if (!restoring) { capture(); return; }
    const viewport = options.viewport();
    const p = restoring;
    const row = p.anchorId ? Array.from(list.querySelectorAll<HTMLElement>("[data-mid]"))
      .find((candidate) => candidate.dataset.mid === p.anchorId) : null;
    if (p.mode === "reading" && p.anchorId && !row && revealPending) return;
    const top = p.mode === "latest" ? viewport.scrollHeight - viewport.clientHeight
      : row ? viewport.scrollTop + relativeTop(row, viewport) - p.offset : p.top;
    if (Math.abs(viewport.scrollTop - top) > 1) {
      markTranscriptScroll(viewport);
      options.setTop(viewport, Math.max(0, top));
    }
    // Persist the intended anchor, never a half-laid-out intermediate offset.
    saved = p;
    publish();
  };
  const schedule = () => {
    if (!stopped && frame === null) frame = view.requestAnimationFrame(align);
  };
  const begin = (position = saved) => {
    if (!position || !active) { schedule(); return; }
    if (settleTimer !== null) view.clearTimeout(settleTimer);
    options.releaseInitial();
    restoring = saved = position;
    resumed = true;
    restoreController ??= new AbortController();
    if (!revealPending) {
      const controller = restoreController;
      const pending = options.reveal(position, controller.signal);
      if (pending) {
        revealPending = pending;
        void pending.catch(() => {}).finally(() => {
          if (revealPending !== pending || restoreController !== controller) return;
          revealPending = null;
          if (!controller.signal.aborted && !stopped) {
            schedule();
            if (settleTimer !== null) view.clearTimeout(settleTimer);
            settleTimer = view.setTimeout(() => { restoring = null; settleTimer = null; }, RESTORE_SETTLE_MS);
          }
        });
      }
    }
    schedule();
    settleTimer = view.setTimeout(() => { if (!revealPending) restoring = null; settleTimer = null; }, RESTORE_SETTLE_MS);
  };
  const onInput = (event: Event) => {
    const target = event.target;
    const viewport = options.viewport();
    if (!(target instanceof view.Node)) return;
    // Sending/typing in the composer also ends a resume transaction; otherwise
    // its next assistant reply could inherit an old "latest" checkpoint.
    if (!viewport.contains(target)) { cancel(); return; }
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key)) return;
      if ((target as Element).closest?.("input,textarea,select,[contenteditable=true]")) return;
    }
    cancel();
    options.releaseInitial();
    userMovingUntil = Date.now() + 1500;
    userCapturePending = true;
    schedule();
  };
  const onScroll = (event: Event) => {
    if (event.target !== options.viewport() || !visible() || restoring) return;
    // Browser anchoring/keyboard scrolls must not replace the pre-hide intent.
    if (Date.now() <= userMovingUntil && !isInitialTranscriptScroll(options.viewport())) {
      userMovingUntil = Date.now() + 1500;
      userCapturePending = true;
      schedule();
    }
  };
  const onVisibility = () => {
    if (doc.hidden) { publish(); return; }
    begin();
  };
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) begin(); };
  const onActive = (event: Event) => {
    const next = (event as CustomEvent<boolean>).detail;
    if (active === next) return;
    active = next;
    if (active) begin(); else publish();
  };
  const onRestore = (event: Event) => {
    if (options.persist === false) return;
    const position: unknown = (event as CustomEvent).detail;
    if (!isTranscriptPosition(position) || position.sessionId !== sessionId) return;
    // A delayed bridge handshake must not override a reader who already moved.
    if (userMovingUntil > 0) return;
    pendingRestores.delete(sessionId);
    begin(position);
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  observer?.observe(list);
  observer?.observe(options.viewport());
  if (list.firstElementChild) observer?.observe(list.firstElementChild);
  for (const name of ["wheel", "touchmove", "pointerdown", "keydown"]) doc.addEventListener(name, onInput, { capture: true, passive: true });
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  doc.addEventListener("visibilitychange", onVisibility);
  view.addEventListener("pageshow", onPageShow);
  view.addEventListener("resize", schedule);
  view.visualViewport?.addEventListener("resize", schedule);
  view.addEventListener(RESTORE_EVENT, onRestore);
  view.addEventListener(ACTIVE_EVENT, onActive);
  const pending = options.persist !== false ? pendingRestores.get(sessionId) : null;
  if (pending) { pendingRestores.delete(sessionId); begin(pending); }
  schedule();
  return {
    updating: () => Boolean(restoring),
    changed: (messagesChanged = true) => {
      // A slow foreground refresh may finish after the initial settle window.
      // Re-arm only if no new user interaction has superseded this resume.
      if (resumed && messagesChanged) { begin(); resumed = false; } else schedule();
    },
    stop: () => {
      stopped = true;
      cancel();
      if (frame !== null) view.cancelAnimationFrame(frame);
      observer?.disconnect();
      for (const name of ["wheel", "touchmove", "pointerdown", "keydown"]) doc.removeEventListener(name, onInput, true);
      doc.removeEventListener("scroll", onScroll, true);
      doc.removeEventListener("visibilitychange", onVisibility);
      view.removeEventListener("pageshow", onPageShow);
      view.removeEventListener("resize", schedule);
      view.visualViewport?.removeEventListener("resize", schedule);
      view.removeEventListener(RESTORE_EVENT, onRestore);
      view.removeEventListener(ACTIVE_EVENT, onActive);
    },
  };
}

/** Handwritten worlds need warm-resume protection too. Track the actual
 * scroll-event targets rather than guessing that the first overflow panel is
 * the chat. Without message IDs, older reading positions use a pixel fallback.
 * They intentionally do not share the built-in transcript's reload checkpoint. */
export function trackCustomTranscriptPositions(sessionId: string, setTop: (element: HTMLElement, top: number) => void): () => void {
  const trackers = new Map<HTMLElement, ReturnType<typeof trackTranscriptPosition>>();
  const onScroll = (event: Event) => {
    if (document.querySelector(".play-message-scroll")) return;
    const element = event.target;
    if (!(element instanceof HTMLElement) || element.clientHeight < 100 || element.scrollHeight <= element.clientHeight) return;
    for (const [target, tracker] of trackers) {
      if (!target.isConnected) { tracker.stop(); trackers.delete(target); }
    }
    if (trackers.has(element) || trackers.size >= 8) return;
    trackers.set(element, trackTranscriptPosition({ sessionId, list: element, viewport: () => element,
      setTop, expanded: () => false, reveal: () => {}, releaseInitial: () => {}, persist: false,
    }));
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    document.removeEventListener("scroll", onScroll, true);
    trackers.forEach((tracker) => tracker.stop());
  };
}
