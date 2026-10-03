import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;

/**
 * A popover that opens upward from a composer toolbar button.
 *
 * Portaled to <body> with viewport-fixed coordinates (same approach as the
 * MessageActions confirmations). Anchoring with `absolute bottom-full` inside
 * the composer broke on creator layouts: the interface-document pages put
 * <MessageInput/> in a fixed-size `overflow: hidden` box stacked after the
 * message box, so the popover's upper part was clipped away and clicks there
 * fell through to the message list. Scaled stages (`transform: scale`) also
 * blew the popover past the viewport.
 *
 * The popover sits `gap` px above the anchor, aligned to its left or right
 * edge, clamped inside the viewport, and its max height is the room above the
 * anchor — so the caller's inner scroll area must be able to shrink
 * (`min-h-0 overflow-y-auto` inside a flex column).
 */
export function ComposerPopover({
  anchorRef,
  popoverRef,
  align,
  gap = MARGIN,
  className,
  children,
  role,
  ariaLabel,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** Also used by the caller's click-outside check: the portaled popover is
   *  no longer inside the anchor's DOM subtree. */
  popoverRef: RefObject<HTMLDivElement | null>;
  align: "left" | "right";
  gap?: number;
  className?: string;
  children: ReactNode;
  role?: string;
  ariaLabel?: string;
}) {
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const el = popoverRef.current;
      if (!anchor || !el) return;
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const width = el.offsetWidth;
      let left = align === "right" ? rect.right - width : rect.left;
      left = Math.max(MARGIN, Math.min(left, viewportWidth - width - MARGIN));
      setPos({
        left,
        bottom: window.innerHeight - rect.top + gap,
        maxHeight: Math.max(0, rect.top - gap - MARGIN),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, popoverRef, align, gap]);

  const style: CSSProperties = pos
    ? { position: "fixed", left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight }
    : { position: "fixed", left: -9999, bottom: 0 };

  return createPortal(
    <div ref={popoverRef} role={role} aria-label={ariaLabel} style={style} className={`z-[9000] ${className ?? ""}`}>
      {children}
    </div>,
    document.body,
  );
}
