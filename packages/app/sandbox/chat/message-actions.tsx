import { useState, useRef, useEffect, useLayoutEffect, useMemo, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useYumina } from "../sandbox-context";
import { makeChatT } from "./i18n";

interface MessageActionsProps {
  message: { id: string; role: string; content: string };
  isLastAssistant: boolean;
  isLastMessage: boolean;
  onEditStart: () => void;
}

// Popover sits above the trigger button. We anchor with position:fixed +
// computed coords so the popover always stays inside the viewport regardless
// of where the action toolbar lands (assistant bubbles are left-aligned, user
// bubbles are right-aligned, mobile is narrow). Pure CSS anchoring (left-0 /
// right-0 on the toolbar) overflows on one side or the other.
function computePopoverPos(
  triggerRect: DOMRect,
  popoverWidth: number,
  popoverHeight: number,
  margin = 8,
) {
  const viewportWidth = window.innerWidth;
  // Right-align popover to trigger button by default (destructive buttons
  // are on the right of the toolbar).
  let left = triggerRect.right - popoverWidth;
  // Clamp to viewport.
  if (left < margin) left = margin;
  if (left + popoverWidth > viewportWidth - margin) {
    left = viewportWidth - popoverWidth - margin;
  }
  // Place popover above the trigger with an 8px gap. If there isn't room
  // above, fall back to below.
  let top = triggerRect.top - popoverHeight - margin;
  if (top < margin) top = triggerRect.bottom + margin;
  return { left, top };
}

