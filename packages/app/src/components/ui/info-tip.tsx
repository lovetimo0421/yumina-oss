import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ⓘ beside a label: what the term means, in a sentence or two, the moment
 * the pointer reaches it. It used to be the browser's own `title` tooltip,
 * which waits a second, looks like a system message, never shows on touch
 * and — hovered briefly — never shows at all: authors reported the ⓘ as
 * empty.
 *
 * Hover or focus opens it; a click pins it open (for touch, and for reading
 * a longer one); leaving, Escape or a click elsewhere closes it.
 */
export function InfoTip({ text, className }: { text?: string; className?: string }) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const open = hover || pinned;
  const leaveTimer = useRef<number | undefined>(undefined);

  const measure = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const b = bubble.current;
    if (!a || !b) return;
    const width = b.offsetWidth, height = b.offsetHeight, margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, a.left + a.width / 2 - width / 2));
    const below = a.bottom + 6;
    const above = below + height > window.innerHeight - margin;
    setPlace({ left, top: above ? a.top - 6 - height : below, above });
  }, []);

  useLayoutEffect(() => { if (open) measure(); else setPlace(null); }, [open, measure, text]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) { if (event.key === "Escape") { setPinned(false); setHover(false); } return; }
      const target = event.target as Node;
      if (anchor.current?.contains(target) || bubble.current?.contains(target)) return;
      setPinned(false); setHover(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  if (!text) return null;
  const enter = () => { window.clearTimeout(leaveTimer.current); setHover(true); };
  // A moment's grace, so the pointer can cross from the ⓘ onto the bubble.
  const leave = () => { leaveTimer.current = window.setTimeout(() => setHover(false), 120); };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={text}
        aria-describedby={open ? id : undefined}
        aria-expanded={pinned}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={enter}
        onBlur={leave}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPinned(value => !value); }}
        data-info-tip=""
        className={cn(
          "nodrag inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border transition-colors",
          open ? "border-[#f0c674]/70 text-[#f0c674]" : "border-foreground/25 text-foreground/45 hover:border-foreground/50 hover:text-foreground/80",
          className,
        )}
      >
        <Info className="h-2.5 w-2.5" />
      </button>
      {open && createPortal(
        <div
          ref={bubble}
          id={id}
          role="tooltip"
          onPointerEnter={enter}
          onPointerLeave={leave}
          className="studio-glass fixed z-[400] max-w-[280px] whitespace-pre-line rounded-lg border px-3 py-2 text-[12px] font-normal leading-relaxed text-foreground/90 shadow-xl"
          style={place ? { left: place.left, top: place.top } : { left: -9999, top: -9999 }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
