import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type T = (key: string) => string;

export interface PortraitSource {
  src: string;
  /** The idle loop of a moving portrait, shown in place of the still. */
  video?: string | null;
  name?: string;
}

/** A character's face in the chat is a 32px circle; this opens the whole
 *  picture the author gave them. Goes to document.body for the same reason as
 *  the turn-image lightbox: bubbles sit in transformed or overflow-hidden
 *  boxes where position:fixed is clipped. */
export function PortraitViewer({ portrait, t, onClose }: { portrait: PortraitSource; t: T; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={portrait.name ?? t("portraitView")} onClick={onClose}
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/85 p-4">
      <button type="button" onClick={onClose} aria-label={t("turnImageClose")} className="fixed right-4 top-3 p-2 text-2xl leading-none text-white/90">×</button>
      <figure className="m-0 grid max-w-[min(92vw,640px)] justify-items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {portrait.video
          ? <video src={portrait.video} poster={portrait.src || undefined} autoPlay muted loop playsInline className="max-h-[80vh] w-auto max-w-full rounded-lg" />
          : <img src={portrait.src} alt={portrait.name ?? ""} draggable={false} className="max-h-[80vh] w-auto max-w-full rounded-lg" />}
        {portrait.name && <figcaption className="text-sm font-medium text-white/90">{portrait.name}</figcaption>}
      </figure>
    </div>,
    document.body,
  );
}

/** Open/close state for a viewer, plus the props a clickable face needs. */
export function usePortraitViewer() {
  const [open, setOpen] = useState<PortraitSource | null>(null);
  const faceProps = (portrait: PortraitSource, t: T) => ({
    role: "button" as const,
    tabIndex: 0,
    "aria-label": t("portraitView"),
    title: t("portraitView"),
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); setOpen(portrait); },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(portrait);
    },
  });
  return { open, close: () => setOpen(null), faceProps };
}
