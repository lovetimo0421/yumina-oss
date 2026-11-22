import "./world-gallery.css";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Images, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cardImageUrl } from "@/lib/asset-url";
import { GallerySwap } from "./gallery-swap";

/**
 * A card's screenshot gallery: the stacked thumbnail that sits on the cover
 * (flip in place, click to open) and the full-screen viewer. Shared by the
 * Discover preview and the Library detail so both show the same pictures the
 * same way.
 */

export interface WorldGalleryLabels {
  /** "Open gallery (n images)". */
  open: string;
  /** Alt text for picture `index` (1-based) of `total`. */
  imageAlt: (index: number, total: number) => string;
  previous: string;
  next: string;
  close: string;
}

/** A screenshot thumbnail: the resized copy first, the original if that fails. */
function GalleryThumb({ src, width, className }: { src: string; width: number; className?: string }) {
  const [attempt, setAttempt] = useState(0);
  if (attempt >= 2) return <span className={`block bg-black/50 ${className ?? ""}`} />;
  return <img alt="" src={(attempt === 0 ? cardImageUrl(src, width) : null) ?? src} loading="lazy" decoding="async"
    onError={() => setAttempt((n) => n + 1)} className={`block object-cover ${className ?? ""}`} />;
}

/** The gallery's entry on the cover: a screenshot at full brightness that
 *  faint arrows flip through in place, two offset frames behind it when there
 *  are more, and the position. Clicking the picture opens the viewer there. */
export function HeroGallery({ images, label, prevLabel, nextLabel, onOpen }: {
  images: string[]; label: string; prevLabel: string; nextLabel: string;
  onOpen: (index: number, el: HTMLButtonElement) => void;
}) {
  const count = images.length;
  const [at, setAt] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const i = Math.min(at, count - 1);
  const step = (d: 1 | -1) => { setDirection(d); setAt((n) => (n + d + count) % count); };
  // Warm the neighbours so a flip shows the picture, not an empty frame.
  useEffect(() => {
    if (count < 2) return;
    for (const n of [i + 1, i - 1 + count]) { const img = new Image(); img.src = cardImageUrl(images[n % count]!, 360) ?? images[n % count]!; }
  }, [i, count, images]);
  const ring = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C9A25E]";
  const arrow = `absolute top-1/2 z-10 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white/85 opacity-60 backdrop-blur-sm transition-opacity hover:bg-black/70 hover:opacity-100 group-hover:opacity-90 focus-visible:opacity-100 ${ring}`;
  return (
    <div className="group relative shrink-0">
      {count > 2 && <span aria-hidden="true" className="absolute inset-0 translate-x-[10px] -translate-y-[10px] rounded-lg border border-white/15 bg-white/[0.06]" />}
      {count > 1 && <span aria-hidden="true" className="absolute inset-0 translate-x-[5px] -translate-y-[5px] rounded-lg border border-white/25 bg-black/40" />}
      <div className="relative overflow-hidden rounded-lg border border-white/40 shadow-[0_8px_22px_rgba(0,0,0,0.6)] transition-colors group-hover:border-[#C9A25E]/80">
        <button type="button" onClick={(e) => onOpen(i, e.currentTarget)} aria-label={`${label} ${i + 1}/${count}`} title={label} className={`block ${ring}`}>
          <GallerySwap index={i} direction={direction} className="aspect-video w-[128px] md:w-[176px]"
            render={(n) => <GalleryThumb key={n} src={images[n]!} width={360} className="h-full w-full" />} />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1 pt-4 text-[11px] font-semibold tabular-nums text-white">
            <Images aria-hidden="true" className="h-3 w-3" />
            {count > 1 ? <span key={i} className="gallery-count-tick inline-block">{`${i + 1}/${count}`}</span> : count}
          </span>
        </button>
        {count > 1 && (
          <>
            <button type="button" aria-label={prevLabel} onClick={() => step(-1)} className={`${arrow} left-1`}><ChevronLeft aria-hidden="true" size={16} /></button>
            <button type="button" aria-label={nextLabel} onClick={() => step(1)} className={`${arrow} right-1`}><ChevronRight aria-hidden="true" size={16} /></button>
          </>
        )}
      </div>
    </div>
  );
}

/** The full-screen viewer. Its own focus-managed layer: Escape closes it first
 *  and focus returns to the cover button that opened it. */
export function GalleryLightbox({ images, index, direction, labels, returnFocusTo, onFlip, onClose }: {
  images: string[];
  /** Open on this picture; null = closed. */
  index: number | null;
  direction: 1 | -1;
  labels: WorldGalleryLabels;
  returnFocusTo?: { current: HTMLElement | null };
  onFlip: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={index !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        hideClose
        className="world-gallery-dialog z-[101] flex h-[min(90dvh,900px)] max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-6xl flex-col gap-3 overflow-hidden border-0 bg-transparent p-0 shadow-none"
        overlayClassName="z-[100]"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusTo?.current?.focus({ preventScroll: true }); }}
        onKeyDown={(event) => {
          if (index === null) return;
          if (event.key === "ArrowLeft") { event.preventDefault(); onFlip(-1); }
          if (event.key === "ArrowRight") { event.preventDefault(); onFlip(1); }
        }}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 px-1 text-white">
          <DialogTitle className="sr-only">{labels.open}</DialogTitle>
          <span aria-live="polite" className="text-sm tabular-nums">{(index ?? 0) + 1} / {images.length}</span>
          <DialogClose aria-label={labels.close} className="grid h-11 w-11 place-items-center rounded-full bg-white/10"><X size={20} /></DialogClose>
        </div>
        {index !== null && (
          <GallerySwap index={index} direction={direction} className="min-h-0 w-full flex-1"
            render={(n) => <img src={images[n]} alt={labels.imageAlt(n + 1, images.length)}
              className="h-full w-full object-contain" />} />
        )}
        <div className="flex shrink-0 justify-center gap-4 pb-1 text-white">
          <button type="button" disabled={index === 0} aria-label={labels.previous}
            onClick={() => onFlip(-1)}
            className="grid h-11 w-11 place-items-center rounded-full bg-white/10 disabled:opacity-25"><ChevronLeft size={22} /></button>
          <button type="button" disabled={index === images.length - 1} aria-label={labels.next}
            onClick={() => onFlip(1)}
            className="grid h-11 w-11 place-items-center rounded-full bg-white/10 disabled:opacity-25"><ChevronRight size={22} /></button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Lightbox position + the step rule both views use (stops at the ends). */
export function useGalleryViewer(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);
  const opener = useRef<HTMLElement | null>(null);
  const flip = (d: 1 | -1) => {
    if (index === null) return;
    const next = Math.min(count - 1, Math.max(0, index + d));
    if (next === index) return;
    setDirection(d);
    setIndex(next);
  };
  const open = (at: number, el: HTMLElement) => { opener.current = el; setIndex(at); };
  return { index, direction, opener, flip, open, close: () => setIndex(null) };
}

/** Cover thumbnail + viewer in one piece, for views that need nothing else. */
export function WorldGallery({ images, labels }: { images: string[]; labels: WorldGalleryLabels }) {
  const viewer = useGalleryViewer(images.length);
  if (images.length === 0) return null;
  return (
    <>
      <HeroGallery images={images} label={labels.open} prevLabel={labels.previous} nextLabel={labels.next} onOpen={viewer.open} />
      <GalleryLightbox images={images} index={viewer.index} direction={viewer.direction} labels={labels}
        returnFocusTo={viewer.opener} onFlip={viewer.flip} onClose={viewer.close} />
    </>
  );
}
