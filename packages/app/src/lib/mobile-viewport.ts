const MIN_SOFT_KEYBOARD_INSET_PX = 120;
const MAX_BROWSER_CHROME_INSET_PX = 160;
const SOFT_KEYBOARD_INSET_RATIO = 0.2;

interface SoftKeyboardViewportMeasurement {
  layoutHeight: number;
  /** Measured 100dvh box: the baseline globals.css subtracts the inset from. */
  cssViewportHeight?: number;
  visualHeight: number;
  visualOffsetTop: number;
  safeAreaBottom: number;
  scale: number;
  hasTextEntryFocus: boolean;
}

/**
 * Separate a real soft-keyboard resize from mobile browser chrome moving.
 *
 * iOS Chrome can leave `innerHeight` at the larger layout viewport while its
 * address and tab bars reduce `visualViewport.height` by roughly 100-150px.
 * Treating every positive delta as a keyboard shortens the entire app shell
 * and exposes a dead band below it until reload. A keyboard is both tied to a
 * text-entry focus and materially taller than browser chrome.
 */
export function calculateSoftKeyboardInset({
  layoutHeight,
  cssViewportHeight = layoutHeight,
  visualHeight,
  visualOffsetTop,
  safeAreaBottom,
  scale,
  hasTextEntryFocus,
}: SoftKeyboardViewportMeasurement): number {
  if (scale !== 1 || !hasTextEntryFocus) return 0;

  const rawInset = layoutHeight - visualHeight - visualOffsetTop - safeAreaBottom;
  if (!Number.isFinite(rawInset) || rawInset <= 0) return 0;

  const browserChromeCeiling = Math.min(
    MAX_BROWSER_CHROME_INSET_PX,
    Math.max(MIN_SOFT_KEYBOARD_INSET_PX, layoutHeight * SOFT_KEYBOARD_INSET_RATIO),
  );

  if (rawInset <= browserChromeCeiling) return 0;

  // innerHeight can differ from 100dvh in standalone mode or when the browser
  // already resizes content. Subtract only the occlusion of the CSS box, and
  // don't discount a retained safe area once a real keyboard is detected.
  const cssInset = cssViewportHeight - visualHeight - visualOffsetTop;
  return Number.isFinite(cssInset) ? Math.max(0, Math.round(cssInset)) : 0;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function hasTextEntryFocus(element: Element | null): boolean {
  const view = element?.ownerDocument.defaultView;
  if (!view || !(element instanceof view.HTMLElement)) return false;

  if (element instanceof view.HTMLInputElement) {
    return (
      !element.disabled &&
      !element.readOnly &&
      !NON_TEXT_INPUT_TYPES.has(element.type.toLowerCase())
    );
  }

  if (element instanceof view.HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }

  // A focused sandbox iframe can own the actual text input in its document.
  // The parent cannot inspect that focus under the sandbox boundary, but a
  // browser-chrome-only resize is still rejected by the height threshold.
  if (element instanceof view.HTMLIFrameElement) return true;

  return element.isContentEditable === true;
}

const OUTER_SHELL_SELECTOR = "html, body, #root, .app-shell-root, .app-shell-content";

export type ViewportRecovery = {
  reason: "viewport_resume";
  previousHeight: number;
  height: number;
  layoutHeight: number;
  visualHeight: number;
  keyboardInset: number;
} | {
  reason: "outer_scroll";
  scrollTarget: "html" | "body" | "root" | "shell" | "shell_content";
  previousScrollTop: number;
  scrollTop: number;
  layoutHeight: number;
  visualHeight: number;
};

/**
 * Let CSS own the idle browser viewport; Home Screen mode uses its window
 * height to avoid a shorter dvh box. During text entry, size only the fixed shell
 * from the visual viewport; never resize the document or add its pan to height.
 */
export function installMobileViewport(
  view: Window,
  onRecovery?: (recovery: ViewportRecovery) => void,
  pageScrollId?: import("./mobile-reading-route").MobileReadingPageId,
  messageCanvas = false,
): () => void {
  const document = view.document;
  const root = document.documentElement;
  const vv = view.visualViewport;
  root.setAttribute("data-mobile-viewport", "");
  const mobileQuery = view.matchMedia?.("(max-width: 767px)");
  const displayMode = view.matchMedia?.("(display-mode: standalone), (display-mode: fullscreen)");
  const updateMessageCanvas = () => root.toggleAttribute("data-mobile-message-canvas", messageCanvas && Boolean(mobileQuery?.matches));
  updateMessageCanvas();
  const usesDocumentScroll = () => Boolean(pageScrollId && mobileQuery?.matches);
  if (usesDocumentScroll()) root.setAttribute("data-mobile-page-scroll", pageScrollId!);
  else root.removeAttribute("data-mobile-page-scroll");
  root.removeAttribute("data-reading-boot");
  const safeAreaProbe = document.createElement("div");
  safeAreaProbe.style.cssText =
    "position:fixed;bottom:0;left:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none;";
  document.body.appendChild(safeAreaProbe);
  // WebKit's installed-app safe-content measurements can ALL omit the status
  // area (innerHeight and clientHeight included). Measure legacy vh separately:
  // https://bugs.webkit.org/show_bug.cgi?id=254868#c2
  const fullHeightProbe = document.createElement("div");
  fullHeightProbe.setAttribute("data-mobile-full-height-probe", "");
  fullHeightProbe.style.cssText =
    "position:absolute;top:0;left:0;width:0;height:100vh;visibility:hidden;pointer-events:none;";
  document.body.appendChild(fullHeightProbe);

  let frame: number | null = null;
  let scrollFrame: number | null = null;
  let modeTransferFrame: number | null = null;
  let keyboardTimer: number | null = null;
  let settleTimers: number[] = [];
  let resumeUntil = 0;
  let repairScrollUntil = 0;
  let repairScrollPending = false;
  let revealFocusPending = false;
  let touchActive = false;
  let diagnosticsLeft = 3;
  let disposed = false;
  let suspended = document.visibilityState === "hidden";
  let previousFocus: Element | null = null;

  const write = (property: string, value: string) => {
    if (root.style.getPropertyValue(property) !== value) root.style.setProperty(property, value);
  };
  const isStandalone = () => displayMode?.matches ||
    (view.navigator as Navigator & { standalone?: boolean }).standalone === true;
  // Use one baseline for idle size and keyboard detection. Some engines resize
  // innerHeight for the keyboard before resizing the actual layout viewport.
  const getLayoutHeight = () => isStandalone() && !usesDocumentScroll()
    ? Math.max(view.innerHeight, root.clientHeight, fullHeightProbe.getBoundingClientRect().height) : view.innerHeight;
  const updateIdleHeight = () => {
    if (!isStandalone()) root.style.removeProperty("--mobile-vh");
    else if ((!vv || vv.scale === 1) && Number.isFinite(view.innerHeight) && view.innerHeight > 0) {
      // WebKit can report the safe content height as innerHeight while the
      // fixed layout viewport still extends farther down the Home Screen.
      // Use the actual layout viewport as well, never screen.height (which
      // could include areas outside a window). Native pages have auto-height
      // roots, so their clientHeight must not size a viewport from page content.
      write("--mobile-vh", `${getLayoutHeight()}px`);
    }
  };
  const stopKeyboardTimer = () => {
    if (keyboardTimer !== null) view.clearInterval(keyboardTimer);
    keyboardTimer = null;
  };
  const repairOuterScroll = (immediate = false) => {
    if (usesDocumentScroll() || root.hasAttribute("data-mobile-notification-page")) return;
    if (scrollFrame !== null) return;
    if (touchActive || hasTextEntryFocus(document.activeElement)) {
      repairScrollPending = true;
      return;
    }
    repairScrollPending = false;
    // Legacy engines fall back to overflow:hidden rather than clip. Keep
    // those wrappers anchored; the feed/chat/editor own separate scrollers.
    const shifted = [...document.querySelectorAll(OUTER_SHELL_SELECTOR)]
      .map((element) => ({ element, top: element.scrollTop }))
      .filter(({ top }) => Math.abs(top) > 2);
    if (shifted.length === 0) return;
    const repair = () => {
      scrollFrame = null;
      if (disposed || suspended || document.visibilityState === "hidden" || usesDocumentScroll() || root.hasAttribute("data-mobile-notification-page")) return;
      if (touchActive || (vv && vv.scale !== 1) || hasTextEntryFocus(document.activeElement)) {
        repairScrollPending = true;
        return;
      }
      for (const { element, top } of shifted) {
        // Allow the browser's own keyboard/overscroll animation to finish.
        if (!element.isConnected || element.scrollTop !== top) continue;
        element.scrollTop = 0;
        if (element.scrollTop !== top && diagnosticsLeft-- > 0) {
          onRecovery?.({
            reason: "outer_scroll",
            scrollTarget: element === root ? "html" : element === document.body ? "body" :
              element.id === "root" ? "root" : element.classList.contains("app-shell-root") ? "shell" : "shell_content",
            previousScrollTop: top,
            scrollTop: element.scrollTop,
            layoutHeight: view.innerHeight,
            visualHeight: vv?.height ?? view.innerHeight,
          });
        }
      }
    };
    if (immediate) repair();
    else scrollFrame = view.requestAnimationFrame(repair);
  };
  const apply = (repairImmediately = false) => {
    frame = null;
    if (disposed || suspended || document.visibilityState === "hidden") return;
    if (root.hasAttribute("data-mobile-notification-page")) return;
    // Reading pages use native document flow. WebKit owns focus/caret panning
    // and toolbar motion; chasing offsetTop/height here makes the page shake.
    if (usesDocumentScroll()) {
      // Native pages retain their full-height canvas while WebKit pans a field.
      if (!hasTextEntryFocus(document.activeElement)) updateIdleHeight();
      root.style.removeProperty("--mobile-viewport-top");
      write("--keyboard-inset", "0px");
      stopKeyboardTimer();
      repairScrollPending = revealFocusPending = false;
      return;
    }
    // Zoom must magnify the existing layout, not resize it to the zoomed viewport.
    if (vv && vv.scale !== 1) return;
    const layoutHeight = getLayoutHeight();
    const visualHeight = vv?.height ?? layoutHeight;
    // Transient zero/invalid geometry during restore must never collapse the app.
    if (!Number.isFinite(layoutHeight) || layoutHeight <= 0 ||
        !Number.isFinite(visualHeight) || visualHeight <= 0) return;

    const activeElement = document.activeElement;
    const textEntryFocused = hasTextEntryFocus(activeElement);
    const inset = calculateSoftKeyboardInset({
      layoutHeight,
      visualHeight,
      visualOffsetTop: vv?.offsetTop ?? 0,
      safeAreaBottom: safeAreaProbe.getBoundingClientRect().height,
      scale: vv?.scale ?? 1,
      hasTextEntryFocus: textEntryFocused,
    });
    const height = Math.round(visualHeight);
    const previousHeight = Number.parseFloat(root.style.getPropertyValue("--mobile-vh"));
    write("--keyboard-inset", `${inset}px`);
    // Home Screen's visual viewport can exclude the home indicator even with
    // no keyboard. Focus can survive keyboard dismissal (including in a game
    // iframe); only a real keyboard may shorten its full-window shell.
    if (textEntryFocused && vv && (!isStandalone() || inset > 0)) {
      write("--mobile-vh", `${height}px`);
      // iOS can pan the visual viewport to reveal a field. Keep the fixed
      // shell at that origin without transforming its fixed/portal children.
      const offset = Number.isFinite(vv.offsetTop) ? Math.max(0, vv.offsetTop) : 0;
      write("--mobile-viewport-top", `${offset}px`);
      revealFocusPending ||= previousHeight !== height || previousFocus !== activeElement;
      if (!touchActive && revealFocusPending) {
        revealFocusPending = false;
        // Only opt-in page scrollers move. scrollIntoView() would also scroll
        // locked ancestors and recreate the blank band; never blur/remount a
        // composing textarea or reset its selection/draft.
        const scroller = activeElement?.closest<HTMLElement>("[data-keyboard-scroll]");
        if (scroller && activeElement) {
          const bounds = scroller.getBoundingClientRect();
          const field = activeElement.getBoundingClientRect();
          const top = bounds.top + 12;
          const bottom = bounds.bottom - 12;
          if (bottom > top) {
            // A tall editor can already span the whole scrollport. Leave
            // its native caret scrolling alone while any of it is visible.
            const delta = field.height > bottom - top
              ? field.top > bottom ? field.top - top : field.bottom < top ? field.bottom - bottom : 0
              : field.top < top ? field.top - top : Math.max(0, field.bottom - bottom);
            if (delta !== 0) scroller.scrollTop += delta;
          }
        }
      }
    } else {
      revealFocusPending = false;
      updateIdleHeight();
      root.style.removeProperty("--mobile-viewport-top");
    }
    previousFocus = activeElement;
    if (textEntryFocused && vv && keyboardTimer === null) {
      // Some webviews omit the keyboard's final resize; only poll while needed.
      keyboardTimer = view.setInterval(schedule, 1000);
    } else if (!textEntryFocused || !vv) {
      stopKeyboardTimer();
    }
    if (repairScrollPending || Date.now() < repairScrollUntil) repairOuterScroll(repairImmediately);
    if (Date.now() < resumeUntil && Number.isFinite(previousHeight) && Math.abs(previousHeight - height) > 2) {
      resumeUntil = 0;
      if (diagnosticsLeft-- > 0) {
        onRecovery?.({ reason: "viewport_resume", previousHeight, height, layoutHeight, visualHeight, keyboardInset: inset });
      }
    }
  };
  function schedule() {
    if (!disposed && !suspended && document.visibilityState !== "hidden" && frame === null) {
      frame = view.requestAnimationFrame(() => apply());
    }
  }
  const clearPending = () => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    if (scrollFrame !== null) view.cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
    settleTimers.forEach((timer) => view.clearTimeout(timer));
    settleTimers = [];
  };
  const settle = () => {
    clearPending();
    repairScrollUntil = Date.now() + 1500;
    schedule();
    // iOS may publish geometry only after its toolbar/keyboard animation ends.
    if (!suspended) settleTimers = [250, 1000].map((delay) => view.setTimeout(schedule, delay));
  };
  const suspend = () => {
    suspended = true;
    resumeUntil = 0;
    touchActive = false;
    clearPending();
    stopKeyboardTimer();
    write("--keyboard-inset", "0px");
    root.style.removeProperty("--mobile-vh");
    root.style.removeProperty("--mobile-viewport-top");
    previousFocus = null;
    revealFocusPending = false;
  };
  const resume = () => {
    if (document.visibilityState === "hidden") return;
    suspended = false;
    resumeUntil = Date.now() + 1500;
    settle();
    // Resume listeners run before the next paint. Do not spend two animation
    // frames (or wait for the 1s settling retry) displaying a stale outer scroll.
    if (frame !== null) view.cancelAnimationFrame(frame);
    apply(true);
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") suspend();
    else resume();
  };
  const onTouchStart = () => { touchActive = true; };
  const onTouchEnd = (event: Event) => {
    touchActive = "touches" in event && (event as TouchEvent).touches.length > 0;
    if (!touchActive && (repairScrollPending || revealFocusPending)) schedule();
  };
  const onOuterScroll = (event: Event) => {
    if (usesDocumentScroll() || root.hasAttribute("data-mobile-notification-page")) return;
    const ElementType = document.defaultView?.Element;
    if (event.target !== document && !(ElementType && event.target instanceof ElementType &&
        event.target.matches(OUTER_SHELL_SELECTOR))) return;
    // Browser focus/history restoration can shift a locked wrapper well after
    // pageshow. Feed/chat/editor scrolling must not run this repair path.
    repairScrollPending = true;
    schedule();
  };

  const onPageScrollModeChange = () => {
    updateMessageCanvas();
    if (!pageScrollId) return;
    // The notification page owns scrollY until it closes. Change the restored
    // layout at the breakpoint without copying the inbox's offset into it.
    if (root.hasAttribute("data-mobile-notification-page")) {
      if (usesDocumentScroll()) root.setAttribute("data-mobile-page-scroll", pageScrollId);
      else root.removeAttribute("data-mobile-page-scroll");
      return;
    }
    if (modeTransferFrame !== null) view.cancelAnimationFrame(modeTransferFrame);
    modeTransferFrame = null;
    const scroller = document.querySelector<HTMLElement>(`[data-scroll-restoration-id="${pageScrollId}"]`);
    const wasNative = root.hasAttribute("data-mobile-page-scroll");
    const top = wasNative ? view.scrollY : scroller?.scrollTop ?? 0;
    clearPending();
    if (usesDocumentScroll()) {
      root.setAttribute("data-mobile-page-scroll", pageScrollId);
      if (scroller) scroller.scrollTop = 0;
      view.scrollTo({ top, left: 0, behavior: "auto" });
    } else {
      root.removeAttribute("data-mobile-page-scroll");
      view.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (scroller) scroller.scrollTop = top;
      // Library replaces its detail markup at this breakpoint. Transfer to
      // the replacement after React commits, before the next paint.
      modeTransferFrame = view.requestAnimationFrame(() => {
        modeTransferFrame = null;
        const replacement = document.querySelector<HTMLElement>(`[data-scroll-restoration-id="${pageScrollId}"]`);
        if (!disposed && !usesDocumentScroll() && replacement && replacement !== scroller) replacement.scrollTop = top;
      });
    }
    apply();
  };

  mobileQuery?.addEventListener("change", onPageScrollModeChange);
  displayMode?.addEventListener("change", schedule);
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  view.addEventListener("resize", schedule);
  view.addEventListener("orientationchange", settle);
  view.addEventListener("pageshow", resume);
  view.addEventListener("pagehide", suspend);
  view.addEventListener("focus", resume);
  view.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
  view.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
  view.addEventListener("touchcancel", onTouchEnd, { passive: true, capture: true });
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  document.addEventListener("scroll", onOuterScroll, { passive: true, capture: true });
  apply();

  return () => {
    disposed = true;
    clearPending();
    if (modeTransferFrame !== null) view.cancelAnimationFrame(modeTransferFrame);
    stopKeyboardTimer();
    mobileQuery?.removeEventListener("change", onPageScrollModeChange);
    displayMode?.removeEventListener("change", schedule);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    view.removeEventListener("resize", schedule);
    view.removeEventListener("orientationchange", settle);
    view.removeEventListener("pageshow", resume);
    view.removeEventListener("pagehide", suspend);
    view.removeEventListener("focus", resume);
    view.removeEventListener("touchstart", onTouchStart, { capture: true });
    view.removeEventListener("touchend", onTouchEnd, { capture: true });
    view.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("focusin", settle);
    document.removeEventListener("focusout", settle);
    document.removeEventListener("scroll", onOuterScroll, { capture: true });
    safeAreaProbe.remove();
    fullHeightProbe.remove();
    root.style.removeProperty("--keyboard-inset");
    root.style.removeProperty("--mobile-vh");
    root.style.removeProperty("--mobile-viewport-top");
    root.removeAttribute("data-mobile-viewport");
    root.removeAttribute("data-mobile-page-scroll");
    root.removeAttribute("data-mobile-message-canvas");
  };
}
