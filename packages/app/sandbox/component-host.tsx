/**
 * ComponentHost — the sandbox-side runtime.
 *
 * - ONE root component per world, composed from a multi-file virtual filesystem
 * - Channel-based state updates (variables / messages / streaming / session / ui)
 * - Building blocks (Chat, MessageList, MessageInput, ChatCanvas) are injected
 *   into compilation scope so creator code can import them by name.
 * - Game events emitted via emitEvent() on the yumina API
 */

import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Track every AudioContext a card creates so the host can suspend them when the
 * parent hides the iframe.
 *
 * The `suspend-media` handler can only find `<video>`/`<audio>` elements via a
 * DOM query. Web Audio has no element to find — a card that synthesises its own
 * sound kept playing after the player navigated away, and only a full page
 * refresh stopped it. Wrapping the constructor here (before any creator code
 * runs) is the same replace-the-browser-API approach the SDK already takes for
 * storage and networking.
 *
 * Contexts are held weakly so a discarded one does not pin its graph in memory.
 * Only contexts this host suspended are resumed, so a card that deliberately
 * paused its own audio is never restarted behind its back.
 */
const trackedAudioContexts = new Set<WeakRef<AudioContext>>();
const hostSuspendedContexts = new WeakSet<AudioContext>();

function trackAudioContexts(): void {
  const w = window as unknown as Record<string, unknown>;
  for (const key of ["AudioContext", "webkitAudioContext"]) {
    const Original = w[key] as (new (...args: unknown[]) => AudioContext) | undefined;
    if (typeof Original !== "function" || (Original as { __yuminaTracked?: boolean }).__yuminaTracked) continue;
    const Wrapped = function (this: unknown, ...args: unknown[]) {
      const ctx = new Original(...args);
      try {
        trackedAudioContexts.add(new WeakRef(ctx));
      } catch {}
      return ctx;
    } as unknown as new (...args: unknown[]) => AudioContext;
    Wrapped.prototype = Original.prototype;
    (Wrapped as { __yuminaTracked?: boolean }).__yuminaTracked = true;
    w[key] = Wrapped;
  }
}
trackAudioContexts();

function suspendTrackedAudioContexts(suspended: boolean): void {
  for (const ref of [...trackedAudioContexts]) {
    const ctx = ref.deref();
    if (!ctx) {
      trackedAudioContexts.delete(ref);
      continue;
    }
    try {
      if (suspended) {
        if (ctx.state === "running") {
          hostSuspendedContexts.add(ctx);
          void ctx.suspend();
        }
      } else if (hostSuspendedContexts.has(ctx)) {
        hostSuspendedContexts.delete(ctx);
        void ctx.resume();
      }
    } catch {}
  }
}
import { buildComponent } from "../src/features/studio/lib/tsx-component-builder";
import { useAssetFont } from "../src/lib/asset-font";
import { resolveAssetUrl, resolveAssetRefs } from "../src/lib/asset-url";
import { rewriteSandboxRootSelectors } from "../src/lib/sandbox-style-isolation";
import {
  classifyTopEdgeSample,
  shouldRevealTopEdge,
  TOP_EDGE_PX,
} from "../src/lib/top-edge-gate";
import {
  unwrapMessage,
  wrapMessage,
  postToParentWindow,
  isFromParent,
} from "./protocol";
import type {
  ParentMessage,
  ComponentErrorMessage,
  ReadyMessage,
  RenderedMessage,
  ChannelDataMap,
  StreamingChannelData,
  VariablesChannelData,
  MessagesChannelData,
  SessionChannelData,
  SandboxMode,
  UIChannelData,
} from "./protocol";
import { YuminaContext, buildAPI, useYumina, resolveApiCall, receiveStreamChunk, AUDIO_ENDED_EVENT, COMPOSER_DRAFT_EVENT, ROOM_FRAME_EVENT, OPEN_MEMORY_PANEL_EVENT } from "./sandbox-context";
import { withVariableNameAliases } from "./variable-alias";
import { installCompatShims, resolveShimCall, updateShimState } from "./compat-shims";
import { syncInstalledExtensions } from "./extensions";
import { ChatCanvas } from "./chat/chat-canvas";
import { LoreSlot } from "./lore-slot";
import { LoreButton, LorePanel, LoreGroup, LoreSwitch } from "./lore-button";
import { Chat } from "./building-blocks/chat";
import { MessageList } from "./chat/message-list";
import { isScrollIntent } from "./chat/scroll-intent";
import { restoreTranscriptPosition, setTranscriptActive, trackCustomTranscriptPositions } from "./chat/transcript-position";
import { MessageInput } from "./chat/message-input";
import { makeChatT } from "./chat/i18n";
import { ModelPickerModal, ModelTrigger } from "./chat/model-picker-modal";
import { SessionMemoryModal } from "./extensions/session-memory/session-memory-modal";
import type { StateChannel } from "@yumina/engine";
import type { SandboxState } from "./protocol";

// ── Error Boundary ──────────────────────────────────────────────────

// One-click copy button for the play-time component error. Self-contained
// (inline SVG + inline styles) because the sandbox bundle deliberately
// avoids lucide-react, sonner, and Tailwind. Uses navigator.clipboard with
// an execCommand fallback for iframes where the async clipboard API is
// blocked — both paths require a user gesture, which this button click
// provides.
function CopyErrorIconButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy error"
      title="Copy error"
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        padding: 0,
        borderRadius: 4,
        border: "none",
        background: "transparent",
        color: copied ? "#D3544B" : "rgba(211,84,75,0.7)",
        cursor: "pointer",
      }}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

