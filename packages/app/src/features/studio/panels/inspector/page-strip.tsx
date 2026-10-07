import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { DoorClosed, Home, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W, duplicatePage, elementActions, movePage, removePage, renamePage, setEntryPage } from "@yumina/engine";
import type { UiDoc, UiElement, UiPage } from "@yumina/engine";
import { getAssetCdnUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";

/**
 * The card's pages down the left edge, the way a deck shows its slides.
 *
 * Each page is drawn small from its own parts — words as lines, buttons in
 * the accent, cards and lists as blocks — on the card's own ground, so the
 * strip reads as the card rather than as a column of empty frames. Pages are
 * reordered by dragging, and everything else a page can have done to it is on
 * its right-click menu: open on it, rename, copy, delete. Folded, the strip
 * is a narrow column of page numbers.
 */

type Box = { x: number; y: number; w: number; h: number };

function boxOf(el: UiElement, wide: boolean): Box | null {
  if (wide) return el.desktop === null ? null : (el.desktop ?? { x: el.x, y: el.y, w: el.w, h: el.h });
  return el.w > 0 && el.h > 0 ? { x: el.x, y: el.y, w: el.w, h: el.h } : null;
}

const TEXT = "var(--yc-text, #e8e2d2)";
const ACCENT = "var(--yc-send-bg, #d9a13f)";
const SURFACE = "color-mix(in srgb, var(--yc-text, #e8e2d2) 12%, transparent)";
/** The page's own colour; a gradient `--yc-bg` would not fill an SVG rect. */
const GROUND = "var(--yc-bg-solid, var(--yc-bg, #15171d))";

/**
 * A page a player can walk into and not out of: nothing on it goes to another
 * page, it has no chat to play in, and it does not leave on its own. A part
 * the editor cannot see into (custom code) may lead anywhere, so it counts as
 * a way out.
 */
export function isDeadEnd(doc: UiDoc, page: UiPage): boolean {
  if (doc.pages.length < 2 || page.leaveWhen) return false;
  if (doc.surface === "chat" && page.elements.length === 0) return false;
  return !page.elements.some((el) =>
    el.type === "chat" || el.type === "messages" || el.type === "composer" || el.type === "custom"
    || elementActions(el).some((a) => a.kind === "go-page" && a.pageId !== page.id && doc.pages.some((q) => q.id === a.pageId)));
}

/** The words a thumbnail spells out: the page's biggest line —
 *  its title — which is what tells one page from the next. */
function headlineIds(parts: Array<{ el: UiElement }>): Set<string> {
  const texts = parts
    .filter((p) => p.el.type === "text" && p.el.text.template.trim())
    .map((p) => p.el as Extract<UiElement, { type: "text" }>)
    .sort((a, b) => (b.style?.desktopSize ?? b.style?.size ?? 16) - (a.style?.desktopSize ?? a.style?.size ?? 16));
  return new Set(texts.slice(0, 1).map((el) => el.id));
}

/** One part as a few strokes. */
function Mark({ el, box, spell, minSize, pageW }: { el: UiElement; box: Box; spell: boolean; minSize: number; pageW: number }) {
  const faded = el.visibleWhen ? 0.45 : 1;
  const r = (fill: string, extra: Partial<Box> = {}, radius = 6, opacity = 1) => (
    <rect x={box.x + (extra.x ?? 0)} y={box.y + (extra.y ?? 0)} width={extra.w ?? box.w} height={extra.h ?? box.h}
      rx={radius} style={{ fill, opacity: opacity * faded }} />
  );
  switch (el.type) {
    case "text": {
      if (spell) {
        // Drawn big enough to read at thumbnail size, centred on where the
        // words sit, and cut at the page's edge.
        const size = Math.max(el.style?.desktopSize ?? el.style?.size ?? 16, minSize);
        const words = el.text.template.replace(/\{\{[^}]*\}\}/g, "…").replace(/\s+/g, " ").trim();
        const align = el.style?.align ?? "left";
        const x = align === "center" ? box.x + box.w / 2 : align === "right" ? box.x + box.w : box.x;
        const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
        return (
          <text x={Math.min(pageW, Math.max(0, x))} y={box.y + Math.min(box.h, size) / 2} dominantBaseline="central" textAnchor={anchor}
            style={{ fill: el.style?.color ?? TEXT, fontSize: size, fontWeight: 700, opacity: faded }}>
            {words.length > 10 ? `${words.slice(0, 9)}…` : words}
          </text>
        );
      }
      const size = Math.min(box.h, Math.max(8, (el.style?.desktopSize ?? el.style?.size ?? 16)));
      const len = Math.max(2, el.text.template.replace(/\{\{[^}]*\}\}/g, "xxxx").length);
      const w = Math.min(box.w, len * size * 0.8);
      return r(TEXT, { h: size * 0.7, w, y: Math.max(0, (Math.min(box.h, size * 1.4) - size * 0.7) / 2) }, size / 3, 0.75);
    }
    case "button":
      return r(ACCENT, {}, Math.min(box.h / 2, 24), 0.9);
    case "meter":
      return r(ACCENT, { h: Math.max(4, box.h) }, 4, 0.8);
    case "image":
      return r("color-mix(in srgb, var(--yc-text, #e8e2d2) 18%, transparent)", {}, 8);
    case "box": {
      const fill = el.style?.fills?.find((f) => f.kind === "color");
      return r(fill && fill.kind === "color" ? fill.color : SURFACE, {}, 10, 0.9);
    }
    case "composer":
      return r("var(--yc-input-bg, rgba(255,255,255,0.08))", {}, 14);
    case "messages":
    case "chat":
      return (
        <g style={{ opacity: 0.5 * faded }}>
          {[0.1, 0.3, 0.5].map((f, i) => (
            <rect key={i} x={box.x + box.w * (i === 1 ? 0.35 : 0.04)} y={box.y + box.h * f} width={box.w * 0.6} height={Math.max(10, box.h * 0.1)} rx={8} style={{ fill: SURFACE }} />
          ))}
        </g>
      );
    case "popup":
      return null;
    default:
      return r(SURFACE, {}, 10);
  }
}

