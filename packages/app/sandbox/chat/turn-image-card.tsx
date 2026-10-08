import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SandboxedYuminaAPI } from "../sandbox-context";
import type { SandboxMessage } from "./types";
import type { makeChatT } from "./i18n";
import { resolveSandboxImageSrc } from "./markdown";
import { splitTurnImages } from "./turn-image-embeds";
import { TurnImageDrawingLabel } from "./turn-image-state";
import { useTurnImageSettings } from "./turn-images";

type T = ReturnType<typeof makeChatT>;

const SRC_RE = /\[\s*image:\s*(\/cdn\/key\/[A-Za-z0-9_-]+)/;

/** The picture's address in a `[image:/cdn/key/…|alt=…]` embed. */
export function turnImageSrc(embed: string): string | null {
  const m = SRC_RE.exec(embed);
  return m ? resolveSandboxImageSrc(m[1]!) : null;
}

const Icon = {
  adjust: <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />,
  redraw: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
  fine: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /><path d="M11 8v6" /><path d="M8 11h6" /></>,
  note: <><path d="M12 20h9" /><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z" /></>,
  album: <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>,
};
function Svg({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  );
}

/**
 * A reply's picture. At rest it is only the picture; one small control in its
 * corner (shown on hover, faint but always there on touch screens) opens a
 * menu over the picture: redraw, redraw with a note, the story's album.
 * Tapping the picture shows it large.
 */
export function TurnImageCard({ embed, message, api, t }: { embed: string; message: SandboxMessage; api: SandboxedYuminaAPI; t: T }) {
  const src = turnImageSrc(embed);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [large, setLarge] = useState(false);
  const [album, setAlbum] = useState(false);
  const { settings, refresh } = useTurnImageSettings(api);
  const wrapRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const drawing = message.turnImage?.status === "drawing";

  // Close the menu on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => { if (asking) noteRef.current?.focus(); }, [asking]);

  if (!src) return null;

  const cost = settings?.unlimited ? "" : settings?.freeLeft ? t("turnImageCostFree", { count: settings.freeLeft })
    : settings?.price ? t("turnImageCostPrice", { price: settings.price }) : "";
  const redraw = (withNote?: string, fine = false) => {
    setOpen(false);
    setAsking(false);
    setLarge(false);
    setNote("");
    void api.illustrateMessage(message.id, withNote?.trim() || undefined, fine || undefined);
  };
  const addChip = (chip: string) => setNote((v) => (v.trim() ? `${v.trim()}${t("turnImageNoteJoin")}${chip}` : chip));

  return (
    <div ref={wrapRef} className="group relative my-3 w-full" style={{ maxWidth: "24rem" }}>
      <button type="button" onClick={() => setLarge(true)} aria-label={t("turnImageViewLarge")}
        className="block w-full overflow-hidden rounded-lg border border-border/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <img src={src} alt="" loading="lazy" className={`block h-auto w-full transition ${drawing ? "scale-[1.02] blur-sm brightness-50" : ""}`} />
      </button>
      {drawing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-foreground" role="status" aria-live="polite">
          <TurnImageDrawingLabel t={t} />
        </div>
      )}

      {!drawing && (
        <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={t("turnImageAdjust")}
          onClick={() => { setOpen((o) => !o); setAsking(false); refresh(); }}
          className={`absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full border backdrop-blur-md transition
            ${open ? "border-primary bg-primary text-primary-foreground opacity-100"
              : "border-white/20 bg-black/45 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-80"}`}>
          <Svg>{Icon.adjust}</Svg>
        </button>
      )}

      {open && (
        <div role="menu" className="absolute bottom-12 right-2 z-20 w-64 origin-bottom-right rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl">
          <button type="button" role="menuitem" onClick={() => redraw()}
            className="hover-surface grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm">
            <span className="text-muted-foreground"><Svg>{Icon.redraw}</Svg></span>{t("turnImageRedraw")}
            <span className="text-[11px] text-muted-foreground">{cost}</span>
          </button>
          {settings?.fine && (
            <button type="button" role="menuitem" onClick={() => redraw(undefined, true)}
              className="hover-surface grid w-full grid-cols-[20px_1fr] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm">
              <span className="text-muted-foreground"><Svg>{Icon.fine}</Svg></span>
              <span className="grid leading-tight">{t("turnImageFine")}<span className="text-[11px] text-muted-foreground">{t("turnImageFineHint")}</span></span>
            </button>
          )}
          <button type="button" role="menuitem" aria-expanded={asking} onClick={() => setAsking((a) => !a)}
            className={`hover-surface grid w-full grid-cols-[20px_1fr] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${asking ? "bg-accent" : ""}`}>
            <span className="text-muted-foreground"><Svg>{Icon.note}</Svg></span>{t("turnImageRedrawWithNote")}
          </button>
          {asking && (
            <div className="grid gap-2 px-1.5 pb-2 pt-1">
              <textarea ref={noteRef} value={note} maxLength={200} rows={2} onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && note.trim()) { e.preventDefault(); redraw(note); } }}
                placeholder={t("turnImageNotePlaceholder")}
                className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] leading-snug text-foreground focus:border-primary focus:outline-none" />
              <div className="flex flex-wrap gap-1.5">
                {[t("turnImageChipOutfit"), t("turnImageChipCloser"), t("turnImageChipAngle")].map((chip) => (
                  <button key={chip} type="button" onClick={() => addChip(chip)}
                    className="rounded-full border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:border-primary hover:text-foreground">{chip}</button>
                ))}
              </div>
              <button type="button" disabled={!note.trim()} onClick={() => redraw(note)}
                className="justify-self-end rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40">
                {cost ? `${t("turnImageRedraw")} · ${cost}` : t("turnImageRedraw")}
              </button>
            </div>
          )}
          <div className="mx-1.5 my-1 h-px bg-border" />
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setAlbum(true); }}
            className="hover-surface grid w-full grid-cols-[20px_1fr] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm">
            <span className="text-muted-foreground"><Svg>{Icon.album}</Svg></span>{t("turnImageAlbum")}
          </button>
        </div>
      )}

      {large && <Lightbox src={src} t={t} onClose={() => setLarge(false)} onRedraw={() => redraw()} onNote={() => { setLarge(false); setOpen(true); setAsking(true); }} onAlbum={() => { setLarge(false); setAlbum(true); }} />}
      {album && <Album api={api} t={t} onClose={() => setAlbum(false)} />}
    </div>
  );
}

