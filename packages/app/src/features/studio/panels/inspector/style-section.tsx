import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isThemeFontValue } from "./font-value";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  AlignCenter, AlignLeft, AlignRight, ChevronDown, Italic, Plus, Upload, X,
} from "lucide-react";
import { UI_THEME_FONTS, UI_WEB_FONTS, fitFontWeight, fitTextOnPage, textStyleAffectsHeight, fontWeightsOf, getUiThemePreset, primaryFamily, webFontOf } from "@yumina/engine";
import type {
  UiBoxStyle, UiButtonStyle, UiDoc, UiElement, UiFill, UiGradientStop, UiShadow, UiTextStyle,
} from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { colorWord } from "./color-words";
import { AssetPicker } from "@/features/editor/asset-picker";

/**
 * 外观 — the style controls a slide editor puts beside the canvas.
 *
 * The document already carried far more style than the panel offered (fills as
 * layers, gradients, per-corner radius, borders, shadows, frosted glass, text
 * shadow and stroke, fonts). This is the panel catching up, in the order a
 * person reaches for things: what it is filled with, its corners and edge, its
 * shadow, how see-through it is, then its words.
 *
 * Every control writes through `onPatch`, which applies to every picked part
 * the control makes sense for — recolouring three buttons at once is one
 * gesture, and a text control simply skips a picked picture.
 */

// ── Undo: one step per gesture, not per frame ─────────────────────────────
//
// A slider or a colour wheel emits a value per pixel of travel. Each of those
// goes through `setUiDoc`, and each would be its own undo step — dragging
// opacity from 100 to 20 would take eighty Ctrl+Z to put back. So continuous
// controls open a batch keyed by what they edit, and the batch closes after a
// short pause or when a different control starts.
let openKey: string | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
function closeCoalesced() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
  if (openKey === null) return;
  openKey = null;
  useEditorStore.getState().commitBatch();
}
export function coalesce(key: string) {
  if (openKey !== key) {
    closeCoalesced();
    useEditorStore.getState().beginBatch();
    openKey = key;
  }
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(closeCoalesced, 450);
}
// Undo pressed mid-gesture must see the gesture as a step.
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z" || e.key === "y")) closeCoalesced();
  }, true);
}

// ── Colour ────────────────────────────────────────────────────────────────

interface Rgba { r: number; g: number; b: number; a: number }

