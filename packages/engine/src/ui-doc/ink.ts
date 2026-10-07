import {
  MIN_TEXT_CONTRAST,
  composite,
  contrastRatio,
  cssHex,
  inkOnGround,
  readableOn,
  resolveCssColor,
  themeGround,
  tokenValue,
} from "./contrast.js";
import type { GroundInk, Rgba } from "./contrast.js";
import type { UiDoc, UiElement, UiFill, UiPage } from "./types.js";

/**
 * Where a card's own words land, and the ink each needs there.
 *
 * `readableThemeTokens` holds the chat's ink to the chat's surfaces: text to
 * the bubble, the composer's ink to the composer. The card's parts draw in
 * the same `--yc-text` — a starter's status labels, a location, a list's empty
 * line — but they sit on the PAGE, or on a panel box on the page. With a pink
 * page under a dark bubble the one `--yc-text` cannot read on both, and the
 * bubble pair wins: the labels went to 1.5:1 on the phone.
 *
 * So each part is measured against what is actually beneath it: the page (the
 * theme's, or the page's own colour), composited with every painted box it
 * sits inside, in paint order. A part whose ink already reads there is left
 * exactly as it was — an official preset that passes compiles byte for byte
 * as before. One that does not gets the ink of its ground:
 *
 * - on the theme's page: `--yc-page-text` / `--yc-page-text-muted`
 * - on a panel painted in the input surface (`--yc-input-bg`, the starters'
 *   rails and cards): `--yc-panel-text` / `--yc-panel-text-muted`
 * - on anything else it can read: the colour itself, computed here.
 *
 * Those tokens are emitted on the stage only when something moved, and are
 * derived from the creator's own text colour, so a dark-rose theme keeps its
 * dark rose on the pink page even while its bubble text had to go light.
 * Anything it cannot read — an image or a gradient underneath, a colour it
 * cannot resolve — it leaves alone.
 */

export interface ElementInk {
  /** What lies under it on this canvas, as drawn. */
  ground: Rgba;
  /** Replacement for the element's own text colour (text elements, plain list rows). */
  color?: string;
  /** Custom properties for a part's root: the ink its on-page words use. */
  vars?: Record<string, string>;
}

export interface InkPlan {
  /** Tokens to add on the stage root. */
  tokens: Record<string, string>;
  /** Extra stylesheet rules (the parts' card text on a panel that moved). */
  css: string[];
  /** Per judged element, per canvas: its ground, and what changed. */
  elements: Map<UiElement, { phone?: ElementInk; desktop?: ElementInk }>;
}

const EMPTY: InkPlan = { tokens: {}, css: [], elements: new Map() };

/** Text the platform draws when a theme sets none. */
const DEFAULT_TEXT = "#f1ece4";

/** How much of a part's area must lie on a box for the box to be its ground. */
const ON_BOX = 0.6;

const PART_TYPES = new Set(["list", "choice", "field"]);
/** Parts drawn by the shared runtime (a `.yp` root), which read the vars. */
const isRuntimePart = (el: UiElement) => el.type === "choice" || el.type === "field" || (el.type === "list" && !!el.card);

const PURE_TEXT = /^\s*var\(\s*--yc-text\s*(?:,[^()]*(?:\([^()]*\))?[^()]*)?\)\s*$/;
const QUIET_TEXT = /^\s*color-mix\(\s*in\s+srgb\s*,\s*var\(\s*--yc-text\b[^()]*(?:\([^()]*\))?[^()]*\)\s*[\d.]+%\s*,\s*transparent\s*\)\s*$/;
const USES_TEXT = /var\(\s*--yc-text\s*[,)]/;

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

type Canvas = "phone" | "desktop";
type Rect = { x: number; y: number; w: number; h: number };

function rectOn(el: UiElement, canvas: Canvas): Rect | null {
  const b = canvas === "phone" || el.desktop === undefined
    ? { x: num(el.x, 0), y: num(el.y, 0), w: num(el.w, 0), h: num(el.h, 0) }
    : el.desktop === null ? null
    : { x: num(el.desktop.x, 0), y: num(el.desktop.y, 0), w: num(el.desktop.w, 0), h: num(el.desktop.h, 0) };
  return b && b.w > 0 && b.h > 0 ? b : null;
}

function onBox(inner: Rect, outer: Rect): boolean {
  const w = Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x);
  const h = Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y);
  return w > 0 && h > 0 && w * h >= ON_BOX * inner.w * inner.h;
}

const same = (a: Rgba, b: Rgba) =>
  Math.abs(a.r - b.r) < 0.5 && Math.abs(a.g - b.g) < 0.5 && Math.abs(a.b - b.b) < 0.5;