/** A page, small. The theme's tokens are set as CSS variables on the frame so
 *  every stroke paints in the card's own colours. */
export function PageThumb({ doc, page, wide }: { doc: UiDoc | undefined; page: UiPage; wide: boolean }) {
  const w = wide ? UI_DESKTOP_W : UI_CANVAS_W;
  const h = wide ? (page.desktopHeight ?? UI_DESKTOP_H) : page.height;
  const vars = (doc?.theme?.tokens ?? {}) as CSSProperties;
  const ground = page.background?.kind === "color" && !page.background.color.includes("gradient") ? page.background.color : GROUND;
  const bg = page.background;
  const ref = bg?.kind === "image" && bg.src.kind === "asset" ? bg.src.ref : "";
  const picture = ref.startsWith("@asset:") ? getAssetCdnUrl(ref.slice(7)) : ref;
  const dim = bg?.kind === "image" ? bg.dim ?? 0 : 0;
  const parts = [...page.elements]
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    .map((el) => ({ el, box: boxOf(el, wide) }))
    .filter((p): p is { el: UiElement; box: Box } => p.box !== null);
  const spelled = headlineIds(parts);
  // About 11px on a tile ~108px wide.
  const minSize = (w / 108) * 11;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice" className="h-full w-full" style={vars} aria-hidden>
      <rect x={0} y={0} width={w} height={h} style={{ fill: ground }} />
      {picture && (
        <>
          <image href={picture} x={0} y={0} width={w} height={h} preserveAspectRatio="xMidYMid slice" />
          {dim > 0 && <rect x={0} y={0} width={w} height={h} style={{ fill: `rgba(0,0,0,${dim})` }} />}
        </>
      )}
      {doc?.surface === "chat" && parts.length === 0 && (
        <g style={{ opacity: 0.45 }}>
          <rect x={w * 0.05} y={h * 0.1} width={w * 0.6} height={h * 0.08} rx={10} style={{ fill: SURFACE }} />
          <rect x={w * 0.35} y={h * 0.3} width={w * 0.6} height={h * 0.08} rx={10} style={{ fill: SURFACE }} />
          <rect x={w * 0.05} y={h * 0.85} width={w * 0.9} height={h * 0.08} rx={14} style={{ fill: SURFACE }} />
        </g>
      )}
      {parts.map(({ el, box }) => <Mark key={el.id} el={el} box={box} spell={spelled.has(el.id)} minSize={minSize} pageW={w} />)}
    </svg>
  );
}

