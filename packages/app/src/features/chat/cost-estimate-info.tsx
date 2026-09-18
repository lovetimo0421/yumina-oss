import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const POPOVER_WIDTH = 320;
const VIEWPORT_GUTTER = 12;
const TRIGGER_GAP = 8;

/**
 * The "?" next to the model list: how the mushie estimate is made, and why it is
 * a range. Same portal/positioning approach as the DeepSeek pricing notice so it
 * escapes the browser sheet's overflow and works inside the sandbox shadow root.
 */
export function CostEstimateInfo({ className }: { className?: string }) {
  const { t } = useTranslation("chat");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const contentId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: POPOVER_WIDTH, ready: false });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const contentHeight = contentRef.current?.getBoundingClientRect().height ?? 180;
    const left = Math.min(Math.max(rect.right - width, VIEWPORT_GUTTER), window.innerWidth - width - VIEWPORT_GUTTER);
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_GUTTER;
    const preferredTop = spaceBelow >= contentHeight + TRIGGER_GAP ? rect.bottom + TRIGGER_GAP : rect.top - contentHeight - TRIGGER_GAP;
    const top = Math.min(Math.max(preferredTop, VIEWPORT_GUTTER), Math.max(VIEWPORT_GUTTER, window.innerHeight - contentHeight - VIEWPORT_GUTTER));
    setPosition({ top, left, width, ready: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = requestAnimationFrame(() => {
      updatePosition();
      contentRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if ((!triggerRef.current || !path.includes(triggerRef.current)) && (!contentRef.current || !path.includes(contentRef.current))) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const rootNode = triggerRef.current?.getRootNode();
  const portalTarget = typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot ? rootNode : document.body;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("modelBrowser.costHelpAria")}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setPosition((current) => ({ ...current, ready: false }));
          setOpen((current) => !current);
        }}
        className={cn(
          "group/help inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/5 hover:text-white/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25",
          className,
        )}
      >
        <CircleHelp className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && createPortal(
        <div
          ref={contentRef}
          id={contentId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          style={{ position: "fixed", top: position.top, left: position.left, width: position.width, visibility: position.ready ? "visible" : "hidden" }}
          className="z-[10000] rounded-2xl border border-white/[0.08] bg-[#1a1b20] p-4 text-left shadow-[0_24px_64px_rgba(0,0,0,0.6)] focus:outline-none"
        >
          <p id={titleId} className="mb-2 text-[12px] font-bold text-gold/85">{t("modelBrowser.costHelpTitle")}</p>
          <p className="text-[11px] leading-relaxed text-white/60">{t("modelBrowser.costHelpBody")}</p>
        </div>,
        portalTarget,
      )}
    </>
  );
}