/** `fills` (index 0 on top, as CSS paints them) over an opaque `under`, the
 *  whole box at `opacity`; null when a layer is an image, a gradient or a
 *  colour that cannot be read. */
function paintFills(fills: UiFill[] | undefined, under: Rgba, opacity: number, tokens: Record<string, string>): Rgba | null {
  if (!Array.isArray(fills) || fills.length === 0) return under;
  let stacked = under;
  for (let i = fills.length - 1; i >= 0; i--) {
    const fill = fills[i];
    if (!fill || fill.kind !== "color") return null;
    const c = resolveCssColor(fill.color, tokens);
    if (!c) return null;
    stacked = composite(c, stacked);
  }
  return composite({ ...stacked, a: Math.max(0, Math.min(1, opacity)) }, under);
}

export function planInk(
  doc: UiDoc,
  drawn: Record<string, string> | undefined,
  original: Record<string, string> | undefined,
): InkPlan {
  const tokens = drawn ?? {};
  const page = themeGround(tokens);
  const drawnText = resolveCssColor(tokenValue(tokens, "--yc-text") ?? DEFAULT_TEXT, tokens);
  if (!drawnText) return EMPTY;
  const preferred = resolveCssColor(tokenValue(original, "--yc-text"), original);

  const out: InkPlan = { tokens: {}, css: [], elements: new Map() };
  const memo = new Map<string, GroundInk>();
  const inkFor = (g: Rgba) => {
    const key = cssHex(g);
    let ink = memo.get(key);
    if (!ink) memo.set(key, (ink = inkOnGround(g, drawnText, preferred)));
    return ink;
  };

  // The two named grounds and their tokens, emitted only when they moved.
  const named: Array<{ ground: Rgba; text?: string; muted?: string }> = [];
  const panelRaw = tokenValue(tokens, "--yc-input-bg");
  const panelColor = panelRaw ? resolveCssColor(panelRaw, tokens) : null;
  const panel = page && panelColor ? (panelColor.a >= 1 ? panelColor : composite(panelColor, page)) : null;
  let panelMoved = false;
  for (const [prefix, ground] of [["page", page], ["panel", panel]] as const) {
    if (!ground) continue;
    const ink = inkFor(ground);
    const entry: { ground: Rgba; text?: string; muted?: string } = { ground };
    if (ink.textMoved) {
      out.tokens[`--yc-${prefix}-text`] = cssHex(ink.text);
      entry.text = `var(--yc-${prefix}-text)`;
    }
    if (ink.mutedMoved) {
      out.tokens[`--yc-${prefix}-text-muted`] = cssHex(ink.muted);
      entry.muted = `var(--yc-${prefix}-text-muted)`;
    }
    if (prefix === "panel" && ink.textMoved) panelMoved = true;
    named.push(entry);
  }
  // A part's cards are drawn on the input surface; when the text had to move
  // for that surface, the cards' text follows (a look's own inks, set later
  // in the sheet on the element, still win).
  if (panelMoved) {
    out.css.push("[data-ui-stage] .yp{--yp-text:var(--yc-panel-text);--yp-muted:var(--yc-panel-text-muted,color-mix(in srgb,var(--yp-text) 64%,transparent))}");
  }
  const partText = panelMoved && panel ? inkFor(panel).text : drawnText;

  const inkRef = (g: Rgba, role: "text" | "muted") => {
    const hit = named.find((e) => same(e.ground, g));
    const ref = hit?.[role];
    if (ref) return ref;
    const ink = inkFor(g);
    return cssHex(role === "text" ? ink.text : ink.muted);
  };

  /** A replacement for a colour that references `--yc-text`, or undefined
   *  when it already reads on `g`. */
  const fixColor = (raw: string | undefined, g: Rgba, size: number, weight: number): string | undefined => {
    if (typeof raw !== "string" || !USES_TEXT.test(raw)) return undefined;
    const c = resolveCssColor(raw, tokens);
    if (!c) return undefined;
    const large = size >= 24 || (size >= 18.5 && weight >= 700);
    const min = large ? 3 : MIN_TEXT_CONTRAST;
    const onG = composite(c, g);
    if (contrastRatio(onG, g) >= min) return undefined;
    if (PURE_TEXT.test(raw)) return inkRef(g, "text");
    if (QUIET_TEXT.test(raw)) return inkRef(g, "muted");
    return cssHex(readableOn(onG, g, MIN_TEXT_CONTRAST, 0.3));
  };

  let partsMoved = false;
  for (const pg of doc.pages ?? []) {
    if (!pg || !Array.isArray(pg.elements)) continue;
    const ground = pageGround(pg, page, tokens);
    if (!ground) continue;
    const ordered = pg.elements
      .filter((el): el is UiElement => !!el && typeof el.type === "string" && typeof el.id === "string")
      .map((el, i) => ({ el, i }))
      .sort((a, b) => num(a.el.z, 0) - num(b.el.z, 0) || a.i - b.i)
      .map((x) => x.el);
    ordered.forEach((el, index) => {
      const isText = el.type === "text";
      const isPart = PART_TYPES.has(el.type);
      if (!isText && !isPart) return;
      for (const canvas of ["phone", "desktop"] as const) {
        const rect = rectOn(el, canvas);
        if (!rect) continue;
        const g = groundUnder(ordered, index, rect, canvas, ground, tokens);
        if (!g) continue;
        const found: ElementInk = { ground: g };
        if (isText) {
          const style = el.style;
          const size = canvas === "desktop" ? num(style?.desktopSize, num(style?.size, 14)) : num(style?.size, 14);
          const color = fixColor(style?.color, g, size, num(style?.weight, 400));
          if (color) found.color = color;
        } else {
          const vars = isRuntimePart(el) ? partVars(g) : undefined;
          if (vars) { found.vars = vars; partsMoved = true; }
          if (el.type === "list" && !el.card && !(el.itemStyle?.fills?.length)) {
            const ts = el.textStyle;
            const size = canvas === "desktop" ? num(ts?.desktopSize, num(ts?.size, 12)) : num(ts?.size, 12);
            const color = fixColor(ts?.color, g, size, num(ts?.weight, 400));
            if (color) found.color = color;
          }
        }
        {
          const entry = out.elements.get(el) ?? {};
          entry[canvas] = found;
          out.elements.set(el, entry);
        }
      }
    });
  }
  // The words a part draws straight on its ground rather than on a card of
  // its own: the field's label, the list's empty line, the choice's filter
  // chips and the chip set's "your own" chip while it is empty.
  if (partsMoved) {
    out.css.push(
      "[data-ui-stage] .yp{--yp-ground-text:var(--ui-ground-text,var(--yp-text));--yp-ground-muted:var(--ui-ground-muted,var(--yp-muted))}",
      "[data-ui-stage] .yp-label{color:var(--yp-ground-text)}",
      "[data-ui-stage] .yp-empty,[data-ui-stage] .yp-chips>.yp-chip:not([aria-pressed=\"true\"]):not([aria-checked=\"true\"]),[data-ui-stage] .yp-chipset .yp-chip.yp-chip-custom:not([aria-checked=\"true\"]){color:var(--yp-ground-muted)}",
    );
  }
  return out;

  /** The ink a part's on-page words (a label, the empty line, a loose chip)
   *  need, when the part's own text does not read on its ground. */
  function partVars(g: Rgba): Record<string, string> | undefined {
    const text = composite(partText, g);
    const quiet = composite({ ...partText, a: partText.a * 0.64 }, g);
    const vars: Record<string, string> = {};
    if (contrastRatio(text, g) < MIN_TEXT_CONTRAST) vars["--ui-ground-text"] = inkRef(g, "text");
    if (contrastRatio(quiet, g) < MIN_TEXT_CONTRAST) vars["--ui-ground-muted"] = inkRef(g, "muted");
    return Object.keys(vars).length ? vars : undefined;
  }
}

/** The ground a page's parts start from: its own colour over the theme's
 *  page, or the theme's page. Null for an image page or one that cannot be read. */
function pageGround(pg: UiPage, theme: Rgba | null, tokens: Record<string, string>): Rgba | null {
  const bg = pg.background;
  if (!bg) return theme;
  if (bg.kind !== "color") return null;
  const c = resolveCssColor(bg.color, tokens);
  if (!c) return null;
  if (c.a >= 1) return c;
  return theme ? composite(c, theme) : null;
}

/** What lies under `rect`: the page, then every box painted before the
 *  element that it sits on. An image or an unreadable fill makes it unknown. */
function groundUnder(
  ordered: UiElement[],
  index: number,
  rect: Rect,
  canvas: Canvas,
  page: Rgba,
  tokens: Record<string, string>,
): Rgba | null {
  let g: Rgba | null = page;
  for (let i = 0; i < index && g; i++) {
    const below = ordered[i]!;
    if (below.type !== "box" && below.type !== "image" && below.type !== "custom") continue;
    const r = rectOn(below, canvas);
    if (!r || !onBox(rect, r)) continue;
    if (below.type !== "box") return null;
    g = paintFills(below.style?.fills, g, num(below.opacity, 1), tokens);
  }
  return g;
}
