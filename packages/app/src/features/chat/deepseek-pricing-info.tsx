import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { usesDeepSeekLatestPricing } from "@/lib/deepseek-pricing-notice";
import { cn } from "@/lib/utils";

export interface DeepSeekPricingCopy {
  triggerLabel: string;
  title: string;
  body: string;
}

interface DeepSeekPricingInfoProps {
  modelId: string;
  modelName: string;
  copy: DeepSeekPricingCopy;
  className?: string;
}

const POPOVER_WIDTH = 304;
const VIEWPORT_GUTTER = 12;
const TRIGGER_GAP = 8;

export function DeepSeekPricingInfo({ modelId, modelName, copy, className }: DeepSeekPricingInfoProps) {
  const showNotice = usesDeepSeekLatestPricing(modelId);
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
    const contentHeight = contentRef.current?.getBoundingClientRect().height ?? 140;
    const left = Math.min(
      Math.max(rect.right - width, VIEWPORT_GUTTER),
      window.innerWidth - width - VIEWPORT_GUTTER,
    );
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_GUTTER;
    const preferredTop = spaceBelow >= contentHeight + TRIGGER_GAP
      ? rect.bottom + TRIGGER_GAP
      : rect.top - contentHeight - TRIGGER_GAP;
    const top = Math.min(
      Math.max(preferredTop, VIEWPORT_GUTTER),
      Math.max(VIEWPORT_GUTTER, window.innerHeight - contentHeight - VIEWPORT_GUTTER),
    );

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
      const trigger = triggerRef.current;
      const content = contentRef.current;
      if (
        (!trigger || !path.includes(trigger))
        && (!content || !path.includes(content))
      ) {
        setOpen(false);
      }
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

  if (!showNotice) return null;

  const rootNode = triggerRef.current?.getRootNode();
  const portalTarget = typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot
    ? rootNode
    : document.body;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${copy.triggerLabel}: ${modelName}`}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setPosition((current) => ({ ...current, ready: false }));
          setOpen((current) => !current);
        }}
        className={cn(
          "group/help inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-cyan-300/55",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1b1e]",
          className,
        )}
      >
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors group-hover/help:bg-cyan-300/10 group-hover/help:text-cyan-200 group-active/help:bg-cyan-300/15">
          <CircleHelp className="h-4 w-4" aria-hidden="true" />
        </span>
      </button>

      {open && createPortal(
        <div
          ref={contentRef}
          id={contentId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            "fixed z-[20000] max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-xl border border-cyan-300/15 bg-[#17191d]/[0.98] p-3.5 text-left",
            "shadow-2xl shadow-black/60 backdrop-blur-xl focus:outline-none",
            "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150",
          )}
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
            visibility: position.ready ? "visible" : "hidden",
          }}
        >
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-300/10 text-cyan-200">
              <CircleHelp className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 id={titleId} className="text-sm font-semibold text-white">{copy.title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-white/70">{copy.body}</p>
            </div>
          </div>
        </div>,
        portalTarget,
      )}
    </>
  );
}
