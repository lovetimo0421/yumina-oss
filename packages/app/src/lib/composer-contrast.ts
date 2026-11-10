// Colour math for the sandbox composer guard (sandbox/chat/composer-guard.ts).
// Kept DOM-free so it can be unit tested.

export type Rgba = { r: number; g: number; b: number; a: number };

/** Parse a computed CSS colour (`rgb()`/`rgba()`/`#hex`/`transparent`). Returns null for anything else. */
export function parseColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  // Tailwind 4 opacity modifiers compute to oklab()/oklch(), not rgba().
  const ok = v.match(/^(oklab|oklch)\(\s*([\d.]+%?)\s+(-?[\d.]+%?)\s+(-?[\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (ok) {
    const num = (s: string, pct: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * pct : parseFloat(s));
    const L = num(ok[2], 1);
    let A: number, B: number;
    if (ok[1] === "oklab") { A = num(ok[3], 0.4); B = parseFloat(ok[4]); }
    else { const C = num(ok[3], 0.4); const h = (parseFloat(ok[4]) * Math.PI) / 180; A = C * Math.cos(h); B = C * Math.sin(h); }
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const enc = (x: number) => {
      const c = Math.min(1, Math.max(0, x));
      return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
    };
    return {
      r: enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
      a: ok[5] === undefined ? 1 : num(ok[5], 1),
    };
  }
  const fn = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (!fn) return null;
  let a = 1;
  if (fn[4] !== undefined) a = fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
  return { r: +fn[1], g: +fn[2], b: +fn[3], a };
}

/** Paint `top` over `bottom` (source-over). The result is as opaque as the pair allows. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

export function luminance(c: Rgba): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** WCAG contrast of `fg` drawn over an opaque `bg` (fg alpha is blended in first). */
export function contrast(fg: Rgba, bg: Rgba): number {
  const solidBg = bg.a < 1 ? composite(bg, { r: 0, g: 0, b: 0, a: 1 }) : bg;
  const painted = fg.a < 1 ? composite(fg, solidBg) : fg;
  const l1 = luminance(painted);
  const l2 = luminance(solidBg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export const INK_ON_LIGHT = "#1f1b16";
export const INK_ON_DARK = "#f2ede3";

/** The readable text colour for a surface. */
export function inkFor(bg: Rgba): string {
  const dark = parseColor(INK_ON_LIGHT)!;
  const light = parseColor(INK_ON_DARK)!;
  return contrast(dark, bg) >= contrast(light, bg) ? INK_ON_LIGHT : INK_ON_DARK;
}

export function toCss(c: Rgba): string {
  const n = (v: number) => Math.round(v);
  return `rgba(${n(c.r)}, ${n(c.g)}, ${n(c.b)}, ${Math.round(c.a * 1000) / 1000})`;
}

/** True when a computed `border-*-width`/colour pair actually draws a line. */
export function drawsBorder(width: string, color: string): boolean {
  const c = parseColor(color);
  return parseFloat(width) >= 1 && !!c && c.a >= 0.25;
}