export function parseColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  let v = value.trim();
  // A theme token reads as its fallback: `var(--yc-text, #f4f1ea)`.
  const token = /^var\(\s*--[\w-]+\s*,\s*(.+)\)$/.exec(v);
  if (token) v = token[1]!.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 100) / 100 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Math.max(0, Math.min(1, a)) };
  }
  return null;
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
export function formatColor({ r, g, b, a }: Rgba): string {
  return a >= 1 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 100) / 100})`;
}
const opaqueHex = (c: Rgba) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

const PALETTE = [
  "#ffffff", "#e8e6ef", "#a9a5b8", "#5f5b6e", "#2a2733", "#111015",
  "#f28b82", "#e05c6e", "#e5893f", "#f2c14e", "#5bb974", "#3fb8af",
  "#4c8fd0", "#6f7de0", "#8d6fd1", "#d06fa8", "#b5835a", "#7a5c3e",
];

const RECENT_KEY = "yumina.studio.recentColors";
function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((c) => typeof c === "string").slice(0, 8) : [];
  } catch { return []; }
}
function pushRecent(color: string) {
  try {
    const list = [color, ...readRecent().filter((c) => c !== color)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* private mode: recent colours are a convenience */ }
}

/** The card's own colours: the theme's accents and colour tokens, then the
 *  colours its parts already use — so a new part can match the rest in one
 *  click, the way a slide deck offers "document colours". */
export function themeSwatches(doc: UiDoc): string[] {
  const out: string[] = [];
  const preset = getUiThemePreset(doc.theme?.preset?.id ?? "");
  for (const a of preset?.accents ?? []) out.push(a);
  for (const value of Object.values(doc.theme?.tokens ?? {})) {
    if (parseColor(value) && !value.startsWith("var(")) out.push(value);
  }
  const seen = new Set<string>();
  const visit = (v: unknown, key?: string) => {
    if (typeof v === "string") {
      if (key && /color|textColor/i.test(key) && !v.startsWith("var(")) {
        const c = parseColor(v);
        if (c && c.a > 0.2) seen.add(formatColor(c));
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => visit(x, key)); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  for (const page of doc.pages ?? []) for (const el of page.elements ?? []) visit((el as { style?: unknown }).style);
  return [...new Set([...out, ...seen])].slice(0, 16);
}

/** A little anchored panel, portalled so the side panel's scroll does not clip
 *  it. Closes on a press outside it and on Escape. */
function Popover({ anchor, onClose, children, width = 232 }: {
  anchor: HTMLElement | null; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 300;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    setPos({ top, left });
  }, [anchor, width]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={ref}
      data-style-popover=""
      className="fixed z-[200] rounded-xl border border-white/10 bg-[#1b1824] p-2.5 text-foreground shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
      style={{ width, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}

const checker = "repeating-conic-gradient(#555 0% 25%, #888 0% 50%) 50% / 8px 8px";

function Chip({ color, size = 20, active, title, onPick }: { color: string; size?: number; active?: boolean; title?: string; onPick: () => void }) {
  return (
    <button
      type="button"
      title={title ?? color}
      aria-label={title ?? color}
      onClick={onPick}
      className={cn("shrink-0 rounded-md border transition-transform hover:scale-110", active ? "border-primary ring-2 ring-primary/40" : "border-white/15")}
      style={{ width: size, height: size, background: `linear-gradient(${color}, ${color}), ${checker}` }}
    />
  );
}

/** A colour control: the chip shows what it is, a press opens the choices. */
export function ColorField({
  value, onChange, swatches, allowNone, label, editKey,
}: {
  value: string | null | undefined;
  onChange: (color: string | undefined) => void;
  swatches: string[];
  allowNone?: boolean;
  label?: string;
  /** Groups the continuous edits of this control into one undo step. */
  editKey: string;
}) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const parsed = parseColor(value);
  const following = !!value?.startsWith("var(");
  const shown = following ? (parsed ? formatColor(parsed) : "") : value ?? "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => { setDraft(shown); }, [shown]);
  const [recent, setRecent] = useState<string[]>(() => readRecent());

  const pick = useCallback((color: string | undefined, live = false) => {
    if (live) coalesce(editKey);
    onChange(color);
    if (color && !live) { pushRecent(color); setRecent(readRecent()); }
  }, [onChange, editKey]);

  const alpha = parsed?.a ?? 1;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-background px-1.5 text-[11px] hover:border-foreground/30"
      >
        <span className="h-4 w-4 shrink-0 rounded border border-white/20" style={{ background: value ? `linear-gradient(${value}, ${value}), ${checker}` : "transparent" }} />
        <span className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground" title={parsed ? formatColor(parsed) : value ?? undefined}>
          {!value
            ? t("studio.style.none")
            : following
              ? t("studio.element.followsTheme")
              : parsed
                ? `${t(`studio.style.colorWord.${colorWord(parsed)}` as never)}${parsed.a < 1 ? ` ${Math.round(parsed.a * 100)}%` : ""}`
                : t("studio.style.customColor")}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      </button>
      {open && (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)}>
          {swatches.length > 0 && (
            <>
              <div className="mb-1 text-[10px] text-muted-foreground">{t("studio.style.themeColors")}</div>
              <div className="mb-2 flex flex-wrap gap-1">
                {swatches.map((c) => <Chip key={c} color={c} active={value === c} onPick={() => pick(c)} />)}
              </div>
            </>
          )}
          {recent.length > 0 && (
            <>
              <div className="mb-1 text-[10px] text-muted-foreground">{t("studio.style.recentColors")}</div>
              <div className="mb-2 flex flex-wrap gap-1">
                {recent.map((c) => <Chip key={c} color={c} active={value === c} onPick={() => pick(c)} />)}
              </div>
            </>
          )}
          <div className="mb-2 grid grid-cols-9 gap-1">
            {PALETTE.map((c) => <Chip key={c} color={c} active={value === c} onPick={() => pick(c)} />)}
          </div>
          <div className="flex items-center gap-1.5">
            <label className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-white/15" title={t("studio.element.customColor")}
              style={{ background: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}>
              <input
                type="color"
                className="absolute inset-0 cursor-pointer opacity-0"
                value={parsed ? opaqueHex(parsed) : "#ffffff"}
                onChange={(e) => {
                  const c = parseColor(e.target.value)!;
                  pick(formatColor({ ...c, a: alpha }), true);
                }}
              />
            </label>
            <input
              value={draft}
              spellCheck={false}
              aria-label={t("studio.style.hex")}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { if (draft.trim() && draft !== shown) pick(draft.trim()); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (draft.trim()) pick(draft.trim()); } }}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[11px] outline-none focus:border-primary"
            />
            {allowNone && (
              <button type="button" title={t("studio.style.none")} onClick={() => { pick(undefined); setOpen(false); }}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {parsed && (
            <label className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
              {t("studio.style.colorOpacity")}
              <input type="range" min={0} max={100} value={Math.round(alpha * 100)}
                onChange={(e) => pick(formatColor({ ...parsed, a: Number(e.target.value) / 100 }), true)}
                className="h-1 min-w-0 flex-1 accent-primary" />
              <span className="w-8 text-right tabular-nums">{Math.round(alpha * 100)}%</span>
            </label>
          )}
        </Popover>
      )}
    </>
  );
}

// ── Small controls ───────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

function Slider({ value, min, max, step = 1, unit = "", onChange, editKey, label }: {
  value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; editKey: string; label: string;
}) {
  return (
    <>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value}
        onChange={(e) => { coalesce(editKey); onChange(Number(e.target.value)); }}
        className="h-1 min-w-0 flex-1 accent-primary" />
      <input type="number" aria-label={label} min={min} max={max} step={step} value={Number.isInteger(step) ? Math.round(value) : Math.round(value * 100) / 100}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return;
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          coalesce(editKey);
          onChange(n);
        }}
        className="h-6 w-12 shrink-0 rounded border border-border bg-background px-1 text-right text-[11px] tabular-nums outline-none focus:border-primary" />
      {unit && <span className="-ml-1 w-3 shrink-0 text-[10px] text-muted-foreground/60">{unit}</span>}
    </>
  );
}

function Segmented<T extends string>({ value, options, onChange }: {
  value: T | undefined; options: Array<{ value: T; label: React.ReactNode; title?: string }>; onChange: (v: T) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 rounded-md border border-border bg-background p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" title={o.title} aria-label={o.title} aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("flex h-6 min-w-0 flex-1 items-center justify-center rounded px-1 text-[11px] transition-colors",
            value === o.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border/50 px-3 py-2.5">
      <div className="mb-2 text-[11px] font-semibold text-foreground/80">{title}</div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

// ── Which style an element carries ───────────────────────────────────────

const BOX_TYPES = new Set(["box", "button", "chat", "messages", "composer", "custom"]);

/** The part's box style, when it has one the panel can edit. */
export function boxStyleOf(el: UiElement): UiBoxStyle | null {
  if (BOX_TYPES.has(el.type)) return ((el as { style?: UiBoxStyle }).style ?? {});
  if (el.type === "meter") return { fills: el.style?.fills, radius: el.style?.radius };
  if (el.type === "image") return { radius: el.radius };
  return null;
}

const clean = <T extends object>(o: T): T => {
  const out = { ...o } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
};

export function withBoxStyle(el: UiElement, patch: Partial<UiBoxStyle>): UiElement {
  // A layout may round a part through its free CSS (with !important, to beat
  // the theme). Setting corners here means these corners, so that rule goes.
  if ("radius" in patch && el.css && /border-radius/i.test(el.css)) {
    const css = el.css.replace(/border-radius\s*:[^;]*;?/gi, "").trim();
    const { css: _old, ...rest } = el;
    el = (css ? { ...rest, css } : rest) as UiElement;
  }
  if (BOX_TYPES.has(el.type)) {
    const style = clean({ ...((el as { style?: UiBoxStyle }).style ?? {}), ...patch });
    return { ...el, style } as UiElement;
  }
  if (el.type === "meter") {
    const next = { ...el.style };
    if ("fills" in patch) next.fills = patch.fills;
    if ("radius" in patch) next.radius = patch.radius;
    return { ...el, style: clean(next) };
  }
  if (el.type === "image" && "radius" in patch) return clean({ ...el, radius: patch.radius }) as UiElement;
  return el;
}

/** Which box properties make sense for a part. A picture only has corners; a
 *  meter has a bar colour and corners. */
function boxSupports(el: UiElement, key: keyof UiBoxStyle): boolean {
  if (BOX_TYPES.has(el.type)) return true;
  if (el.type === "meter") return key === "fills" || key === "radius";
  if (el.type === "image") return key === "radius";
  return false;
}

export function textStyleOf(el: UiElement): UiTextStyle | null {
  if (el.type === "text") return el.style ?? {};
  if (el.type === "list") return el.textStyle ?? {};
  if (el.type === "button") {
    const s: UiButtonStyle = el.style ?? {};
    return { size: s.size, desktopSize: s.desktopSize, weight: s.weight, family: s.family, letterSpacing: s.letterSpacing, color: s.textColor };
  }
  return null;
}

const BUTTON_TEXT_KEYS = new Set<keyof UiTextStyle>(["size", "desktopSize", "weight", "family", "letterSpacing", "color"]);

function textSupports(el: UiElement, key: keyof UiTextStyle): boolean {
  if (el.type === "text" || el.type === "list") return true;
  if (el.type === "button") return BUTTON_TEXT_KEYS.has(key);
  return false;
}

export function withTextStyle(el: UiElement, patch: Partial<UiTextStyle>): UiElement {
  if (el.type === "text") return { ...el, style: clean({ ...el.style, ...patch }) };
  if (el.type === "list") return { ...el, textStyle: clean({ ...el.textStyle, ...patch }) };
  if (el.type === "button") {
    const next: Record<string, unknown> = { ...el.style };
    for (const [k, v] of Object.entries(patch)) {
      if (!BUTTON_TEXT_KEYS.has(k as keyof UiTextStyle)) continue;
      next[k === "color" ? "textColor" : k] = v;
    }
    return { ...el, style: clean(next) as UiButtonStyle };
  }
  return el;
}

/**
 * A text-style change on the picked parts, the one way the panel and the
 * floating bar both make it: a change that can change how much room the words
 * take refits each box to its words (and moves what is under a grown one).
 */
export function applyTextPatch({ doc, targets, lead, patch, onPatch, onDoc }: {
  doc: UiDoc; targets: UiElement[]; lead: UiElement; patch: Partial<UiTextStyle>;
  onPatch: (fn: (el: UiElement) => UiElement) => void; onDoc: (next: UiDoc) => void;
}): void {
  const apply = (el: UiElement): UiElement => {
    const keys = Object.keys(patch) as Array<keyof UiTextStyle>;
    if (!textStyleOf(el) || !keys.some((k) => textSupports(el, k))) return el;
    return withTextStyle(el, patch);
  };
  const page = textStyleAffectsHeight(patch)
    ? (doc.pages ?? []).find((p) => p.elements.some((el) => el.id === lead.id))
    : undefined;
  if (!page) {
    onPatch(apply);
    return;
  }
  let next = page;
  for (const target of targets) {
    const before = next.elements.find((el) => el.id === target.id);
    if (!before) continue;
    const changed = apply(before);
    if (changed === before) continue;
    next = { ...next, elements: next.elements.map((el) => (el.id === before.id ? changed : el)) };
    next = fitTextOnPage(next, before.id, before, { hug: true });
  }
  if (next !== page) onDoc({ ...doc, pages: doc.pages.map((p) => (p.id === page.id ? next : p)) });
}

/** The weights the weight menu offers: every labelled weight for a system or
 *  uploaded font, only the faces a curated web font really ships (a display
 *  face with one weight offers just that one). */
const LABELLED_WEIGHTS = [300, 400, 500, 600, 700, 900];
function weightChoices(family: string | undefined): number[] {
  const own = fontWeightsOf(family);
  if (!own) return LABELLED_WEIGHTS;
  const shown = LABELLED_WEIGHTS.filter((w) => own.includes(w));
  return shown.length ? shown : [fitFontWeight(family, 400)];
}

// ── Presets ──────────────────────────────────────────────────────────────

type ShadowPreset = "none" | "soft" | "medium" | "lifted" | "glow";
const SHADOWS: Record<Exclude<ShadowPreset, "none">, (color: string) => UiShadow[]> = {
  soft: (c) => [{ x: 0, y: 1, blur: 4, color: c }],
  medium: (c) => [{ x: 0, y: 4, blur: 14, color: c }],
  lifted: (c) => [{ x: 0, y: 14, blur: 34, spread: -4, color: c }],
  glow: (c) => [{ x: 0, y: 0, blur: 18, spread: 2, color: c }],
};
const SHADOW_DEFAULT_COLOR: Record<Exclude<ShadowPreset, "none">, string> = {
  soft: "rgba(0, 0, 0, 0.3)", medium: "rgba(0, 0, 0, 0.38)", lifted: "rgba(0, 0, 0, 0.5)", glow: "rgba(242, 193, 78, 0.65)",
};
function shadowPresetOf(shadows: UiShadow[] | undefined): ShadowPreset | "custom" {
  const list = (shadows ?? []).filter((s) => !s.inset);
  if (list.length === 0) return "none";
  const s = list[0]!;
  for (const key of Object.keys(SHADOWS) as Array<Exclude<ShadowPreset, "none">>) {
    const p = SHADOWS[key](s.color)[0]!;
    if (list.length === 1 && p.x === s.x && p.y === s.y && p.blur === s.blur && (p.spread ?? 0) === (s.spread ?? 0)) return key;
  }
  return "custom";
}

type TextFx = "none" | "soft" | "crisp" | "glow";
const TEXT_SHADOWS: Record<Exclude<TextFx, "none">, (c: string) => UiShadow> = {
  soft: (c) => ({ x: 0, y: 1, blur: 4, color: c }),
  crisp: (c) => ({ x: 1, y: 1, blur: 0, color: c }),
  glow: (c) => ({ x: 0, y: 0, blur: 10, color: c }),
};
function textFxOf(s: UiShadow | undefined): TextFx | "custom" {
  if (!s) return "none";
  for (const key of Object.keys(TEXT_SHADOWS) as Array<Exclude<TextFx, "none">>) {
    const p = TEXT_SHADOWS[key](s.color);
    if (p.x === s.x && p.y === s.y && p.blur === s.blur) return key;
  }
  return "custom";
}

const GRADIENTS: Array<{ id: string; angle: number; stops: UiGradientStop[] }> = [
  { id: "dusk", angle: 135, stops: [{ color: "#f6a57a", at: 0 }, { color: "#b0527e", at: 100 }] },
  { id: "night", angle: 180, stops: [{ color: "#2b2f5c", at: 0 }, { color: "#0e0f1d", at: 100 }] },
  { id: "mint", angle: 135, stops: [{ color: "#9be7c4", at: 0 }, { color: "#3fb8af", at: 100 }] },
  { id: "rose", angle: 135, stops: [{ color: "#ffd1dc", at: 0 }, { color: "#e05c8e", at: 100 }] },
  { id: "gold", angle: 160, stops: [{ color: "#f7e08b", at: 0 }, { color: "#c58a2a", at: 55 }, { color: "#f2d27a", at: 100 }] },
  { id: "glass", angle: 180, stops: [{ color: "rgba(255, 255, 255, 0.22)", at: 0 }, { color: "rgba(255, 255, 255, 0.06)", at: 100 }] },
];
const gradientCss = (angle: number, stops: UiGradientStop[]) =>
  `linear-gradient(${angle}deg, ${stops.map((s) => `${s.color} ${s.at}%`).join(", ")})`;

// ── Fonts ────────────────────────────────────────────────────────────────

/** The font list previews each font in itself, loading just the glyphs of
 *  each label — a few hundred bytes a font. Under an ALIAS: the app's own font
 *  stack names "Noto Sans SC", and a face registered under that name would
 *  quietly restyle the editor around the picker. */
const previewLoaded = new Set<string>();
export const previewFamily = (family: string) => `yumina-preview-${family}`;
function loadPreview(family: string, google: string, sample: string) {
  if (previewLoaded.has(family) || typeof document === "undefined") return;
  previewLoaded.add(family);
  const base = google.split(":")[0];
  const url = `https://fonts.googleapis.com/css2?family=${base}&text=${encodeURIComponent(sample)}&display=swap`;
  fetch(url)
    .then((r) => (r.ok ? r.text() : ""))
    .then((css) => {
      if (!css) return;
      const style = document.createElement("style");
      style.textContent = css.replace(/font-family:\s*['"]([^'"]+)['"]/g, (_m, name: string) => `font-family: '${previewFamily(name)}'`);
      document.head.appendChild(style);
    })
    .catch(() => { /* offline: the list still works, in the fallback face */ });
}

