import { useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import {
  Send,
  Square,
  Plus,
  X,
  RotateCcw,
  FastForward,
  User,
  Share2,
  GitBranch,
  ArrowUp,
  ListTree,
  Loader2,
  Check,
} from "lucide-react";
import {
  useYumina,
  COMPOSER_DRAFT_EVENT,
  type BranchContext,
  type BranchNode,
} from "../sandbox-context";
import { ModelTrigger } from "./model-picker-modal";
import { makeChatT } from "./i18n";
import { SlotOutlet, useToolMenuCount } from "../extensions/registry";
import { ComposerToolMenu, useIsNarrow } from "./composer-tool-menu";
import { postToParentWindow, wrapMessage } from "../protocol";
import {
  clampComposerMessage,
  getComposerMessageLimitState,
  MAX_USER_MESSAGE_CHARS,
} from "../../src/lib/composer-message-limit";

// How long to sit on keystrokes before mirroring the draft to the host. Long
// enough that a fast typist doesn't generate a postMessage per character, short
// enough that a reload arriving mid-sentence still finds the text.
const COMPOSER_DRAFT_SYNC_MS = 400;

// TODO: Attachment support — the bridge currently only takes text via api.sendMessage(text).
// FileReader works in sandbox, but we need the bridge to support attachments before enabling.

export function MessageInput() {
  const api = useYumina();
  const {
    isStreaming,
    pendingChoices,
    readOnly,
    sendMessage,
    stopGeneration,
    continueLastMessage,
    restartChat,
    clearPendingChoices,
    showToast,
    openPersonaManager,
    openModelPicker,
    openSessionManager,
    sharePlaythrough,
    messages,
    getBranchContext,
    branchFromMessage,
    navigate,
  } = api;
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const generationBlocked = isStreaming || !!api.modelFallback;
  const canSendMessage = api.capabilities?.canSendMessage !== false
    && api.mode !== "guest-preview";

  const [content, setContent] = useState("");
  const messageLimitState = getComposerMessageLimitState(content);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchCtx, setBranchCtx] = useState<BranchContext | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState(false);
  const [branching, setBranching] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tracks an in-flight IME composition so Enter commits the candidate instead
  // of sending. (The sandbox is bundled in isolation and can't import the app's
  // shared composer-submit hook, so the guard is inlined here.)
  const composingRef = useRef(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  // On a narrow toolbar (mobile / split desktop) collapse the model pill and
  // the extension buttons into one menu so they don't crowd the send button.
  // Only when there IS a launchable tool to collapse — otherwise keep the plain
  // inline model pill.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const isNarrow = useIsNarrow(toolbarRef, 520);
  const toolMenuCount = useToolMenuCount();
  const collapseTools = isNarrow && toolMenuCount > 0;
  // Stash of the text we just sent, so a failed send can restore it to the
  // composer (creator feedback 2026-05-31: "don't swallow my message").
  const lastSentRef = useRef<string | null>(null);
  const prevErrorRef = useRef(api.error);

  // ── Click-outside handler for dropdowns ────────────────────────────
  useEffect(() => {
    if (!actionsOpen) return;
    const handler = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [actionsOpen]);

  // ── Branch panel: click-outside + Esc dismissal ────────────────────
  useEffect(() => {
    if (!branchOpen) return;
    const onDown = (e: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) {
        setBranchOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBranchOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [branchOpen]);

  // ── Branch panel: (re)load context every time it opens ─────────────
  const loadBranchCtx = useCallback(async () => {
    setBranchLoading(true);
    setBranchError(false);
    try {
      setBranchCtx(await getBranchContext());
    } catch {
      setBranchError(true);
    } finally {
      setBranchLoading(false);
    }
  }, [getBranchContext]);

  useEffect(() => {
    if (branchOpen) void loadBranchCtx();
  }, [branchOpen, loadBranchCtx]);

  // ── Handlers ───────────────────────────────────────────────────────

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (generationBlocked) return;
    lastSentRef.current = trimmed;
    sendMessage(trimmed);
    setContent("");
    // Height resets itself: the CSS auto-grow wrapper shrinks to one line once
    // `content` is empty (no manual style write, so no forced reflow).
  }, [content, generationBlocked, sendMessage]);

  const handleChoiceClick = useCallback(
    (choice: string) => {
      if (generationBlocked) return;
      lastSentRef.current = choice;
      sendMessage(choice);
      setContent("");
    },
    [generationBlocked, sendMessage]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    // Never send while a pinyin/CJK candidate is being composed — Enter commits it.
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Match Settings and the host composer: touch support alone also includes laptops.
    const isTouchPrimary = typeof window.matchMedia === "function"
      && window.matchMedia("(pointer: coarse)").matches;
    if (isTouchPrimary) return; // touch keyboards: Enter = newline, send via the button
    // Honor the user's Settings → "Press Enter to send" preference (mirrored
    // across the bridge — the iframe can't read the host ui store). Same
    // semantics as the host's useComposerSubmit:
    //   "enter"     → Enter sends, Shift+Enter newlines.
    //   "mod-enter" → Ctrl/⌘+Enter sends, plain Enter newlines.
    if (api.composerSendKey === "mod-enter") {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleSend();
      }
      return;
    }
    if (!e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleRestart = useCallback(async () => {
    setConfirmRestart(false);
    restartChat();
    showToast(t("chatRestarted"), "success");
  }, [restartChat, showToast, t]);

  const handleContinue = useCallback(() => {
    if (generationBlocked) return;
    continueLastMessage();
    setActionsOpen(false);
  }, [generationBlocked, continueLastMessage]);

  const handleOpenPersona = useCallback(() => {
    setActionsOpen(false);
    openPersonaManager();
  }, [openPersonaManager]);

  const handleSharePlaythrough = useCallback(() => {
    setActionsOpen(false);
    sharePlaythrough?.();
  }, [sharePlaythrough]);

  // ── Branch handlers ────────────────────────────────────────────────
  const canBranchFromLatest = !isStreaming && (messages?.length ?? 0) > 0;

  const handleOpenBranch = useCallback(() => {
    setActionsOpen(false);
    setBranchOpen(true);
  }, []);

  const goToBranch = useCallback(
    (id: string) => {
      setBranchOpen(false);
      navigate(`/app/chat/${id}`);
    },
    [navigate]
  );

  const handleBranchFromLatest = useCallback(async () => {
    if (!canBranchFromLatest || branching) return;
    const list = messages ?? [];
    const latest = list[list.length - 1] as { id?: string } | undefined;
    const latestId = latest?.id;
    if (!latestId) return;
    setBranching(true);
    try {
      // branchFromMessage surfaces its own success/error toast in the host.
      const newId = await branchFromMessage(latestId);
      if (newId) {
        setBranchOpen(false);
        navigate(`/app/chat/${newId}`);
      }
    } finally {
      setBranching(false);
    }
  }, [canBranchFromLatest, branching, messages, branchFromMessage, navigate]);

  const handleOpenManager = useCallback(() => {
    setBranchOpen(false);
    openSessionManager();
  }, [openSessionManager]);

  const timeAgo = useCallback(
    (iso: string) => {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return t("timeJustNow");
      if (mins < 60) return t("timeMinAgo", { n: mins });
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return t("timeHourAgo", { n: hrs });
      return t("timeDayAgo", { n: Math.floor(hrs / 24) });
    },
    [t]
  );

  // ── Mirror the draft to the host ───────────────────────────────────
  // The host refuses the post-deploy auto-reload while this is non-empty, and
  // persists it so a reload it couldn't avoid (manual F5, stale-chunk recovery)
  // doesn't cost the user a half-typed message. The sandbox can't store this
  // itself: it runs on an opaque origin where sessionStorage throws.
  // Debounced while typing, but flushed synchronously the moment the composer
  // empties (send / clear) so the reload guard unblocks without a stale tail.
  const draftMirrorPrimedRef = useRef(false);
  useEffect(() => {
    const report = (text: string) =>
      postToParentWindow(wrapMessage({ type: "composer-draft" as const, text }));

    // Skip the mount-time empty report. The host may be holding a saved draft
    // it hasn't pushed down yet, and reporting "" would delete it before the
    // restore ever lands.
    if (!draftMirrorPrimedRef.current) {
      draftMirrorPrimedRef.current = true;
      if (!content) return;
    }

    if (!content) {
      report("");
      return;
    }
    const id = window.setTimeout(() => report(content), COMPOSER_DRAFT_SYNC_MS);
    return () => window.clearTimeout(id);
  }, [content]);

  // ── External prefill (yumina.setComposerDraft, host draft restore) ──
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string; focus?: boolean }>).detail;
      const text = detail?.text ?? "";
      setContent(clampComposerMessage(text));
      // Restoring a draft on load must not steal focus — that would pop the
      // mobile keyboard on every reload. Creator-driven prefill still focuses.
      if (detail?.focus === false) return;
      // Focus + move caret to end on the next frame so layout has settled
      // against the new value.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        // preventScroll: programmatic focus must never scroll #sandbox-root
        // (the document scroller) — a missed clamp would strand the canvas
        // offset. The OS keyboard reveal still works via viewport resize.
        el.focus({ preventScroll: true });
        const end = el.value.length;
        try { el.setSelectionRange(end, end); } catch { /* noop */ }
      });
    };
    window.addEventListener(COMPOSER_DRAFT_EVENT, handler);
    return () => window.removeEventListener(COMPOSER_DRAFT_EVENT, handler);
  }, []);

  // ── Auto-resize ─────────────────────────────────────────────────────
  // Handled by CSS, not JS. The textarea sits in a `.play-composer-grow`
  // grid whose hidden ::after replica mirrors `content` and sizes the cell.
  // The old JS version set style.height + read scrollHeight on every [content]
  // change — a synchronous forced reflow per keystroke. On long sessions that
  // reflow re-laid-out every message row (after content-visibility paint-
  // skipping was removed in c7f83e05), which froze the tab while typing.

  // ── Preserve the user's message on a failed send ───────────────────
  // The composer clears optimistically on send. If the send then fails (the
  // model errored, the stream dropped, or it returned an empty reply), put the
  // text back so a long message never has to be retyped. Only refill an empty
  // composer so we never clobber something new the user has started typing.
  useEffect(() => {
    const prev = prevErrorRef.current;
    prevErrorRef.current = api.error;
    if (api.error && api.error !== prev && lastSentRef.current) {
      const failed = lastSentRef.current;
      lastSentRef.current = null;
      setContent((cur) => (cur.trim() ? cur : failed));
    }
  }, [api.error]);

  // Toast-only failures (NO_CREDITS, MODEL_NOT_ALLOWED, …) deliberately never
  // set `error`, so the effect above can't see them — the host bumps
  // sendFailureNonce for EVERY terminally-failed send instead (@burlingk lost a
  // long post to the plan-gate toast). Declared before the stash-drop effect so
  // that, when both fire in one commit, the restore consumes the stash first.
  const lastHandledNonceRef = useRef(api.sendFailureNonce);
  useEffect(() => {
    if (api.sendFailureNonce === lastHandledNonceRef.current) return;
    lastHandledNonceRef.current = api.sendFailureNonce;
    if (lastSentRef.current) {
      const failed = lastSentRef.current;
      lastSentRef.current = null;
      setContent((cur) => (cur.trim() ? cur : failed));
    }
  }, [api.sendFailureNonce]);

  // Drop the stash once a send completes cleanly (no error) so a later,
  // unrelated failure can't resurrect an old message. Delayed: isStreaming
  // (streaming channel) and error/sendFailureNonce (ui channel) arrive as
  // separate bridge messages, so "streaming ended, no error yet" is also the
  // first frame of every failure — dropping synchronously here raced the
  // failure signal and ate the stash before the restore effects could run.
  useEffect(() => {
    if (isStreaming || api.error) return;
    const t = window.setTimeout(() => { lastSentRef.current = null; }, 2000);
    return () => window.clearTimeout(t);
  }, [isStreaming, api.error]);

  if (readOnly || !canSendMessage) return null;

  return (
    <div className="play-composer-shell shrink-0">
      <div className="play-composer-inner w-full min-w-0">
        {/* Choice buttons */}
        {pendingChoices.length > 0 && !isStreaming && (
          <div className="play-choice-row mb-2 flex flex-wrap items-center gap-1.5">
            {pendingChoices.map((choice, i) => (
              <button
                key={i}
                onClick={() => handleChoiceClick(choice)}
                className="play-choice-chip rounded-lg border border-border/50 bg-accent px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
              >
                {choice}
              </button>
            ))}
            <button
              onClick={clearPendingChoices}
              className="play-choice-dismiss flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/30 transition-colors hover:text-muted-foreground/60"
              title={t("dismissChoices")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Glass reply bar card.
            No `overflow-hidden`: the "+" actions menu opens upward (absolute
            bottom-full) and must escape the card bounds, or it gets clipped by
            the composer. The only child whose background reaches a rounded
            corner is the restart-confirm banner, which rounds its own top. */}
        <div className="play-composer-card glass rounded-2xl">
          {/* Restart confirmation banner */}
          {confirmRestart && (
            <div className="flex items-center justify-between rounded-t-2xl border-b border-border/50 bg-destructive/5 px-4 py-2">
              <span className="text-xs text-foreground/70">
                {t("restartBanner")}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleRestart}
                  className="rounded-md bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/25"
                >
                  {t("restart")}
                </button>
                <button
                  onClick={() => setConfirmRestart(false)}
                  className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          )}

          {/* Textarea — full width. The wrapper grows to a hidden text replica
              (data-replicated-value) so the textarea auto-sizes via CSS only —
              no per-keystroke scrollHeight read / forced reflow. Padding, font
              size and wrapping are set on both textarea and replica in CSS
              (.play-composer-grow) so they measure identically. */}
          <div className="play-composer-grow" data-replicated-value={content}>
            <textarea
              ref={textareaRef}
              value={content}
              maxLength={MAX_USER_MESSAGE_CHARS}
              onChange={(e) => setContent(clampComposerMessage(e.target.value))}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              placeholder={
                api.modelFallback ? modelFallbackText(api.language, "waiting") : isStreaming
                  ? t("generating")
                  : pendingChoices.length > 0
                    ? t("choiceHint")
                    : t("placeholder")
              }
              // NOT disabled while streaming: disabling forcibly blurs the
              // textarea, which slams the phone keyboard shut on every send
              // (and each close/open cycle is a viewport resize — the exact
              // churn behind the stale-canvas bugs). Typing ahead is fine;
              // handleSend/Enter are already guarded by isStreaming, and the
              // send button becomes Stop during generation.
              rows={1}
              className={`play-composer-textarea block w-full resize-none bg-transparent text-foreground placeholder:text-muted-foreground/75 focus:outline-none ${isStreaming ? "opacity-60" : ""}`}
            />
          </div>

          {/* Bottom row: + button (left) | send (right) */}
          <div ref={toolbarRef} className="play-composer-toolbar px-3 pb-2.5">
            {/* Left: actions menu + model trigger */}
            <div className="play-composer-actions flex items-center gap-1">
              <div ref={actionsRef} className="relative">
                <button
                  onClick={() => setActionsOpen((v) => !v)}
                  className="play-composer-icon-button hover-surface rounded-lg text-foreground/70 hover:text-foreground transition-colors"
                  title={t("actions")}
                >
                  <Plus className="h-4 w-4" />
                </button>
                {actionsOpen && (
                  /* Row padding + icon size are em-based so Android textZoom
                     (which inflates text but not rem/px boxes) scales the whole
                     row with the text. ~45px rows at 16px type. */
                  <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[230px] overflow-hidden rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md">
                    <button
                      onClick={handleContinue}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                    >
                      <FastForward className="h-[1.15em] w-[1.15em]" />
                      {t("continue")}
                    </button>
                    <button
                      onClick={() => {
                        setActionsOpen(false);
                        setConfirmRestart(true);
                      }}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                    >
                      <RotateCcw className="h-[1.15em] w-[1.15em]" />
                      {t("restartChat")}
                    </button>
                    <div className="my-1 h-px bg-border" />
                    <button
                      onClick={handleOpenPersona}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                    >
                      <User className="h-[1.15em] w-[1.15em]" />
                      {t("persona")}
                    </button>
                    {(messages?.length ?? 0) > 0 && (
                      <button
                        onClick={handleSharePlaythrough}
                        className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                      >
                        <Share2 className="h-[1.15em] w-[1.15em]" />
                        {t("sharePlaythrough")}
                      </button>
                    )}
                    <button
                      onClick={handleOpenBranch}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                    >
                      <GitBranch className="h-[1.15em] w-[1.15em]" />
                      {t("branches")}
                    </button>
                  </div>
                )}
              </div>

              {/* Branch panel — opens upward from the "+" area. Rendered only
                  while open so the wrapper doesn't add a stray flex gap when
                  closed; click-outside is scoped to the panel, not the "+" menu
                  that triggers it. */}
              {branchOpen && (
                <div ref={branchRef} className="relative">
                  <div
                    role="dialog"
                    aria-label={t("branches")}
                    className="absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
                  >
                    <div className="max-h-[60vh] overflow-y-auto">
                      {branchLoading && !branchCtx && (
                        <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground/60">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t("branchLoading")}
                        </div>
                      )}

                      {branchError && !branchLoading && (
                        <div className="p-4 text-xs text-destructive/80">{t("branchFailed")}</div>
                      )}

                      {branchCtx && !branchError && (
                        <>
                          <BranchSection label={t("branchCurrent")}>
                            <BranchRow node={branchCtx.current} isCurrent t={t} timeAgo={timeAgo} />
                          </BranchSection>

                          {branchCtx.parent && (
                            <BranchSection label={t("branchParent")}>
                              <BranchRow
                                node={branchCtx.parent}
                                onSelect={() => goToBranch(branchCtx.parent!.id)}
                                leadingIcon={<ArrowUp className="h-3 w-3" />}
                                t={t}
                                timeAgo={timeAgo}
                              />
                            </BranchSection>
                          )}

                          {branchCtx.siblings.length > 0 && (
                            <BranchSection label={`${t("branchSiblings")} (${branchCtx.siblings.length})`}>
                              {branchCtx.siblings.map((s) => (
                                <BranchRow key={s.id} node={s} onSelect={() => goToBranch(s.id)} t={t} timeAgo={timeAgo} />
                              ))}
                            </BranchSection>
                          )}

                          {branchCtx.children.length > 0 && (
                            <BranchSection label={`${t("branchChildren")} (${branchCtx.children.length})`}>
                              {branchCtx.children.map((c) => (
                                <BranchRow key={c.id} node={c} onSelect={() => goToBranch(c.id)} t={t} timeAgo={timeAgo} />
                              ))}
                            </BranchSection>
                          )}

                          {!branchCtx.parent &&
                            branchCtx.siblings.length === 0 &&
                            branchCtx.children.length === 0 && (
                              <p className="px-4 py-3 text-[11px] text-muted-foreground/50">{t("branchEmpty")}</p>
                            )}
                        </>
                      )}
                    </div>

                    <div className="border-t border-border p-1.5">
                      <button
                        type="button"
                        onClick={() => void handleBranchFromLatest()}
                        disabled={!canBranchFromLatest || branching}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                      >
                        {branching ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                        ) : (
                          <Plus className="h-3.5 w-3.5 text-primary" />
                        )}
                        {t("branchFromLatest")}
                      </button>
                      <button
                        type="button"
                        onClick={handleOpenManager}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <ListTree className="h-3.5 w-3.5" />
                        {t("openManager")}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Narrow toolbar + at least one extension → collapse the model
                  pill and extension buttons into a single menu (opens a popover
                  with the model row + every extension's own settings button).
                  Wider toolbars keep the inline pills. */}
              {collapseTools ? (
                <ComposerToolMenu onOpenModelPicker={openModelPicker} />
              ) : (
                <>
                  <ModelTrigger onClick={openModelPicker} />
                  {/* Installed extensions' composer contributions (e.g. the
                      session-memory Context button) — see sandbox/extensions/. */}
                  <SlotOutlet point="chat.composer.toolbar" />
                </>
              )}
            </div>

            {/* Right: send/stop */}
            <div className="play-composer-send-row flex shrink-0 items-center gap-2">
              {messageLimitState !== "hidden" && (
                <span
                  aria-live="polite"
                  className={`tabular-nums text-[11px] ${
                    messageLimitState === "limit"
                      ? "font-medium text-destructive"
                      : "text-muted-foreground/60"
                  }`}
                >
                  {content.length.toLocaleString()} / {MAX_USER_MESSAGE_CHARS.toLocaleString()}
                </span>
              )}
              {isStreaming ? (
                <button
                  onClick={stopGeneration}
                  className="play-composer-stop hover-surface-strong flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground"
                  title={t("stopGeneration")}
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!content.trim() || generationBlocked}
                  className="play-composer-send flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:pointer-events-none disabled:opacity-20"
                  title={t("sendMessage")}
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

// Branch panel i18n lives in ./i18n (sandbox has no react-i18next).
type ChatT = ReturnType<typeof makeChatT>;

function BranchSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {label}
      </div>
      <div className="px-1 pb-1.5">{children}</div>
    </div>
  );
}

function BranchRow({
  node,
  isCurrent,
  onSelect,
  leadingIcon,
  t,
  timeAgo,
}: {
  node: BranchNode;
  isCurrent?: boolean;
  onSelect?: () => void;
  leadingIcon?: ReactNode;
  t: ChatT;
  timeAgo: (iso: string) => string;
}) {
  const displayName = node.name || t("untitledBranch");
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isCurrent}
      className={`group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        isCurrent ? "bg-primary/10 cursor-default" : "hover:bg-accent"
      }`}
    >
      {leadingIcon && <span className="shrink-0 text-muted-foreground/60">{leadingIcon}</span>}
      {isCurrent && <Check className="h-3 w-3 shrink-0 text-primary" />}
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[12px] ${isCurrent ? "text-foreground" : "text-foreground/90"}`}>
          {displayName}
        </div>
        <div className="truncate text-[10px] text-muted-foreground/50">
          {node.messageCount} {t("msgs")} · {timeAgo(node.updatedAt)}
        </div>
      </div>
    </button>
  );
}
import { modelFallbackText } from "@yumina/shared";
