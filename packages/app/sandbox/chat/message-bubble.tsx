/**
 * Sandbox-side message bubble component.
 *
 * Ported from packages/app/src/features/chat/message-bubble.tsx with:
 * - useYumina() from sandbox context instead of Zustand stores
 * - renderMessage/renderMarkdown from local sandbox markdown module
 * - SandboxMessage type instead of store Message type
 * - No CustomComponentRenderer — accepts a pre-compiled rendererComponent prop
 * - No i18next — inline English strings
 * - No toast() — uses api.showToast()
 * - cn() inlined (clsx + tailwind-merge)
 */

import React, { useState, useRef, useLayoutEffect, useMemo } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { useYumina } from "../sandbox-context";
import { renderMessage, renderMarkdown } from "./markdown";
import { MessageRendererBoundary } from "./message-renderer-boundary";
import {
  isContentBlockedError,
  makeChatT,
  parseFailureCode,
  FALLBACK_MODEL_ID,
} from "./i18n";
import type { SandboxMessage } from "./types";
import { resolveSpeaker, stripLeadingSpeakerTag, isPartialLeadingSpeakerTag } from "./speaker";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function trimFixed(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

// ── Strip directives (inlined from @/lib/strip-directives) ─────────
// Strips state-change directives from streaming text so they never show.

const DIR_STANDARD =
  /\[([\w\p{L}\p{N}.$-]+):\s*(set|add|subtract|multiply|toggle|append|\+|-|\*)?\s*("(?:[^"\\]|\\.)*"|[\w\p{L}\p{N}.$-]+)?\]/gu;
const DIR_AUDIO =
  /\[audio:\s*([\w\p{L}\p{N}-]+)\s+(play|stop|crossfade|volume)(?:\s+([\d.]+))?(?:\s+chain:([\w\p{L}\p{N}-]+))?\]/gu;
const DIR_JSON =
  /\[([\w\p{L}\p{N}.$-]+):\s*(set|merge|push|delete)\s+(\{[\s\S]*?\}|\[[\s\S]*?\])\]/gu;
const DIR_UPDATE_VAR = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi;
const DIR_STRUCTURAL_XML =
  /^\s*<\/?(maintext|option|sum|Analysis|UpdateVariable|JSONPatch|status_current_variable)\s*>\s*$/gim;
const DIR_TRAILING = /\[[\w\p{L}\p{N}.$-]+:[^\]]*$/u;

function stripDirectives(text: string): string {
  return text
    .replace(DIR_UPDATE_VAR, "")
    .replace(DIR_AUDIO, "")
    .replace(DIR_JSON, "")
    .replace(DIR_STANDARD, "")
    .replace(DIR_STRUCTURAL_XML, "")
    .replace(DIR_TRAILING, "");
}

// ── Props ──────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: SandboxMessage;
  isStreaming?: boolean;
  streamingContent?: string;
  streamingReasoning?: string;
  dimmed?: boolean;
  children?: React.ReactNode; // actions slot
  swipeControls?: React.ReactNode;
  rendererComponent?: React.ComponentType<Record<string, unknown>> | null;
  variables?: Record<string, unknown>;
  messageIndex?: number;
  showRoleLabel?: boolean;
  /** Retry only makes sense for the trailing turn — `continueLastMessage`
   *  generates a reply for the newest message, not an arbitrary one. */
  isLastMessage?: boolean;
  /** Fingerprint of everything the `children`/`swipeControls` slots depend on
   *  (isLast flags, swipe count, status). The memo comparator can't see into
   *  those element trees, so without this a bubble that stops being the last
   *  message would keep its stale action row (ghost regenerate button). */
  actionsKey?: string;
  // Inline edit
  isEditing?: boolean;
  isSavingEdit?: boolean;
  editContent?: string;
  onEditContentChange?: (content: string) => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
}

// ── Component ──────────────────────────────────────────────────────