const SYSTEM_FONTS = ["sans", "serif", "rounded", "mono"] as const;
const slug = (family: string) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** The one font list: localized names, each drawn in itself. Shared by every
 *  panel that picks a font (text parts, and the messages part's two sides).
 *  Without `onAddFont` there is no upload row. `themeLabel` names the "no font
 *  of its own" choice. */
export function FontPicker({ value, onChange, doc, onAddFont, canUpload = false, themeLabel }: {
  value: string | undefined; onChange: (stack: string | undefined) => void; doc?: UiDoc;
  onAddFont?: () => void; canUpload?: boolean; themeLabel?: string;
}) {
  const { t, i18n } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const themeFonts = (doc?.theme?.fonts ?? []).filter((f) => f && typeof f.family === "string");
  const labelOf = useCallback((family: string) => {
    const key = `studio.style.fontName.${slug(family)}`;
    return i18n.exists(`editor:${key}`) ? t(key as never) : family;
  }, [t, i18n]);

  const current = (() => {
    // A var() is the theme speaking (the starters set words in
    // `var(--yc-font, inherit)`): it reads as 「跟着主题」, never as code.
    if (isThemeFontValue(value)) return themeLabel ?? t("studio.style.fontTheme");
    const web = webFontOf(value);
    if (web) return labelOf(web.family);
    const sys = SYSTEM_FONTS.find((k) => UI_THEME_FONTS[k] === value);
    if (sys) return t(`studio.style.system.${sys}` as never);
    return primaryFamily(value) ?? value;
  })();

  useEffect(() => {
    const web = webFontOf(value);
    if (web) loadPreview(web.family, web.google, labelOf(web.family));
  }, [value, labelOf]);
  useEffect(() => {
    if (!open) return;
    for (const f of UI_WEB_FONTS) loadPreview(f.family, f.google, labelOf(f.family));
  }, [open, labelOf]);

  const groups: Array<{ title: string; items: Array<{ stack: string; label: string; preview: string }> }> = [
    { title: t("studio.style.fontGroup.system"), items: SYSTEM_FONTS.map((k) => ({ stack: UI_THEME_FONTS[k], label: t(`studio.style.system.${k}` as never), preview: UI_THEME_FONTS[k] })) },
    ...(["zh", "ja", "latin"] as const).map((script) => ({
      title: t(`studio.style.fontGroup.${script}` as never),
      items: UI_WEB_FONTS.filter((f) => f.script === script).map((f) => ({ stack: f.stack, label: labelOf(f.family), preview: `"${previewFamily(f.family)}", ${f.stack.split(",").slice(1).join(",") || "sans-serif"}` })),
    })),
  ];
  if (themeFonts.length) {
    groups.unshift({ title: t("studio.style.fontGroup.card"), items: themeFonts.map((f) => ({ stack: f.family, label: f.family, preview: "inherit" })) });
  }

  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)}
        className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:border-foreground/30">
        <span className="min-w-0 flex-1 truncate text-left" style={{ fontFamily: value && webFontOf(value) ? `"${previewFamily(webFontOf(value)!.family)}", sans-serif` : undefined }}>{current}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      </button>
      {open && (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} width={248}>
          <div className="max-h-[360px] overflow-y-auto pr-1">
            <button type="button" onClick={() => { onChange(undefined); setOpen(false); }}
              className={cn("mb-1 flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-accent", isThemeFontValue(value) && "bg-accent")}>
              {themeLabel ?? t("studio.style.fontTheme")}
            </button>
            {groups.map((g) => (
              <div key={g.title} className="mb-1">
                <div className="px-2 pb-0.5 pt-1.5 text-[10px] text-muted-foreground">{g.title}</div>
                {g.items.map((item) => (
                  <button key={item.stack} type="button" onClick={() => { onChange(item.stack); setOpen(false); }}
                    className={cn("flex w-full items-center rounded-md px-2 py-1.5 text-left text-[14px] hover:bg-accent", value === item.stack && "bg-accent text-primary")}
                    style={{ fontFamily: item.preview }}>
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
            {onAddFont && <button type="button" disabled={!canUpload} title={canUpload ? undefined : t("studio.element.saveFirst")}
              onClick={() => { setOpen(false); onAddFont(); }}
              className="mt-1 flex w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40">
              <Upload className="h-3.5 w-3.5" /> {t("studio.style.uploadFont")}
            </button>}
          </div>
        </Popover>
      )}
    </>
  );
}

// ── The section ──────────────────────────────────────────────────────────

export function StyleSection({
  doc, targets, lead, canvas, onPatch, onDoc, worldId,
}: {
  doc: UiDoc;
  /** Every picked element. */
  targets: UiElement[];
  /** The one whose values the controls show. */
  lead: UiElement;
  canvas: "phone" | "desktop";
  /** Apply a change to every picked element (each decides if it applies). */
  onPatch: (fn: (el: UiElement) => UiElement) => void;
  /** Replace the whole doc — adding a card font. */
  onDoc: (next: UiDoc) => void;
  worldId?: string | null;
}) {
  const { t } = useTranslation("editor");
  const swatches = useMemo(() => themeSwatches(doc), [doc]);
  const [pickingImage, setPickingImage] = useState(false);
  const [pickingFont, setPickingFont] = useState(false);
  const [corners, setCorners] = useState(false);

  // The element whose box style is shown: the lead if it has one, else the
  // first picked part that does (a meter group's lead is its track).
  const boxEl = boxStyleOf(lead) ? lead : targets.find((el) => boxStyleOf(el));
  const box = boxEl ? boxStyleOf(boxEl)! : null;
  const textEl = textStyleOf(lead) ? lead : targets.find((el) => textStyleOf(el));
  const text = textEl ? textStyleOf(textEl)! : null;

  const patchBox = (patch: Partial<UiBoxStyle>) =>
    onPatch((el) => (Object.keys(patch).every((k) => boxSupports(el, k as keyof UiBoxStyle)) ? withBoxStyle(el, patch) : el));
  const patchText = (patch: Partial<UiTextStyle>) => applyTextPatch({ doc, targets, lead, patch, onPatch, onDoc });

  const fills = box?.fills ?? [];
  const top = fills[0];
  const fillMode: "none" | "color" | "gradient" | "image" = !top ? "none" : top.kind;
  const canFill = !!boxEl && boxSupports(boxEl, "fills");
  const canBorder = !!boxEl && boxSupports(boxEl, "borderWidth");
  const canRadius = !!boxEl && boxSupports(boxEl, "radius");
  // A button with no corners set is drawn as a pill (the compiler's default).
  const radius = box?.radius ?? (boxEl?.type === "button" ? 999 : undefined);
  const radiusList: [number, number, number, number] = Array.isArray(radius) ? radius : [radius ?? 0, radius ?? 0, radius ?? 0, radius ?? 0];
  const perCorner = corners || Array.isArray(radius);
  const shadowPreset = shadowPresetOf(box?.shadows);

  const setFillMode = (mode: typeof fillMode) => {
    if (mode === fillMode) return;
    const firstColor = fills.find((f): f is Extract<UiFill, { kind: "color" }> => f.kind === "color")?.color;
    if (mode === "none") patchBox({ fills: undefined });
    else if (mode === "color") patchBox({ fills: [{ kind: "color", color: firstColor ?? swatches[0] ?? "#4c8fd0" }] });
    else if (mode === "gradient") patchBox({ fills: [{ kind: "gradient", angle: GRADIENTS[0]!.angle, stops: GRADIENTS[0]!.stops }] });
    else setPickingImage(true);
  };
  const setTopFill = (fill: UiFill) => patchBox({ fills: [fill, ...fills.slice(1)] });

  const size = text ? Math.round((canvas === "desktop" ? text.desktopSize ?? text.size : text.size) ?? (lead.type === "button" ? 13 : 14)) : 14;

  return (
    <div data-testid="style-section">
      {text && textEl && (
        <Section title={t("studio.style.textStyle")}>
          <Row label={t("studio.style.font")}>
            <FontPicker value={text.family} doc={doc} canUpload={!!worldId} onAddFont={() => setPickingFont(true)}
              onChange={(family) => {
                // A font that has no face at the current weight would be
                // drawn as a smeared fake bold — snap to the nearest it has.
                const weight = text.weight ?? (lead.type === "button" ? 600 : undefined);
                const fitted = weight === undefined ? undefined : fitFontWeight(family, weight);
                patchText(fitted !== undefined && fitted !== weight ? { family, weight: fitted } : { family });
              }} />
          </Row>
          <Row label={t("studio.element.size")}>
            <Slider label={t("studio.element.size")} editKey={`size-${canvas}`} min={8} max={96} value={size} unit="px"
              onChange={(v) => {
                if (v <= 0) return;
                patchText(canvas === "desktop" ? { desktopSize: v } : { size: v });
              }} />
          </Row>
          <Row label={t("studio.element.weight")}>
            <select value={String(fitFontWeight(text.family, text.weight ?? (lead.type === "button" ? 600 : 400)))} aria-label={t("studio.element.weight")}
              onChange={(e) => patchText({ weight: Number(e.target.value) })}
              disabled={weightChoices(text.family).length < 2}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-[11px] outline-none focus:border-primary disabled:opacity-60">
              {weightChoices(text.family).map((w) => <option key={w} value={w}>{t(`studio.style.weightN.${w}` as never)}</option>)}
            </select>
            {textSupports(textEl, "italic") && (
              <button type="button" aria-pressed={!!text.italic} title={t("studio.style.italic")} aria-label={t("studio.style.italic")}
                onClick={() => patchText({ italic: text.italic ? undefined : true })}
                className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md border", text.italic ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
                <Italic className="h-3.5 w-3.5" />
              </button>
            )}
          </Row>
          <Row label={t("studio.style.color")}>
            <ColorField editKey="textColor" value={text.color} swatches={swatches} onChange={(c) => patchText({ color: c })} />
          </Row>
          {textSupports(textEl, "align") && (
            <Row label={t("studio.style.align")}>
              <Segmented value={text.align ?? "left"} onChange={(align) => patchText({ align })}
                options={[
                  { value: "left", label: <AlignLeft className="h-3.5 w-3.5" />, title: t("studio.style.alignLeft") },
                  { value: "center", label: <AlignCenter className="h-3.5 w-3.5" />, title: t("studio.style.alignCenter") },
                  { value: "right", label: <AlignRight className="h-3.5 w-3.5" />, title: t("studio.style.alignRight") },
                ]} />
            </Row>
          )}
          {textSupports(textEl, "lineHeight") && (
            <Row label={t("studio.style.lineHeight")}>
              <Slider label={t("studio.style.lineHeight")} editKey="lineHeight" min={0.8} max={2.6} step={0.05} value={text.lineHeight ?? 1.4}
                onChange={(v) => patchText({ lineHeight: v })} />
            </Row>
          )}
          <Row label={t("studio.style.letterSpacing")}>
            <Slider label={t("studio.style.letterSpacing")} editKey="letterSpacing" min={-3} max={16} step={0.5} value={text.letterSpacing ?? 0} unit="px"
              onChange={(v) => patchText({ letterSpacing: v || undefined })} />
          </Row>
          {textSupports(textEl, "textShadow") && (
            <>
              <Row label={t("studio.style.textShadow")}>
                <Segmented
                  value={textFxOf(text.textShadow) === "custom" ? undefined : (textFxOf(text.textShadow) as TextFx)}
                  onChange={(fx) => patchText({ textShadow: fx === "none" ? undefined : TEXT_SHADOWS[fx](text.textShadow?.color ?? (fx === "glow" ? swatches[0] ?? "#f2c14e" : "rgba(0, 0, 0, 0.6)")) })}
                  options={(["none", "soft", "crisp", "glow"] as const).map((fx) => ({ value: fx, label: t(`studio.style.textFx.${fx}` as never) }))}
                />
              </Row>
              {text.textShadow && (
                <Row label="">
                  <ColorField editKey="textShadowColor" value={text.textShadow.color} swatches={swatches}
                    onChange={(c) => c && patchText({ textShadow: { ...text.textShadow!, color: c } })} />
                </Row>
              )}
              <Row label={t("studio.style.stroke")}>
                <Segmented
                  value={!text.stroke ? "none" : text.stroke.width >= 2 ? "thick" : "thin"}
                  onChange={(v) => patchText({ stroke: v === "none" ? undefined : { width: v === "thick" ? 2 : 1, color: text.stroke?.color ?? "rgba(0, 0, 0, 0.85)" } })}
                  options={(["none", "thin", "thick"] as const).map((v) => ({ value: v, label: t(`studio.style.strokeN.${v}` as never) }))}
                />
              </Row>
              {text.stroke && (
                <Row label="">
                  <ColorField editKey="strokeColor" value={text.stroke.color} swatches={swatches}
                    onChange={(c) => c && patchText({ stroke: { ...text.stroke!, color: c } })} />
                </Row>
              )}
            </>
          )}
        </Section>
      )}

      {canFill && (
        <Section title={t(lead.type === "meter" ? "studio.element.barColor" : "studio.style.fill")}>
          <Segmented
            value={fillMode}
            onChange={setFillMode}
            options={[
              { value: "none", label: t("studio.style.fillNone") },
              { value: "color", label: t("studio.style.fillColor") },
              { value: "gradient", label: t("studio.style.fillGradient") },
              ...(boxEl && BOX_TYPES.has(boxEl.type) ? [{ value: "image" as const, label: t("studio.style.fillImage") }] : []),
            ]}
          />
          {top?.kind === "color" && (
            <Row label={t("studio.style.color")}>
              <ColorField editKey="fill" value={top.color} swatches={swatches} onChange={(c) => c && setTopFill({ kind: "color", color: c })} />
            </Row>
          )}
          {top?.kind === "gradient" && (
            <>
              <div className="flex gap-1">
                {GRADIENTS.map((g) => (
                  <button key={g.id} type="button" title={t(`studio.style.gradient.${g.id}` as never)}
                    onClick={() => setTopFill({ kind: "gradient", angle: g.angle, stops: g.stops })}
                    className="h-6 flex-1 rounded-md border border-white/15 hover:scale-105"
                    style={{ background: `${gradientCss(g.angle, g.stops)}, ${checker}` }} />
                ))}
              </div>
              <div className="h-3 rounded-sm border border-white/10" style={{ background: gradientCss(90, top.stops) }} />
              {top.stops.map((stop, i) => (
                <Row key={i} label={t("studio.style.stopN", { n: i + 1 })}>
                  <ColorField editKey={`stop-${i}`} value={stop.color} swatches={swatches}
                    onChange={(c) => c && setTopFill({ ...top, stops: top.stops.map((s, j) => (j === i ? { ...s, color: c } : s)) })} />
                  {top.stops.length > 2 && (
                    <button type="button" aria-label={t("studio.style.removeStop")} title={t("studio.style.removeStop")}
                      onClick={() => setTopFill({ ...top, stops: top.stops.filter((_, j) => j !== i) })}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                  )}
                </Row>
              ))}
              {top.stops.length < 3 && (
                <button type="button" onClick={() => {
                  const [a, b] = [top.stops[0]!, top.stops[top.stops.length - 1]!];
                  setTopFill({ ...top, stops: [a, { color: a.color, at: 50 }, b] });
                }} className="flex items-center gap-1 self-start text-[11px] text-muted-foreground hover:text-foreground">
                  <Plus className="h-3 w-3" /> {t("studio.style.addStop")}
                </button>
              )}
              <Row label={t("studio.style.angle")}>
                <Slider label={t("studio.style.angle")} editKey="angle" min={0} max={360} value={top.angle ?? 180} unit="°"
                  onChange={(v) => setTopFill({ ...top, angle: v })} />
              </Row>
            </>
          )}
          {top?.kind === "image" && (
            <Row label={t("studio.style.fillImage")}>
              <button type="button" disabled={!worldId} onClick={() => setPickingImage(true)}
                className="h-7 flex-1 rounded-md border border-border text-[11px] hover:bg-accent disabled:opacity-40">
                {t("studio.element.changeImage")}
              </button>
              <select value={top.fit ?? "cover"} aria-label={t("studio.style.fit")}
                onChange={(e) => setTopFill({ ...top, fit: e.target.value as "cover" | "contain" | "fill" })}
                className="h-7 rounded-md border border-border bg-background px-1 text-[11px]">
                <option value="cover">{t("studio.style.fitCover")}</option>
                <option value="contain">{t("studio.style.fitContain")}</option>
                <option value="fill">{t("studio.style.fitFill")}</option>
              </select>
            </Row>
          )}
        </Section>
      )}

      {(canRadius || canBorder) && (
        <Section title={t("studio.style.shape")}>
          {canRadius && (
            <Row label={t("studio.style.radius")}>
              {!perCorner ? (
                <Slider label={t("studio.style.radius")} editKey="radius" min={0} max={100} value={Math.min(100, radiusList[0])} unit="px"
                  onChange={(v) => patchBox({ radius: v })} />
              ) : (
                <div className="grid flex-1 grid-cols-4 gap-1">
                  {radiusList.map((r, i) => (
                    <input key={i} type="number" min={0} value={r} aria-label={t(`studio.style.corner.${i}` as never)} title={t(`studio.style.corner.${i}` as never)}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n) || n < 0) return;
                        coalesce("radius4");
                        const next = [...radiusList] as [number, number, number, number];
                        next[i] = n;
                        patchBox({ radius: next });
                      }}
                      className="h-6 w-full rounded border border-border bg-background px-1 text-center text-[11px] outline-none focus:border-primary" />
                  ))}
                </div>
              )}
              <button type="button" aria-pressed={perCorner} title={t("studio.style.perCorner")} aria-label={t("studio.style.perCorner")}
                onClick={() => {
                  if (perCorner) { setCorners(false); patchBox({ radius: radiusList[0] }); } else setCorners(true);
                }}
                className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded border text-[10px]", perCorner ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
                ⌜⌟
              </button>
            </Row>
          )}
          {canBorder && (
            <>
              <Row label={t("studio.style.border")}>
                <Slider label={t("studio.style.borderWidth")} editKey="borderWidth" min={0} max={12} value={box?.borderWidth ?? 0} unit="px"
                  onChange={(v) => patchBox(v > 0
                    ? { borderWidth: v, borderColor: box?.borderColor ?? "rgba(255, 255, 255, 0.35)", borderStyle: box?.borderStyle ?? "solid" }
                    : { borderWidth: undefined })} />
              </Row>
              {(box?.borderWidth ?? 0) > 0 && (
                <>
                  <Row label={t("studio.style.color")}>
                    <ColorField editKey="borderColor" value={box?.borderColor} swatches={swatches} onChange={(c) => patchBox({ borderColor: c })} />
                  </Row>
                  <Row label={t("studio.style.line")}>
                    <Segmented value={box?.borderStyle ?? "solid"} onChange={(v) => patchBox({ borderStyle: v })}
                      options={[
                        { value: "solid", label: t("studio.style.solid") },
                        { value: "dashed", label: t("studio.style.dashed") },
                        { value: "dotted", label: t("studio.style.dotted") },
                      ]} />
                  </Row>
                </>
              )}
            </>
          )}
        </Section>
      )}

      {canBorder && (
        <Section title={t("studio.style.shadow")}>
          <Segmented
            value={shadowPreset === "custom" ? undefined : shadowPreset}
            onChange={(p) => {
              const inset = (box?.shadows ?? []).filter((s) => s.inset);
              if (p === "none") patchBox({ shadows: inset.length ? inset : undefined });
              else {
                const keep = (box?.shadows ?? []).find((s) => !s.inset)?.color;
                const color = p === "glow" ? (swatches[0] ? withAlpha(swatches[0], 0.65) : SHADOW_DEFAULT_COLOR.glow) : shadowPreset !== "glow" && keep ? keep : SHADOW_DEFAULT_COLOR[p];
                patchBox({ shadows: [...SHADOWS[p](color), ...inset] });
              }
            }}
            options={(["none", "soft", "medium", "lifted", "glow"] as const).map((p) => ({ value: p, label: t(`studio.style.shadowPreset.${p}` as never) }))}
          />
          {shadowPreset !== "none" && (
            <Row label={t("studio.style.color")}>
              <ColorField editKey="shadowColor" value={(box?.shadows ?? []).find((s) => !s.inset)?.color} swatches={swatches}
                onChange={(c) => c && patchBox({ shadows: (box?.shadows ?? []).map((s) => (s.inset ? s : { ...s, color: c })) })} />
            </Row>
          )}
        </Section>
      )}

      <Section title={t("studio.style.effects")}>
        <Row label={t("studio.style.opacity")}>
          <Slider label={t("studio.style.opacity")} editKey="opacity" min={0} max={100} unit="%"
            value={Math.round((lead.opacity ?? 1) * 100)}
            onChange={(v) => onPatch((el) => {
              const o = Math.max(0, Math.min(100, v)) / 100;
              if (o >= 1) { const { opacity: _o, ...rest } = el; return rest as UiElement; }
              return { ...el, opacity: o };
            })} />
        </Row>
        {canBorder && (
          <Row label={t("studio.style.blur")}>
            <Slider label={t("studio.style.blur")} editKey="blur" min={0} max={40} value={box?.backdropBlur ?? 0} unit="px"
              onChange={(v) => patchBox({ backdropBlur: v > 0 ? v : undefined })} />
          </Row>
        )}
        <Row label={t("studio.style.rotation")}>
          <Slider label={t("studio.style.rotation")} editKey="rotation" min={-180} max={180} value={lead.rotation ?? 0} unit="°"
            onChange={(v) => onPatch((el) => {
              if (!v) { const { rotation: _r, ...rest } = el; return rest as UiElement; }
              return { ...el, rotation: v };
            })} />
        </Row>
      </Section>

      {pickingImage && worldId && createPortal(
        <AssetPicker
          worldId={worldId}
          filterType="image"
          onSelect={(ref) => {
            setPickingImage(false);
            setTopFill({ kind: "image", src: { kind: "asset", ref }, fit: top?.kind === "image" ? top.fit ?? "cover" : "cover" });
          }}
          onClose={() => setPickingImage(false)}
        />,
        document.body,
      )}
      {pickingFont && worldId && createPortal(
        <AssetPicker
          worldId={worldId}
          filterType="font"
          onSelect={(ref) => {
            setPickingFont(false);
            const taken = new Set((doc.theme?.fonts ?? []).map((f) => f.family));
            let family = t("studio.style.myFont");
            for (let n = 2; taken.has(family); n++) family = `${t("studio.style.myFont")} ${n}`;
            const withFont: UiDoc = { ...doc, theme: { ...doc.theme, fonts: [...(doc.theme?.fonts ?? []), { family, ref, fallback: "sans-serif" }] } };
            const page = withFont.pages.find((p) => p.elements.some((e) => e.id === lead.id));
            if (!page) { onDoc(withFont); return; }
            const ids = new Set(targets.map((e) => e.id));
            onDoc({
              ...withFont,
              pages: withFont.pages.map((p) => p !== page ? p : {
                ...p,
                elements: p.elements.map((el) => (ids.has(el.id) && textStyleOf(el) ? withTextStyle(el, { family }) : el)),
              }),
            });
          }}
          onClose={() => setPickingFont(false)}
        />,
        document.body,
      )}
    </div>
  );
}

function withAlpha(color: string, a: number): string {
  const c = parseColor(color);
  return c ? formatColor({ ...c, a }) : color;
}
