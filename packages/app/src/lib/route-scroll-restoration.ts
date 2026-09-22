import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";
import type { HistoryEntryStateStorage } from "./history-entry-state";
import { getPageScrollTop, isDocumentPageScroller } from "./page-scroll";

const STORAGE_PREFIX = "yumina:route-scroll:v1:";
const TANSTACK_STORAGE_KEY = "tsr-scroll-restoration-v1_3";
const DM_TRANSCRIPT_SELECTOR = '[data-scroll-restoration-id="dm-conversation-messages"]';
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 100;
const MAX_POSITION = 100_000_000;
const RETRY_DELAYS_MS = [0, 50, 150, 300, 600, 1200, 2500, 5000] as const;

export interface RouteScrollPosition {
  selector: string;
  top: number;
  left: number;
}

interface RouteScrollSnapshot {
  version: typeof SNAPSHOT_VERSION;
  updatedAt: number;
  positions: RouteScrollPosition[];
}

interface ExplicitScrollRestore {
  expectedUrl: string;
  queuedAt: number;
  positions: RouteScrollPosition[];
}

let queuedExplicitRestore: ExplicitScrollRestore | null = null;
let cancelActiveRestore: (() => void) | null = null;
let coveredPagePositions: RouteScrollPosition[] | null = null;

/** Preserve the background route's history while a document-scrolling overlay
 * owns scrollY, including pagehide and browser Back/Forward captures. */
export function suspendRouteScrollCapture(): () => void {
  const previous = coveredPagePositions;
  const snapshot = captureRegisteredScrollPositions();
  coveredPagePositions = snapshot;
  return () => {
    if (coveredPagePositions === snapshot) coveredPagePositions = previous;
  };
}

function getSessionStorage(): HistoryEntryStateStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** DM's virtual list owns its message anchor; route offsets cannot restore it.
 * Runs immediately before TanStack reads its persisted cache on navigation,
 * including caches written by older clients and floating DMs on other routes.
 */
export function prepareRouteScrollRestoration(): true {
  const storage = getSessionStorage();
  try {
    const cache: unknown = JSON.parse(storage?.getItem(TANSTACK_STORAGE_KEY) ?? "{}");
    if (isRecord(cache)) {
      let changed = false;
      for (const positions of Object.values(cache)) {
        if (isRecord(positions) && DM_TRANSCRIPT_SELECTOR in positions) {
          delete positions[DM_TRANSCRIPT_SELECTOR];
          changed = true;
        }
      }
      if (changed) storage?.setItem(TANSTACK_STORAGE_KEY, JSON.stringify(cache));
    }
  } catch {
    // Storage can be disabled. The transcript still manages its own position.
  }
  return true;
}

function snapshotKey(entryKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(entryKey)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScrollPosition(value: unknown): value is RouteScrollPosition {
  if (!isRecord(value)) return false;
  return typeof value.selector === "string"
    && value.selector.length > 0
    && value.selector.length <= 500
    && typeof value.top === "number"
    && Number.isFinite(value.top)
    && value.top >= 0
    && value.top <= MAX_POSITION
    && typeof value.left === "number"
    && Number.isFinite(value.left)
    && value.left >= 0
    && value.left <= MAX_POSITION;
}

function parseSnapshot(raw: string | null, now = Date.now()): RouteScrollSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value)
      || value.version !== SNAPSHOT_VERSION
      || typeof value.updatedAt !== "number"
      || now - value.updatedAt > SNAPSHOT_TTL_MS
      || !Array.isArray(value.positions)
      || value.positions.length > 100
      || !value.positions.every(isScrollPosition)
    ) {
      return null;
    }
    return value as unknown as RouteScrollSnapshot;
  } catch {
    return null;
  }
}

export function readRouteScrollSnapshot(
  storage: HistoryEntryStateStorage | null,
  entryKey: string | undefined,
): RouteScrollPosition[] {
  if (!storage || !entryKey) return [];
  try {
    const key = snapshotKey(entryKey);
    const snapshot = parseSnapshot(storage.getItem(key));
    if (!snapshot) storage.removeItem(key);
    return snapshot?.positions ?? [];
  } catch {
    return [];
  }
}

function cleanupSnapshots(storage: HistoryEntryStateStorage, now: number): void {
  const snapshots: Array<{ key: string; updatedAt: number }> = [];
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const snapshot = parseSnapshot(storage.getItem(key), now);
    if (!snapshot) {
      storage.removeItem(key);
      continue;
    }
    snapshots.push({ key, updatedAt: snapshot.updatedAt });
  }
  snapshots
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(MAX_SNAPSHOTS)
    .forEach(({ key }) => storage.removeItem(key));
}

export function writeRouteScrollSnapshot(
  storage: HistoryEntryStateStorage | null,
  entryKey: string | undefined,
  positions: RouteScrollPosition[],
): void {
  if (!storage || !entryKey) return;
  const safePositions = positions.filter(isScrollPosition).slice(0, 100);
  try {
    const now = Date.now();
    storage.setItem(snapshotKey(entryKey), JSON.stringify({
      version: SNAPSHOT_VERSION,
      updatedAt: now,
      positions: safePositions,
    } satisfies RouteScrollSnapshot));
    cleanupSnapshots(storage, now);
  } catch {
    // Scroll restoration is best-effort when storage is unavailable or full.
  }
}