class ErrorBoundary extends Component<
  { children: React.ReactNode; onError: (error: string) => void },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }

  componentDidCatch() {
    if (this.state.error) {
      this.props.onError(this.state.error);
    }
  }

  render() {
    if (this.state.error) {
      const err = this.state.error;
      return (
        <div
          style={{
            position: "relative",
            padding: 12,
            paddingRight: 36,
            borderRadius: 8,
            background: "rgba(211,84,75,0.08)",
            border: "1px solid rgba(211,84,75,0.3)",
          }}
        >
          <p style={{ fontSize: 12, fontWeight: 500, color: "#D3544B" }}>
            Component Error
          </p>
          <p
            style={{
              fontSize: 12,
              color: "rgba(211,84,75,0.7)",
              fontFamily: "monospace",
              marginTop: 4,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {err}
          </p>
          <CopyErrorIconButton text={`Component Error:\n${err}`} />
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Channel State ───────────────────────────────────────────────────

/** Compose channel updates into the flat SandboxState shape buildAPI() consumes. */
function assembleState(channels: ChannelState): SandboxState {
  return {
    // Variables channel. Both bags go through the name→id alias so a card can
    // read `api.variables.hunger` even when the variable's id is a UUID.
    variables: withVariableNameAliases(
      channels.variables?.variables ?? {},
      channels.variables?.variableIdsByName,
    ),
    globalVariables: withVariableNameAliases(
      channels.variables?.globalVariables ?? {},
      channels.variables?.variableIdsByName,
    ),
    // Messages channel
    messages: channels.messages?.messages ?? [],

    // Streaming channel
    isStreaming: channels.streaming?.isStreaming ?? false,
    streamingContent: channels.streaming?.content ?? "",
    streamingReasoning: channels.streaming?.reasoning ?? "",

    // Session channel
    worldName: channels.session?.worldName ?? "",
    worldCover: channels.session?.worldCover ?? null,
    worldId: channels.session?.worldId ?? "",
    sessionId: channels.session?.sessionId ?? "",
    currentUser: channels.session?.currentUser ?? null,
    user: channels.session?.user ?? { name: "Player", avatar: null },
    entries: channels.session?.entries ?? [],
    loreUiBindings: channels.session?.loreUiBindings ?? [],
    worldbooks: channels.session?.worldbooks ?? [],

    // UI channel
    canvasMode: "custom",
    mode: channels.ui?.mode ?? "session",
    capabilities: channels.ui?.capabilities ?? {
      canSendMessage: true,
      canPersistSession: true,
      canUseSessionApis: true,
      requiresAuth: false,
    },
    pendingChoices: channels.ui?.pendingChoices ?? [],
    error: channels.ui?.error ?? null,
    readOnly: channels.ui?.readOnly ?? false,
    checkpoints: channels.ui?.checkpoints ?? [],
    greetingContent: channels.ui?.greetingContent ?? null,
    selectedModel: channels.ui?.selectedModel ?? "",
    modelFallback: channels.ui?.modelFallback ?? null,
    userPlan: channels.ui?.userPlan ?? "free",
    memorySummaryEnabled: channels.ui?.memorySummaryEnabled ?? false,
    installedExtensions: channels.ui?.installedExtensions ?? [],
    preferredProvider: channels.ui?.preferredProvider ?? "official",
    mixMode: channels.ui?.mixMode ?? false,
    modelPool: channels.ui?.modelPool ?? [],
    hasEarlierMessages: channels.ui?.hasEarlierMessages ?? false,
    isLoadingEarlier: channels.ui?.isLoadingEarlier ?? false,
    bgmVolume: channels.ui?.bgmVolume ?? 0.7,
    sfxVolume: channels.ui?.sfxVolume ?? 0.8,
    language: channels.ui?.language ?? "en",
    balance: channels.ui?.balance ?? null,
    composerSendKey: channels.ui?.composerSendKey ?? "enter",
    sendFailureNonce: channels.ui?.sendFailureNonce ?? 0,
  };
}

interface ChannelState {
  variables: VariablesChannelData | null;
  messages: MessagesChannelData | null;
  streaming: StreamingChannelData | null;
  session: SessionChannelData | null;
  ui: UIChannelData | null;
}

// ── Smart scroll guard ──────────────────────────────────────────────
//
// Rule: programmatic scrolls (scrollTo / scrollBy / scrollIntoView and
// `scrollTop`/`scrollLeft` setters) are allowed until the user scrolls a
// container themselves. Once a container has been user-scrolled, further
// programmatic scrolls on it are no-ops until the next session reset.
//
// Why: creator-written custom UI usually does
//     useEffect(() => { el.scrollTop = el.scrollHeight }, [streamingContent])
// which yanks the viewport down on every streaming token, fighting the user
// when they scroll up to read history. Patching the DOM here fixes every
// existing card without requiring creators to rewrite their auto-scroll code.
//
// `fullyLocked` is the older guest-preview behavior (suppress all programmatic
// scrolls including initial mount-time auto-scroll) — kept intact.

const sandboxScrollState: {
  installed: boolean;
  fullyLocked: boolean;
  userScrolled: WeakSet<Element>;
  programmaticPending: WeakSet<Element>;
  windowScroll?: typeof window.scroll;
  windowScrollTo?: typeof window.scrollTo;
  windowScrollBy?: typeof window.scrollBy;
  elementScroll?: typeof Element.prototype.scroll;
  elementScrollTo?: typeof Element.prototype.scrollTo;
  elementScrollBy?: typeof Element.prototype.scrollBy;
  elementScrollIntoView?: typeof Element.prototype.scrollIntoView;
  scrollTopDesc?: PropertyDescriptor;
  scrollLeftDesc?: PropertyDescriptor;
} = {
  installed: false,
  fullyLocked: false,
  userScrolled: new WeakSet<Element>(),
  programmaticPending: new WeakSet<Element>(),
};

function callNativeWindowScrollTo(options: ScrollToOptions): void {
  const scrollTo = sandboxScrollState.windowScrollTo ?? window.scrollTo;
  scrollTo.call(window, options);
}

function callNativeElementScrollTo(element: Element | null, options: ScrollToOptions): void {
  if (!element) return;
  const scrollTo = sandboxScrollState.elementScrollTo ?? Element.prototype.scrollTo;
  scrollTo.call(element, options);
}

function shouldSuppressProgrammaticScroll(target: Element | null): boolean {
  if (sandboxScrollState.fullyLocked) return true;
  if (!target) return false;
  return sandboxScrollState.userScrolled.has(target);
}

function markProgrammaticScroll(target: Element | null): void {
  if (!target) return;
  sandboxScrollState.programmaticPending.add(target);
  // Clear after the resulting scroll event has had a chance to fire and be
  // consumed by the listener. Two rAFs gives the browser a frame to dispatch
  // the scroll event even if it was deferred to post-layout.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      sandboxScrollState.programmaticPending.delete(target);
    });
  });
}

function findScrollableAncestor(el: Element): Element | null {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;
  let current: Element | null = el;
  while (current && current !== doc.documentElement) {
    const cs = view.getComputedStyle(current);
    const overflowY = cs.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return doc.scrollingElement as Element | null;
}

function handleSandboxScrollEvent(event: Event): void {
  if (!isScrollIntent(event)) return;
  const target = event.target;
  let el: Element | null = null;
  if (target instanceof Element) {
    el = findScrollableAncestor(target);
  } else if (target instanceof Document) {
    el = (target.scrollingElement as Element | null) ?? target.documentElement;
  }
  if (!el) return;
  // Real input wins even during an initial/platform scroll. Browser-generated
  // scroll events never enter this path, so smooth scrolling cannot lock itself.
  sandboxScrollState.userScrolled.add(el);
}

function installSandboxScrollGuard(): void {
  if (sandboxScrollState.installed) return;

  sandboxScrollState.windowScroll = window.scroll;
  sandboxScrollState.windowScrollTo = window.scrollTo;
  sandboxScrollState.windowScrollBy = window.scrollBy;
  sandboxScrollState.elementScroll = Element.prototype.scroll;
  sandboxScrollState.elementScrollTo = Element.prototype.scrollTo;
  sandboxScrollState.elementScrollBy = Element.prototype.scrollBy;
  sandboxScrollState.elementScrollIntoView = Element.prototype.scrollIntoView;
  sandboxScrollState.scrollTopDesc =
    Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") ??
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop") ??
    undefined;
  sandboxScrollState.scrollLeftDesc =
    Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft") ??
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollLeft") ??
    undefined;

  window.scroll = guardWindowScroll(sandboxScrollState.windowScroll);
  window.scrollTo = guardWindowScroll(sandboxScrollState.windowScrollTo);
  window.scrollBy = guardWindowScroll(sandboxScrollState.windowScrollBy);
  Element.prototype.scroll = guardElementScroll(sandboxScrollState.elementScroll);
  Element.prototype.scrollTo = guardElementScroll(sandboxScrollState.elementScrollTo);
  Element.prototype.scrollBy = guardElementScroll(sandboxScrollState.elementScrollBy);

  const nativeScrollIntoView = sandboxScrollState.elementScrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    const container = findScrollableAncestor(this);
    if (shouldSuppressProgrammaticScroll(container)) return;
    markProgrammaticScroll(container);
    nativeScrollIntoView.call(this, arg as ScrollIntoViewOptions);
  };

  if (sandboxScrollState.scrollTopDesc?.set && sandboxScrollState.scrollTopDesc.get) {
    const origSet = sandboxScrollState.scrollTopDesc.set;
    const origGet = sandboxScrollState.scrollTopDesc.get;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      enumerable: sandboxScrollState.scrollTopDesc.enumerable ?? true,
      get(this: Element) {
        return origGet.call(this);
      },
      set(this: Element, value: number) {
        if (shouldSuppressProgrammaticScroll(this)) return;
        markProgrammaticScroll(this);
        origSet.call(this, value);
      },
    });
  }

  if (sandboxScrollState.scrollLeftDesc?.set && sandboxScrollState.scrollLeftDesc.get) {
    const origSet = sandboxScrollState.scrollLeftDesc.set;
    const origGet = sandboxScrollState.scrollLeftDesc.get;
    Object.defineProperty(Element.prototype, "scrollLeft", {
      configurable: true,
      enumerable: sandboxScrollState.scrollLeftDesc.enumerable ?? true,
      get(this: Element) {
        return origGet.call(this);
      },
      set(this: Element, value: number) {
        if (shouldSuppressProgrammaticScroll(this)) return;
        markProgrammaticScroll(this);
        origSet.call(this, value);
      },
    });
  }

  for (const event of ["wheel", "touchmove", "keydown", "pointerdown"]) {
    document.addEventListener(event, handleSandboxScrollEvent, { capture: true, passive: true });
  }

  sandboxScrollState.installed = true;
}