export function MessageActions({
  message,
  isLastAssistant,
  isLastMessage,
  onEditStart,
}: MessageActionsProps) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [branching, setBranching] = useState(false);
  // Double-tap lock for regenerate: api.isStreaming flips only after a host
  // round-trip, so an unguarded fast second tap = two generations, two charges.
  const [regenPending, setRegenPending] = useState(false);
  useEffect(() => {
    if (api.isStreaming) setRegenPending(false);
  }, [api.isStreaming]);
  const handleRegenerate = () => {
    if (regenPending || api.isStreaming) return;
    setRegenPending(true);
    api.regenerateMessage(message.id);
    window.setTimeout(() => setRegenPending(false), 4000);
  };
  const popoverRef = useRef<HTMLDivElement>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const revertBtnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number } | null>(null);

  // Compute popover position relative to its trigger when it opens, and
  // recompute on resize/scroll so it tracks the trigger.
  useLayoutEffect(() => {
    const trigger = confirmDelete
      ? deleteBtnRef.current
      : confirmRevert
        ? revertBtnRef.current
        : null;
    if (!trigger) {
      setPopoverPos(null);
      return;
    }
    const update = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const el = popoverRef.current;
      // Use measured size if popover has rendered, else fall back to mins.
      const width = el?.offsetWidth ?? (confirmRevert ? 220 : 200);
      const height = el?.offsetHeight ?? 96;
      setPopoverPos(computePopoverPos(triggerRect, width, height));
    };
    update();
    // Re-measure once after popover renders so we use its actual size.
    const id = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [confirmDelete, confirmRevert]);

  // Click-outside to dismiss floating confirmations
  useEffect(() => {
    if (!confirmDelete && !confirmRevert) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setConfirmDelete(false);
        setConfirmRevert(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [confirmDelete, confirmRevert]);

  const handleCopy = () => {
    api.copyToClipboard(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = async () => {
    try {
      const ok = await api.deleteMessage(message.id);
      if (!ok) {
        api.showToast(t("failedDelete"), "error");
      }
    } catch {
      api.showToast(t("failedDelete"), "error");
    }
    setConfirmDelete(false);
  };

  const handleRevert = async () => {
    setConfirmRevert(false);
    try {
      await api.revertToMessage(message.id);
      api.showToast(t("revertedToHere"), "success");
    } catch {
      api.showToast(t("failedRevert"), "error");
    }
  };

  const handleBranch = async () => {
    if (branching) return;
    setBranching(true);
    try {
      const newId = await api.branchFromMessage(message.id);
      if (newId) {
        api.navigate(`/app/chat/${newId}`);
      } else {
        api.showToast(t("failedBranch"), "error");
      }
    } catch {
      api.showToast(t("failedBranch"), "error");
    } finally {
      setBranching(false);
    }
  };

  const popoverStyle: React.CSSProperties = popoverPos
    ? { position: "fixed", left: popoverPos.left, top: popoverPos.top }
    : { position: "fixed", left: -9999, top: -9999 };

  // Popovers are portaled to document.body so they escape chat row and custom
  // renderer clipping/stacking contexts and stay positioned against the
  // viewport.
  return (
    <div className="relative flex items-center gap-0.5">
      {/* Floating delete confirmation */}
      {confirmDelete && createPortal(
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="z-50 min-w-[200px] max-w-[calc(100vw-1rem)] rounded-xl border border-destructive/20 bg-card/95 p-3 shadow-lg backdrop-blur-md"
        >
          <p className="text-xs font-medium text-foreground">
            {t("deleteThisMessage")}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/60">
            {t("deleteWarning")}
          </p>
          <div className="mt-2.5 flex justify-end gap-2">
            <button
              onClick={() => setConfirmDelete(false)}
              className="hover-surface h-7 rounded-md px-3 text-xs text-muted-foreground [@media(hover:none)]:min-h-10"
            >
              {t("cancel")}
            </button>
            <button
              onClick={handleDelete}
              className="flex h-7 items-center gap-1 rounded-md bg-destructive/20 px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/30 active:bg-destructive/30 [@media(hover:none)]:min-h-10"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>{" "}
              {t("confirmDelete")}
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* Floating revert confirmation */}
      {confirmRevert && createPortal(
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="z-50 min-w-[220px] max-w-[calc(100vw-1rem)] rounded-xl border border-destructive/20 bg-card/95 p-3 shadow-lg backdrop-blur-md"
        >
          <p className="text-xs font-medium text-foreground">
            {t("revertThisMessage")}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/60">
            {t("revertWarning")}
          </p>
          <div className="mt-2.5 flex justify-end gap-2">
            <button
              onClick={() => setConfirmRevert(false)}
              className="hover-surface h-7 rounded-md px-3 text-xs text-muted-foreground [@media(hover:none)]:min-h-10"
            >
              {t("cancel")}
            </button>
            <button
              onClick={handleRevert}
              className="flex h-7 items-center gap-1 rounded-md bg-destructive/20 px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/30 active:bg-destructive/30 [@media(hover:none)]:min-h-10"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
              </svg>{" "}
              {t("confirmRevert")}
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* Primary actions */}
      <ActionBtn onClick={handleCopy} title={t("copy")}>
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-primary"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
        )}
      </ActionBtn>

      <ActionBtn onClick={handleBranch} title={t("branchFromHere")} disabled={branching}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </ActionBtn>

      <ActionBtn onClick={onEditStart} title={t("edit")}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
          <path d="m15 5 4 4" />
        </svg>
      </ActionBtn>

      {message.role === "assistant" && isLastAssistant && (
        <ActionBtn
          onClick={handleRegenerate}
          title={t("regenerate")}
          disabled={regenPending}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </ActionBtn>
      )}

      {/* Separator */}
      <div className="mx-1 h-3.5 w-px bg-muted-foreground/15" />

      {/* Secondary/destructive actions */}
      {!isLastMessage && (
        <ActionBtn
          ref={revertBtnRef}
          onClick={() => setConfirmRevert(true)}
          title={t("revertToHere")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
          </svg>
        </ActionBtn>
      )}

      <ActionBtn
        ref={deleteBtnRef}
        onClick={() => setConfirmDelete(true)}
        title={t("delete")}
        className="hover:text-destructive"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
      </ActionBtn>
    </div>
  );
}

const ActionBtn = forwardRef<
  HTMLButtonElement,
  {
    children: React.ReactNode;
    onClick: () => void;
    title: string;
    className?: string;
    disabled?: boolean;
  }
>(function ActionBtn({ children, onClick, title, className, disabled }, ref) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        // play-action-btn: globals.css bumps these to a 40px touch target
        // under @media (hover: none) — 28px icon boxes mis-tap constantly.
        "hover-surface play-action-btn flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:text-foreground",
        disabled ? "pointer-events-none opacity-40" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </button>
  );
});
