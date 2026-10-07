import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Minus, Plus, SlidersHorizontal } from "lucide-react";
import { updateElements, type UiDoc, type UiElement } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { BAR_H, placeBar, type Box } from "./bar-place";
import { applyTextPatch, coalesce, ColorField, textStyleOf, themeSwatches } from "./style-section";

const SIZE_STEPS = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 84, 96];

/**
 * The few things a creator changes most, over the part itself — as a slide
 * editor's toolbar changes with what is selected — so the eyes stay on the
 * page. The panel keeps everything else. Same edits as the panel's
 * (applyTextPatch), so a box refits to its words here too.
 */
export function FloatingTextBar({ doc, lead, pageId, canvas, rect, onDoc, onMore, others = [], stage = { width: Infinity, height: Infinity }, room, anchor }: {
  doc: UiDoc;
  lead: UiElement;
  pageId: string;
  canvas: "phone" | "desktop";
  /** The part on the stage, in stage px. */
  rect: { top: number; left: number; width: number; height: number };
  onDoc: (next: UiDoc) => void;
  /** Opens the full panel; absent while it is already open. */
  onMore?: () => void;
  /** Other parts on the stage, in stage px — the bar keeps off them. */
  others?: Box[];
  /** The page itself, in stage px (it can be narrower than the stage). */
  stage?: { width: number; height: number; top?: number; left?: number };
  /** Space beside the page inside the scroller, where the bar can stand. */
  room?: { left: number; right: number };
  /** The whole part the bar belongs to, when it is more than `rect`. */
  anchor?: Box;
}) {
  const { t } = useTranslation("editor");
  const swatches = useMemo(() => themeSwatches(doc), [doc]);
  const style = textStyleOf(lead);
  if (!style || (lead.type !== "text" && lead.type !== "button")) return null;
  const size = (canvas === "desktop" ? style.desktopSize ?? style.size : style.size) ?? (lead.type === "button" ? 13 : 14);
  const bold = (style.weight ?? (lead.type === "button" ? 600 : 400)) >= 600;
  const color = lead.type === "button" ? (lead.style as { textColor?: string } | undefined)?.textColor : style.color;

  const patch = (p: Parameters<typeof applyTextPatch>[0]["patch"], key: string) => {
    coalesce(key);
    applyTextPatch({
      doc, targets: [lead], lead, patch: p, onDoc,
      onPatch: (fn) => onDoc(updateElements(doc, pageId, [lead.id], fn)),
    });
  };
  const sizeKey = canvas === "desktop" ? "desktopSize" : "size";
  const stepSize = (dir: 1 | -1) => {
    const next = dir > 0 ? SIZE_STEPS.find((s) => s > size) : [...SIZE_STEPS].reverse().find((s) => s < size);
    if (next) patch({ [sizeKey]: next }, `bar-size-${canvas}`);
  };

  const near = anchor ?? rect;
  const place = placeBar({ ...near, left: rect.left }, others, stage, lead.type === "text" ? 330 : 240, room);
  const v = place.vertical;
  const btn = "flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white";
  const sep = v ? "my-1 h-px w-4 bg-white/10" : "mx-1 h-4 w-px bg-white/10";
  const on = "bg-white/15 text-white";
  return (
    <div
      data-floating-text-bar=""
      // The stage reads clicks as picks; these are not.
      data-inspector-overlay=""
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      data-bar-vertical={v ? "" : undefined}
      className={cn("pointer-events-auto absolute z-40 flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#17181c]/95 shadow-2xl backdrop-blur",
        v ? "flex-col px-1 py-1" : "px-1")}
      style={v ? { top: place.top, left: place.left, width: 40 } : { top: place.top, left: place.left, height: BAR_H }}
    >
      <button type="button" className={btn} title={t("studio.floatBar.smaller")} aria-label={t("studio.floatBar.smaller")} onClick={() => stepSize(-1)}><Minus className="h-3.5 w-3.5" /></button>
      <span className="w-8 text-center text-[12px] tabular-nums text-zinc-200">{size}</span>
      <button type="button" className={btn} title={t("studio.floatBar.bigger")} aria-label={t("studio.floatBar.bigger")} onClick={() => stepSize(1)}><Plus className="h-3.5 w-3.5" /></button>
      <span className={sep} />
      <button type="button" className={cn(btn, bold && on)} aria-pressed={bold} title={t("studio.floatBar.bold")} aria-label={t("studio.floatBar.bold")}
        onClick={() => patch({ weight: bold ? 400 : 700 }, "bar-weight")}><Bold className="h-3.5 w-3.5" /></button>
      {lead.type === "text" && (
        <button type="button" className={cn(btn, style.italic && on)} aria-pressed={!!style.italic} title={t("studio.floatBar.italic")} aria-label={t("studio.floatBar.italic")}
          onClick={() => patch({ italic: !style.italic }, "bar-italic")}><Italic className="h-3.5 w-3.5" /></button>
      )}
      <span className={sep} />
      <div className={cn("flex h-7 items-center [&_button]:h-6 [&_button]:min-w-0", v && "[&_button>span+span]:hidden [&_button>svg]:hidden [&_button]:px-1")} title={t("studio.floatBar.color")}>
        <ColorField value={color} swatches={swatches} editKey="bar-color" label={t("studio.floatBar.color")}
          onChange={(c) => patch({ color: c }, "bar-color")} />
      </div>
      {lead.type === "text" && (
        <>
          <span className={sep} />
          {(["left", "center", "right"] as const).map((a) => {
            const Icon = a === "left" ? AlignLeft : a === "center" ? AlignCenter : AlignRight;
            const active = (style.align ?? "left") === a;
            return (
              <button key={a} type="button" className={cn(btn, active && on)} aria-pressed={active}
                title={t(`studio.style.align${a === "left" ? "Left" : a === "center" ? "Center" : "Right"}` as never)}
                onClick={() => { if (!active) patch({ align: a }, "bar-align"); }}><Icon className="h-3.5 w-3.5" /></button>
            );
          })}
        </>
      )}
      {onMore && (
        <>
          <span className={sep} />
          <button type="button" data-floating-more="" className={cn(btn, "gap-1 px-2 text-[11.5px]")} onClick={onMore}>
            <SlidersHorizontal className="h-3.5 w-3.5" />{t("studio.floatBar.more")}
          </button>
        </>
      )}
    </div>
  );
}