function readTanStackSnapshot(
  storage: HistoryEntryStateStorage | null,
  entryKey: string | undefined,
): RouteScrollPosition[] {
  if (!storage || !entryKey) return [];
  try {
    const cache: unknown = JSON.parse(storage.getItem(TANSTACK_STORAGE_KEY) ?? "{}");
    if (!isRecord(cache) || !isRecord(cache[entryKey])) return [];
    return Object.entries(cache[entryKey]).flatMap(([selector, raw]) => {
      if (!isRecord(raw)) return [];
      const position = { selector, top: raw.scrollY, left: raw.scrollX };
      return isScrollPosition(position) ? [position] : [];
    });
  } catch {
    return [];
  }
}

function mergePositions(
  primary: RouteScrollPosition[],
  secondary: RouteScrollPosition[],
): RouteScrollPosition[] {
  const merged = new Map<string, RouteScrollPosition>();
  for (const position of secondary) merged.set(position.selector, position);
  for (const position of primary) merged.set(position.selector, position);
  return [...merged.values()];
}

function historyEntryKey(location: ParsedLocation | undefined): string | undefined {
  return location?.state.__TSR_key;
}

function currentInternalUrl(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function selectorForElement(element: Element): string | null {
  const id = element.getAttribute("data-scroll-restoration-id");
  return id && /^[a-zA-Z0-9:_-]{1,100}$/.test(id)
    ? `[data-scroll-restoration-id="${id}"]`
    : null;
}

export function captureRegisteredScrollPositions(): RouteScrollPosition[] {
  if (coveredPagePositions) return coveredPagePositions.map((position) => ({ ...position }));
  if (typeof window === "undefined" || typeof document === "undefined") return [];
  const positions: RouteScrollPosition[] = [
    { selector: "window", top: Math.max(0, window.scrollY), left: Math.max(0, window.scrollX) },
  ];

  document.querySelectorAll<HTMLElement>("[data-scroll-restoration-id]").forEach((element) => {
    const selector = selectorForElement(element);
    if (!selector || selector === DM_TRANSCRIPT_SELECTOR) return;
    positions.push({
      selector,
      top: Math.max(0, getPageScrollTop(element)),
      left: Math.max(0, isDocumentPageScroller(element) ? window.scrollX : element.scrollLeft),
    });
  });
  return positions;
}

function maxWindowScrollTop(): number {
  const documentHeight = Math.max(
    document.documentElement?.scrollHeight ?? 0,
    document.body?.scrollHeight ?? 0,
  );
  return Math.max(0, documentHeight - window.innerHeight);
}

/** Apply every currently attainable position and report whether all are exact. */
export function restoreScrollPositions(
  positions: RouteScrollPosition[],
  finalAttempt = false,
): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return true;
  let complete = true;
  const nativeId = document.documentElement?.getAttribute?.("data-mobile-page-scroll");
  // Older mobile Library versions scrolled the shell, while their named list
  // and detail wrappers remained at zero. Adopt that saved shell position once
  // instead of allowing the old zero to win over the user's place.
  if (nativeId?.startsWith("library-")) {
    const nativeSelector = `[data-scroll-restoration-id="${nativeId}"]`;
    const shellSelector = '[data-scroll-restoration-id="app-shell-main"]';
    const legacyShell = positions.find((position) => position.selector === shellSelector && position.top > 0);
    const named = positions.find((position) => position.selector === nativeSelector);
    if (legacyShell && (!named || named.top === 0)) {
      positions = positions.filter((position) => position.selector !== shellSelector && position.selector !== nativeSelector);
      positions.push({ ...legacyShell, selector: nativeSelector });
    }
  }
  const hasNamedNativePosition = nativeId && positions.some(
    (position) => position.selector === `[data-scroll-restoration-id="${nativeId}"]`,
  );

  for (const position of positions) {
    if (!isScrollPosition(position)) continue;
    if (position.selector === DM_TRANSCRIPT_SELECTOR) continue;
    if (position.selector === "window") {
      // A named page survives desktop/mobile changes and old nested snapshots.
      // Its saved position takes precedence over the incidental window entry.
      if (hasNamedNativePosition) continue;
      if (!nativeId && document.querySelector(".app-shell-root")) {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        continue;
      }
      const maxTop = maxWindowScrollTop();
      const maxLeft = Math.max(0, (document.documentElement?.scrollWidth ?? 0) - window.innerWidth);
      if (!finalAttempt && (position.top > maxTop + 1 || position.left > maxLeft + 1)) {
        complete = false;
        continue;
      }
      const top = Math.min(position.top, maxTop);
      const left = Math.min(position.left, maxLeft);
      window.scrollTo({ top, left, behavior: "auto" });
      if (Math.abs(window.scrollY - top) > 1 || Math.abs(window.scrollX - left) > 1) complete = false;
      continue;
    }

    let element: HTMLElement | null = null;
    try {
      element = document.querySelector<HTMLElement>(position.selector);
    } catch {
      continue;
    }
    if (!element) {
      if (!finalAttempt) complete = false;
      continue;
    }
    if (isDocumentPageScroller(element)) {
      if (!restoreScrollPositions([{ ...position, selector: "window" }], finalAttempt)) complete = false;
      continue;
    }
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    if (!finalAttempt && (position.top > maxTop + 1 || position.left > maxLeft + 1)) {
      complete = false;
      continue;
    }
    const top = Math.min(position.top, maxTop);
    const left = Math.min(position.left, maxLeft);
    element.scrollTop = top;
    element.scrollLeft = left;
    if (Math.abs(element.scrollTop - top) > 1 || Math.abs(element.scrollLeft - left) > 1) complete = false;
  }

  return complete;
}