function guardWindowScroll(nativeScroll: typeof window.scroll): typeof window.scroll {
  return function (this: Window, optionsOrX?: ScrollToOptions | number, y?: number) {
    const target = (document.scrollingElement as Element | null) ?? document.documentElement;
    if (shouldSuppressProgrammaticScroll(target)) return;
    markProgrammaticScroll(target);
    if (typeof optionsOrX === "number") {
      nativeScroll.call(this, optionsOrX, y ?? 0);
    } else {
      nativeScroll.call(this, optionsOrX);
    }
  } as typeof window.scroll;
}

function guardElementScroll(nativeScroll: typeof Element.prototype.scroll): typeof Element.prototype.scroll {
  return function (this: Element, optionsOrX?: ScrollToOptions | number, y?: number) {
    if (shouldSuppressProgrammaticScroll(this)) return;
    markProgrammaticScroll(this);
    if (typeof optionsOrX === "number") {
      nativeScroll.call(this, optionsOrX, y ?? 0);
    } else {
      nativeScroll.call(this, optionsOrX);
    }
  } as typeof Element.prototype.scroll;
}

function resetSandboxUserScrollState(): void {
  // WeakSet has no .clear() — replace to drop all marks.
  sandboxScrollState.userScrolled = new WeakSet<Element>();
  sandboxScrollState.programmaticPending = new WeakSet<Element>();
}

function setSandboxDocumentScrollLocked(locked: boolean): void {
  // The smart guard is the only thing that knows how to bypass itself for
  // resetSandboxScrollPositions(); make sure it's installed even if the lock
  // is toggled before the mount useEffect runs.
  installSandboxScrollGuard();

  const root = document.documentElement;
  const body = document.body;
  const sandboxRoot = document.getElementById("sandbox-root");
  const targets = [root, body, sandboxRoot].filter(Boolean) as HTMLElement[];

  sandboxScrollState.fullyLocked = locked;

  if (!locked) {
    targets.forEach((el) => {
      el.style.removeProperty("overflow-y");
    });
    return;
  }

  targets.forEach((el) => {
    el.style.overflowY = "hidden";
  });
  resetSandboxScrollPositions();
}

function resetSandboxScrollPositions(): void {
  const sandboxRoot = document.getElementById("sandbox-root");

  // Bypass the smart guard via the saved native setters/methods — these resets
  // are platform-driven and must not be blocked by user-scroll state.
  const scrollTopSet = sandboxScrollState.scrollTopDesc?.set;
  if (scrollTopSet) {
    scrollTopSet.call(document.documentElement, 0);
    scrollTopSet.call(document.body, 0);
  } else {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
  callNativeElementScrollTo(sandboxRoot, { top: 0, left: 0, behavior: "auto" });
  callNativeWindowScrollTo({ top: 0, left: 0, behavior: "auto" });
}

// ── Self-healing scroll clamp watchdog ──────────────────────────────
//
// The sandbox document has exactly ONE document-level scroller
// (#sandbox-root; html/body are overflow:hidden). Browser-driven scrolls
// bypass the smart guard entirely: Android's soft-keyboard focus reveal
// scrolls it, and when the keyboard closes (interactive-widget=
// resizes-content grows the iframe back) the engine must clamp scrollTop
// back into range. On some devices that clamp is missed for composited
// iframe scrollers, leaving the whole game UI shifted up with dead sandbox
// background below — the "blank space under the game" reports. The same
// stuck state can follow any content shrink while pinned at max scroll
// (streaming bubble swap, creator UI collapsing a section).
//
// The watchdog re-checks the invariant `scrollTop <= scrollHeight -
// clientHeight` whenever the right-hand side changes (viewport resize,
// orientation, keyboard focusout, tab restore) plus a slow heartbeat for
// shrinks that fire no event when the engine's clamp was missed. It only
// corrects a STUCK offset: a reading must be out of range across two
// consecutive frames with an identical value, so UA animations (iOS rubber
// banding) and in-flight gestures are never fought.

// Fractional-DPR scroll positions legitimately rest ~0.5px past max — the
// user's "ratio/resolution" observation. Anything within this slack is the
// browser's own rounding, not a stuck offset.
const SCROLL_CLAMP_SLACK_PX = 2;

const scrollClampState = {
  touchActive: false,
  checkScheduled: false,
  // Diag budget per sandbox lifetime — enough to measure, never spammy.
  diagBudget: 3,
};

function clampCandidates(): Element[] {
  const els: (Element | null)[] = [
    document.getElementById("sandbox-root"),
    document.documentElement,
    document.body,
  ];
  return els.filter(Boolean) as Element[];
}

function scrollClampMax(el: Element): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

function runScrollClampCheck(trigger: string): void {
  if (scrollClampState.touchActive) return;
  const stuck = clampCandidates()
    .map((el) => ({ el, top: el.scrollTop }))
    .filter(({ el, top }) => top > scrollClampMax(el) + SCROLL_CLAMP_SLACK_PX);
  if (stuck.length === 0) return;

  // Second read one frame later: identical out-of-range value = frozen
  // offset (the bug); a changing value = the UA is animating it home.
  requestAnimationFrame(() => {
    if (scrollClampState.touchActive) return;
    for (const { el, top } of stuck) {
      const max = scrollClampMax(el);
      const current = el.scrollTop;
      if (current <= max + SCROLL_CLAMP_SLACK_PX) continue; // UA fixed it
      if (current !== top) continue; // still moving — not stuck
      markProgrammaticScroll(el);
      const setter = sandboxScrollState.scrollTopDesc?.set;
      if (setter) setter.call(el, max);
      else el.scrollTop = max;
      const delta = Math.round(current - max);
      if (delta >= 8 && scrollClampState.diagBudget > 0) {
        scrollClampState.diagBudget--;
        postToParentWindow(
          wrapMessage({
            type: "diag" as const,
            event: "scroll-clamped",
            data: {
              element:
                el === document.documentElement
                  ? "html"
                  : el === document.body
                    ? "body"
                    : el.id || "sandbox-root",
              delta,
              clientHeight: el.clientHeight,
              scrollHeight: el.scrollHeight,
              trigger,
            },
          }),
        );
      }
    }
  });
}

function scheduleScrollClampCheck(trigger: string): void {
  if (scrollClampState.checkScheduled) return;
  scrollClampState.checkScheduled = true;
  // Double rAF: let the resize/keyboard relayout — and the UA's own clamp —
  // settle first, so we only ever correct what the engine actually missed.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollClampState.checkScheduled = false;
      runScrollClampCheck(trigger);
    });
  });
}

function installScrollClampWatchdog(): () => void {
  const onResize = () => scheduleScrollClampCheck("resize");
  const onOrientation = () => scheduleScrollClampCheck("orientation");
  const onFocusOut = () => scheduleScrollClampCheck("focusout");
  const onVisibility = () => {
    if (!document.hidden) scheduleScrollClampCheck("visible");
  };
  const onTouchStart = () => {
    scrollClampState.touchActive = true;
  };
  const onTouchEnd = () => {
    scrollClampState.touchActive = false;
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onOrientation);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  window.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  window.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
  // Heartbeat: a missed clamp after a no-event content shrink has nothing to
  // hook — three layout reads every 2.5s is negligible next to streaming.
  const heartbeat = window.setInterval(() => runScrollClampCheck("heartbeat"), 2500);
  return () => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onOrientation);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("touchstart", onTouchStart, { capture: true });
    window.removeEventListener("touchend", onTouchEnd, { capture: true });
    window.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    window.clearInterval(heartbeat);
  };
}

