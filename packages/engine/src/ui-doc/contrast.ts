/**
 * Readable theme colours.
 *
 * A card's theme is a set of `--yc-*` tokens, and they are set one at a time —
 * by the assistant (「粉色可爱风」 changed the page to pink and the text to dark
 * rose, but left the official theme's dark bubble and dark composer in place),
 * by a hand edit in the inspector, or by a preset. Nothing tied a surface to
 * the ink drawn on it, so a restyle could leave body text at 1.3:1.
 *
 * `readableThemeTokens` is applied where the tokens are compiled, so every
 * path that sets them is covered: for each surface / ink pair the chat draws,
 * it measures WCAG contrast against the colour the ink actually lands on (a
 * translucent or missing surface lets the page show through) and, below 4.5:1,
 * moves the INK toward black or white — the creator's surface colour is the
 * design; the text is what has to give way. A pair whose colours cannot be
 * read (a gradient, a `var()`) is left alone.
 */

export interface Rgba { r: number; g: number; b: number; a: number }

export const MIN_TEXT_CONTRAST = 4.5;

const NAMED: Record<string, Rgba> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and hsl()/hsla(), plus
 *  white / black / transparent. Anything else is null. */
export function parseCssColor(input: string | undefined): Rgba | null {
  if (!input) return null;
  const value = input.trim().toLowerCase();
  if (value in NAMED) return { ...NAMED[value]! };
  let m = /^#([0-9a-f]{3,8})$/.exec(value);
  if (m) {
    const hex = m[1]!;
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split("").map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value);
  if (m) {
    const channel = (v: string) => (v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v));
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: channel(m[1]!), g: channel(m[2]!), b: channel(m[3]!), a: Math.min(1, Math.max(0, alpha)) };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value);
  if (m) {
    const h = (parseFloat(m[1]!) % 360) / 360;
    const s = parseFloat(m[2]!) / 100;
    const l = parseFloat(m[3]!) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t: number) => {
      const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255, a: alpha };
  }
  return null;
}

/** The first colour a gradient names — for a ground that is a gradient, the
 *  best single stand-in available when `--yc-bg-solid` is not set. */
function firstColorIn(value: string | undefined): Rgba | null {
  if (!value) return null;
  const direct = parseCssColor(value);
  if (direct) return direct;
  const m = /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/i.exec(value);
  return m ? parseCssColor(m[1]) : null;
}

/** `top` painted over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = Math.min(255, Math.max(0, v)) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2 contrast ratio between two opaque colours (1–21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex = (c: Rgba) =>
  "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

/**
 * `fg`, or the nearest colour of the same hue toward black or white that reads
 * at `min` on the opaque `bg`. Moves toward whichever end can reach further; if
 * neither can reach `min` (a mid-grey ground), it goes all the way.
 */
export function readableOn(
  fg: Rgba,
  bg: Rgba,
  min = MIN_TEXT_CONTRAST,
  /** How far past `min` a moved ink should land. 4.5:1 is the floor, and body
   *  text sitting exactly on it still reads as washed out, so text aims a
   *  little higher once it has to move at all. */
  headroom = 0.05,
): Rgba {
  const ink = fg.a < 1 ? composite(fg, bg) : fg;
  if (contrastRatio(ink, bg) >= min) return ink;
  const white = NAMED.white!;
  const black = NAMED.black!;
  const target = contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black;
  const mix = (t: number): Rgba => ({
    r: ink.r + (target.r - ink.r) * t, g: ink.g + (target.g - ink.g) * t, b: ink.b + (target.b - ink.b) * t, a: 1,
  });
  if (contrastRatio(mix(1), bg) < min) return mix(1);
  // Aim a hair above the line: the result is rounded to whole channels when
  // written back as hex, and that rounding must not land it just under.
  const aim = Math.min(min + Math.max(0.05, headroom), contrastRatio(mix(1), bg));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(mid), bg) >= aim) hi = mid;
    else lo = mid;
  }
  return mix(hi);
}

/** The ink/surface pairs the platform chat draws, with the page as the
 *  surface wherever the pair's own surface is missing or see-through. */
const PAIRS: Array<{ fg: string; bg?: string; min?: number }> = [
  { fg: "--yc-text", bg: "--yc-bubble-bg" },
  { fg: "--yc-user-text", bg: "--yc-user-bubble-bg" },
  { fg: "--yc-input-fg", bg: "--yc-input-bg" },
  // The send button carries an icon, not text: WCAG's 3:1 for graphics.
  { fg: "--yc-send-fg", bg: "--yc-send-bg", min: 3 },
  { fg: "--yc-chip-fg", bg: "--yc-chip-bg" },
  { fg: "--yc-name" },
];

