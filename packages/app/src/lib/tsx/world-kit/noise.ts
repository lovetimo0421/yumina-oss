/**
 * Tileable noise for the world kit's procedural materials. Every function here
 * wraps at integer periods, so a texture made from them repeats without seams.
 * Pure math, no three.js.
 */

export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mod = (a: number, p: number) => ((a % p) + p) % p;
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise in [0,1], periodic with `period` lattice cells on both axes. */
export function vnoise(x: number, y: number, period: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = fade(x - xi), fy = fade(y - yi);
  const x0 = mod(xi, period), x1 = mod(xi + 1, period), y0 = mod(yi, period), y1 = mod(yi + 1, period);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal value noise over a unit tile: u,v in [0,1), `freq` cells across at the base octave. */
export function fbm(u: number, v: number, freq: number, octaves = 4, seed = 0, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(u * f, v * f, f, seed + o * 101) * amp;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Anisotropic fbm: different cell counts along u and v (grain, brushed metal, fibres). */
export function fbm2(u: number, v: number, fu: number, fv: number, octaves = 3, seed = 0): number {
  let sum = 0, amp = 1, norm = 0, a = fu, b = fv;
  for (let o = 0; o < octaves; o++) {
    const xi = u * a, yi = v * b;
    const x0 = Math.floor(xi), y0 = Math.floor(yi);
    const fx = fade(xi - x0), fy = fade(yi - y0);
    const s = seed + o * 131;
    const p = hash2(mod(x0, a), mod(y0, b), s), q = hash2(mod(x0 + 1, a), mod(y0, b), s);
    const r = hash2(mod(x0, a), mod(y0 + 1, b), s), t = hash2(mod(x0 + 1, a), mod(y0 + 1, b), s);
    sum += (p + (q - p) * fx + (r - p) * fy + (p - q - r + t) * fx * fy) * amp;
    norm += amp; amp *= 0.5; a *= 2; b *= 2;
  }
  return sum / norm;
}

/** Tileable cellular noise: nearest and second-nearest feature distance (in cell units) and the nearest cell's id. */
export function worley(u: number, v: number, cells: number, seed = 0, jitter = 0.9): { f1: number; f2: number; id: number } {
  const x = u * cells, y = v * cells;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j;
    const wx = mod(cx, cells), wy = mod(cy, cells);
    const px = cx + 0.5 + (hash2(wx, wy, seed) - 0.5) * jitter;
    const py = cy + 0.5 + (hash2(wx, wy, seed + 7) - 0.5) * jitter;
    const d = Math.hypot(px - x, py - y);
    if (d < f1) { f2 = f1; f1 = d; id = wy * cells + wx; } else if (d < f2) f2 = d;
  }
  return { f1, f2, id };
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
