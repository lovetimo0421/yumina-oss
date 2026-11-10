import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter,
  AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowDownToLine, ArrowUpToLine,
  ChevronDown, ChevronUp, Eye, EyeOff,
} from "lucide-react";
import {
  alignElements, distributeElements, paintOrder, reorderElements, unitsOf, UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W,
} from "@yumina/engine";
import type { UiAlignMode, UiBox, UiDoc, UiElement, UiZOrderOp } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { IGNORE_ATTR } from "./hit-test";
import { partKindKeys } from "./parts";
import type { Rect } from "./use-inspector";
import { textStyleOf } from "./style-section";
import { offCanvasCount, presenceBadgeKey } from "./selection-units";
import { templateFromDisplay, templateToDisplay, type NamedVariable } from "./template-names";

/**
 * The slide-editor half of the canvas: arranging several parts, the clipboard,
 * editing words where they sit, and the list of layers.
 */

/** Parts copied with Ctrl+C. Module state rather than the system clipboard:
 *  a part is a document fragment, and pasting it into a text box elsewhere as
 *  JSON would help nobody. `pastes` offsets each successive paste further. */
export const partClipboard: { items: UiElement[] | null; pastes: number } = { items: null, pastes: 0 };

/** The page as a box on the canvas in view — what a lone part aligns to. */
export function pageBoxOf(doc: UiDoc, pageId: string, canvas: "phone" | "desktop"): UiBox {
  const page = doc.pages.find((p) => p.id === pageId);
  return canvas === "desktop"
    ? { x: 0, y: 0, w: UI_DESKTOP_W, h: page?.desktopHeight ?? UI_DESKTOP_H }
    : { x: 0, y: 0, w: UI_CANVAS_W, h: page?.height ?? 812 };
}

