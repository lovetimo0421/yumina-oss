import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** Lightweight hover popup that portals to <body>, so it never gets clipped by
 *  ancestor `overflow-hidden`. We deliberately avoid `@radix-ui/react-tooltip`
 *  here because that combo (Radix Tooltip + React 19 Strict Mode + portals)
 *  occasionally throws "removeChild: not a child of this node" during dev HMR
 *  and rapid state changes. This implementation owns its own DOM, so React's
 *  reconciler never loses track of it. */
export function HoverHint({
  children,
  content,
  side = "top",
  align = "end",
  className,
  delayMs = 120,
  width = 320,
}: {
  children: ReactNode;
  content: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  delayMs?: number;
  width?: number;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const node = triggerRef.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const anchorX =
      align === "start" ? r.left
      : align === "end" ? r.right
      : (r.left + r.right) / 2;
    const top = side === "top" ? r.top - 8 : r.bottom + 8;
    setCoords({ top, left: anchorX });
  }, [side, align]);

  const handleEnter = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      updatePosition();
      setOpen(true);
    }, delayMs);
  }, [delayMs, updatePosition]);

  const handleLeave = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setOpen(false);
  }, []);

  // Reposition on scroll/resize while open — viewport coords can drift.
  useLayoutEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updatePosition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, updatePosition]);

  const translate =
    align === "start" ? "translateX(0)"
    : align === "end" ? "translateX(-100%)"
    : "translateX(-50%)";
  const yTranslate = side === "top" ? "translateY(-100%)" : "translateY(0)";

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocus={handleEnter}
        onBlur={handleLeave}
        className="inline-flex"
      >
        {children}
      </span>
      {open && typeof document !== "undefined" && createPortal(
        <div
          role="tooltip"
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            transform: `${translate} ${yTranslate}`,
            width,
            zIndex: 9999,
            pointerEvents: "none",
          }}
          className={cn(
            "rounded-md border border-border bg-popover px-3.5 py-2.5 text-xs leading-relaxed text-popover-foreground shadow-xl animate-in fade-in-0 zoom-in-95",
            className
          )}
        >
          {content}
        </div>,
        document.body
      )}
    </>
  );
}
