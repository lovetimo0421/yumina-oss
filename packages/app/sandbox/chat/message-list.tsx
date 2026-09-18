import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { useYumina } from "../sandbox-context";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import { SwipeControls } from "./swipe-controls";
import { makeChatT } from "./i18n";
import {
  EARLIER_HISTORY_TOP_PX,
  executeEarlierHistoryAction,
  getEarlierHistoryAction,
  shouldAutoRequestEarlierHistory,
} from "./message-history-pagination";
import type { SandboxMessage } from "./types";
import { anchorInitialTranscript, markTranscriptScroll } from "./initial-message-scroll";
import { trackTranscriptPosition } from "./transcript-position";
import { restoreTranscriptHistory } from "./restore-transcript-history";

const warmedPortraits = new Map<string, HTMLImageElement>();

// The sandbox scroll guard (component-host.tsx) patches Element.prototype's
// scrollTop setter to NO-OP programmatic scrolls once the user has scrolled a
// container — right for creator auto-scroll-to-bottom, but it also swallows our
// own "reveal older messages" anchor below (reaching the toggle requires
// scrolling up, so the container is always user-scrolled by then). Capture the
// NATIVE setter at module load — which runs before the guard installs (the
// guard installs in a post-render effect) — so the anchor can compensate for
// content inserted above even after the user scrolled.
const NATIVE_SCROLLTOP_SET =
  Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")?.set ??
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop")?.set;

function setScrollTopRaw(el: HTMLElement, top: number): void {
  markTranscriptScroll(el);
  if (NATIVE_SCROLLTOP_SET) NATIVE_SCROLLTOP_SET.call(el, top);
  else el.scrollTop = top;
}

/** Find the element that actually owns vertical scrolling for the history
 *  marker. Creator layouts can put <Chat/> inside their own fixed-height
 *  overflow container, so the injected `.play-message-scroll` is not always
 *  the viewport the player moved. */
function findHistoryScrollContainer(
  marker: HTMLElement,
  fallback: HTMLElement | null,
): HTMLElement | null {
  let overflowCandidate: HTMLElement | null = null;
  let current = marker.parentElement;
  while (current) {
    const overflowY = current.ownerDocument.defaultView?.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      overflowCandidate = current;
      if (current.scrollHeight > current.clientHeight) return current;
    }
    current = current.parentElement;
  }
  // A short transcript has no scroll owner yet. Keep the outermost overflow
  // viewport so we can still tell that the history does not fill it.
  return overflowCandidate ?? fallback;
}

function isHistoryViewportUnderfilled(
  viewport: HTMLElement | null,
  messageList: HTMLElement | null,
): boolean {
  return Boolean(
    viewport &&
    messageList &&
    viewport.clientHeight > 0 &&
    // Measure the transcript itself, not the creator wrapper's scrollHeight.
    // Verdant's fixed wrapper has 75px of layout padding, which creates a
    // scrollbar even when three messages leave most of the viewport empty.
    messageList.scrollHeight <= viewport.clientHeight + 1
  );
}

interface MessageListProps {
  rendererComponent: React.ComponentType<Record<string, unknown>> | null;
}

const INITIAL_MESSAGE_WINDOW = 50;
const AT_BOTTOM_THRESHOLD_PX = 80;

