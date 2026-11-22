import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";

const CLAMP_PX = 420;
// Only clamp when there is clearly more to see; hiding two lines behind a button is worse than showing them.
const SLACK_PX = 160;

/** A long description starts folded so the sections below it stay a short scroll away. */
export function ClampedDescription({ children }: { children: ReactNode }) {
  const { t } = useTranslation("library");
  const wrap = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    // Pictures load after the first layout, so keep measuring as the content grows.
    const measure = () => setTall(el.scrollHeight > CLAMP_PX + SLACK_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const folded = tall && !open;
  return (
    <div ref={wrap}>
      <div
        className="overflow-hidden"
        style={folded ? {
          maxHeight: CLAMP_PX,
          maskImage: "linear-gradient(to bottom, black 70%, transparent)",
          WebkitMaskImage: "linear-gradient(to bottom, black 70%, transparent)",
        } : undefined}
      >
        <div ref={inner}>{children}</div>
      </div>
      {tall && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
            if (open) wrap.current?.scrollIntoView({ block: "nearest" });
          }}
          className="mt-2 inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-white/60 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {open ? <ChevronUp aria-hidden="true" className="h-4 w-4" /> : <ChevronDown aria-hidden="true" className="h-4 w-4" />}
          {open ? t("detail.showLess") : t("detail.showMore")}
        </button>
      )}
    </div>
  );
}
