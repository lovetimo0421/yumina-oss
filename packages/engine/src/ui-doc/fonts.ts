import type { UiDoc, UiElement } from "./types.js";

/**
 * Web fonts a creator can pick without uploading a file.
 *
 * A font is stored on a part as a plain CSS stack (`"Noto Serif SC", serif`),
 * so a doc stays readable and a stack the creator typed still works. What makes
 * one of THESE fonts actually draw is the compiler noticing the family and
 * loading its stylesheet — see `webFontsHref`.
 *
 * The stylesheet is attached to the document head rather than emitted inside
 * the card: the editor's preview renders into a shadow root, and Chrome ignores
 * `@font-face` declared inside a shadow tree. A face registered on the document
 * is visible to every shadow root under it, and in a played card (an iframe)
 * the head is the iframe's own.
 */
export interface UiWebFont {
  /** The family as CSS names it — the first entry of `stack`. */
  family: string;
  stack: string;
  /** Google Fonts `family=` parameter. */
  google: string;
  /** Which scripts it covers, for grouping in the picker. */
  script: "zh" | "ja" | "latin";
  /** Where it reads best, for the picker's hint. */
  mood: "body" | "display" | "hand" | "pixel" | "mono";
  /** The weights the font actually ships. Anything else is drawn by the
   *  browser smearing the nearest face ("faux bold"), which ruins a
   *  single-weight display face — so the editor offers only these and the
   *  compiler snaps to the nearest. Read off `google`. */
  weights: number[];
}

const g = (family: string, weights = "400;700") =>
  `${family.replace(/ /g, "+")}:wght@${weights}`;

type FontRow = Omit<UiWebFont, "weights">;

const FONT_ROWS: FontRow[] = [
  // Chinese — sliced by unicode-range on Google's side, so a page only
  // downloads the glyphs it draws.
  { family: "Noto Sans SC", stack: `"Noto Sans SC", sans-serif`, google: g("Noto Sans SC", "400;500;700;900"), script: "zh", mood: "body" },
  { family: "Noto Serif SC", stack: `"Noto Serif SC", serif`, google: g("Noto Serif SC", "400;600;900"), script: "zh", mood: "body" },
  { family: "ZCOOL XiaoWei", stack: `"ZCOOL XiaoWei", serif`, google: g("ZCOOL XiaoWei", "400"), script: "zh", mood: "display" },
  { family: "ZCOOL KuaiLe", stack: `"ZCOOL KuaiLe", sans-serif`, google: g("ZCOOL KuaiLe", "400"), script: "zh", mood: "display" },
  { family: "ZCOOL QingKe HuangYou", stack: `"ZCOOL QingKe HuangYou", sans-serif`, google: g("ZCOOL QingKe HuangYou", "400"), script: "zh", mood: "display" },
  { family: "Ma Shan Zheng", stack: `"Ma Shan Zheng", cursive`, google: g("Ma Shan Zheng", "400"), script: "zh", mood: "hand" },
  { family: "Long Cang", stack: `"Long Cang", cursive`, google: g("Long Cang", "400"), script: "zh", mood: "hand" },
  { family: "Zhi Mang Xing", stack: `"Zhi Mang Xing", cursive`, google: g("Zhi Mang Xing", "400"), script: "zh", mood: "hand" },
  // Japanese
  { family: "Zen Maru Gothic", stack: `"Zen Maru Gothic", sans-serif`, google: g("Zen Maru Gothic", "400;700"), script: "ja", mood: "body" },
  { family: "Shippori Mincho", stack: `"Shippori Mincho", serif`, google: g("Shippori Mincho", "400;700"), script: "ja", mood: "body" },
  { family: "DotGothic16", stack: `"DotGothic16", monospace`, google: g("DotGothic16", "400"), script: "ja", mood: "pixel" },
  // Latin
  { family: "Inter", stack: `"Inter", sans-serif`, google: g("Inter", "400;500;600;700;800"), script: "latin", mood: "body" },
  { family: "Lora", stack: `"Lora", serif`, google: g("Lora", "400;600;700"), script: "latin", mood: "body" },
  { family: "Playfair Display", stack: `"Playfair Display", serif`, google: g("Playfair Display", "400;700;900"), script: "latin", mood: "display" },
  { family: "Cinzel", stack: `"Cinzel", serif`, google: g("Cinzel", "400;700;900"), script: "latin", mood: "display" },
  { family: "Cormorant Garamond", stack: `"Cormorant Garamond", serif`, google: g("Cormorant Garamond", "400;600;700"), script: "latin", mood: "display" },
  { family: "Bebas Neue", stack: `"Bebas Neue", sans-serif`, google: g("Bebas Neue", "400"), script: "latin", mood: "display" },
  { family: "Orbitron", stack: `"Orbitron", sans-serif`, google: g("Orbitron", "400;700;900"), script: "latin", mood: "display" },
  { family: "Quicksand", stack: `"Quicksand", sans-serif`, google: g("Quicksand", "400;600;700"), script: "latin", mood: "body" },
  { family: "Caveat", stack: `"Caveat", cursive`, google: g("Caveat", "400;700"), script: "latin", mood: "hand" },
  { family: "Dancing Script", stack: `"Dancing Script", cursive`, google: g("Dancing Script", "400;700"), script: "latin", mood: "hand" },
  { family: "Press Start 2P", stack: `"Press Start 2P", monospace`, google: g("Press Start 2P", "400"), script: "latin", mood: "pixel" },
  { family: "VT323", stack: `"VT323", monospace`, google: g("VT323", "400"), script: "latin", mood: "pixel" },
  { family: "JetBrains Mono", stack: `"JetBrains Mono", monospace`, google: g("JetBrains Mono", "400;700"), script: "latin", mood: "mono" },
];