const MessageBubbleInner: React.FC<MessageBubbleProps> = function MessageBubbleInner({
  message,
  isStreaming,
  streamingContent,
  streamingReasoning,
  dimmed,
  children,
  swipeControls,
  rendererComponent: RendererComp,
  variables,
  messageIndex,
  showRoleLabel = true,
  isLastMessage,
  isEditing,
  isSavingEdit,
  editContent,
  onEditContentChange,
  onSaveEdit,
  onCancelEdit,
}: MessageBubbleProps) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const rawContent = isStreaming ? (streamingContent ?? "") : message.content;
  // The leading speaker tag is stripped server-side for stored content, but
  // a live stream is raw — peel it before the generic directive strip (which
  // cannot match a multi-word name).
  // While the tag itself is still arriving (`[spea`) show nothing yet: the
  // label would otherwise flash "Narrator" for a token before the face lands.
  const holdingSpeakerTag = isStreaming && isPartialLeadingSpeakerTag(rawContent);
  const displayContent = isStreaming
    ? holdingSpeakerTag ? "" : stripDirectives(stripLeadingSpeakerTag(rawContent))
    : rawContent;
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  // A failed turn is recorded on the USER row, not as a synthetic assistant
  // row (see server/src/lib/turn-failure.ts for why). Before 2026-07-30 this
  // only checked assistant rows, and since nothing ever wrote `failed` the
  // whole branch was dead code — which is exactly how failures became silent.
  const generationFailed = !isSystem && message.status === "failed" && api.modelFallback?.userMessageId !== message.id;
  const failure = useMemo(
    () => parseFailureCode(message.errorMessage),
    [message.errorMessage],
  );
  const failureText = useMemo(() => {
    switch (failure.code) {
      case "FREE_POOL_EXHAUSTED": return t("freePoolExhausted");
      case "INTERRUPTED":         return t("turnInterrupted");
      case "UPSTREAM_UNAVAILABLE": return t("upstreamBusy");
      case "MODEL_FALLBACK_REQUIRED": return t("upstreamBusy");
      case "CONTENT_FILTER":      return t("contentBlocked");
      default:
        return isContentBlockedError(failure.text)
          ? t("contentBlocked")
          : failure.text || t("generationFailed");
    }
  }, [failure, t]);
  // Retrying only reaches the server for the trailing turn, and firing it
  // mid-stream would stack a second generation on the same message.
  const canRetryTurn = generationFailed && !!isLastMessage && !api.isStreaming && !api.modelFallback;

  // Raw LLM output for the active swipe. Persisted server-side starting 2026-05
  // so older messages may not have it — hide the toggle when missing rather
  // than showing an empty drawer.
  const activeSwipeIdx = message.activeSwipeIndex ?? 0;
  const activeSwipe = message.swipes?.[activeSwipeIdx];
  const rawOutput =
    !isUser && !isStreaming && !isSystem
      ? activeSwipe?.rawContent ?? null
      : null;
  const hasRawOutput = !!rawOutput && rawOutput !== message.content;
  const creditCost =
    typeof activeSwipe?.creditCost === "number"
      ? activeSwipe.creditCost
      : typeof message.creditCost === "number"
        ? message.creditCost
        : null;
  const creditBalanceAfter =
    typeof activeSwipe?.creditBalanceAfter === "number"
      ? activeSwipe.creditBalanceAfter
      : typeof message.creditBalanceAfter === "number"
        ? message.creditBalanceAfter
        : null;

  // User label
  const userLabel = t("you");

  // Which character's face goes above this bubble. Reads the world's entries
  // straight from the sandbox API (pushed by the host with portraits already
  // resolved to URLs) so message rows never have to carry it.
  // Stored replies keep the tag only in the swipe's rawContent (cleanText has
  // it stripped), so the resolver reads raw: live stream while streaming,
  // else the active swipe's raw output, else the content itself (greeting,
  // pre-2026-09 history) where only the prose heuristics apply.
  const speakerSource = isStreaming
    ? (streamingContent ?? "")
    : (activeSwipe?.rawContent ?? message.content);
  const speaker = useMemo(
    () => (isUser || isSystem ? null : resolveSpeaker(api.entries, speakerSource)),
    [api.entries, isUser, isSystem, speakerSource],
  );

  // Auto-resize edit textarea
  useLayoutEffect(() => {
    const textarea = editTextareaRef.current;
    if (!textarea || !isEditing) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [isEditing, editContent]);

  // Handle choice button clicks
  const handleClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-yumina-choice]");
    if (el) {
      const text = el.getAttribute("data-yumina-choice");
      if (!text) return;
      api.sendMessage(text);
    }
  };

  // ── System messages ──────────────────────────────────────────────

  if (isSystem) {
    return (
      <div
        className={cn(
          "play-system-message text-center text-xs italic text-muted-foreground/50",
          dimmed && "text-xs opacity-50",
        )}
      >
        {displayContent}
      </div>
    );
  }

  // ── Thinking section ─────────────────────────────────────────────

  const showThinking = isStreaming && !!streamingReasoning;

  // ── Metadata ─────────────────────────────────────────────────────

  const hasMetadata = !isStreaming && !isUser && message.generationTimeMs;
  const metadataTitle = [
    creditCost != null
      ? `${trimFixed(creditCost, 3)} mush${creditBalanceAfter != null ? ` · balance ${Math.floor(creditBalanceAfter).toLocaleString()} mush` : ""}`
      : null,
  ].filter(Boolean).join(" · ") || undefined;

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div
      className={cn(
        "play-message-block group relative",
        isUser && "play-message-block--user",
        dimmed && "opacity-50",
      )}
    >
      <div className={cn("w-full min-w-0", isUser && "play-user-message-shell")}>
        {/* Name label — a character portrait + name when the world says who is
            speaking, otherwise the plain role label on role changes. */}
        {speaker ? (
          <div className="play-message-speaker mb-1.5 flex items-center gap-2">
            {speaker.portrait && (
              <img
                src={speaker.portrait}
                alt=""
                draggable={false}
                className="h-8 w-8 shrink-0 rounded-full border border-border object-cover"
              />
            )}
            <p className="play-message-role text-xs font-medium text-primary/70">
              {speaker.name}
            </p>
          </div>
        ) : (
          showRoleLabel && !holdingSpeakerTag && (
            <p
              className={cn(
                "play-message-role mb-1 text-xs font-medium",
                isUser ? "text-emerald-300/60" : "text-primary/70",
              )}
            >
              {isUser ? userLabel : t("narrator")}
            </p>
          )
        )}

        {/* Attachment thumbnails */}
        {message.attachments && message.attachments.length > 0 && (
          <div className={cn("mb-2 flex flex-wrap gap-2", isUser && "justify-end")}>
            {message.attachments.map((att, i) => (
              <img
                key={i}
                src={att.url}
                alt={att.name}
                className="h-20 w-20 rounded-lg border border-border object-cover"
              />
            ))}
          </div>
        )}

        {/* Thinking/reasoning collapsible section */}
        {showThinking && (
          <div className="mb-2">
            <button
              onClick={() => setThinkingExpanded(!thinkingExpanded)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground/80"
            >
              <svg
                className={cn(
                  "h-3 w-3 transition-transform duration-200",
                  thinkingExpanded && "rotate-90",
                )}
                viewBox="0 0 12 12"
                fill="currentColor"
              >
                <path d="M4.5 2l4 4-4 4V2z" />
              </svg>
              <span className="italic">
                {t("thinking")}
                {!displayContent && (
                  <span className="ml-1 inline-flex">
                    <span className="animate-pulse">...</span>
                  </span>
                )}
              </span>
            </button>
            {thinkingExpanded && (
              <div className="mt-1.5 ml-4.5 border-l-2 border-muted-foreground/15 pl-3 text-xs leading-relaxed text-muted-foreground/50 whitespace-pre-wrap">
                {streamingReasoning}
              </div>
            )}
          </div>
        )}

        {/* Message content — inline edit or rendered HTML */}
        <div
          className={cn(
            "play-message-content text-sm leading-relaxed text-foreground",
            isUser && "play-user-message-content",
            dimmed && "text-xs",
          )}
        >
          {isEditing ? (
            <div>
              <textarea
                ref={editTextareaRef}
                autoFocus
                value={editContent}
                disabled={isSavingEdit}
                onChange={(e) => {
                  onEditContentChange?.(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    onSaveEdit?.();
                  }
                  if (e.key === "Escape") {
                    onCancelEdit?.();
                  }
                }}
                className="w-full resize-y rounded-md border border-primary/30 bg-white/5 p-2 text-sm leading-relaxed text-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30 focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  onClick={onCancelEdit}
                  disabled={isSavingEdit}
                  className="hover-surface flex h-7 items-center gap-1.5 rounded-md px-3 text-xs text-muted-foreground disabled:pointer-events-none disabled:opacity-40 [@media(hover:none)]:min-h-10"
                >
                  {/* X icon (inline SVG to avoid lucide-react dependency) */}
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>{" "}
                  Cancel
                  <kbd className="ml-1 text-[10px] text-muted-foreground/40">
                    Esc
                  </kbd>
                </button>
                <button
                  onClick={onSaveEdit}
                  disabled={isSavingEdit}
                  className="flex h-7 items-center gap-1.5 rounded-md bg-primary/15 px-3 text-xs font-medium text-primary transition-colors hover:bg-primary/25 active:bg-primary/25 disabled:pointer-events-none disabled:opacity-60 [@media(hover:none)]:min-h-10"
                >
                  {/* Check icon (inline SVG) */}
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>{" "}
                  {isSavingEdit ? "Saving..." : "Save"}
                  <kbd className="ml-1 text-[10px] text-primary/40">
                    Ctrl+Enter
                  </kbd>
                </button>
              </div>
            </div>
          ) : RendererComp ? (
            <div className="play-custom-component-shell" onClick={handleClick}>
              <MessageRendererBoundary
                resetKeys={[
                  RendererComp,
                  displayContent,
                  !!isStreaming,
                  activeSwipeIdx,
                  message.stateSnapshot,
                  variables,
                ]}
                fallback={(
                  <div
                    dangerouslySetInnerHTML={{
                      __html: renderMessage(displayContent),
                    }}
                  />
                )}
                onError={(error) => {
                  console.warn(
                    "[Yumina] Custom message renderer failed; using the default message renderer.",
                    error,
                  );
                }}
              >
                <RendererComp
                  content={displayContent}
                  rawContent={rawContent}
                  stateSnapshot={message.stateSnapshot ?? null}
                  role={message.role}
                  messageIndex={messageIndex}
                  renderMarkdown={renderMarkdown}
                  isStreaming={!!isStreaming}
                  variables={variables ?? {}}
                />
              </MessageRendererBoundary>
            </div>
          ) : (
            <div
              onClick={handleClick}
              dangerouslySetInnerHTML={{
                __html: renderMessage(displayContent),
              }}
            />
          )}
          {isStreaming && (
            <span className="streaming-cursor ml-0.5 inline-block text-primary">
              &#x258E;
            </span>
          )}
        </div>

        {generationFailed && (
          <div className="play-turn-error mt-2 w-full min-w-0 self-stretch rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="play-turn-error__text">{failureText}</div>
            {(canRetryTurn || failure.code === "FREE_POOL_EXHAUSTED") && (
              <div className="play-turn-error__actions mt-2 flex flex-wrap gap-2">
                {canRetryTurn && (
                  <button
                    type="button"
                    onClick={() => api.continueLastMessage()}
                    className="play-turn-error__action rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 font-medium transition-colors hover:bg-destructive/20"
                  >
                    {t("retryTurn")}
                  </button>
                )}
                {failure.code === "FREE_POOL_EXHAUSTED" && (
                  <button
                    type="button"
                    onClick={() => api.setModel(FALLBACK_MODEL_ID)}
                    className="play-turn-error__action rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 font-medium transition-colors hover:bg-destructive/20"
                  >
                    {t("switchModel")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {!isUser && !isSystem && !isStreaming && (activeSwipe ? activeSwipe.modelFallback : message.modelFallback) && (
          <ModelFallbackBadge record={(activeSwipe ? activeSwipe.modelFallback : message.modelFallback)!} />
        )}

        {/* Raw LLM output drawer — toggled by the eye icon in the action row. */}
        {hasRawOutput && rawExpanded && (
          <div className="mt-2 rounded-md border border-muted-foreground/15 bg-muted-foreground/[0.04] px-3 py-2 text-[11px] font-mono leading-relaxed text-muted-foreground/70 whitespace-pre-wrap break-all max-h-[40vh] overflow-y-auto">
            {rawOutput}
          </div>
        )}

        {/* Swipe controls — separate centered row */}
        {!isStreaming && !dimmed && swipeControls && (
          <div className="touch-reveal mt-2 flex justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            {swipeControls}
          </div>
        )}

        {/* Hover-reveal actions + metadata. flex-wrap: on touch the action
            buttons grow to 40px targets — metadata wraps below on narrow
            phones instead of squeezing the buttons. */}
        {!isStreaming && !dimmed && (children || hasMetadata || hasRawOutput) && (
          <div className="touch-reveal mt-1 flex flex-wrap items-center justify-between gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <div className="flex items-center gap-1">
              {children}
              {hasRawOutput && (
                <button
                  type="button"
                  onClick={() => setRawExpanded((v) => !v)}
                  title={rawExpanded ? t("hideRawOutput") : t("showRawOutput")}
                  aria-pressed={rawExpanded}
                  className={cn(
                    "hover-surface play-action-btn flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:text-muted-foreground",
                    rawExpanded && "bg-muted-foreground/10 text-muted-foreground",
                  )}
                >
                  {/* Eye icon (inline SVG to avoid lucide-react dependency) */}
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              )}
            </div>
            {hasMetadata && (
              <p
                className="shrink-0 text-[11px] text-muted-foreground/35"
                title={metadataTitle}
              >
                {(message.generationTimeMs! / 1000).toFixed(1)}s
                {message.model
                  ? ` \u00b7 ${message.model.split("/").pop()}`
                  : ""}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Memoized message bubble — skips re-render when props haven't changed.
 * This is critical for performance: during streaming, only the active
 * streaming bubble re-renders, not the 500 completed messages above it.
 */
export const MessageBubble = React.memo(MessageBubbleInner, (prev, next) => {
  // Return true = skip re-render (props are equal)
  if (prev.message.id !== next.message.id) return false;
  if (prev.message.content !== next.message.content) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.streamingContent !== next.streamingContent) return false;
  if (prev.streamingReasoning !== next.streamingReasoning) return false;
  if (prev.dimmed !== next.dimmed) return false;
  if (prev.showRoleLabel !== next.showRoleLabel) return false;
  if (prev.isEditing !== next.isEditing) return false;
  if (prev.editContent !== next.editContent) return false;
  if (prev.rendererComponent !== next.rendererComponent) return false;
  if (prev.messageIndex !== next.messageIndex) return false;
  // Swipe: check by active swipe index (content changes on swipe)
  if (prev.message.activeSwipeIndex !== next.message.activeSwipeIndex) return false;
  if (prev.message.modelFallback !== next.message.modelFallback) return false;
  if (prev.message.swipes !== next.message.swipes) return false;
  // Action-row dependencies (isLast flags, swipe count, status) live inside the
  // children/swipeControls elements, which this comparator can't diff.
  if (prev.actionsKey !== next.actionsKey) return false;
  return true;
});
import { ModelFallbackBadge } from "./model-fallback-card";