/** Ink for a surface whose own ink the theme left to the platform: the
 *  platform's is light, which is right on dark and invisible on light. */
const DEFAULT_INK_ON_LIGHT = "#231d22";

/**
 * The tokens as they should be drawn: every ink the chat puts on a surface
 * reaches 4.5:1 against it. Returns the same object when nothing needed to
 * change, so callers can compare by reference. Keys may be written with or
 * without the leading `--`; the returned object keeps the caller's spelling.
 */
export function readableThemeTokens(
  tokens: Record<string, string> | undefined,
  /** The official preset's own tokens, when the theme is on one. A pair still
   *  exactly as the preset drew it is the preset's design (white on a mid-blue
   *  bubble sits at 4.3:1) and is left alone; only pairs someone changed are
   *  held to the line. */
  designed?: Record<string, string>,
): Record<string, string> | undefined {
  if (!tokens) return tokens;
  const keyOf = (name: string) => (name in tokens ? name : name.slice(2) in tokens ? name.slice(2) : undefined);
  const read = (name: string) => {
    const key = keyOf(name);
    return key === undefined ? undefined : tokens[key];
  };
  const page = parseCssColor(read("--yc-bg-solid")) ?? firstColorIn(read("--yc-bg"));
  const pageOpaque = page ? composite(page, NAMED.black!) : null;
  let out: Record<string, string> | null = null;
  const set = (name: string, value: string) => {
    out ??= { ...tokens };
    out[keyOf(name) ?? name] = value;
  };
  for (const pair of PAIRS) {
    const min = pair.min ?? MIN_TEXT_CONTRAST;
    const headroom = pair.min === undefined ? 1.5 : 0.05;
    if (designed && [pair.fg, pair.bg ?? "--yc-bg-solid", "--yc-bg-solid", "--yc-bg"].every((name) => read(name) === designed[name])) continue;
    const surfaceRaw = pair.bg ? read(pair.bg) : undefined;
    const surface = surfaceRaw !== undefined ? parseCssColor(surfaceRaw) : null;
    if (surfaceRaw !== undefined && !surface) continue; // a gradient / var(): cannot judge
    let ground: Rgba | null;
    if (surface && surface.a >= 1) ground = surface;
    else if (pageOpaque) ground = surface ? composite(surface, pageOpaque) : pageOpaque;
    else continue; // see-through surface, unknown page
    const inkRaw = read(pair.fg);
    if (inkRaw === undefined) {
      // Only a surface the theme itself painted needs an ink supplied — the
      // page alone keeps the platform's own colours, as it always has.
      if (!surface || surface.a === 0) continue;
      if (luminance(ground) > 0.4) set(pair.fg, hex(readableOn(parseCssColor(DEFAULT_INK_ON_LIGHT)!, ground, min, headroom)));
      continue;
    }
    const ink = parseCssColor(inkRaw);
    if (!ink) continue;
    const inkOnGround = ink.a < 1 ? composite(ink, ground) : ink;
    if (contrastRatio(inkOnGround, ground) >= min) continue;
    set(pair.fg, hex(readableOn(ink, ground, min, headroom)));
  }
  return out ?? tokens;
}

// ── Ink on the page ─────────────────────────────────────────────────────────
//
// The pairs above are the chat's. A card's own words — a status label, a
// location, a list's empty line — are drawn in the same `--yc-text` but land
// on the PAGE, or on a panel box, never on a bubble. When the page and the
// bubble disagree (a pink page under the old theme's dark bubble), the one
// `--yc-text` that reads on the bubble cannot also read on the page. So the
// page and the panel get inks of their own, derived here from the creator's
// own text colour and moved only as far as the ground they sit on needs.

/** The share of the text colour a "quiet" line (a label, a caption) is drawn
 *  at — the starters' and layouts' `color-mix(… var(--yc-text) 62%, transparent)`. */
export const QUIET_SHARE = 0.62;

/** A token's value, whether the map spells it with or without `--`. */
export function tokenValue(tokens: Record<string, string> | undefined, name: string): string | undefined {
  if (!tokens) return undefined;
  const bare = name.startsWith("--") ? name.slice(2) : name;
  return tokens[`--${bare}`] ?? tokens[bare];
}

/** Splits `a, b(c, d), e` at top-level commas. */
function topLevelArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(body.slice(start).trim());
  return out;
}