const FOLD_KEY = "yumina-page-strip-folded";

/** The creator's own choice, if they made one. */
function readFolded(): boolean | null {
  try { const v = localStorage.getItem(FOLD_KEY); return v === "1" ? true : v === "0" ? false : null; } catch { return null; }
}

/** The ready-made chat screen a card has before it has pages of its own. */
function ChatThumb({ wide }: { wide: boolean }) {
  const w = wide ? UI_DESKTOP_W : UI_CANVAS_W;
  const h = wide ? UI_DESKTOP_H : 844;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice" className="h-full w-full" aria-hidden>
      <rect x={0} y={0} width={w} height={h} style={{ fill: GROUND }} />
      <g style={{ opacity: 0.55 }}>
        <rect x={w * 0.05} y={h * 0.1} width={w * 0.62} height={h * 0.07} rx={12} style={{ fill: SURFACE }} />
        <rect x={w * 0.05} y={h * 0.21} width={w * 0.45} height={h * 0.07} rx={12} style={{ fill: SURFACE }} />
        <rect x={w * 0.45} y={h * 0.36} width={w * 0.5} height={h * 0.07} rx={12} style={{ fill: ACCENT, opacity: 0.6 }} />
        <rect x={w * 0.05} y={h * 0.84} width={w * 0.9} height={h * 0.09} rx={18} style={{ fill: SURFACE }} />
      </g>
    </svg>
  );
}