export function MessageList({ rendererComponent }: MessageListProps) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const messages = api.messages as unknown as SandboxMessage[];
  // Warm the portraits: the speaker tag lands with the first token of a reply,
  // and the face should land with it rather than a network round-trip later.
  // The elements are kept in a module map so the decoded bitmaps stay live
  // (a GC'd Image gives the cache nothing to share with the bubble's <img>).
  useEffect(() => {
    for (const e of api.entries) {
      if (e.role !== "character" || typeof e.portrait !== "string" || !e.portrait) continue;
      if (warmedPortraits.has(e.portrait)) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = e.portrait;
      warmedPortraits.set(e.portrait, img);
    }
  }, [api.entries]);
  const isStreaming = api.isStreaming;
  const streamingContent = api.streamingContent;
  const streamingReasoning = api.streamingReasoning;
  const gameState = api.variables;
  const greetingContent = api.greetingContent;
  const error = api.error;
  const hasMessageHistory = messages.length > 0;
  const isGuestPreview = api.mode === "guest-preview";
  const canSendMessage = api.capabilities?.canSendMessage !== false && !isGuestPreview;

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const historySentinelRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const hasMountedRef = useRef(false);
  const releaseInitialAnchorRef = useRef<(() => void) | null>(null);
  const resumePositionRef = useRef<ReturnType<typeof trackTranscriptPosition> | null>(null);
  const historyRenderWaiters = useRef(new Set<() => void>());
  const historyAutoLoadArmedRef = useRef(false);
  const historyIntersectionSeenAwayRef = useRef(false);
  const historyAutoFillRequestKeyRef = useRef<string | null>(null);
  const requestEarlierFromViewportRef = useRef<(
    historyScrollElement: HTMLElement | null,
    scrollTop: number,
  ) => void>(() => {});
  const historyLoadInFlightRef = useRef(false);
  const historyLoadRequestTokenRef = useRef(0);
  const expandAnchorRef = useRef<{ element: HTMLElement; height: number; top: number } | null>(null);
  const earlierAnchorRef = useRef<{ element: HTMLElement; firstId: string; offsetTop: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const savingEditRef = useRef<string | null>(null);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [historyLoadRequested, setHistoryLoadRequested] = useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const currentPositionState = useRef({ api, showAllMessages });
  currentPositionState.current = { api, showAllMessages };

  // Reset dismiss when error changes
  useEffect(() => { setErrorDismissed(false); }, [error]);

  // ── Scroll management ──
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Reset on session change — fresh session starts with auto-scroll re-enabled.
  // The sandbox-wide scroll guard (component-host.tsx) also drops its
  // user-scrolled marks on session change, so both layers stay in sync.
  useEffect(() => {
    historyLoadRequestTokenRef.current += 1;
    hasMountedRef.current = false;
    userScrolledUp.current = false;
    historyAutoLoadArmedRef.current = false;
    historyIntersectionSeenAwayRef.current = false;
    historyAutoFillRequestKeyRef.current = null;
    historyLoadInFlightRef.current = false;
    expandAnchorRef.current = null;
    earlierAnchorRef.current = null;
    setShowAllMessages(false);
    setHistoryLoadRequested(false);
    setHistoryLoadFailed(false);
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = 0;
    return () => {
      releaseInitialAnchorRef.current?.();
      releaseInitialAnchorRef.current = null;
      historyLoadRequestTokenRef.current += 1;
    };
  }, [api.sessionId]);

  // Auto-scroll: only on initial mount. Once the user has scrolled, we leave
  // the viewport alone — even when they send a new message — until the session
  // resets. The sandbox guard enforces the same rule for creator custom UI.
  useEffect(() => {
    if (messages.length === 0) return;
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      if (messages.length > 1 && !isGuestPreview && scrollContainerRef.current) {
        // Native setter is safe here: the anchor releases on real user input,
        // before any scroll. Layout-generated events must not block restoration.
        releaseInitialAnchorRef.current = anchorInitialTranscript(
          scrollContainerRef.current,
          setScrollTopRaw,
          () => { historyAutoLoadArmedRef.current = true; },
        );
      }
      return;
    }
    releaseInitialAnchorRef.current?.();
    releaseInitialAnchorRef.current = null;
    if (resumePositionRef.current?.updating()) return;
    const lastMsg = messages[messages.length - 1];
    if (!userScrolledUp.current && lastMsg?.role === "user") {
      scrollToBottom("smooth");
    }
  }, [api.sessionId, messages, isGuestPreview, scrollToBottom]);

  useEffect(() => {
    const list = scrollContainerRef.current;
    if (!list || !hasMessageHistory || isGuestPreview) return;
    const tracker = trackTranscriptPosition({
      sessionId: api.sessionId, list,
      viewport: () => historySentinelRef.current
        ? findHistoryScrollContainer(historySentinelRef.current, list) ?? list : list,
      setTop: setScrollTopRaw,
      expanded: () => currentPositionState.current.showAllMessages,
      loadedCount: () => currentPositionState.current.api.messages.length,
      reveal: (position, signal) => {
        if (position.expanded || position.mode === "reading") setShowAllMessages(true);
        if (position.mode !== "reading" || !position.anchorId) return;
        // Rehydrate at most the previously loaded range (+ one boundary page).
        // Each request remains server-bounded; never fetch the whole session.
        return restoreTranscriptHistory(position, signal, {
          current: () => currentPositionState.current.api,
          load: () => currentPositionState.current.api.loadEarlierMessages(),
          // Observe the actual channel/React commit, not an assumed bridge delay.
          committed: (previous) => new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              window.clearTimeout(timeout);
              historyRenderWaiters.current.delete(check);
              signal.removeEventListener("abort", abort);
            };
            const abort = () => { cleanup(); reject(new DOMException("Restoration canceled", "AbortError")); };
            const check = () => {
              const current = currentPositionState.current.api;
              if (signal.aborted || current.sessionId !== position.sessionId) { abort(); return; }
              if (current.messages[0]?.id !== previous.messages[0]?.id || !current.hasEarlierMessages ||
                  (previous.isLoadingEarlier && !current.isLoadingEarlier)) { cleanup(); resolve(); }
            };
            const timeout = window.setTimeout(() => { cleanup(); reject(new Error("History render timed out")); }, 10_000);
            historyRenderWaiters.current.add(check);
            signal.addEventListener("abort", abort, { once: true });
            check();
          }),
        });
      },
      releaseInitial: () => {
        releaseInitialAnchorRef.current?.();
        releaseInitialAnchorRef.current = null;
      },
    });
    resumePositionRef.current = tracker;
    return () => { tracker.stop(); resumePositionRef.current = null; };
  }, [api.sessionId, hasMessageHistory, isGuestPreview]);

  useLayoutEffect(() => { resumePositionRef.current?.changed(); }, [messages]);
  useLayoutEffect(() => { resumePositionRef.current?.changed(false); }, [showAllMessages]);
  useLayoutEffect(() => { historyRenderWaiters.current.forEach((check) => check()); }, [messages, api.isLoadingEarlier, api.hasEarlierMessages]);

  // ── Preserve scroll position when older messages are revealed ──
  // Expanding the window (or compacted history) mounts messages ABOVE the
  // current view. Without anchoring, the browser keeps scrollTop where it was
  // (≈0, since the toggle sits at the top of the list), so the viewport jumps
  // to the very top. Capture scrollHeight + scrollTop before the toggle, then
  // once the new rows mount, shift scrollTop by exactly the height added above —
  // so the messages the user was reading stay put and the older ones appear
  // above to scroll into, like any chat app. The delta is whatever was inserted,
  // so this stays correct even while content-visibility is still estimating
  // off-screen row heights. Works for collapse too (delta is negative).
  const captureExpandAnchor = useCallback((element: HTMLElement | null) => {
    if (element) {
      expandAnchorRef.current = {
        element,
        height: element.scrollHeight,
        top: element.scrollTop,
      };
    }
  }, []);
  useLayoutEffect(() => {
    const anchor = expandAnchorRef.current;
    if (!anchor) return;
    expandAnchorRef.current = null;
    // Native setter: bypass the smart scroll guard, which no-ops scrollTop on a
    // user-scrolled container and would otherwise swallow this anchor.
    setScrollTopRaw(
      anchor.element,
      anchor.element.scrollHeight - anchor.height + anchor.top,
    );
  }, [showAllMessages]);

  // ── Server-side history pages ──
  // The host only holds a recent window of the transcript (mega sessions froze
  // the server serializing full histories); api.loadEarlierMessages() fetches
  // the previous page and PREPENDS it asynchronously. Anchoring differs from
  // the sync reveal above: rows arrive on a later render, so we remember the
  // current first row's offsetTop at click time and, once it moves down (new
  // rows mounted above it), shift scrollTop by exactly that delta.
  const handleLoadEarlier = useCallback(async (
    historyScrollElement: HTMLElement | null = scrollContainerRef.current,
  ) => {
    const action = getEarlierHistoryAction(
      showAllMessages ? 0 : Math.max(0, messages.length - INITIAL_MESSAGE_WINDOW),
      api.hasEarlierMessages,
    );
    if (action === "none" || historyLoadInFlightRef.current || api.isLoadingEarlier) return;

    releaseInitialAnchorRef.current?.();
    releaseInitialAnchorRef.current = null;
    historyLoadInFlightRef.current = true;
    const requestToken = ++historyLoadRequestTokenRef.current;
    setHistoryLoadRequested(true);
    setHistoryLoadFailed(false);

    const shouldLoadServer = action === "load-server" || action === "reveal-and-load";
    const listElement = scrollContainerRef.current;
    const firstVisibleIndex = showAllMessages
      ? 0
      : Math.max(0, messages.length - INITIAL_MESSAGE_WINDOW);
    const firstId = messages[firstVisibleIndex]?.id;
    if (shouldLoadServer && historyScrollElement && listElement && firstId) {
      const row = listElement.querySelector<HTMLElement>(`[data-mid="${CSS.escape(firstId)}"]`);
      earlierAnchorRef.current = {
        element: historyScrollElement,
        firstId,
        offsetTop: row?.offsetTop ?? 0,
      };
    }
    try {
      const loaded = await executeEarlierHistoryAction(action, {
        revealLocal: () => {
          captureExpandAnchor(historyScrollElement);
          setShowAllMessages(true);
        },
        loadServer: api.loadEarlierMessages,
      });
      if (!loaded && historyLoadRequestTokenRef.current === requestToken) {
        earlierAnchorRef.current = null;
        setHistoryLoadFailed(true);
      }
    } finally {
      if (historyLoadRequestTokenRef.current === requestToken) {
        historyLoadInFlightRef.current = false;
        setHistoryLoadRequested(false);
      }
    }
  }, [messages, api.hasEarlierMessages, api.isLoadingEarlier, api.loadEarlierMessages, captureExpandAnchor, showAllMessages]);
  useLayoutEffect(() => {
    const anchor = earlierAnchorRef.current;
    if (!anchor) return;
    const listElement = scrollContainerRef.current;
    if (!listElement) return;
    const row = listElement.querySelector<HTMLElement>(`[data-mid="${CSS.escape(anchor.firstId)}"]`);
    if (!row) { earlierAnchorRef.current = null; return; }
    const delta = row.offsetTop - anchor.offsetTop;
    if (delta > 0) {
      earlierAnchorRef.current = null;
      setScrollTopRaw(anchor.element, anchor.element.scrollTop + delta);
    }
  }, [messages.length]);

  const maybeRequestEarlierHistory = useCallback((
    historyScrollElement: HTMLElement | null,
    scrollTop: number,
  ) => {
    if (scrollTop > EARLIER_HISTORY_TOP_PX) {
      historyAutoLoadArmedRef.current = true;
    }

    const hiddenLocalCount = showAllMessages
      ? 0
      : Math.max(0, messages.length - INITIAL_MESSAGE_WINDOW);
    const action = getEarlierHistoryAction(hiddenLocalCount, api.hasEarlierMessages);
    const loading = historyLoadRequested || api.isLoadingEarlier || historyLoadInFlightRef.current;
    const autoFillKey = `${api.sessionId}:${messages[0]?.id ?? "empty"}:${messages.length}:${showAllMessages ? 1 : 0}:${api.hasEarlierMessages ? 1 : 0}`;
    const viewportUnderfilled = isHistoryViewportUnderfilled(
      historyScrollElement,
      scrollContainerRef.current,
    );
    const canAutoFillViewport =
      viewportUnderfilled && historyAutoFillRequestKeyRef.current !== autoFillKey;
    if (shouldAutoRequestEarlierHistory({
      action,
      armed: historyAutoLoadArmedRef.current,
      failed: historyLoadFailed,
      loading,
      scrollTop,
      viewportUnderfilled: canAutoFillViewport,
    })) {
      if (canAutoFillViewport) historyAutoFillRequestKeyRef.current = autoFillKey;
      historyAutoLoadArmedRef.current = false;
      void handleLoadEarlier(historyScrollElement);
    }
  }, [api.hasEarlierMessages, api.isLoadingEarlier, api.sessionId, handleLoadEarlier, historyLoadFailed, historyLoadRequested, messages, showAllMessages]);
  requestEarlierFromViewportRef.current = maybeRequestEarlierHistory;

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX;
    userScrolledUp.current = !atBottom;
    maybeRequestEarlierHistory(el, el.scrollTop);
  }, [maybeRequestEarlierHistory]);

  // If the current page is too short to create a scrollbar, there is no user
  // scroll event and the marker never leaves the viewport. Re-check after each
  // prepended page until the viewport fills or the server reports no history.
  // The request key prevents a successful-but-empty response from looping.
  useEffect(() => {
    const marker = historySentinelRef.current;
    if (!marker) return;
    const historyScrollElement = findHistoryScrollContainer(
      marker,
      scrollContainerRef.current,
    );
    if (!isHistoryViewportUnderfilled(historyScrollElement, scrollContainerRef.current)) return;
    requestEarlierFromViewportRef.current(
      historyScrollElement,
      historyScrollElement?.scrollTop ?? 0,
    );
  }, [api.hasEarlierMessages, api.isLoadingEarlier, hasMessageHistory, historyLoadFailed, historyLoadRequested, messages.length, showAllMessages]);

  // Observe the history marker itself instead of assuming the injected list is
  // the element being scrolled. IntersectionObserver accounts for every nested
  // overflow ancestor, including creator wrappers such as Verdant's fixed chat
  // viewport. Requiring one non-intersecting observation prevents an initial
  // top-position frame from loading history before the mount-time bottom scroll.
  useEffect(() => {
    const marker = historySentinelRef.current;
    if (!marker || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === marker);
      if (!entry) return;
      if (!entry.isIntersecting) {
        historyIntersectionSeenAwayRef.current = true;
        historyAutoLoadArmedRef.current = true;
        return;
      }
      const historyScrollElement = findHistoryScrollContainer(
        marker,
        scrollContainerRef.current,
      );
      if (
        !historyIntersectionSeenAwayRef.current &&
        !isHistoryViewportUnderfilled(historyScrollElement, scrollContainerRef.current)
      ) return;
      requestEarlierFromViewportRef.current(historyScrollElement, 0);
    });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [hasMessageHistory]);

  // ── Edit handlers ──
  const handleStartEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditContent(content);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditContent("");
  }, []);

  const handleSaveEdit = useCallback(async (messageId: string) => {
    if (savingEditRef.current) return;
    savingEditRef.current = messageId;
    setSavingEditId(messageId);
    try {
      const success = await api.editMessage(messageId, editContent);
      if (!success) {
        api.showToast(t("failedEdit"), "error");
        return;
      }
      setEditingMessageId(null);
      setEditContent("");
    } catch {
      api.showToast(t("failedEdit"), "error");
    } finally {
      savingEditRef.current = null;
      setSavingEditId(null);
    }
  }, [api, editContent, t]);

  // ── Messages ──
  // Render the FULL transcript inline, compacted rows included. Compaction is a
  // PROMPT-level optimization (compacted messages are swapped for the summary in
  // the LLM context only); it must not change what the player sees or can do.
  // The old behavior hid compacted rows behind a dimmed, non-interactive "earlier
  // messages" collapser, which made them look greyed-out and blocked revert/fork
  // to any summarized turn. They now render identically to the rest of the
  // conversation. The windowing below still caps mounted rows for perf.
  const allActiveMessages = messages;

  // Only mount the most recent messages in the React tree to reduce memory.
  // Avoid content-visibility here: its intrinsic fallback can reserve too
  // little height for rich/custom bubbles and make adjacent sent messages
  // visually overlap.
  const needsWindow = allActiveMessages.length > INITIAL_MESSAGE_WINDOW && !showAllMessages;
  const hiddenCount = needsWindow ? allActiveMessages.length - INITIAL_MESSAGE_WINDOW : 0;
  const activeMessages = needsWindow
    ? allActiveMessages.slice(-INITIAL_MESSAGE_WINDOW)
    : allActiveMessages;
  const earlierHistoryAction = getEarlierHistoryAction(hiddenCount, api.hasEarlierMessages);
  const isEarlierHistoryLoading = historyLoadRequested || api.isLoadingEarlier;

  // ── Greeting (empty state) ──
  if (messages.length === 0 && !isStreaming) {
    if (greetingContent) {
      return (
        <div className="play-message-scroll flex-1 min-h-0 overflow-y-auto">
          <div className="play-message-stack">
            <MessageBubble
              message={{
                id: "__greeting__",
                sessionId: "",
                role: "assistant",
                content: greetingContent,
                createdAt: new Date().toISOString(),
              }}
              rendererComponent={rendererComponent}
              variables={gameState as Record<string, unknown>}
              messageIndex={0}
            />
            <div ref={bottomRef} className="h-4" />
          </div>
        </div>
      );
    }
    if (api.readOnly || !canSendMessage || isGuestPreview) {
      return <div className="flex-1" />;
    }
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground/40">
          {t("startConversation")}
        </p>
      </div>
    );
  }

  // ── Main message list ──
  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="play-message-scroll flex-1 min-h-0 overflow-y-auto"
    >
      <div className="play-message-stack">
        <div
          ref={historySentinelRef}
          data-history-sentinel="true"
          aria-hidden="true"
          style={{ height: 1, width: "100%" }}
        />
        {/* One history control covers both client windowing and server paging.
            Scrolling to the top triggers the same action automatically; this
            remains as an accessible keyboard/touch fallback and retry state. */}
        {isEarlierHistoryLoading ? (
          <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            className="mt-2 flex min-h-11 w-full items-center justify-center px-4 py-3 text-center text-sm text-muted-foreground"
          >
            {t("loadingEarlier")}
          </div>
        ) : earlierHistoryAction !== "none" ? (
          <button
            type="button"
            onClick={() => { void handleLoadEarlier(); }}
            className={`mt-2 min-h-11 w-full cursor-pointer px-4 py-3 text-center text-sm font-medium transition-colors active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              historyLoadFailed
                ? "text-destructive hover:text-destructive/80"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {historyLoadFailed ? t("loadEarlierFailed") : t("loadEarlier")}
          </button>
        ) : null}

        {/* Active messages */}
        {activeMessages.map((message, idx) => {
          const messageVars = ((message.stateSnapshot as Record<string, unknown> | null)
            ?.variables as Record<string, unknown> | undefined) ?? gameState;
          const prevRole = idx > 0 ? activeMessages[idx - 1]!.role : null;
          const showRoleLabel = message.role !== prevRole;
          const isEditingThis = editingMessageId === message.id;
          const isLastMessage = idx === activeMessages.length - 1;
          const isLastAssistant = isLastMessage && message.role === "assistant";

          return (
            <div key={message.id} data-mid={message.id} className="play-message-row">
              <MessageBubble
                message={message}
                rendererComponent={rendererComponent}
                variables={messageVars as Record<string, unknown>}
                messageIndex={idx}
                showRoleLabel={showRoleLabel}
                isLastMessage={isLastMessage}
                actionsKey={`${isLastAssistant ? 1 : 0}${isLastMessage ? 1 : 0}:${message.swipes?.length ?? 0}:${message.status ?? ""}`}
                isEditing={isEditingThis}
                isSavingEdit={savingEditId === message.id}
                editContent={isEditingThis ? editContent : undefined}
                onEditContentChange={setEditContent}
                onSaveEdit={() => handleSaveEdit(message.id)}
                onCancelEdit={handleCancelEdit}
                swipeControls={
                  message.role === "assistant" ? (
                    <SwipeControls message={message} />
                  ) : undefined
                }
              >
                <MessageActions
                  message={message}
                  isLastAssistant={isLastAssistant}
                  isLastMessage={isLastMessage}
                  onEditStart={() => handleStartEdit(message.id, message.content)}
                />
              </MessageBubble>
            </div>
          );
        })}

        {/* Platform-owned consent renders here, including creator-skinned chats. */}
        <div data-yumina-model-fallback-slot="true" />

        {/* Streaming message */}
        {isStreaming && (streamingContent || streamingReasoning) && (
          <MessageBubble
            message={{
              id: "__streaming__",
              sessionId: "",
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString(),
            }}
            isStreaming
            streamingContent={streamingContent}
            streamingReasoning={streamingReasoning}
            rendererComponent={rendererComponent}
            variables={gameState as Record<string, unknown>}
            messageIndex={activeMessages.length}
          />
        )}

        {/* Error banner */}
        {error && !errorDismissed && (
          <div
            role="alert"
            className="play-message-error flex min-w-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
          >
            <p className="play-message-error__text min-w-0 flex-1 text-xs text-destructive">{error}</p>
            <button
              type="button"
              onClick={() => setErrorDismissed(true)}
              className="play-message-error__dismiss shrink-0 text-xs text-destructive/60 hover:text-destructive"
            >
              Dismiss
            </button>
          </div>
        )}

        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
}
