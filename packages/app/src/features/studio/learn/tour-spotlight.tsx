import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clipTourTarget, placeTourCardWithSide, type TourBox } from "./tour-placement";
import { LEARNING_ROOM_EVENT } from "./learning-catalog";

export function visibleTourElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 4 && rect.height > 4 && getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none";
}

/** The guide's width on a desktop. */
export const TOUR_CARD_WIDTH = 460;
/** About as tall as the card gets with a lesson's paragraph and its course
 *  strip — what the canvas keeps free under what it frames (see the
 *  blueprint's guide reserve), so the block stands above the card. */
export const TOUR_CARD_HEIGHT = 290;

/* How a lesson change moves.

   The card and the light around the block used to be re-measured ten times
   a second and eased to each measurement with a CSS transition. While the
   canvas glided to the next block (a 400ms move) they trailed it in a
   hundred small steps, the light blinked off and back on at a stale spot,
   and the card sometimes set off in the wrong direction before the block's
   final place pulled it back. It read as stutter.

   Now the light is glued to the block: measured every frame and placed
   directly, no easing, so it moves exactly as the block moves. And the
   card does not move at all: it is docked at the bottom of the canvas,
   centred, and the camera frames the lesson's block above it, so the eye
   has one place to read and one place to look. A lesson change is one
   gesture: the card and the light step back (HOLD_MS), the canvas moves,
   and when the block has come to rest they come back together. A beat
   inside a lesson only changes the words and the light — the card stays
   put and does not fade. */
const HOLD_MS = 140;
const REST_MS = 90;
const REST_DEADLINE_MS = 1400;

function visualBounds(): TourBox {
  const viewport = window.visualViewport;
  return { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight };
}

const boxKey = (box: TourBox | null) => box ? `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}` : "none";