/**
 * A CSS colour value as it will be drawn, with the theme's tokens in hand:
 * plain colours, `var(--token, fallback)` and `color-mix(in srgb, …)` (the
 * forms the editor, the starters and the layouts write). Anything else — a
 * gradient, `oklab` mixing, an unknown variable with no fallback — is null:
 * not judged, left as it is.
 */
export function resolveCssColor(
  value: string | undefined,
  tokens: Record<string, string> | undefined,
  depth = 0,
): Rgba | null {
  if (!value || depth > 8) return null;
  const v = value.trim();
  const plain = parseCssColor(v);
  if (plain) return plain;
  let m = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/i.exec(v);
  if (m) {
    const own = tokenValue(tokens, m[1]!);
    if (own !== undefined) return resolveCssColor(own, tokens, depth + 1);
    return m[2] === undefined ? null : resolveCssColor(m[2], tokens, depth + 1);
  }
  m = /^color-mix\(([\s\S]*)\)$/i.exec(v);
  if (m) {
    const args = topLevelArgs(m[1]!);
    if (args.length !== 3 || !/^in\s+srgb$/i.test(args[0]!)) return null;
    const part = (arg: string) => {
      const pm = /^([\s\S]*?)\s+(\d+(?:\.\d+)?)%$/.exec(arg);
      return pm ? { color: pm[1]!, pct: parseFloat(pm[2]!) / 100 } : { color: arg, pct: undefined as number | undefined };
    };
    const a = part(args[1]!);
    const b = part(args[2]!);
    const ca = resolveCssColor(a.color, tokens, depth + 1);
    const cb = resolveCssColor(b.color, tokens, depth + 1);
    if (!ca || !cb) return null;
    let pa = a.pct ?? (b.pct === undefined ? 0.5 : 1 - b.pct);
    let pb = b.pct ?? 1 - pa;
    const sum = pa + pb;
    if (!(sum > 0)) return null;
    // Percentages summing under 100% leave the rest transparent (CSS Color 5).
    const scale = Math.min(1, sum);
    pa /= sum;
    pb /= sum;
    const alpha = ca.a * pa + cb.a * pb;
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k: "r" | "g" | "b") => (ca[k] * ca.a * pa + cb[k] * cb.a * pb) / alpha;
    return { r: ch("r"), g: ch("g"), b: ch("b"), a: alpha * scale };
  }
  return null;
}

/** The page the theme paints, as an opaque colour — `--yc-bg-solid`, or the
 *  first colour of a gradient `--yc-bg`. Null when the theme paints none (the
 *  card then sits on the app's own ground, which is not the card's to judge). */
export function themeGround(tokens: Record<string, string> | undefined): Rgba | null {
  const page = parseCssColor(tokenValue(tokens, "--yc-bg-solid")) ?? firstColorIn(tokenValue(tokens, "--yc-bg"));
  return page ? composite(page, NAMED.black!) : null;
}

export interface GroundInk {
  /** Full-strength text on this ground. */
  text: Rgba;
  /** A quiet line (label, caption) on this ground. */
  muted: Rgba;
  /** Whether `text` differs from the drawn `--yc-text`. */
  textMoved: boolean;
  /** Whether `muted` differs from the drawn `--yc-text` at QUIET_SHARE. */
  mutedMoved: boolean;
}

/**
 * The inks for words on `ground`. Text is the drawn `--yc-text` when that
 * reads; otherwise the creator's own pick (`preferred`, the theme's text as
 * they set it, before the bubble pair moved it) when THAT reads; otherwise
 * the pick moved toward black or white until it does. The quiet ink is the
 * text at QUIET_SHARE over the ground, raised to 4.5:1 only if it falls short.
 */
export function inkOnGround(ground: Rgba, drawn: Rgba, preferred?: Rgba | null): GroundInk {
  const reads = (c: Rgba) => contrastRatio(c.a < 1 ? composite(c, ground) : c, ground) >= MIN_TEXT_CONTRAST;
  let text: Rgba;
  let textMoved = true;
  if (reads(drawn)) { text = drawn; textMoved = false; }
  else if (preferred && reads(preferred)) text = preferred.a < 1 ? composite(preferred, ground) : preferred;
  else text = readableOn(preferred ?? drawn, ground, MIN_TEXT_CONTRAST, 1.5);
  const quiet = composite({ ...text, a: (text.a < 1 ? text.a : 1) * QUIET_SHARE }, ground);
  const quietReads = contrastRatio(quiet, ground) >= MIN_TEXT_CONTRAST;
  const muted = quietReads ? quiet : readableOn(quiet, ground, MIN_TEXT_CONTRAST, 0.3);
  return { text, muted, textMoved, mutedMoved: textMoved || !quietReads };
}

export { hex as cssHex };
