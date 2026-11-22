/**
 * Where a live character stands beside the stock chat: a column on a wide screen, a strip above the transcript on a
 * narrow one, sized off the space the chat has. On a narrow screen the strip folds away into a slim bar with her
 * face, for players who want the room. No sandbox API here, so the Studio preview can use it without loading the
 * sandbox (see live-stage.tsx for the character itself).
 */
import React, { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, UserRound } from "lucide-react";

/** Wide enough for the character to stand beside a readable transcript. */
const SIDE_MIN_WIDTH = 860;
/** She is cut at the waist: the cut fades out instead of ending in a hard line. */
const FADE: React.CSSProperties = { maskImage: "linear-gradient(to bottom, #000 82%, transparent)", WebkitMaskImage: "linear-gradient(to bottom, #000 82%, transparent)" };

export type StageMode = "side" | "top" | "folded";

/** Beside the transcript when there is room; else above it, or folded when the player folded it (narrow only). */
export function stageMode(width: number, folded: boolean): StageMode {
  if (width >= SIDE_MIN_WIDTH) return "side";
  return folded ? "folded" : "top";
}

/** The strip's fold on a narrow screen: whether it is folded, how to flip it, her still face for the slim bar. */
export interface StageFold {
  folded: boolean;
  onToggle: () => void;
  avatar?: string | null;
  hideLabel: string;
  showLabel: string;
}

/** The transcript with the character beside it (wide) or above it (narrow), sized off the space it has. */
export function LiveStageLayout({ stage, children, fold }: { stage: React.ReactNode; children: React.ReactNode; fold?: StageFold }) {
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => { const r = el.getBoundingClientRect(); setBox((b) => (b.w === r.width && b.h === r.height ? b : { w: r.width, h: r.height })); };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mode = stageMode(box.w, !!fold?.folded);
  const wide = mode === "side";
  const side = Math.round(Math.min(440, Math.max(260, box.w * 0.34)));
  const band = Math.round(Math.min(300, Math.max(140, box.h * 0.32)));
  return (
    <div ref={host} data-live-stage={mode}
      className={`relative flex min-h-0 min-w-0 flex-1 ${wide ? "flex-row" : "flex-col"}`}>
      {mode === "folded" && fold ? (
        // Folded: a slim bar with her face; tapping it brings her back. Not drawn meanwhile.
        <button type="button" onClick={fold.onToggle} aria-label={fold.showLabel} title={fold.showLabel} aria-expanded={false}
          data-live-stage-unfold="" className="flex h-10 w-full shrink-0 items-center justify-center gap-1.5 border-b border-border/60">
          <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-border bg-card">
            {fold.avatar
              ? <img src={fold.avatar} alt="" draggable={false} className="h-full w-full object-cover object-top" />
              : <UserRound className="h-3.5 w-3.5 text-muted-foreground" />}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      ) : (
        <div data-live-stage-character="" className="relative shrink-0"
          style={wide ? { width: side, height: "100%" } : { width: "100%", height: band }}>
          <div className="absolute inset-0 overflow-hidden" style={FADE}>{box.w > 0 && stage}</div>
          {!wide && fold && (
            <button type="button" onClick={fold.onToggle} aria-label={fold.hideLabel} title={fold.hideLabel} aria-expanded
              data-live-stage-fold="" className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/30 text-white/70 backdrop-blur-sm hover:text-white">
              <ChevronDown className="h-3.5 w-3.5 rotate-180" />
            </button>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
