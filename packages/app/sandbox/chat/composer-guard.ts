import { useEffect, type RefObject } from "react";
import {
  composite,
  contrast,
  drawsBorder,
  inkFor,
  parseColor,
  toCss,
  type Rgba,
} from "../../src/lib/composer-contrast";

// Card CSS restyles the built-in composer constantly, and two mistakes keep
// shipping (hand-written cards and Studio-agent output alike):
//
// 1. Boxing the textarea on its own (border/background/glow on
//    .play-composer-textarea) while the toolbar under it keeps the platform
//    look, so the composer reads as two mismatched halves.
// 2. Repainting the composer surface (white, parchment, see-through over a
//    scene image) without repainting the platform text drawn on it, so the
//    typed text, placeholder and toolbar labels disappear.
//
// Card CSS lives in the same document and routinely uses !important with
// stacked :root specificity, so a stylesheet can't win. This guard measures
// what actually got painted and corrects it with inline !important (which
// beats any author stylesheet): the composer card is the one surface, the
// textarea never draws its own box, and every label on it stays readable.

const GUARD_ATTR = "data-composer-guard";
const BODY_MIN = 4.5;
const LABEL_MIN = 3;
// Icons are often deliberately faint (chevrons, separators); only rescue the
// ones that have all but vanished.
const ICON_MIN = 2;
// The platform's own composer is ~0.58 alpha with a backdrop blur and reads
// fine over scene art; only surfaces thinner than these floors get a plate.
const SEE_THROUGH = 0.5;
const SEE_THROUGH_BLURRED = 0.35;
const PLATE_ALPHA = 0.86;
const MID_GREY: Rgba = { r: 128, g: 128, b: 128, a: 1 };
const PLATFORM_BG: Rgba = { r: 18, g: 19, b: 22, a: 1 };

// Inline properties this guard owns, so each pass can clear its own work
// before re-measuring the card's styles.
const OWNED: Record<string, string[]> = {
  textarea: ["background", "background-color", "background-image", "border-color", "border-width", "box-shadow", "outline", "color", "-webkit-text-fill-color", "caret-color", "--composer-guard-placeholder"],
  grow: ["background", "background-color", "background-image", "border-color", "border-width", "box-shadow"],
  card: ["background-color", "background-image", "border-color", "box-shadow", "backdrop-filter", "-webkit-backdrop-filter"],
  label: ["color", "-webkit-text-fill-color"],
};

function clear(el: HTMLElement, props: string[]) {
  for (const p of props) el.style.removeProperty(p);
}

function set(el: HTMLElement, prop: string, value: string) {
  el.style.setProperty(prop, value, "important");
}

function hasPaintedImage(style: CSSStyleDeclaration, el: Element): boolean {
  if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement) return true;
  return /url\(/.test(style.backgroundImage);
}

/** What sits behind the card: a composited solid colour, and whether an image is in the stack. */
function backdropBehind(card: HTMLElement): { color: Rgba; image: boolean } {
  const rect = card.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { color: PLATFORM_BG, image: false };
  const y = rect.top + rect.height / 2;
  let image = false;
  let layers: Rgba[] = [];
  for (const x of [rect.left + rect.width * 0.2, rect.left + rect.width / 2, rect.left + rect.width * 0.8]) {
    const stack = document.elementsFromPoint(x, y);
    const below: Rgba[] = [];
    for (const el of stack) {
      if (card.contains(el)) continue;
      const style = getComputedStyle(el);
      if (hasPaintedImage(style, el)) { image = true; below.push(MID_GREY); break; }
      const bg = parseColor(style.backgroundColor);
      if (bg && bg.a > 0) {
        below.push(bg);
        if (bg.a >= 0.98) break;
      }
    }
    if (below.length > layers.length) layers = below;
  }
  let color: Rgba = PLATFORM_BG;
  for (let i = layers.length - 1; i >= 0; i--) color = composite(layers[i], color);
  return { color, image };
}