export function TourSpotlight({ id, motionKey, title, eyebrow, big, dim, getTarget, compact, onCompact, onClose, footer, children }: {
  id: string;
  /** Changes when the lesson does: only then do the card and the light
   *  step back while the canvas moves. `id` changes on every beat. */
  motionKey: string;
  title: string; eyebrow: string;
  /** Below the buttons: the course strip. */
  footer?: ReactNode;
  /** 基础: a larger Mushie and larger type — one idea on screen at a time. */
  big?: boolean;
  /** Point at one small control: everything else is dimmed and the control
   *  is lit, so the eye goes straight to it. Clicks still reach the page. */
  dim?: boolean;
  /** The control the lesson points at — or several, highlighted as one:
   *  a lesson about two blocks that stand side by side frames both. */
  getTarget: () => HTMLElement | HTMLElement[] | null;
  compact: boolean; onCompact: (value: boolean) => void; onClose: () => void; children: ReactNode;
}) {
  const { t } = useTranslation("learning");
  const card = useRef<HTMLDivElement>(null);
  const halo = useRef<HTMLDivElement>(null);
  const resolve = useRef(getTarget); resolve.current = getTarget;
  const compactRef = useRef(compact); compactRef.current = compact;
  const dimRef = useRef(dim); dimRef.current = dim;
  const [modal, setModal] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() => visualBounds().height);
  /** "hold": stepping back while the lesson changes and the canvas moves.
   *  "shown": at rest beside the block. */
  const [phase, setPhase] = useState<"hold" | "shown">("hold");
  // The frame loop reads these; React only hears about the phase.
  const motion = useRef({ changedAt: 0, restSince: 0, lastKey: "", side: undefined as number | undefined, dock: undefined as number | undefined, room: "", phase: "hold" as "hold" | "shown" });

  useEffect(() => {
    motion.current.changedAt = performance.now();
    motion.current.restSince = 0;
    motion.current.side = undefined;
    motion.current.dock = undefined;
    motion.current.phase = "hold";
    setPhase("hold");
  }, [motionKey]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const state = motion.current;
      const viewport = visualBounds();
      const found = resolve.current();
      const elements = (Array.isArray(found) ? found : [found]).filter(visibleTourElement);
      const element = elements[0] ?? null;
      const rect = elements.length ? elements.map((item): TourBox => item.getBoundingClientRect()).reduce((all, box) => {
        const left = Math.min(all.left, box.left), top = Math.min(all.top, box.top);
        return { left, top, width: Math.max(all.left + all.width, box.left + box.width) - left, height: Math.max(all.top + all.height, box.top + box.height) - top };
      }) : null;
      const canvas = element?.closest('[data-onboarding="blueprint"]')?.getBoundingClientRect();
      // Panned nodes can extend behind the companion column. Keep their
      // highlight inside the visible canvas as well as the screen.
      const bounds = canvas ? {
        left: Math.max(viewport.left, canvas.left), top: Math.max(viewport.top, canvas.top),
        width: Math.min(viewport.left + viewport.width, canvas.right) - Math.max(viewport.left, canvas.left),
        height: Math.min(viewport.top + viewport.height, canvas.bottom) - Math.max(viewport.top, canvas.top),
      } : viewport;
      const target = rect ? clipTourTarget(rect, bounds) : null;
      const modalNow = Array.from(document.querySelectorAll('[role="dialog"][data-state="open"]')).some(visibleTourElement);
      setModal((old) => old === modalNow ? old : modalNow);
      setViewportHeight((old) => old === viewport.height ? old : viewport.height);

      // While the card steps back it stays where it was: the new block is
      // measured, not shown, until the light and the card arrive together.
      const holding = state.phase === "hold" && now - state.changedAt < HOLD_MS;
      if (!holding) {
        if (halo.current) {
          if (target) {
            halo.current.style.left = `${target.left}px`;
            halo.current.style.top = `${target.top}px`;
            halo.current.style.width = `${target.width}px`;
            halo.current.style.height = `${target.height}px`;
            halo.current.style.display = "";
          } else {
            halo.current.style.display = "none";
          }
        }
        if (card.current) {
          const phone = viewport.width < 768;
          const size = { width: phone ? viewport.width - 24 : TOUR_CARD_WIDTH, height: card.current.offsetHeight || (compactRef.current ? 68 : 220) };
          // Docked: the bottom of the canvas, centred (the bottom of the
          // screen on a phone, or wherever the canvas is not showing — the
          // screen editor, the playtest). Only when that would cover the
          // very thing the lesson points at does the card stand beside it.
          const board = Array.from(document.querySelectorAll('[data-onboarding="blueprint"]')).find(visibleTourElement)?.getBoundingClientRect();
          const area = !phone && board ? { left: board.left, top: board.top, width: board.width, height: board.height } : viewport;
          const width = Math.min(size.width, area.width - 24);
          const dockTop = area.top + area.height - size.height - (phone ? 12 : 16);
          const at = (left: number) => ({ left, top: dockTop, width, height: size.height });
          // What the card must not cover: the thing pointed at, and the editor
          // a lesson opens beside a row (the fields its beats point into).
          const editor = document.querySelector("[data-floating-editor]");
          const obstacles = [target, editor && visibleTourElement(editor) ? editor.getBoundingClientRect() : null].filter((box): box is TourBox => !!box);
          const hits = (box: TourBox) => obstacles.some(o => box.left < o.left + o.width && o.left < box.left + box.width && box.top < o.top + o.height && o.top < box.top + box.height);
          // Centred; else the same line, at whichever end is clear.
          // Centred, else either end of the same line. Chosen once per lesson
          // and kept for its steps, so the card moves between lessons (while
          // it is faded out) and never between the steps of one.
          const spots = [at(area.left + (area.width - width) / 2), at(area.left + 12), at(area.left + area.width - width - 12)];
          if (state.dock === undefined || hits(spots[state.dock]!)) { const free = spots.findIndex(box => !hits(box)); state.dock = free < 0 ? undefined : free; }
          const docked = state.dock === undefined ? undefined : spots[state.dock];
          if (docked) {
            state.side = undefined;
            card.current.style.left = `${docked.left}px`;
            card.current.style.top = `${Math.max(viewport.top + 12, docked.top)}px`;
            card.current.style.width = `${docked.width}px`;
          } else {
            // Nowhere clear: a block that grew after it was framed (a lesson
            // opening its sample row) fills the strip. Slide the board left
            // once, so the card stands beside the block instead of on it.
            if (canvas && target && board && !phone && state.room !== String(state.changedAt) && ((state.restSince && now - state.restSince > 250) || now - state.changedAt > 1500)) {
              const need = target.left + target.width + 16 + width + 12 - (area.left + area.width);
              if (need > 0 && target.left - need >= area.left + 12) {
                state.room = String(state.changedAt);
                window.dispatchEvent(new CustomEvent(LEARNING_ROOM_EVENT, { detail: { dx: need } }));
              }
            }
            const placed = placeTourCardWithSide(target, canvas && target ? bounds : viewport, size, state.side);
            state.side = placed.side;
            card.current.style.left = `${placed.box.left}px`;
            card.current.style.top = `${placed.box.top}px`;
            card.current.style.width = `${placed.box.width}px`;
          }
        }
      }

      // At rest: the block has not moved for REST_MS. The canvas's own move
      // is what the card waits out; a lesson whose block never moves (one
      // about the column) settles at once.
      const editorBox = document.querySelector("[data-floating-editor]")?.getBoundingClientRect() ?? null;
      const key = `${boxKey(target)}|${boxKey(editorBox)}|${Math.round(viewport.width)}x${Math.round(viewport.height)}`;
      if (key !== state.lastKey) { state.lastKey = key; state.restSince = now; }
      if (state.phase === "hold" && now - state.changedAt >= HOLD_MS && (now - state.restSince >= REST_MS || now - state.changedAt >= REST_DEADLINE_MS)) {
        state.phase = "shown";
        setPhase("shown");
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Mushie stands beside the thing the lesson is about, not in a column of
  // his own: the card is placed off the highlighted control and moves with
  // it as the canvas pans and zooms. A model/display-mode picker owns the
  // screen until it is dismissed. The tour resumes itself afterwards and
  // never blocks a required app dialog.
  const shown = phase === "shown";
  const lessonCard = <div ref={card} role="region" aria-labelledby="creator-tour-step-title" data-learning="coach" data-onboarding-step={id} data-learning-phase={phase} hidden={modal}
      className={`studio-glass studio-lamp-ring pointer-events-auto fixed z-[80] overflow-y-auto rounded-2xl border p-3 text-foreground motion-safe:transition-[opacity,transform] motion-safe:ease-[cubic-bezier(.2,.8,.2,1)] ${shown ? "opacity-100 translate-y-0 motion-safe:duration-[260ms]" : "opacity-0 translate-y-2 motion-safe:duration-[120ms]"}`}
      style={{ maxHeight: Math.max(64, viewportHeight - 24) }}>
      <div className="flex items-center gap-2.5">
        <img src="/mushie-stand.png" alt="" draggable={false} className={compact ? "h-10 w-8 shrink-0 object-contain" : big ? "h-20 w-16 shrink-0 object-contain" : "h-14 w-11 shrink-0 object-contain"} />
        <button type="button" onClick={() => onCompact(!compact)} className="min-w-0 flex-1 text-left" aria-expanded={!compact} aria-controls="creator-tour-body">
          <span className="block text-[10px] font-medium tracking-wide text-[#f0c674]/85">{eyebrow}</span>
          <span id="creator-tour-step-title" className={big && !compact ? "mt-0.5 block text-base font-semibold leading-snug" : "mt-0.5 block text-sm font-semibold leading-snug"}>{title}</span>
        </button>
        <button type="button" onClick={() => onCompact(!compact)} aria-label={t(compact ? "expand" : "collapse")} className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent">
          <ChevronDown className={`h-4 w-4 ${compact ? "rotate-180" : ""}`} />
        </button>
        <button type="button" onClick={onClose} aria-label={t("pause")} className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
      </div>
      <div id="creator-tour-body" hidden={compact} className="mt-2">{children}</div>
      {footer && !compact && <div className="mt-3 border-t border-white/[0.07] pt-2.5">{footer}</div>}
    </div>;
  return <>
    {createPortal(<div hidden={modal} className="pointer-events-none fixed inset-0 z-[80]">
      {/* The dim is always drawn and only its strength changes, easing
          between steps: switching it on and off flashed the whole screen. */}
      <div ref={halo} style={{ display: "none", borderColor: dim ? "rgba(240,198,116,0.95)" : undefined, boxShadow: dim ? "0 0 0 9999px rgba(5,4,8,0.62), 0 0 22px 6px rgba(240,198,116,0.5)" : "0 0 0 9999px rgba(5,4,8,0), 0 0 22px 6px rgba(240,198,116,0)" }} data-onboarding-highlight className={`studio-lamp-highlight absolute rounded-xl border motion-safe:transition-[opacity,box-shadow] ${shown ? "opacity-100 motion-safe:duration-[320ms]" : "opacity-0 motion-safe:duration-[120ms]"}`} />
    </div>, document.body)}
    {createPortal(lessonCard, document.body)}
  </>;
}
