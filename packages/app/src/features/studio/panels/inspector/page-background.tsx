import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { UiBackground, UiDoc } from "@yumina/engine";
import { AssetPicker } from "@/features/editor/asset-picker";
import { getAssetCdnUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";
import { coalesce, ColorField, themeSwatches } from "./style-section";

/**
 * A page's own ground: a colour or a picture behind every part, on the phone
 * and the computer alike, and blurred out to the screen's edges in play.
 *
 * Creators had no way to set it. A night-street title screen took an image
 * part typed to 0/0/375/812, sent to the back and faded by hand, copied onto
 * every page — and on the computer it sat in a corner, because only its phone
 * box had been laid out.
 */
export function PageBackground({ doc, pageId, worldId, onEdit }: {
  doc: UiDoc;
  pageId: string;
  worldId?: string | null;
  onEdit: (next: UiDoc) => void;
}) {
  const { t } = useTranslation("editor");
  const [picking, setPicking] = useState(false);
  const swatches = useMemo(() => themeSwatches(doc), [doc]);
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return null;
  const bg = page.background;
  const kind = bg?.kind ?? "none";

  const setBg = (next: UiBackground | undefined, ids: string[] = [pageId]) =>
    onEdit({
      ...doc,
      pages: doc.pages.map((p) => {
        if (!ids.includes(p.id)) return p;
        if (next) return { ...p, background: next };
        const { background: _drop, ...rest } = p;
        return rest;
      }),
    });

  const ref = bg?.kind === "image" && bg.src.kind === "asset" ? bg.src.ref : "";
  const thumb = ref.startsWith("@asset:") ? getAssetCdnUrl(ref.slice(7)) : ref;
  const others = doc.pages.filter((p) => p.id !== pageId);
  const allSame = others.every((p) => JSON.stringify(p.background ?? null) === JSON.stringify(bg ?? null));
  const tab = "flex-1 rounded-md px-2 py-1 text-[11.5px] transition-colors";

  return (
    <div className="border-b border-border/50 px-3 py-2.5" data-page-background="">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">{t("studio.pageBg.title")}</div>
      <div className="mb-2 flex gap-1 rounded-lg bg-white/[0.04] p-0.5">
        {(["none", "color", "image"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k}
            className={cn(tab, kind === k ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => {
              if (k === kind) return;
              if (k === "none") setBg(undefined);
              else if (k === "color") setBg({ kind: "color", color: "#14161b" });
              else if (worldId) setPicking(true);
            }}
            disabled={k === "image" && !worldId}
            title={k === "image" && !worldId ? t("studio.element.saveFirst") : undefined}>
            {t(`studio.pageBg.${k}` as never)}
          </button>
        ))}
      </div>

      {bg?.kind === "color" && (
        <ColorField value={bg.color} swatches={swatches} editKey="page-bg" label={t("studio.pageBg.color")}
          onChange={(color) => { coalesce("page-bg"); setBg(color ? { kind: "color", color } : undefined); }} />
      )}

      {bg?.kind === "image" && (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => setPicking(true)} disabled={!worldId}
            className="relative h-20 w-full overflow-hidden rounded-md border border-border bg-black/40 text-[11.5px] text-foreground hover:border-foreground/40">
            {thumb && <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ filter: `brightness(${1 - (bg.dim ?? 0)})` }} />}
            <span className="relative rounded bg-black/60 px-2 py-0.5">{t("studio.element.changeImage")}</span>
          </button>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="w-10 shrink-0">{t("studio.pageBg.dim")}</span>
            <input type="range" min={0} max={80} step={5} value={Math.round((bg.dim ?? 0) * 100)}
              aria-label={t("studio.pageBg.dim")}
              onChange={(e) => {
                coalesce("page-bg-dim");
                const dim = Number(e.target.value) / 100;
                const { dim: _old, ...rest } = bg;
                setBg(dim > 0 ? { ...rest, dim } : rest);
              }}
              className="min-w-0 flex-1 accent-[var(--color-primary)]" />
            <span className="w-8 shrink-0 text-right tabular-nums">{Math.round((bg.dim ?? 0) * 100)}%</span>
          </label>
        </div>
      )}

      {bg && others.length > 0 && (
        <button type="button" data-page-bg-all="" disabled={allSame}
          onClick={() => setBg(bg, doc.pages.map((p) => p.id))}
          className="mt-2 w-full rounded-md border border-border px-2 py-1.5 text-[11.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-40">
          {t(allSame ? "studio.pageBg.allSame" : "studio.pageBg.applyAll", { n: others.length + 1 })}
        </button>
      )}

      {picking && worldId && createPortal(
        <AssetPicker worldId={worldId} filterType="image"
          onClose={() => setPicking(false)}
          onSelect={(picked) => {
            setPicking(false);
            const dim = bg?.kind === "image" ? bg.dim : 0.35;
            setBg({ kind: "image", src: { kind: "asset", ref: picked }, fit: "cover", ...(dim ? { dim } : {}) });
          }} />,
        document.body,
      )}
    </div>
  );
}