/** Opaque colour actually under `el`, compositing its own and its ancestors' fills down to the card. */
function surfaceUnder(el: Element, card: HTMLElement, cardSurface: Rgba): Rgba {
  const fills: Rgba[] = [];
  for (let node: Element | null = el; node && node !== card; node = node.parentElement) {
    const bg = parseColor(getComputedStyle(node).backgroundColor);
    if (bg && bg.a > 0) fills.push(bg);
  }
  let color = cardSurface;
  for (let i = fills.length - 1; i >= 0; i--) color = composite(fills[i], color);
  return color;
}

function hasOwnText(el: Element): boolean {
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) return true;
  return false;
}

function isUntouchedPlatformCard(card: HTMLElement, style: CSSStyleDeclaration) {
  const border = parseColor(style.borderTopColor);
  const surfaceRgb = style.getPropertyValue("--cloudy-surface-rgb").trim().split(/[\s,]+/).map(Number);
  const bg = parseColor(style.backgroundColor);
  const defaultBg = surfaceRgb.length === 3 && bg
    // The composer's own fill is surface-rgb at an alpha that differs by
    // breakpoint/theme (0.58–0.78); any of those is "not restyled by the card".
    && bg.a >= 0.5 && bg.a <= 0.85
    && surfaceRgb.every((v, i) => Math.abs(v - [bg.r, bg.g, bg.b][i]) < 2);
  return {
    border: !!border && border.a < 0.25,
    background: !!defaultBg,
  };
}

// The card's focus ring hides whether its border is the platform default, so
// the last unfocused reading is reused while the composer has focus.
const lastUntouched = new WeakMap<HTMLElement, { border: boolean; background: boolean }>();