// Overlays go to document.body: a card's own bubble often sits in a
// transformed or overflow-hidden box, where position:fixed is clipped.
function Lightbox({ src, t, onClose, onRedraw, onNote, onAlbum }: { src: string; t: T; onClose: () => void; onRedraw: () => void; onNote: () => void; onAlbum: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const pill = "rounded-full border border-white/25 px-3 py-1 text-[13px] text-white/90 hover:border-primary hover:text-primary";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("turnImageViewLarge")} onClick={onClose}
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/85 p-4">
      <button type="button" onClick={onClose} aria-label={t("turnImageClose")} className="fixed right-4 top-3 p-2 text-2xl leading-none text-white/90">×</button>
      <figure className="m-0 grid max-w-[min(92vw,520px)] justify-items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt="" className="max-h-[76vh] w-auto max-w-full rounded-lg" />
        <div className="flex flex-wrap justify-center gap-1.5">
          <button type="button" className={pill} onClick={onRedraw}>{t("turnImageRedraw")}</button>
          <button type="button" className={pill} onClick={onNote}>{t("turnImageRedrawWithNote")}</button>
          <button type="button" className={pill} onClick={onAlbum}>{t("turnImageAlbum")}</button>
        </div>
      </figure>
    </div>,
    document.body,
  );
}

/** Every picture drawn in this story so far, newest first. */
function Album({ api, t, onClose }: { api: SandboxedYuminaAPI; t: T; onClose: () => void }) {
  const messages = api.messages as unknown as SandboxMessage[];
  const pictures = useMemo(() => messages.flatMap((m) => (m.role === "assistant" ? splitTurnImages(m.content ?? "").embeds : []))
    .map(turnImageSrc).filter((s): s is string => !!s).reverse(), [messages]);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") (shown ? setShown(null) : onClose()); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose, shown]);
  return createPortal(
    <div className="fixed inset-0 z-[1000]" onClick={onClose}>
      <aside aria-label={t("turnImageAlbumTitle")} onClick={(e) => e.stopPropagation()}
        className="absolute bottom-0 right-0 top-0 grid w-[min(360px,92vw)] grid-rows-[auto_1fr] gap-3 border-l border-border bg-popover p-4 text-popover-foreground shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-base font-medium">{t("turnImageAlbumTitle")} <span className="text-muted-foreground">· {pictures.length}</span></h2>
          <button type="button" onClick={onClose} aria-label={t("turnImageClose")} className="p-1 text-xl leading-none text-muted-foreground">×</button>
        </div>
        {pictures.length ? (
          <div className="grid grid-cols-3 content-start gap-1.5 overflow-auto">
            {pictures.map((p) => (
              <button key={p} type="button" onClick={() => setShown(p)} className="overflow-hidden rounded-md border border-border">
                <img src={p} alt="" loading="lazy" className="block aspect-[832/1216] w-full object-cover" />
              </button>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">{t("turnImageAlbumEmpty")}</p>}
      </aside>
      {shown && (
        <div className="fixed inset-0 grid place-items-center bg-black/85 p-4" onClick={(e) => { e.stopPropagation(); setShown(null); }}>
          <img src={shown} alt="" className="max-h-[86vh] w-auto max-w-full rounded-lg" />
        </div>
      )}
    </div>,
    document.body,
  );
}