export const UI_WEB_FONTS: UiWebFont[] = FONT_ROWS.map((f) => ({
  ...f,
  weights: (f.google.split("wght@")[1] ?? "400").split(";").map(Number).filter((w) => Number.isFinite(w)),
}));

/** The first family a CSS stack names, unquoted. */
export function primaryFamily(stack: string | undefined): string | null {
  if (!stack) return null;
  const first = stack.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  return first || null;
}

const BY_FAMILY = new Map(UI_WEB_FONTS.map((f) => [f.family.toLowerCase(), f]));

/** The curated web font a stack starts with, if any. */
export function webFontOf(stack: string | undefined): UiWebFont | null {
  const family = primaryFamily(stack);
  return family ? BY_FAMILY.get(family.toLowerCase()) ?? null : null;
}

/** The weights a stack can really draw, or null when it is not one of the
 *  curated fonts (system stacks and uploaded fonts are left to the browser). */
export function fontWeightsOf(stack: string | undefined): number[] | null {
  return webFontOf(stack)?.weights ?? null;
}

/**
 * The weight a curated font will actually draw for `weight`: the nearest face
 * it ships, preferring the lighter one on a tie. A stack that is not curated
 * keeps the weight it was given.
 */
export function fitFontWeight(stack: string | undefined, weight: number): number {
  const weights = fontWeightsOf(stack);
  if (!weights?.length || weights.includes(weight)) return weight;
  let best = weights[0]!;
  for (const w of weights) if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  return best;
}

/** Every font stack a part draws text with. */
function familiesOf(el: UiElement): Array<string | undefined> {
  const style = (el as { style?: Record<string, unknown> }).style ?? {};
  const out: Array<string | undefined> = [style.family as string | undefined];
  for (const key of ["title", "subtitle", "label", "body", "button", "input"]) {
    const sub = style[key] as { family?: string } | undefined;
    if (sub && typeof sub === "object") out.push(sub.family);
  }
  if (el.type === "list") out.push(el.textStyle?.family);
  // The message layer: each side's type, and each rule's own.
  if (el.type === "chat" || el.type === "messages") {
    const ms = el.messageStyle;
    out.push(ms?.assistant?.text?.family, ms?.user?.text?.family, ms?.greeting?.text?.family);
    for (const rule of Array.isArray(el.rules) ? el.rules : []) out.push(rule?.options?.text?.family);
  }
  return out;
}

/**
 * One Google Fonts stylesheet URL covering every curated font the doc uses,
 * including the theme's `--yc-font` token, or null when it uses none.
 */
export function webFontsHref(doc: UiDoc): string | null {
  const used = new Map<string, UiWebFont>();
  const note = (stack: string | undefined) => {
    const font = webFontOf(stack);
    if (font) used.set(font.family, font);
  };
  for (const page of doc.pages ?? []) {
    for (const el of page?.elements ?? []) if (el) familiesOf(el).forEach(note);
  }
  note(doc.theme?.tokens?.["--yc-font"]);
  if (used.size === 0) return null;
  const params = [...used.values()]
    .sort((a, b) => a.family.localeCompare(b.family))
    .map((f) => `family=${f.google}`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}