function runGuard(card: HTMLElement, textarea: HTMLTextAreaElement) {
  const grow = textarea.parentElement?.classList.contains("play-composer-grow") ? textarea.parentElement : null;
  clear(textarea, OWNED.textarea);
  if (grow) clear(grow, OWNED.grow);
  clear(card, OWNED.card);
  card.querySelectorAll<HTMLElement>(`[${GUARD_ATTR}]`).forEach((el) => { clear(el, OWNED.label); el.removeAttribute(GUARD_ATTR); });
  textarea.removeAttribute("data-guard-placeholder");

  // 1. One surface. Whatever box the card drew on the textarea moves to the
  //    card (only where the card left that part at the platform default), and
  //    the textarea itself goes flat.
  const cardStyle = getComputedStyle(card);
  let untouched = isUntouchedPlatformCard(card, cardStyle);
  if (card.matches(":focus-within")) untouched = lastUntouched.get(card) ?? untouched;
  else lastUntouched.set(card, untouched);
  for (const el of grow ? [grow, textarea] : [textarea]) {
    const s = getComputedStyle(el);
    if (untouched.border && drawsBorder(s.borderTopWidth, s.borderTopColor)) {
      set(card, "border-color", s.borderTopColor);
      if (s.boxShadow && s.boxShadow !== "none") set(card, "box-shadow", s.boxShadow);
    }
    const fill = parseColor(s.backgroundColor);
    if (untouched.background && fill && fill.a >= 0.5) {
      set(card, "background-color", s.backgroundColor);
      set(card, "background-image", "none");
    }
  }
  for (const el of grow ? [grow, textarea] : [textarea]) {
    set(el, "background", "transparent");
    set(el, "border-color", "transparent");
    set(el, "box-shadow", "none");
  }
  set(textarea, "outline", "none");

  // 2. A see-through composer over a scene image gets a plate, or nothing
  //    can be guaranteed readable.
  const finalCard = getComputedStyle(card);
  let own = parseColor(finalCard.backgroundColor) ?? { r: 0, g: 0, b: 0, a: 0 };
  const behind = backdropBehind(card);
  const blurred = /blur\(/.test(finalCard.backdropFilter || finalCard.getPropertyValue("-webkit-backdrop-filter"));
  if (behind.image && own.a < (blurred ? SEE_THROUGH_BLURRED : SEE_THROUGH)) {
    const base = own.a > 0.05 ? own : parseColor(finalCard.getPropertyValue("--color-background").trim()) ?? PLATFORM_BG;
    own = { ...base, a: PLATE_ALPHA };
    set(card, "background-color", toCss(own));
    set(card, "backdrop-filter", "blur(14px)");
    set(card, "-webkit-backdrop-filter", "blur(14px)");
  }
  const surface = composite(own, behind.color);

  // 3. Every label drawn on the composer clears a contrast floor.
  const fixText = (el: HTMLElement, min: number) => {
    const s = getComputedStyle(el);
    // Cards sometimes force -webkit-text-fill-color, which paints over
    // `color`; only then does the fix have to override it too. Setting it
    // unconditionally would leak into every descendant (it inherits).
    const forcedFill = !!s.webkitTextFillColor && s.webkitTextFillColor !== s.color;
    const fg = parseColor(forcedFill ? s.webkitTextFillColor : s.color);
    if (!fg) return;
    const under = surfaceUnder(el, card, surface);
    if (contrast(fg, under) >= min) return;
    const ink = inkFor(under);
    set(el, "color", ink);
    if (forcedFill) set(el, "-webkit-text-fill-color", ink);
    el.setAttribute(GUARD_ATTR, "");
  };
  fixText(textarea, BODY_MIN);
  if (textarea.hasAttribute(GUARD_ATTR)) set(textarea, "caret-color", getComputedStyle(textarea).color);
  const placeholder = parseColor(getComputedStyle(textarea, "::placeholder").color);
  const taSurface = surfaceUnder(textarea, card, surface);
  if (placeholder && contrast(placeholder, taSurface) < LABEL_MIN) {
    textarea.style.setProperty("--composer-guard-placeholder", inkFor(taSurface));
    textarea.setAttribute("data-guard-placeholder", "");
  }
  card.querySelectorAll<HTMLElement>("button, a, span, label, p, div, svg").forEach((el) => {
    if (el === textarea || !el.getClientRects().length) return;
    if (el.tagName.toLowerCase() === "svg") fixText(el, ICON_MIN);
    else if (el.tagName === "BUTTON" || hasOwnText(el)) fixText(el, LABEL_MIN);
  });
}

/**
 * Keeps the built-in composer one readable surface no matter what the card's
 * CSS does to it. Re-runs when card styles land, the card's theme attributes
 * change, or composer content (popovers, banners) mounts.
 */
export function useComposerGuard(
  cardRef: RefObject<HTMLElement | null>,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const card = cardRef.current;
    const textarea = textareaRef.current;
    if (!active || !card || !textarea) return;
    let frame = 0;
    let timer = 0;
    let lastRun = 0;
    // React re-renders can rewrite an element's inline style (dropping the
    // guard's fix) without adding nodes, so style/class edits re-run it too.
    // The guard's own writes are discarded via takeRecords() after each pass.
    const inside = new MutationObserver(() => schedule());
    const run = () => {
      frame = 0;
      lastRun = performance.now();
      // Measuring mid-transition reads half-faded colours (the card fades its
      // background over 0.18s), so transitions are off while the guard works.
      card.setAttribute("data-guard-measuring", "");
      try { runGuard(card, textarea); } catch (err) { console.warn("[composer-guard]", err); } // never break typing
      finally {
        card.removeAttribute("data-guard-measuring");
        inside.takeRecords();
      }
    };
    // At most one pass per 200ms: some composer children (the voice meter)
    // rewrite their inline style every frame.
    const schedule = () => {
      if (frame || timer) return;
      const wait = 200 - (performance.now() - lastRun);
      if (wait > 0) timer = window.setTimeout(() => { timer = 0; schedule(); }, wait);
      else frame = requestAnimationFrame(run);
    };
    schedule();
    const timers = [300, 1500].map((ms) => window.setTimeout(schedule, ms));

    const head = new MutationObserver(schedule);
    head.observe(document.head, { childList: true, subtree: true, characterData: true });
    inside.observe(card, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style", "class"] });
    const ancestors = new MutationObserver(schedule);
    for (let node = card.parentElement; node; node = node.parentElement) {
      ancestors.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode"] });
    }
    card.addEventListener("focusout", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      timers.forEach(clearTimeout);
      head.disconnect();
      inside.disconnect();
      ancestors.disconnect();
      card.removeEventListener("focusout", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [cardRef, textareaRef, active]);
}