// ── Top-edge reporter ───────────────────────────────────────────────

const TOP_EDGE_THROTTLE_MS = 400;

// Controls the top-edge reporter must NOT fire over: revealing the floating
// bar while the pointer rests on a clickable element slides the bar in ON TOP
// of that element and steals the click (reported: the "show earlier messages"
// button at the top of the message list was unclickable on desktop, windowed
// mode). Real elements only — creator TSX that fakes a button with a plain
// onClick div isn't covered, which is an accepted gap.
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * Forward top-edge pointer/touch hits to the parent.
 *
 * The parent reveals its play-page chrome (back-to-library + fullscreen toggle)
 * when the pointer reaches the top edge of the viewport — but that whole band is
 * covered by this iframe, and events inside an iframe never reach the embedder,
 * so the parent's own listeners can never fire over a card. Report the hit
 * instead. Throttled; the parent re-arms its auto-hide timer on each message.
 *
 * Mouse reveals ONLY on a deliberate edge slam (the outermost
 * TOP_EDGE_ALWAYS_PX strip). The earlier dwell-in-band design (300ms anywhere
 * in the top 60px) kept summoning the bar over the text of readers who park
 * the cursor where they read (@burlingk), and there was no setting to stop
 * it. Touch keeps the discrete per-tap gate over the wide band — taps are
 * deliberate, and phones have no F11/ESC fallback. Decision logic lives in
 * src/lib/top-edge-gate.ts (pure, unit-tested).
 */
function installTopEdgeReporter(): () => void {
  let lastSent = 0;
  const send = () => {
    const now = Date.now();
    if (now - lastSent < TOP_EDGE_THROTTLE_MS) return;
    lastSent = now;
    // Deliberately unwrapped: this is chrome signalling, not a SandboxMessage.
    // The parent bridge drops unwrapped payloads, and the chrome listens for
    // this shape directly.
    postToParentWindow({ type: "yumina:top-edge" });
  };
  const onMove = (e: MouseEvent) => {
    if (classifyTopEdgeSample(e.clientY) === "fire") send();
  };
  const onTouch = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY ?? Infinity;
    if (y > TOP_EDGE_PX) return;
    if (shouldRevealTopEdge(y, isInteractiveTarget(e.target))) send();
  };
  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("touchstart", onTouch, { capture: true, passive: true });
  return () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchstart", onTouch, { capture: true });
  };
}

// ── Scroll-to-top history loader ────────────────────────────────────
//
// Mega-session pagination (2026-08-11) means the host only holds a recent
// window of the transcript. The injected <Chat/> MessageList grew a "load
// earlier messages" button, but cards that draw their OWN message list from
// api.messages got no entry point — players past the window saw older
// history silently vanish. This loader restores the standard chat-app
// contract for those cards at the sandbox level: scrolling any card-drawn
// container to its top pulls the previous history page and re-anchors the
// viewport so the revealed rows land above, with zero card changes.
//
// Cards that mount the injected list (`.play-message-scroll`) are skipped —
// that list already pages itself with its own button and anchoring.

interface EarlierLoaderCtx {
  hasEarlier: boolean;
  loading: boolean;
  sessionId: string;
  language: string;
  load: () => Promise<boolean>;
}

const EARLIER_TOP_PX = 24; // container counts as "at top" within this
const EARLIER_COOLDOWN_MS = 800; // min gap between page pulls
const EARLIER_SETTLE_FRAMES = 90; // ~1.5s of rAF polling for the prepend to mount

/** Write scrollTop through the guard's saved native setter — the container is
 *  user-scrolled by definition here (they scrolled to top), so the patched
 *  setter would swallow the anchor compensation. */
function setScrollTopNative(el: Element, top: number): void {
  const set = sandboxScrollState.scrollTopDesc?.set;
  if (set) set.call(el, top);
  else (el as HTMLElement).scrollTop = top;
}

function installEarlierHistoryLoader(ctxRef: { current: EarlierLoaderCtx }): () => void {
  let lastTrigger = 0;
  let inFlight = false;
  let pill: HTMLElement | null = null;
  let lastTouchY: number | null = null;
  // Last seen scrollTop per container — the scroll path only fires on UPWARD
  // motion into the top band. Cards smooth-auto-scroll to the bottom on mount
  // and that animation starts at scrollTop 0 moving DOWN; its early frames land
  // inside the band but with increasing scrollTop, so direction cleanly
  // separates them from a player scrolling up for history. (The guard's
  // programmatic marks can't do this — they cover only the first animation
  // frame, and frame 2+ can still be inside the band.)
  const lastTops = new WeakMap<Element, number>();

  const showPill = () => {
    if (pill) return;
    const t = makeChatT(ctxRef.current.language);
    pill = document.createElement("div");
    pill.textContent = t("loadingEarlier");
    // Inline styles only — the pill must not depend on any card CSS.
    Object.assign(pill.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483000",
      padding: "6px 14px",
      borderRadius: "999px",
      background: "rgba(20,20,24,.85)",
      color: "rgba(255,255,255,.85)",
      fontSize: "12px",
      fontFamily: "system-ui, sans-serif",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(pill);
  };
  const hidePill = () => {
    pill?.remove();
    pill = null;
  };

  // Rows arrive on a later render (RPC → parent store → channel → React), so
  // poll until the container actually grew, then shift scrollTop by exactly
  // the inserted height — the messages the user was reading stay put and the
  // older ones appear above to scroll into.
  const settleAnchor = (el: Element, height: number, top: number) => {
    let frames = 0;
    const tick = () => {
      const grown = el.scrollHeight - height;
      if (grown > 0) {
        setScrollTopNative(el, top + grown);
        hidePill();
        inFlight = false;
      } else if (++frames < EARLIER_SETTLE_FRAMES) {
        requestAnimationFrame(tick);
      } else {
        // No growth — page was empty or this wasn't the message pane.
        hidePill();
        inFlight = false;
      }
    };
    requestAnimationFrame(tick);
  };

  const maybeTrigger = (el: Element | null) => {
    const ctx = ctxRef.current;
    if (!el || inFlight || ctx.loading || !ctx.hasEarlier || !ctx.sessionId) return;
    if (document.querySelector(".play-message-scroll")) return;
    if (el.scrollTop > EARLIER_TOP_PX) return;
    if (el.scrollHeight <= el.clientHeight + 40) return; // not a real scroll pane
    const now = Date.now();
    if (now - lastTrigger < EARLIER_COOLDOWN_MS) return;
    lastTrigger = now;
    inFlight = true;
    showPill();
    const height = el.scrollHeight;
    const top = el.scrollTop;
    ctx
      .load()
      .then(() => settleAnchor(el, height, top))
      .catch(() => {
        hidePill();
        inFlight = false;
      });
  };

  const onScroll = (event: Event) => {
    const target = event.target;
    let el: Element | null = null;
    if (target instanceof Element) el = target;
    else if (target instanceof Document) {
      el = (target.scrollingElement as Element | null) ?? target.documentElement;
    }
    if (!el) return;
    const prev = lastTops.get(el);
    const cur = el.scrollTop;
    lastTops.set(el, cur);
    // Fire only on upward motion — a container we've seen before, moving to a
    // smaller scrollTop. The first event on a container only records.
    if (prev === undefined || cur >= prev) return;
    maybeTrigger(el);
  };
  // A container already resting at scrollTop 0 emits no scroll event on a
  // further wheel-up / pull-down — only wheel/touch see that gesture.
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY >= 0) return;
    if (!(event.target instanceof Element)) return;
    maybeTrigger(findScrollableAncestor(event.target));
  };
  const onTouchStart = (event: TouchEvent) => {
    lastTouchY = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y === undefined) return;
    const prev = lastTouchY;
    lastTouchY = y;
    if (prev === null || y <= prev) return; // finger moving down = scrolling up
    if (!(event.target instanceof Element)) return;
    maybeTrigger(findScrollableAncestor(event.target));
  };

  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("wheel", onWheel, { capture: true, passive: true });
  document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  return () => {
    document.removeEventListener("scroll", onScroll, { capture: true });
    document.removeEventListener("wheel", onWheel, { capture: true });
    document.removeEventListener("touchstart", onTouchStart, { capture: true });
    document.removeEventListener("touchmove", onTouchMove, { capture: true });
    hidePill();
  };
}