function IconButton({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

const ALIGNS: Array<{ mode: UiAlignMode; icon: typeof AlignStartVertical }> = [
  { mode: "left", icon: AlignStartVertical },
  { mode: "hcenter", icon: AlignCenterVertical },
  { mode: "right", icon: AlignEndVertical },
  { mode: "top", icon: AlignStartHorizontal },
  { mode: "vcenter", icon: AlignCenterHorizontal },
  { mode: "bottom", icon: AlignEndHorizontal },
];

const ORDERS: Array<{ op: UiZOrderOp; icon: typeof ChevronUp; keys: string }> = [
  { op: "front", icon: ArrowUpToLine, keys: "Ctrl+Shift+]" },
  { op: "forward", icon: ChevronUp, keys: "Ctrl+]" },
  { op: "backward", icon: ChevronDown, keys: "Ctrl+[" },
  { op: "back", icon: ArrowDownToLine, keys: "Ctrl+Shift+[" },
];

/** 对齐 · 等距 · 层级, for whatever is picked. One part aligns to the page;
 *  two or more align to each other; three or more can be spaced evenly. */
export function ArrangeBar({ doc, pageId, ids, canvas, onEdit }: {
  doc: UiDoc; pageId: string; ids: string[]; canvas: "phone" | "desktop"; onEdit: (next: UiDoc) => void;
}) {
  const { t } = useTranslation("editor");
  const units = unitsOf(doc, pageId, ids, canvas).length;
  const elsewhere = offCanvasCount(doc.pages.find((p) => p.id === pageId), ids, canvas);
  if (ids.length === 0) return null;
  return (
    <div className="border-b border-border/50 px-3 py-2" data-testid="arrange-bar">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-foreground/80">{t("studio.canvasEdit.arrange")}</span>
        <span className="text-[10px] text-muted-foreground/60">
          {t(units > 1 ? "studio.canvasEdit.alignToEachOther" : "studio.canvasEdit.alignToPage")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-0.5">
        {ALIGNS.map(({ mode, icon: Icon }) => (
          <IconButton key={mode} title={t(`studio.canvasEdit.align.${mode}` as never)}
            disabled={units === 0}
            onClick={() => onEdit(alignElements(doc, pageId, ids, canvas, mode, pageBoxOf(doc, pageId, canvas)))}>
            <Icon className="h-3.5 w-3.5" />
          </IconButton>
        ))}
        <div className="mx-1 h-4 w-px bg-border/60" />
        <IconButton title={t("studio.canvasEdit.distributeH")} disabled={units < 3}
          onClick={() => onEdit(distributeElements(doc, pageId, ids, canvas, "horizontal"))}>
          <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton title={t("studio.canvasEdit.distributeV")} disabled={units < 3}
          onClick={() => onEdit(distributeElements(doc, pageId, ids, canvas, "vertical"))}>
          <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="mt-1 flex items-center gap-0.5">
        <span className="mr-1 w-12 shrink-0 text-[11px] text-muted-foreground">{t("studio.canvasEdit.layer")}</span>
        {ORDERS.map(({ op, icon: Icon, keys }) => (
          <IconButton key={op} title={`${t(`studio.canvasEdit.order.${op}` as never)} (${keys})`}
            onClick={() => onEdit(reorderElements(doc, pageId, ids, op))}>
            <Icon className="h-3.5 w-3.5" />
          </IconButton>
        ))}
      </div>
      {elsewhere > 0 && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80" data-testid="off-canvas-rule">
          {t("studio.canvasEdit.offCanvasRule", { count: elsewhere })}
        </p>
      )}
    </div>
  );
}

/** What a layers row calls a part: its name, else its words (variables by
 *  name), else what it shows — so four meters read 好感度 / 体力 / …, not
 *  four rows of "状态条". */
function layerLabel(el: UiElement, kind: string, members: UiElement[], names: Map<string, string>): string {
  if (el.name?.trim()) return el.name.trim();
  const named = (template: string | undefined) => (template ?? "")
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, id: string) => names.get(id) ?? "…")
    .replace(/\s+/g, " ").trim();
  const meter = members.find((m) => m.type === "meter");
  if (meter) {
    const label = members.find((m) => m.type === "text" && !/\{\{/.test(m.text?.template ?? ""));
    const shown = label?.type === "text" ? label.text.template.trim()
      : meter.type === "meter" && meter.value.kind === "variable" ? names.get(meter.value.variableId) ?? "" : "";
    return shown ? `${kind} · ${shown.slice(0, 18)}` : kind;
  }
  const words = el.type === "text" ? el.text?.template : el.type === "button" ? el.label?.template : "";
  const clean = named(words);
  return clean ? `${kind} · ${clean.slice(0, 18)}` : kind;
}

/** The parts on this page, top of the stack first. A row selects its part; the
 *  eye hides it in the editor only, to get at what is underneath. */
export function LayersList({ doc, pageId, selectedIds, hiddenIds, onSelect, onToggleHidden }: {
  doc: UiDoc; pageId: string; selectedIds: string[]; hiddenIds: string[];
  onSelect: (id: string, additive: boolean) => void; onToggleHidden: (id: string) => void;
}) {
  const { t } = useTranslation("editor");
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const names = useMemo(() => new Map(variables.map((v) => [v.id, v.name])), [variables]);
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return null;
  // One row per group: a meter is one layer, not three.
  const seen = new Set<string>();
  const rows: UiElement[] = [];
  for (const el of [...paintOrder(page)].reverse()) {
    const key = el.group ? `g:${el.group}` : el.id;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(el);
  }
  return (
    <div className="border-b border-border/50 px-3 py-2.5" data-testid="layers-list">
      <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">{t("studio.canvasEdit.layers")}</div>
      <div className="flex max-h-72 flex-col gap-px overflow-y-auto">
        {rows.map((el) => {
          const members = el.group ? page.elements.filter((e) => e.group === el.group).map((e) => e.id) : [el.id];
          const picked = members.some((id) => selectedIds.includes(id));
          const hidden = members.every((id) => hiddenIds.includes(id));
          // Parts the canvas in view does not draw are still listed — this is
          // the only place to reach them — with where they DO live.
          const memberEls = page.elements.filter((e) => members.includes(e.id));
          const badge = el.type === "popup" ? "studio.canvasEdit.popupBadge" : presenceBadgeKey(memberEls);
          return (
            <div key={el.id} className={cn("group flex items-center gap-1 rounded-md pl-2 pr-0.5", picked ? "bg-primary/15 text-foreground" : "hover:bg-accent/60")}>
              <button type="button" onClick={(e) => onSelect(el.id, e.shiftKey || e.ctrlKey || e.metaKey)}
                className={cn("min-w-0 flex-1 truncate py-1 text-left text-[11px]", hidden && "text-muted-foreground/50 line-through")}>
                {layerLabel(el, t(partKindKeys(memberEls.find((m) => m.type === "meter")?.type ?? el.type) as never), memberEls, names)}
              </button>
              {badge && (
                <span data-layer-badge="" className="shrink-0 rounded bg-accent px-1 py-px text-[9px] text-muted-foreground">
                  {t(badge as never)}
                </span>
              )}
              <button type="button" onClick={() => members.forEach((id) => { if (hiddenIds.includes(id) === hidden) onToggleHidden(id); })}
                title={t(hidden ? "studio.canvasEdit.showInEditor" : "studio.canvasEdit.hideInEditor")}
                aria-label={t(hidden ? "studio.canvasEdit.showInEditor" : "studio.canvasEdit.hideInEditor")}
                className={cn("rounded p-1 text-muted-foreground hover:text-foreground", !hidden && "opacity-0 group-hover:opacity-100")}>
                {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Editing a part's words where they sit on the canvas.
 *
 * The part's own text is made transparent underneath and an editable layer is
 * laid over it at the same place, size and type — so it reads as typing into
 * the card rather than into a box floating over it. Enter keeps the edit
 * (Shift+Enter is a new line in a text part), Escape throws it away, and
 * clicking elsewhere keeps it.
 */
export function InlineTextEditor({ el, node, rect, scale, variables, onCommit, onCancel }: {
  el: UiElement;
  /** The compiled part in the preview, to hide its own words while editing. */
  node: HTMLElement | null;
  rect: Rect;
  /** Screen px per design px. */
  scale: number;
  variables: NamedVariable[];
  onCommit: (template: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const done = useRef(false);
  const template = el.type === "text" ? el.text?.template ?? "" : el.type === "button" ? el.label?.template ?? "" : "";
  const style = textStyleOf(el) ?? {};
  const isButton = el.type === "button";
  const size = (style.size ?? (isButton ? 13 : 14)) * scale;
  // What the part actually draws with, read before its words are hidden: a
  // theme colour is a var() that only resolves inside the card, and a card
  // font is registered under a scoped name.
  const [look] = useState(() => {
    if (!node) return null;
    const cs = getComputedStyle(node);
    const px = (v: string) => (v.endsWith("px") ? Number.parseFloat(v) : NaN);
    return {
      color: cs.color, family: cs.fontFamily, weight: cs.fontWeight,
      size: px(cs.fontSize), lineHeight: px(cs.lineHeight), letterSpacing: px(cs.letterSpacing),
    };
  });

  useLayoutEffect(() => {
    const div = ref.current;
    if (!div) return;
    div.innerText = templateToDisplay(template, variables);
    div.focus();
    const range = document.createRange();
    range.selectNodeContents(div);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // Once, on open: the text it started from is the text it edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!node) return;
    const prev = { color: node.style.color, shadow: node.style.textShadow, stroke: node.style.getPropertyValue("-webkit-text-stroke-color") };
    node.style.setProperty("color", "transparent", "important");
    node.style.setProperty("text-shadow", "none", "important");
    node.style.setProperty("-webkit-text-stroke-color", "transparent", "important");
    // Descendants that set their own colour (a button's label span).
    const kids = Array.from(node.querySelectorAll<HTMLElement>("*"));
    const saved = kids.map((k) => k.style.color);
    kids.forEach((k) => k.style.setProperty("color", "transparent", "important"));
    return () => {
      node.style.color = prev.color;
      node.style.textShadow = prev.shadow;
      node.style.removeProperty("-webkit-text-stroke-color");
      if (prev.stroke) node.style.setProperty("-webkit-text-stroke-color", prev.stroke);
      kids.forEach((k, i) => { k.style.removeProperty("color"); if (saved[i]) k.style.color = saved[i]!; });
    };
  }, [node]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const text = (ref.current?.innerText ?? "").replace(/\n$/, "");
    const next = templateFromDisplay(isButton ? text.replace(/\n+/g, " ") : text, variables);
    if (next !== template) onCommit(next);
    else onCancel();
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  // A click on the stage around it does not blur it — the stage takes the
  // mousedown to select — it deselects, and the editor closed with the typing
  // thrown away. Closing for any reason keeps what was typed, as a slide
  // editor does; only Escape discards. (Unchanged text does nothing, so a
  // development double-mount does not close it.)
  const latest = useRef({ onCommit, variables, template, isButton });
  latest.current = { onCommit, variables, template, isButton };
  const typed = useRef<string | null>(null);
  useLayoutEffect(() => () => {
    const raw = ref.current?.innerText ?? typed.current;
    if (done.current || raw == null) return;
    const l = latest.current;
    const text = raw.replace(/\n$/, "");
    const next = templateFromDisplay(l.isButton ? text.replace(/\n+/g, " ") : text, l.variables);
    if (next === l.template) return;
    done.current = true;
    l.onCommit(next);
  }, []);

  const align = style.align ?? (isButton ? "center" : "left");
  return (
    <div
      {...{ [IGNORE_ATTR]: "" }}
      className="pointer-events-auto absolute z-20 flex outline outline-2 outline-offset-2 outline-primary"
      style={{
        ...rect,
        alignItems: isButton ? "center" : "flex-start",
        justifyContent: align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start",
        padding: isButton ? `0 ${8 * scale}px` : 0,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        ref={ref}
        role="textbox"
        aria-multiline={!isButton}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={commit}
        onInput={(e) => { typed.current = e.currentTarget.innerText; }}
        onPaste={(e) => {
          e.preventDefault();
          const plain = e.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, plain);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
          if (e.key === "Enter" && (isButton || !e.shiftKey) && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); }
        }}
        className="min-w-[1ch] max-w-full cursor-text whitespace-pre-wrap break-words outline-none"
        style={{
          fontSize: look && look.size > 0 ? look.size * scale : size,
          fontFamily: look?.family ?? style.family,
          fontWeight: look?.weight ?? style.weight ?? (isButton ? 600 : undefined),
          fontStyle: style.italic ? "italic" : undefined,
          lineHeight: look && look.lineHeight > 0 ? `${look.lineHeight * scale}px` : style.lineHeight ?? (isButton ? 1.2 : 1.4),
          letterSpacing: look && Number.isFinite(look.letterSpacing) ? look.letterSpacing * scale : style.letterSpacing ? style.letterSpacing * scale : undefined,
          color: look?.color ?? (style.color && !style.color.startsWith("var(") ? style.color : "#fff"),
          textAlign: align,
          caretColor: "#8d7cf0",
          width: isButton ? undefined : "100%",
          textShadow: "0 1px 2px rgba(0,0,0,0.35)",
        }}
      />
    </div>
  );
}