export function queueExplicitScrollRestore(
  expectedUrl: string,
  positions: RouteScrollPosition[],
): void {
  queuedExplicitRestore = positions.length > 0
    ? { expectedUrl, positions: positions.filter(isScrollPosition), queuedAt: Date.now() }
    : null;
}

export function consumeExplicitScrollRestore(url: string): RouteScrollPosition[] {
  if (!queuedExplicitRestore) return [];
  if (Date.now() - queuedExplicitRestore.queuedAt > 10_000) {
    queuedExplicitRestore = null;
    return [];
  }
  if (queuedExplicitRestore.expectedUrl !== url) return [];
  const positions = queuedExplicitRestore.positions;
  queuedExplicitRestore = null;
  return positions;
}

function isScrollNavigationKey(event: KeyboardEvent): boolean {
  return ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key);
}

function scheduleRestore(entryKey: string, positions: RouteScrollPosition[]): void {
  cancelActiveRestore?.();
  if (positions.length === 0 || typeof window === "undefined" || typeof document === "undefined") return;

  let cancelled = false;
  let animationFrame = 0;
  const timers: number[] = [];
  let mutationObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    for (const timer of timers) window.clearTimeout(timer);
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener("wheel", cancel, true);
    window.removeEventListener("touchstart", cancel, true);
    window.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("load", queueAttempt, true);
    window.removeEventListener("keydown", onKeyDown, true);
    if (cancelActiveRestore === cancel) cancelActiveRestore = null;
  };

  const attempt = (finalAttempt = false) => {
    if (cancelled || window.history.state?.__TSR_key !== entryKey) {
      cancel();
      return;
    }
    if (restoreScrollPositions(positions, finalAttempt) || finalAttempt) cancel();
  };

  function queueAttempt() {
    if (cancelled || animationFrame) return;
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = 0;
      attempt(false);
    });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (isScrollNavigationKey(event)) cancel();
  }

  cancelActiveRestore = cancel;
  window.addEventListener("wheel", cancel, true);
  window.addEventListener("touchstart", cancel, true);
  window.addEventListener("pointerdown", cancel, true);
  window.addEventListener("load", queueAttempt, true);
  window.addEventListener("keydown", onKeyDown, true);

  if (typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver(queueAttempt);
    mutationObserver.observe(document.getElementById("root") ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(queueAttempt);
    resizeObserver.observe(document.documentElement);
    document.querySelectorAll<HTMLElement>("[data-scroll-restoration-id]").forEach((element) => {
      resizeObserver?.observe(element);
    });
  }

  RETRY_DELAYS_MS.forEach((delay, index) => {
    const finalAttempt = index === RETRY_DELAYS_MS.length - 1;
    timers.push(window.setTimeout(() => attempt(finalAttempt), delay));
  });
}

/**
 * Supplement TanStack's one-shot restoration with synchronous source capture
 * and readiness-aware retries for async route content.
 */
export function installRouteScrollRestoration(router: AnyRouter): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const storage = getSessionStorage();
  let renderedLocation = router.state.resolvedLocation;

  const capture = (location: ParsedLocation | undefined) => {
    writeRouteScrollSnapshot(storage, historyEntryKey(location), captureRegisteredScrollPositions());
  };

  const unsubscribeBeforeNavigate = router.subscribe("onBeforeNavigate", (event) => {
    capture(event.fromLocation ?? renderedLocation);
  });
  const unsubscribeRendered = router.subscribe("onRendered", (event) => {
    renderedLocation = event.toLocation;
    const entryKey = historyEntryKey(event.toLocation);
    if (!entryKey) return;
    const explicit = consumeExplicitScrollRestore(currentInternalUrl());
    const captured = readRouteScrollSnapshot(storage, entryKey);
    const tanStack = readTanStackSnapshot(storage, entryKey);
    scheduleRestore(entryKey, mergePositions(explicit, mergePositions(captured, tanStack)));
  });
  const onPageHide = () => capture(renderedLocation);
  window.addEventListener("pagehide", onPageHide);

  return () => {
    cancelActiveRestore?.();
    unsubscribeBeforeNavigate();
    unsubscribeRendered();
    window.removeEventListener("pagehide", onPageHide);
  };
}