export function PageStrip({
  doc, currentPageId, onPage, onNew, onEdit, wide = true,
}: {
  doc: UiDoc | undefined;
  currentPageId: string | null;
  onPage: (pageId: string) => void;
  onNew: () => void;
  /** Writes the changed document (reorder, rename, copy, delete). */
  onEdit: (next: UiDoc) => void;
  /** Draw the page tiles the shape of the canvas being edited. */
  wide?: boolean;
}) {
  const { t } = useTranslation("editor");
  const pages = doc?.pages ?? [];
  // Most cards have one page: the strip stays folded until there are two,
  // unless the creator opened or folded it themselves.
  const [foldPref, setFoldPref] = useState(readFolded);
  const folded = foldPref ?? pages.length < 2;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ pageId: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ pageId: string; value: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(null); } };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("mousedown", close, true); window.removeEventListener("keydown", esc, true); };
  }, [menu]);

  const fold = (next: boolean) => {
    setFoldPref(next);
    try { localStorage.setItem(FOLD_KEY, next ? "1" : "0"); } catch { /* the choice just isn't remembered */ }
  };
  const nameOf = (p: UiPage, i: number) => p.name || String(t("studio.element.pageN", { n: i + 1 }));
  const commitRename = () => {
    if (doc && renaming && renaming.value.trim()) onEdit(renamePage(doc, renaming.pageId, renaming.value.trim()));
    setRenaming(null);
  };
  const act = (kind: "entry" | "rename" | "copy" | "remove") => {
    if (!doc || !menu) return;
    const i = pages.findIndex((p) => p.id === menu.pageId);
    const p = pages[i];
    setMenu(null);
    if (!p) return;
    if (kind === "entry") onEdit(setEntryPage(doc, p.id));
    if (kind === "rename") setRenaming({ pageId: p.id, value: nameOf(p, i) });
    if (kind === "copy") {
      const id = `page-${crypto.randomUUID().slice(0, 8)}`;
      onEdit(duplicatePage(doc, p.id, { id, name: String(t("studio.pageTemplates.strip.copyName", { name: nameOf(p, i) })) }));
      onPage(id);
    }
    if (kind === "remove" && pages.length > 1) {
      const next = removePage(doc, p.id);
      onEdit(next);
      if (p.id === currentPageId) onPage(next.entryPageId);
    }
  };
  const drop = (i: number) => {
    if (doc && dragId) {
      const from = pages.findIndex((p) => p.id === dragId);
      // Dropped on the line below itself or above the next one: no move.
      const to = from < i ? i - 1 : i;
      if (from !== -1 && to !== from) onEdit(movePage(doc, dragId, to));
    }
    setDragId(null); setDropAt(null);
  };
  const shape = wide ? "aspect-[16/10]" : "aspect-[10/16]";
  const count = Math.max(1, pages.length);

  if (folded) {
    return (
      <nav aria-label={t("studio.pageTemplates.pages")} data-testid="page-strip" data-folded=""
        className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-border/50 bg-muted/20 py-2.5">
        <button type="button" data-testid="page-strip-unfold" onClick={() => fold(false)}
          title={t("studio.pageTemplates.strip.unfold")} aria-label={t("studio.pageTemplates.strip.unfold")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <span className="my-0.5 h-px w-5 bg-border/70" />
        <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto">
          {(pages.length ? pages : [null]).map((p, i) => {
            const active = p ? p.id === currentPageId : true;
            return (
              <button key={p?.id ?? "chat"} type="button" data-strip-page={p?.id}
                onClick={() => p && onPage(p.id)}
                title={p ? nameOf(p, i) : t("studio.pageTemplates.strip.chatPage")}
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums transition-colors",
                  active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}>
                {i + 1}
              </button>
            );
          })}
        </div>
        <button type="button" onClick={onNew} data-testid="strip-new-page"
          title={t("studio.pageTemplates.strip.add")} aria-label={t("studio.pageTemplates.strip.add")}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </nav>
    );
  }

  return (
    <nav aria-label={t("studio.pageTemplates.pages")} data-testid="page-strip"
      className="flex w-[184px] shrink-0 flex-col border-r border-border/50 bg-muted/20">
      <header className="flex h-10 shrink-0 items-center gap-1.5 pl-3.5 pr-1.5">
        <span className="text-[12px] font-semibold text-foreground">{t("studio.pageTemplates.pages")}</span>
        <span className="rounded-full bg-foreground/[0.07] px-1.5 text-[10.5px] font-medium tabular-nums text-muted-foreground">{count}</span>
        <span className="flex-1" />
        <button type="button" onClick={onNew} title={t("studio.pageTemplates.strip.add")} aria-label={t("studio.pageTemplates.strip.add")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" data-testid="page-strip-fold" onClick={() => fold(true)}
          title={t("studio.pageTemplates.strip.fold")} aria-label={t("studio.pageTemplates.strip.fold")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </header>

      <ol className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3 pl-1.5 pr-3 pt-1"
        onDragOver={(e) => { if (dragId) { e.preventDefault(); if (e.target === e.currentTarget) setDropAt(pages.length); } }}
        onDrop={(e) => { e.preventDefault(); if (dropAt !== null) drop(dropAt); }}>
        {!pages.length && (
          <li className="flex items-start gap-1.5 py-1.5">
            <span className="w-4 shrink-0 pt-0.5 text-right text-[11px] font-semibold tabular-nums text-foreground">1</span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={cn("relative block w-full overflow-hidden rounded-[5px] shadow-[0_1px_3px_rgba(0,0,0,0.35)] ring-2 ring-primary ring-offset-2 ring-offset-background", shape)}>
                <ChatThumb wide={wide} />
              </span>
              <span className="truncate text-[11px] text-foreground">{t("studio.pageTemplates.strip.chatPage")}</span>
            </span>
          </li>
        )}
        {pages.map((p, i) => {
          const active = p.id === currentPageId;
          const lineAbove = dragId !== null && dropAt === i;
          const lineBelow = dragId !== null && dropAt === pages.length && i === pages.length - 1;
          return (
            <li key={p.id} className="relative py-1.5"
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault(); e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
              }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dropAt !== null) drop(dropAt); }}>
              {/* Where a dragged page will land: a bar between slides, as in a deck. */}
              {lineAbove && <span className="pointer-events-none absolute -top-px left-5 right-0 h-[3px] rounded-full bg-primary" />}
              {lineBelow && <span className="pointer-events-none absolute -bottom-px left-5 right-0 h-[3px] rounded-full bg-primary" />}
              <button type="button" data-strip-page={p.id}
                draggable
                onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = "move"; }}
                onDragEnd={() => { setDragId(null); setDropAt(null); }}
                onClick={() => onPage(p.id)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ pageId: p.id, x: e.clientX, y: e.clientY }); }}
                onDoubleClick={() => setRenaming({ pageId: p.id, value: nameOf(p, i) })}
                title={t("studio.pageTemplates.strip.hint")}
                className={cn("group flex w-full items-start gap-1.5 text-left", dragId === p.id && "opacity-40")}>
                <span className={cn("w-4 shrink-0 pt-0.5 text-right text-[11px] tabular-nums",
                  active ? "font-semibold text-foreground" : "text-muted-foreground")}>{i + 1}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className={cn(
                    "relative block w-full overflow-hidden rounded-[5px] shadow-[0_1px_3px_rgba(0,0,0,0.35)] ring-offset-2 ring-offset-background transition-shadow",
                    shape,
                    active ? "ring-2 ring-primary" : "ring-1 ring-border/60 group-hover:ring-2 group-hover:ring-foreground/25",
                  )}>
                    <PageThumb doc={doc} page={p} wide={wide} />
                    {doc && isDeadEnd(doc, p) && (
                      <span data-dead-end="" className="absolute bottom-1 right-1 flex h-4 items-center gap-0.5 rounded bg-amber-500/90 px-1 text-[9px] font-semibold text-black" title={t("studio.pageTemplates.strip.deadEndHint")}>
                        <DoorClosed className="h-2.5 w-2.5" />{t("studio.pageTemplates.strip.deadEnd")}
                      </span>
                    )}
                  </span>
                  {renaming?.pageId === p.id ? (
                    <input autoFocus value={renaming.value}
                      aria-label={t("studio.element.renamePage")}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ pageId: p.id, value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); } }}
                      onBlur={commitRename}
                      className="w-full rounded border border-primary bg-background px-1 py-0.5 text-[11px] outline-none" />
                  ) : (
                    <span className={cn("flex min-w-0 items-center gap-1 text-[11px]", active ? "text-foreground" : "text-muted-foreground")}>
                      {p.id === doc?.entryPageId && (
                        <Home className="h-3 w-3 shrink-0 text-primary" aria-label={t("studio.element.entryPage")} />
                      )}
                      <span className="truncate">{nameOf(p, i)}</span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        <li className="py-1.5">
          <button type="button" onClick={onNew} data-testid="strip-new-page"
            className="group flex w-full items-start gap-1.5 text-left">
            <span className="w-4 shrink-0" />
            <span className={cn(
              "flex w-full flex-col items-center justify-center gap-1 rounded-[5px] border border-dashed border-border text-muted-foreground transition-colors group-hover:border-primary/60 group-hover:bg-primary/[0.06] group-hover:text-primary",
              shape,
            )}>
              <Plus className="h-4 w-4" />
              <span className="text-[11px]">{t("studio.pageTemplates.strip.add")}</span>
            </span>
          </button>
        </li>
      </ol>

      {menu && createPortal(
        <div ref={menuRef} role="menu" data-testid="page-strip-menu"
          className="fixed z-[210] min-w-[140px] overflow-hidden rounded-lg border border-border bg-card py-1 text-[12px] shadow-2xl"
          style={{ left: menu.x, top: menu.y }}>
          {menu.pageId !== doc?.entryPageId && (
            <button type="button" role="menuitem" onClick={() => act("entry")} className="block w-full px-3 py-1.5 text-left hover:bg-accent">{t("studio.element.setEntry")}</button>
          )}
          <button type="button" role="menuitem" onClick={() => act("rename")} className="block w-full px-3 py-1.5 text-left hover:bg-accent">{t("studio.element.renamePage")}</button>
          <button type="button" role="menuitem" onClick={() => act("copy")} className="block w-full px-3 py-1.5 text-left hover:bg-accent">{t("studio.pageTemplates.strip.copy")}</button>
          <button type="button" role="menuitem" disabled={pages.length <= 1} onClick={() => act("remove")}
            className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-destructive/10 disabled:opacity-40">{t("studio.element.removePage")}</button>
        </div>,
        document.body,
      )}
    </nav>
  );
}