// ── Component Host ──────────────────────────────────────────────────

/** Host-level mount for the session-memory panel. The parent play-controls bar
 *  can ask for it (open-memory-panel message) so worlds whose custom UI never
 *  renders the composer slots — no Memory pill — still reach the panel. The
 *  modal is mounted here, OUTSIDE creator markup, and gated on install state. */
function MemoryPanelHostMount() {
  const api = useYumina();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_MEMORY_PANEL_EVENT, handler);
    return () => window.removeEventListener(OPEN_MEMORY_PANEL_EVENT, handler);
  }, []);
  if (!api.memorySummaryEnabled || !open) return null;
  return <SessionMemoryModal open={open} onClose={() => setOpen(false)} />;
}

export function ComponentHost() {
  // Per-channel state
  const [channels, setChannels] = useState<ChannelState>({
    variables: null,
    messages: null,
    streaming: null,
    session: null,
    ui: null,
  });

  // The compiled root component. We track the installed files key in a ref
  // (not state) so the message handler closure stays stable across re-renders —
  // otherwise the window message listener gets re-bound on every install.
  const installedFilesKeyRef = useRef<string>("");
  const [rootComponent, setRootComponent] = useState<{
    filesKey: string;
    CompiledComponent: React.ComponentType<Record<string, unknown>> | null;
    error: string | null;
  } | null>(null);

  // ── Hydration gate ──
  // Hold the root component's FIRST render until the initial variables +
  // messages channel pushes have been applied. Without this, a card whose
  // install-root message lands before the channel messages (the precompiled
  // fast path) renders its first frame against the default empty state
  // ({} variables, [] messages) and misreads "loading" as "brand-new session"
  // — the root cause of setup-screen "bounce back" bugs. Every parent host
  // (WorldRenderer) pushes both channels unconditionally on mount, so this
  // gate normally opens within a couple of macrotasks; the timeout below is a
  // belt-and-suspenders fallback so an unexpected host that never pushes a
  // channel degrades to today's behavior instead of hanging the card.
  const stateHydrated = channels.variables !== null && channels.messages !== null;
  const [hydrationTimedOut, setHydrationTimedOut] = useState(false);

  // Assemble channel state into a single SandboxState for the API
  const assembledState = useMemo(() => assembleState(channels), [channels]);
  const api = useMemo(() => buildAPI(assembledState), [assembledState]);

  // Force the hydration gate open if the initial channel pushes never arrive
  // (an unexpected host) — degrades to pre-gate behavior instead of hanging.
  useEffect(() => {
    if (!rootComponent || stateHydrated || hydrationTimedOut) return;
    const t = window.setTimeout(() => setHydrationTimedOut(true), 1500);
    return () => window.clearTimeout(t);
  }, [rootComponent, stateHydrated, hydrationTimedOut]);

  // Lazy-load installed extensions' client modules + gate their contributions.
  // Keyed on the joined list (channel pushes recreate the array each time).
  const installedExtensionsKey = assembledState.installedExtensions.join(",");
  useEffect(() => {
    syncInstalledExtensions(installedExtensionsKey ? installedExtensionsKey.split(",") : []);
  }, [installedExtensionsKey]);

  // Install the smart scroll guard once. Always-on so creator code's
  // unconditional `el.scrollTop = scrollHeight` during streaming stops yanking
  // the viewport once the user has scrolled themselves.
  useEffect(() => {
    installSandboxScrollGuard();
  }, []);

  // Apply the user's site-wide font-size preference to the sandbox document.
  // The host applies it to its own root via --font-size-scale, but CSS never
  // crosses an iframe boundary, so chat text in here stayed 16px-rooted no
  // matter what the setting said (@burlingk's report). Scaling the root
  // font-size is the same mechanism the host uses: rem-based text (the
  // injected chat UI, creator Tailwind classes) follows; px-based card
  // layouts are untouched.
  const uiFontScale = channels.ui?.uiFontScale ?? 1;
  useEffect(() => {
    document.documentElement.style.fontSize =
      uiFontScale === 1 ? "" : `${16 * uiFontScale}px`;
  }, [uiFontScale]);

  // Self-healing clamp for stuck out-of-range scroll offsets (game UI pushed
  // up with dead space below). Guard must be installed first — the watchdog
  // corrects through the guard's saved native setter.
  useEffect(() => installScrollClampWatchdog(), []);

  // Scroll-to-top history loader for cards that draw their own message list.
  // Listeners are installed once and read live state through this ref, so
  // they never rebind on channel updates.
  const earlierLoaderCtxRef = useRef<EarlierLoaderCtx>({
    hasEarlier: false,
    loading: false,
    sessionId: "",
    language: "en",
    load: () => Promise.resolve(false),
  });
  earlierLoaderCtxRef.current = {
    hasEarlier: assembledState.hasEarlierMessages,
    loading: assembledState.isLoadingEarlier,
    sessionId: assembledState.sessionId,
    language: assembledState.language,
    load: api.loadEarlierMessages,
  };
  useEffect(() => installEarlierHistoryLoader(earlierLoaderCtxRef), []);

  // Let the parent's play chrome see top-edge hits that land on this iframe.
  useEffect(() => installTopEdgeReporter(), []);

  // Drop "user has scrolled" marks when the session changes — a fresh session
  // starts with auto-scroll enabled again.
  useEffect(() => {
    resetSandboxUserScrollState();
  }, [assembledState.sessionId]);

  useEffect(() => {
    if (!assembledState.sessionId || assembledState.mode === "guest-preview") return;
    return trackCustomTranscriptPositions(assembledState.sessionId, (element, top) => {
      const setter = sandboxScrollState.scrollTopDesc?.set;
      if (setter) setter.call(element, top); else element.scrollTop = top;
    });
  }, [assembledState.sessionId, assembledState.mode]);

  // Guest preview is hosted inside a fixed-height parent frame. Creator cards
  // may call scrollIntoView() for their own internal chat panes; in preview that
  // can move the whole card out of its initial composition. Lock all programmatic
  // sandbox scrolling in guest preview; pointer/trackpad scrolling still works.
  useEffect(() => {
    setSandboxDocumentScrollLocked(assembledState.mode === "guest-preview");
  }, [assembledState.mode]);

  useEffect(() => {
    if (assembledState.mode !== "guest-preview" || !rootComponent?.CompiledComponent) return;
    const rafId = requestAnimationFrame(resetSandboxScrollPositions);
    return () => cancelAnimationFrame(rafId);
  }, [assembledState.mode, rootComponent?.CompiledComponent]);

  useEffect(() => {
    return () => {
      setSandboxDocumentScrollLocked(false);
    };
  }, []);

  // ── Handle messages from parent ──
  const handleMessage = useCallback(async (event: MessageEvent) => {
    // Only the embedding parent window (validated against the pinned origin
    // when ?parentOrigin= is present) may drive the sandbox — anything else
    // could otherwise install code or spoof state.
    if (!isFromParent(event)) return;
    const msg = unwrapMessage<ParentMessage>(event.data);
    if (!msg) return;

    switch (msg.type) {
      case "install-root": {
        const { entryFile, files, mode, compiledCode, compileError } = msg as {
          entryFile?: string;
          files?: Record<string, string>;
          mode?: SandboxMode;
          compiledCode?: string;
          compileError?: string;
        };

        if (mode) {
          setSandboxDocumentScrollLocked(mode === "guest-preview");
        }

        // Cache key over whatever the parent sent — compiledCode changes per file edit
        // just like the raw files do, so both paths invalidate on real changes.
        const filesKey = JSON.stringify({ entryFile, files, compiledCode, compileError });
        if (installedFilesKeyRef.current === filesKey) break;
        installedFilesKeyRef.current = filesKey;

        let Compiled: React.ComponentType<Record<string, unknown>> | null = null;
        let error: string | null = compileError ?? null;

        if (!error) {
          if (compiledCode) {
            // Fast path: parent pre-bundled the multi-file TSX to a single JS string.
            // The sandbox no longer needs Sucrase or the bundler module — those ~956K
            // are kept entirely on the parent's bundle where they already exist for the
            // studio editor preview.
            const result = buildComponent(compiledCode, useYumina, {
              useAssetFont, ChatCanvas, Chat, MessageList, MessageInput,
              ModelPickerModal: ModelPickerModal as React.ComponentType<Record<string, unknown>>,
              ModelTrigger: ModelTrigger as React.ComponentType<Record<string, unknown>>,
              SessionMemoryModal: SessionMemoryModal as React.ComponentType<Record<string, unknown>>,
              LoreSlot,
              LoreButton: LoreButton as React.ComponentType<Record<string, unknown>>,
              LorePanel: LorePanel as React.ComponentType<Record<string, unknown>>,
              LoreGroup: LoreGroup as React.ComponentType<Record<string, unknown>>,
              LoreSwitch: LoreSwitch as React.ComponentType<Record<string, unknown>>,
            });
            Compiled = result.Component;
            error = result.error;
          } else {
            // Legacy fallback: parent sent raw files without precompile. Keep the dynamic
            // import so the bundler chunk only loads for these rare cases, not every boot.
            try {
              const { bundleAndCompile } = await import("../src/features/studio/lib/tsx-bundler");
              const result = bundleAndCompile(
                { files: files ?? {}, entryFile: entryFile ?? "index.tsx" },
                useYumina,
                {
                  useAssetFont, ChatCanvas, Chat, MessageList, MessageInput,
                  ModelPickerModal: ModelPickerModal as React.ComponentType<Record<string, unknown>>,
                  ModelTrigger: ModelTrigger as React.ComponentType<Record<string, unknown>>,
                  SessionMemoryModal: SessionMemoryModal as React.ComponentType<Record<string, unknown>>,
                  LoreSlot,
                  LoreButton: LoreButton as React.ComponentType<Record<string, unknown>>,
                  LorePanel: LorePanel as React.ComponentType<Record<string, unknown>>,
                  LoreGroup: LoreGroup as React.ComponentType<Record<string, unknown>>,
                  LoreSwitch: LoreSwitch as React.ComponentType<Record<string, unknown>>,
                },
              );
              Compiled = result.Component;
              error = result.error;
            } catch (e) {
              error = e instanceof Error ? e.message : "Bundle compilation failed";
            }
          }
        }

        if (error) {
          const errMsg: ComponentErrorMessage = {
            type: "component-error",
            message: error,
          };
          postToParentWindow(wrapMessage(errMsg));
        }

        setRootComponent({
          filesKey,
          CompiledComponent: Compiled,
          error,
        });
        break;
      }

      case "channel": {
        const { channel, data } = msg;
        setChannels((prev) => ({
          ...prev,
          [channel]: data,
        }));
        // Keep compat shims in sync
        if (channel === "session") {
          const session = data as SessionChannelData;
          updateShimState(session.sessionId, session.worldId);
        }
        break;
      }

      case "theme": {
        const root = document.documentElement;
        for (const [key, value] of Object.entries(msg.cssVars)) {
          root.style.setProperty(key, value);
        }
        break;
      }

      case "suspend-media": {
        setTranscriptActive(!msg.suspended);
        // Universal pause for raw <video>/<audio> tags in creator TSX.
        // Called when the parent hides the iframe (navigation, theater exit) without
        // unmounting it — without this, media elements inside a display:none iframe
        // keep playing. We only pause; resume is up to the creator's own code on
        // re-mount (autoPlay / onVisible handlers), so we don't silently restart
        // audio the user expected to stay stopped.
        const els = document.querySelectorAll<HTMLMediaElement>("video, audio");
        if (msg.suspended) {
          els.forEach((el) => {
            if (!el.paused) el.pause();
          });
        }
        // Web Audio is NOT a media element, so the query above never sees it. A
        // card that synthesises its own sound (procedural ambience, an in-card
        // synth) kept playing after the player navigated away and only stopped on
        // a full refresh. Suspending the tracked contexts covers every card
        // without the creator having to wire anything up.
        suspendTrackedAudioContexts(msg.suspended);
        break;
      }

      case "audio-event": {
        // Parent-side SDK audio finished — re-dispatch as a window event so
        // creator code subscribed via api.onAudioEnded reacts (auto-advance, etc.)
        if (msg.event === "ended") {
          window.dispatchEvent(
            new CustomEvent(AUDIO_ENDED_EVENT, { detail: { trackId: msg.trackId } }),
          );
        }
        break;
      }

      case "room-frame": {
        // Multiplayer frame from the parent-held game WebSocket — re-dispatch
        // as a window event; api.room.on* subscribers (creator code) listen.
        window.dispatchEvent(new CustomEvent(ROOM_FRAME_EVENT, { detail: msg.frame }));
        break;
      }

      case "open-memory-panel": {
        // Parent play-controls bar fallback for worlds whose custom UI has no
        // Memory pill — MemoryPanelHostMount listens.
        window.dispatchEvent(new CustomEvent(OPEN_MEMORY_PANEL_EVENT));
        break;
      }

      case "restore-composer-draft": {
        // A draft this tab typed before a reload. Same event MessageInput uses
        // for creator prefill, but explicitly focus-free: restoring text on load
        // must not pop the mobile keyboard.
        window.dispatchEvent(
          new CustomEvent(COMPOSER_DRAFT_EVENT, {
            detail: { text: msg.text, focus: false },
          }),
        );
        break;
      }

      case "restore-transcript-position": {
        restoreTranscriptPosition(msg.position);
        break;
      }

      case "api-response": {
        if (msg.callId.startsWith("shim-")) {
          resolveShimCall(msg.callId, msg.result);
        } else {
          resolveApiCall(msg.callId, msg.result);
        }
        break;
      }

      case "api-stream": {
        receiveStreamChunk(msg.callId, msg.delta, msg.done, msg.result);
        break;
      }
    }
  }, []);

  // ── Lifecycle ──
  useEffect(() => {
    // Install compat shims before any user code runs
    installCompatShims();

    // Listen for messages
    window.addEventListener("message", handleMessage);

    // iOS autoplay rescue: Safari / Chrome on iOS (all iOS browsers are WebKit)
    // often refuse to honor `autoplay` inside cross-origin iframes even with
    // `allow="autoplay"` and `muted=true`. The <video> / <audio> element loads
    // and just sits at the first frame. The rescue runs on every early gesture
    // (not one-shot) because: (a) one gesture may unlock but not land on a
    // media element that's still buffering, (b) repeated idempotent .play()
    // calls on already-playing media are cheap, (c) we'd rather be robust
    // than clever — iOS behavior varies by version / Low Power Mode.
    // Silent-unlock trick also primes HTMLAudioElement + AudioContext for
    // creator code that calls .play() directly after the gesture.
    const SILENT_WAV =
      "data:audio/wav;base64,UklGRhwAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
    let _rescuedOnce = false;
    const rescueAutoplay = () => {
      if (!_rescuedOnce) {
        _rescuedOnce = true;
        // Prime element-based audio
        try { const a = new Audio(SILENT_WAV); a.volume = 0; void a.play().catch(() => {}); } catch { /* noop */ }
        // Prime Web Audio context
        try {
          const Ctor = (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext
            ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (Ctor) {
            const ctx = new Ctor();
            const src = ctx.createBufferSource();
            src.buffer = ctx.createBuffer(1, 1, 22050);
            src.connect(ctx.destination);
            src.start(0);
            void ctx.resume().catch(() => {});
          }
        } catch { /* noop */ }
      }
      const els = document.querySelectorAll<HTMLMediaElement>(
        "video[autoplay], audio[autoplay]"
      );
      els.forEach((el) => {
        if (el.paused) el.play().catch(() => {});
      });
    };
    document.addEventListener("touchstart", rescueAutoplay, { passive: true, capture: true });
    document.addEventListener("touchend", rescueAutoplay, { passive: true, capture: true });
    document.addEventListener("click", rescueAutoplay, { capture: true });
    document.addEventListener("keydown", rescueAutoplay, { capture: true });

    // Signal ready to parent
    const readyMsg: ReadyMessage = {
      type: "ready",
      protocolVersion: 2,
    };
    postToParentWindow(wrapMessage(readyMsg));

    return () => {
      window.removeEventListener("message", handleMessage);
      document.removeEventListener("touchstart", rescueAutoplay, true);
      document.removeEventListener("touchend", rescueAutoplay, true);
      document.removeEventListener("click", rescueAutoplay, true);
      document.removeEventListener("keydown", rescueAutoplay, true);
    };
  }, [handleMessage]);

  // ── Render ──

  const handleError = useCallback((error: string) => {
    const errMsg: ComponentErrorMessage = {
      type: "component-error",
      message: error,
    };
    postToParentWindow(wrapMessage(errMsg));
  }, []);

  // Ref for the root render container (used by MutationObserver + ResizeObserver)
  const hostRef = useRef<HTMLDivElement>(null);
  // One shared UGC signal. Browser-generated input only, never automatic
  // simulation, API calls, pointer movement, or page chrome. No input content.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || assembledState.mode !== "session" || !rootComponent?.CompiledComponent || rootComponent.error || (!stateHydrated && !hydrationTimedOut)) return;
    let lastSent = -Infinity;
    const interaction = (event: Event) => {
      if (!event.isTrusted || document.visibilityState !== "visible") return;
      if (event instanceof KeyboardEvent && (event.repeat || event.metaKey || event.ctrlKey || event.altKey)) return;
      const now = performance.now();
      if (now - lastSent < 5_000) return;
      lastSent = now;
      postToParentWindow(wrapMessage({ type: "play-interaction" }));
    };
    for (const type of ["pointerdown", "keydown", "wheel"]) host.addEventListener(type, interaction, { capture: true, passive: true });
    return () => { for (const type of ["pointerdown", "keydown", "wheel"]) host.removeEventListener(type, interaction, true); };
  }, [assembledState.mode, assembledState.sessionId, rootComponent, stateHydrated, hydrationTimedOut]);

  // ── Runtime processing pipeline (ported from SandboxHost v1) ──
  // Fixes: arbitrary Tailwind colors (class), @asset: URLs (style/<style>),
  // referrer policies + asset resolution (img). INCREMENTAL: the observer
  // routes each mutation to just the work it needs and processes only the
  // nodes that changed — so a custom card re-rendering hundreds of inline-style
  // objects per keystroke no longer triggers a full-iframe querySelectorAll
  // scan ~20Hz. A pure inline-style change with no `@asset:` is a no-op.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let rafId: number | null = null;
    let suppressObserver = false;
    let lastFlushTs = 0;
    let throttleId: ReturnType<typeof setTimeout> | null = null;
    // 50ms throttle — coalesces bursty DOM churn into ~20Hz. suppressObserver
    // gates re-entry so the fixes we apply don't re-trigger the observer.
    const THROTTLE_MS = 50;

    // Queued work since the last flush — only the nodes that actually changed.
    const treeDirty = new Set<HTMLElement>();   // added subtrees → full process
    const colorDirty = new Set<HTMLElement>();  // class attr changed
    const imgDirty = new Set<HTMLElement>();    // img src attr changed
    const styleDirty = new Set<HTMLElement>();  // style attr changed AND has @asset
    const styleTagDirty = new Set<HTMLStyleElement>(); // <style> text changed

    const flush = () => {
      suppressObserver = true;
      for (const el of treeDirty) { rewriteSandboxRootSelectors(el); applyRuntimeStyleFixes(el); hardenImages(el); void resolveStyleAssetRefsInDOM(el); }
      for (const el of colorDirty) if (!treeDirty.has(el)) fixColorsOnEl(el);
      for (const el of imgDirty) if (!treeDirty.has(el) && el instanceof HTMLImageElement) hardenImageEl(el);
      for (const el of styleDirty) if (!treeDirty.has(el)) void resolveAssetOnStyledEl(el);
      for (const el of styleTagDirty) { rewriteSandboxRootSelectors(el); void resolveAssetOnStyleTag(el); }
      treeDirty.clear(); colorDirty.clear(); imgDirty.clear(); styleDirty.clear(); styleTagDirty.clear();
      queueMicrotask(() => { suppressObserver = false; });
    };

    // Initial full scan — covers everything already in the tree on mount.
    suppressObserver = true;
    rewriteSandboxRootSelectors(host);
    applyRuntimeStyleFixes(host);
    hardenImages(host);
    void resolveStyleAssetRefsInDOM(host);
    queueMicrotask(() => { suppressObserver = false; });

    const scheduleFlush = () => {
      if (rafId !== null) return;
      const now = Date.now();
      const elapsed = now - lastFlushTs;
      if (elapsed < THROTTLE_MS) {
        if (throttleId === null) {
          throttleId = setTimeout(() => { throttleId = null; scheduleFlush(); }, THROTTLE_MS - elapsed);
        }
        return;
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        lastFlushTs = Date.now();
        flush();
      });
    };

    const enqueue = (mutations: MutationRecord[]) => {
      if (suppressObserver) return;
      let hasWork = false;
      for (const m of mutations) {
        if (m.type === "childList") {
          m.addedNodes.forEach((n) => { if (n instanceof HTMLElement) { treeDirty.add(n); hasWork = true; } });
        } else if (m.type === "attributes" && m.target instanceof HTMLElement) {
          const el = m.target;
          if (m.attributeName === "class") { colorDirty.add(el); hasWork = true; }
          else if (m.attributeName === "src") { imgDirty.add(el); hasWork = true; }
          else if (m.attributeName === "style") {
            // Only inline styles that carry an @asset: ref need work; ordinary
            // numeric/color style churn (the per-keystroke re-render case) is
            // skipped entirely, which is the whole point of this rewrite.
            if ((el.getAttribute("style") ?? "").includes("@asset:")) { styleDirty.add(el); hasWork = true; }
          }
        } else if (m.type === "characterData") {
          const p = m.target.parentNode;
          if (p instanceof HTMLStyleElement) { styleTagDirty.add(p); hasWork = true; }
        }
      }
      if (hasWork) scheduleFlush();
    };

    const observer = new MutationObserver(enqueue);
    observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "src", "style"],
    });

    // Also watch document.head for dynamically injected <style> and <link>
    const headObserver = new MutationObserver(enqueue);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
      headObserver.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (throttleId !== null) clearTimeout(throttleId);
    };
  }, [rootComponent?.CompiledComponent]);

  // ── ResizeObserver: report height changes to parent ──
  // Batched to once per animation frame to avoid postMessage flood during streaming.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let rafId: number | null = null;
    let pendingHeight = 0;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        pendingHeight = Math.ceil(
          entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height,
        );
      }
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        postToParentWindow(wrapMessage({ type: "resize" as const, height: pendingHeight }));
      });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [rootComponent?.CompiledComponent]);

  // Tell the parent the world has actually painted (root installed + first
  // frame), so it can drop its loading overlay exactly when the world's own UI
  // is on screen — not at the boot handshake, which fires before any world
  // content exists. Fires after a double-rAF on every (re)install, including
  // world switches, and also when a compile-error panel is shown (that is still
  // "something on screen", not a grey gap).
  // Gate must match the render below: with the hydration gate closed the world
  // hasn't painted yet, so reporting "rendered" would drop the parent overlay
  // onto a blank frame. Error panels are ungated (they ARE the paint).
  const canPaintRoot = !!rootComponent && (!!rootComponent.error || stateHydrated || hydrationTimedOut);
  useEffect(() => {
    if (!canPaintRoot) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const msg: RenderedMessage = { type: "rendered" };
        postToParentWindow(wrapMessage(msg));
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [canPaintRoot, rootComponent]);

  // If no root component is installed yet, stay visually empty. The parent
  // always sends an install-root message; rendering ChatCanvas here leaks a
  // misleading "Start the conversation..." UI before the real card mounts.
  const RootComp = rootComponent?.CompiledComponent;

  return (
    <YuminaContext.Provider value={api}>
      <div
        ref={hostRef}
        data-yumina-world-root="true"
        style={{ width: "100%", height: "100%", position: "relative" }}
      >
        {rootComponent?.error ? (
          <div
            style={{
              position: "relative",
              padding: 16,
              paddingRight: 40,
              background: "rgba(211,84,75,0.08)",
              border: "1px solid rgba(211,84,75,0.3)",
              borderRadius: 8,
              margin: 16,
            }}
          >
            <p style={{ fontSize: 13, fontWeight: 500, color: "#D3544B" }}>
              Compilation Error
            </p>
            <pre
              style={{
                fontSize: 12,
                color: "rgba(211,84,75,0.7)",
                fontFamily: "monospace",
                marginTop: 8,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {rootComponent.error}
            </pre>
            <CopyErrorIconButton text={`Compilation Error:\n${rootComponent.error}`} />
          </div>
        ) : RootComp && (stateHydrated || hydrationTimedOut) ? (
          <ErrorBoundary onError={handleError}>
            <RootComp />
          </ErrorBoundary>
        ) : (
          // Either no root installed yet, or the hydration gate is still
          // closed (initial channel pushes in flight). The parent keeps its
          // loading overlay up until we post "rendered", so this stays covered.
          null
        )}
      </div>
      <MemoryPanelHostMount />
      <ModelFallbackHost />
    </YuminaContext.Provider>
  );
}

// ── Runtime processing functions (ported from SandboxHost v1) ────────
// These run inside the sandbox iframe on the iframe's own document.

function parseArbitraryColorToken(token: string, prefix: string): string | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = token.match(new RegExp(`^${escaped}\\[(.+)\\]$`));
  if (!m) return null;
  const raw = m[1]?.trim() ?? "";
  if (!raw) return null;
  if (!/^[#(),.%\s\-+/_a-zA-Z0-9]+$/.test(raw)) return null;
  return raw;
}

/** Run `fn` on `root` itself (when it's an element matching `selector`) AND on
 *  every matching descendant. `querySelectorAll` alone excludes the root, which
 *  matters for the incremental path where `root` is a single mutated element. */
function eachMatchEls(root: ParentNode, selector: string, fn: (el: HTMLElement) => void): void {
  if (root instanceof HTMLElement && root.matches(selector)) fn(root);
  root.querySelectorAll<HTMLElement>(selector).forEach(fn);
}

// ── Per-element fixers (idempotent; safe to call repeatedly) ──
// Each is guarded by a dataset flag or a content check, so the incremental
// observer can re-run them on just the elements that changed.

function fixColorsOnEl(el: HTMLElement): void {
  const tokens = Array.from(el.classList);
  let hoverBg: string | null = null;
  let hoverBorder: string | null = null;
  let hoverText: string | null = null;

  for (const token of tokens) {
    const bg = parseArbitraryColorToken(token, "bg-");
    if (bg) { el.style.backgroundColor = bg; continue; }
    const text = parseArbitraryColorToken(token, "text-");
    if (text) { el.style.color = text; continue; }
    const border = parseArbitraryColorToken(token, "border-");
    if (border) { el.style.borderColor = border; continue; }
    hoverBg = hoverBg ?? parseArbitraryColorToken(token, "hover:bg-");
    hoverBorder = hoverBorder ?? parseArbitraryColorToken(token, "hover:border-");
    hoverText = hoverText ?? parseArbitraryColorToken(token, "hover:text-");
  }

  if ((hoverBg || hoverBorder || hoverText) && !el.dataset.yuminaHoverBound) {
    el.dataset.yuminaHoverBound = "1";
    el.addEventListener("mouseenter", () => {
      if (hoverBg) { if (!el.dataset.yuminaOrigBg) el.dataset.yuminaOrigBg = el.style.backgroundColor || ""; el.style.backgroundColor = hoverBg; }
      if (hoverBorder) { if (!el.dataset.yuminaOrigBorder) el.dataset.yuminaOrigBorder = el.style.borderColor || ""; el.style.borderColor = hoverBorder; }
      if (hoverText) { if (!el.dataset.yuminaOrigText) el.dataset.yuminaOrigText = el.style.color || ""; el.style.color = hoverText; }
    });
    el.addEventListener("mouseleave", () => {
      if (hoverBg) el.style.backgroundColor = el.dataset.yuminaOrigBg ?? "";
      if (hoverBorder) el.style.borderColor = el.dataset.yuminaOrigBorder ?? "";
      if (hoverText) el.style.color = el.dataset.yuminaOrigText ?? "";
    });
  }
}

function hardenImageEl(img: HTMLImageElement): void {
  if (!img.getAttribute("referrerpolicy")) {
    img.setAttribute("referrerpolicy", "no-referrer");
  }
  const src = img.getAttribute("src");
  if (src && src.startsWith("@asset:") && !img.dataset.yuminaAssetResolved) {
    img.dataset.yuminaAssetResolved = "1";
    resolveAssetUrl(src).then((resolved) => {
      if (resolved !== src) img.src = resolved;
    });
  }
  if (!img.dataset.yuminaRetryBound) {
    img.dataset.yuminaRetryBound = "1";
    img.addEventListener("error", () => {
      if (!img.dataset.yuminaRetried) {
        img.dataset.yuminaRetried = "1";
        const errSrc = img.getAttribute("src");
        if (!errSrc) return;
        const sep = errSrc.includes("?") ? "&" : "?";
        img.src = `${errSrc}${sep}_cb=${Date.now()}`;
      }
    });
  }
}

async function resolveAssetOnStyleTag(styleEl: HTMLStyleElement): Promise<void> {
  const cssText = styleEl.textContent ?? "";
  if (!cssText.includes("@asset:")) return;
  const resolved = await resolveAssetRefs(cssText);
  if (resolved !== cssText) styleEl.textContent = resolved;
}

async function resolveAssetOnStyledEl(el: HTMLElement): Promise<void> {
  const styleAttr = el.getAttribute("style") ?? "";
  if (!styleAttr.includes("@asset:")) return;
  const resolved = await resolveAssetRefs(styleAttr);
  if (resolved !== styleAttr) el.setAttribute("style", resolved);
}

// ── Subtree fixers (root + descendants) — used for the initial mount scan and
// for newly-added DOM subtrees. ──

function applyRuntimeStyleFixes(root: ParentNode): void {
  eachMatchEls(root, "[class]", fixColorsOnEl);
}

function hardenImages(root: ParentNode): void {
  eachMatchEls(root, "img", (el) => hardenImageEl(el as HTMLImageElement));
}

async function resolveStyleAssetRefsInDOM(root: ParentNode): Promise<void> {
  eachMatchEls(root, "style", (el) => void resolveAssetOnStyleTag(el as HTMLStyleElement));
  eachMatchEls(root, "[style]", (el) => void resolveAssetOnStyledEl(el));
}
import { ModelFallbackHost } from "./chat/model-fallback-card";
