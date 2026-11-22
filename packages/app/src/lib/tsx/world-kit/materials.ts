/**
 * The world kit's material library: physically based surfaces painted in code
 * (colour, relief and shine from tileable noise), so a world looks textured with
 * nothing to download and nothing for the creator to draw. Every texture is a
 * DataTexture built in memory, which the card sandbox's no-fetch policy cannot
 * block. UVs in the kit are in metres; `scale` is how many metres one tile spans.
 */
import * as THREE from "three";
import { clamp01, fbm, fbm2, hash2, lerp, smooth, vnoise, worley } from "./noise";

export type RGB = [number, number, number];

export interface MaterialOptions {
  type?: string;
  color?: string;
  color2?: string;
  scale?: number;
  /** 0 = new, 1 = old and stained. */
  wear?: number;
  /** Multiplies the surface's roughness: below 1 is shinier. */
  rough?: number;
  wet?: boolean;
  pattern?: string;
  metal?: number;
  emissive?: string;
  glow?: number;
  opacity?: number;
  /** A picture asset as the surface ("@asset:<id>" or a URL). */
  image?: string;
  seed?: number;
  side?: "front" | "double";
}

interface SynthParams {
  c: RGB;
  c2: RGB;
  wear: number;
  wet: boolean;
  pattern: string;
  seed: number;
}

interface Sample { r: number; g: number; b: number; h: number; rough: number; metal?: number }

interface MaterialDef {
  color: string;
  color2?: string;
  scale: number;
  /** Relief depth of the height map in metres; drives the normal map. */
  depth: number;
  metal: number;
  synth: (u: number, v: number, p: SynthParams, out: Sample) => void;
}

export function parseColor(hex: string | undefined, fallback: string): RGB {
  const c = new THREE.Color();
  c.setStyle(fallback);
  if (hex) { const t = new THREE.Color(-1, -1, -1); t.setStyle(hex); if (t.r >= 0) c.copy(t); }
  const out = { r: 0, g: 0, b: 0 };
  c.getRGB(out, THREE.SRGBColorSpace);
  return [out.r, out.g, out.b];
}

const set = (o: Sample, c: RGB, k: number, h: number, rough: number) => {
  o.r = c[0] * k; o.g = c[1] * k; o.b = c[2] * k; o.h = h; o.rough = rough;
};
const mix3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Plank layout shared by floors and wall panelling: boards run along u. */
function planks(u: number, v: number, rows: number, perRow: number, seed: number) {
  const row = Math.floor(v * rows);
  const fy = v * rows - row;
  const off = hash2(row, 3, seed);
  const x = (u + off) * perRow;
  const seg = Math.floor(x);
  const fx = x - seg;
  const id = hash2(row, ((seg % perRow) + perRow) % perRow, seed + 1);
  return { row, fy, fx, id };
}

const DEFS: Record<string, MaterialDef> = {
  plaster: {
    color: "#b9b4a6", scale: 2, depth: 0.0025, metal: 0,
    synth(u, v, p, o) {
      const n1 = fbm(u, v, 4, 4, p.seed), n2 = fbm(u, v, 24, 3, p.seed + 5), n3 = vnoise(u * 192, v * 192, 192, p.seed + 9);
      const stain = smooth(0.55, 0.85, fbm(u, v, 5, 4, p.seed + 11)) * p.wear;
      const streak = smooth(0.62, 0.9, fbm2(u, v, 10, 2, 3, p.seed + 13)) * p.wear * 0.5;
      const k = 0.9 + (n1 - 0.5) * 0.1 + (n2 - 0.5) * 0.08 - stain * 0.13 - streak * 0.08;
      set(o, p.c, k, n1 * 0.3 + n2 * 0.45 + n3 * 0.25, 0.86 + n2 * 0.1);
    },
  },
  paint: {
    color: "#c9c3b5", scale: 2, depth: 0.0008, metal: 0,
    synth(u, v, p, o) {
      const n1 = fbm(u, v, 3, 3, p.seed), n2 = fbm(u, v, 40, 2, p.seed + 3);
      const stain = smooth(0.55, 0.85, fbm(u, v, 4, 3, p.seed + 7)) * p.wear;
      set(o, p.c, 0.95 + (n1 - 0.5) * 0.07 - stain * 0.22, n2 * 0.7 + n1 * 0.3, 0.62 + n2 * 0.12 + stain * 0.2);
    },
  },
  wood: {
    color: "#7a5636", scale: 1, depth: 0.0006, metal: 0,
    synth(u, v, p, o) {
      const warp = fbm(u, v, 3, 3, p.seed) * 2.5;
      const rings = 0.5 + 0.5 * Math.sin((v * 18 + warp) * Math.PI * 2);
      const g = fbm2(u, v, 3, 64, 3, p.seed + 3);
      const pore = vnoise(u * 256, v * 512, 256, p.seed + 5) > 0.93 ? 1 : 0;
      const k = 0.8 + (g - 0.5) * 0.3 + (rings - 0.5) * 0.1 - pore * 0.1;
      const c = mix3(p.c, [p.c[0] * 0.7, p.c[1] * 0.62, p.c[2] * 0.56], smooth(0.6, 1, rings) * 0.35);
      set(o, c, k, g * 0.6 + rings * 0.25 - pore * 0.3, 0.55 + (1 - g) * 0.2 + p.wear * 0.15);
    },
  },
  "wood-floor": {
    color: "#6b4a2e", scale: 2, depth: 0.0018, metal: 0,
    synth(u, v, p, o) {
      const rows = 14;
      const pl = planks(u, v, rows, 1, p.seed);
      const edge = Math.min(pl.fy, 1 - pl.fy) * (2 / rows), endEdge = Math.min(pl.fx, 1 - pl.fx) * 2;
      const gap = Math.min(edge, endEdge);
      const groove = smooth(0.0006, 0.0025, gap);
      const g = fbm2(u + pl.id * 7, v, 3, 110, 3, p.seed + Math.floor(pl.id * 50));
      const fig = fbm2(u + pl.id * 3, v, 2, 14, 3, p.seed + 2);
      const tone = 0.86 + (pl.id - 0.5) * 0.22;
      const worn = smooth(0.5, 0.8, fbm(u, v, 2, 3, p.seed + 17)) * p.wear;
      const k = (tone + (g - 0.5) * 0.26 + (fig - 0.5) * 0.16) * (0.4 + 0.6 * groove) + worn * 0.08;
      set(o, p.c, k, groove * (0.88 + g * 0.12), lerp(0.4 + pl.id * 0.15 + (1 - g) * 0.1, 0.95, 1 - groove) + worn * 0.25);
    },
  },
  "wood-panel": {
    color: "#5a3b22", scale: 2, depth: 0.003, metal: 0,
    synth(u, v, p, o) {
      const pl = planks(v, u, 12, 1, p.seed);
      const edge = Math.min(pl.fy, 1 - pl.fy) * (2 / 12);
      const groove = smooth(0.002, 0.007, edge);
      const g = fbm2(v + pl.id * 5, u, 3, 70, 3, p.seed + 4);
      const k = (0.78 + pl.id * 0.3 + (g - 0.5) * 0.38) * (0.4 + 0.6 * groove);
      set(o, p.c, k, groove, 0.5 + (1 - groove) * 0.4 + p.wear * 0.2);
    },
  },
  tatami: {
    color: "#b5ad74", color2: "#2b2b26", scale: 1.8, depth: 0.0015, metal: 0,
    synth(u, v, p, o) {
      const half = v < 0.5 ? v * 2 : (v - 0.5) * 2;
      const border = Math.min(half, 1 - half) < 0.035;
      const weave = 0.5 + 0.5 * Math.sin(u * 180 * Math.PI * 2);
      const n = fbm2(u, v, 2, 60, 3, p.seed);
      if (border) {
        const t = fbm(u, v, 60, 2, p.seed + 3);
        set(o, p.c2, 0.85 + t * 0.3, 0.7, 0.85);
      } else {
        const k = 0.82 + (n - 0.5) * 0.25 + weave * 0.1 - p.wear * smooth(0.5, 0.8, fbm(u, v, 3, 2, p.seed + 5)) * 0.2;
        set(o, p.c, k, 0.5 + weave * 0.5, 0.8 + weave * 0.1);
      }
    },
  },
  concrete: {
    color: "#8d8b86", scale: 2, depth: 0.002, metal: 0,
    synth(u, v, p, o) {
      const n = fbm(u, v, 6, 5, p.seed), n2 = fbm(u, v, 2, 3, p.seed + 3);
      const w = worley(u, v, 48, p.seed + 5);
      const pore = smooth(0.12, 0.05, w.f1);
      const stain = smooth(0.5, 0.85, n2) * p.wear;
      const k = 0.85 + (n - 0.5) * 0.28 - pore * 0.3 - stain * 0.25;
      set(o, p.c, k, n * 0.7 - pore * 0.5 + 0.3, 0.88 + (n - 0.5) * 0.1);
    },
  },
  brick: {
    color: "#8c4a35", color2: "#b8ad9a", scale: 1, depth: 0.012, metal: 0,
    synth(u, v, p, o) {
      const rows = 16, per = 4;
      const row = Math.floor(v * rows), fy = v * rows - row;
      const x = u * per + (row % 2) * 0.5, bx = Math.floor(x), fx = x - bx;
      const edge = Math.min(Math.min(fx, 1 - fx) / per, Math.min(fy, 1 - fy) / rows);
      const n = fbm(u, v, 24, 3, p.seed);
      const chip = (fbm(u, v, 64, 2, p.seed + 3) - 0.5) * 0.006;
      const brick = smooth(0.005, 0.009, edge + chip);
      const id = hash2(((bx % per) + per) % per, row, p.seed + 7);
      const burnt = id > 0.85 ? 0.6 : 1;
      const bc = mix3(p.c, [p.c[0] * 1.15, p.c[1] * 0.95, p.c[2] * 0.85], hash2(bx, row, p.seed + 9));
      const mortar: RGB = [p.c2[0] * (0.9 + n * 0.15), p.c2[1] * (0.9 + n * 0.15), p.c2[2] * (0.9 + n * 0.15)];
      const soot = smooth(0.55, 0.9, fbm(u, v, 2, 3, p.seed + 13)) * p.wear * 0.4;
      const c = mix3(mortar, bc, brick);
      const k = (brick > 0.5 ? (0.8 + id * 0.35) * burnt + (n - 0.5) * 0.3 : 1) - soot;
      set(o, c, k, brick * (0.8 + n * 0.2), lerp(0.95, 0.78 + n * 0.12, brick));
    },
  },
  stone: {
    color: "#8a857a", color2: "#5b5850", scale: 2, depth: 0.012, metal: 0,
    synth(u, v, p, o) {
      const rows = 5, row = Math.floor(v * rows), fy = v * rows - row;
      const per = 2 + Math.floor(hash2(row, 1, p.seed) * 2.99);
      const x = (u + hash2(row, 2, p.seed)) * per, bx = Math.floor(x), fx = x - bx;
      const wob = (fbm(u, v, 20, 2, p.seed + 3) - 0.5) * 0.012;
      const edge = Math.min(Math.min(fx, 1 - fx) * (2 / per), Math.min(fy, 1 - fy) * (2 / rows)) + wob;
      const block = smooth(0.006, 0.02, edge);
      const id = hash2(((bx % per) + per) % per, row, p.seed + 5);
      const n = fbm(u, v, 12, 5, p.seed + Math.floor(id * 20));
      const c = mix3(p.c, [p.c[0] * 0.9, p.c[1] * 0.92, p.c[2] * 0.98], id);
      const moss = smooth(0.6, 0.85, fbm(u, v, 3, 3, p.seed + 9)) * p.wear * 0.35;
      const k = (0.78 + id * 0.3 + (n - 0.5) * 0.35) * lerp(0.45, 1, block) - moss * 0.2;
      set(o, block > 0.2 ? c : p.c2, k, block * (0.75 + n * 0.25), 0.8 + (1 - block) * 0.15 - (p.wet ? 0.4 : 0));
    },
  },
  "stone-floor": {
    color: "#9a948a", color2: "#4e4b45", scale: 3, depth: 0.006, metal: 0,
    synth(u, v, p, o) {
      const rows = 4, row = Math.floor(v * rows), fy = v * rows - row;
      const per = 2 + Math.floor(hash2(row, 1, p.seed) * 1.99);
      const x = (u + hash2(row, 2, p.seed)) * per, bx = Math.floor(x), fx = x - bx;
      const edge = Math.min(Math.min(fx, 1 - fx) * (3 / per), Math.min(fy, 1 - fy) * (3 / rows));
      const slab = smooth(0.003, 0.009, edge);
      const id = hash2(((bx % per) + per) % per, row, p.seed + 5);
      const n = fbm(u, v, 10, 5, p.seed + Math.floor(id * 30));
      const worn = smooth(0.45, 0.75, fbm(u, v, 2, 3, p.seed + 7)) * p.wear;
      const vein = Math.pow(1 - Math.abs(Math.sin((u * 3 + v * 2) * Math.PI * 2 + fbm(u, v, 5, 4, p.seed + 9) * 6)), 14) * 0.18;
      const pit = smooth(0.1, 0.03, worley(u, v, 40, p.seed + 11).f1) * 0.25;
      const k = (0.78 + id * 0.3 + (n - 0.5) * 0.42 - vein - pit) * lerp(0.4, 1, slab) + worn * 0.06;
      set(o, slab > 0.3 ? p.c : p.c2, k, slab * (0.85 + n * 0.15), lerp(0.9, 0.62 - worn * 0.25 + n * 0.15, slab) - (p.wet ? 0.35 : 0));
    },
  },
  cobblestone: {
    color: "#7b7770", color2: "#3e3b36", scale: 1.5, depth: 0.03, metal: 0,
    synth(u, v, p, o) {
      const w = worley(u, v, 10, p.seed, 0.75);
      const e = w.f2 - w.f1;
      const dome = smooth(0.0, 0.45, e);
      const id = hash2(w.id, 3, p.seed);
      const n = fbm(u, v, 30, 3, p.seed + 5);
      const k = (0.7 + id * 0.45 + (n - 0.5) * 0.25) * lerp(0.35, 1, smooth(0.02, 0.12, e));
      set(o, e > 0.06 ? p.c : p.c2, k, Math.sqrt(dome) * 0.9 + n * 0.1, lerp(0.95, 0.7 + n * 0.15, dome) - (p.wet ? 0.45 : 0));
    },
  },
  tile: {
    color: "#d8d2c4", color2: "#9c968a", scale: 1.2, depth: 0.002, metal: 0,
    synth(u, v, p, o) {
      const n = p.pattern === "small" ? 12 : p.pattern === "subway" ? 8 : 4;
      const rowsY = p.pattern === "subway" ? n * 2 : n;
      const ty = Math.floor(v * rowsY), fy = v * rowsY - ty;
      const xx = u * n + (p.pattern === "subway" ? (ty % 2) * 0.5 : 0);
      const tx = Math.floor(xx), fx = xx - tx;
      const g = 0.0035 / 1.2 * n;
      const edge = Math.min(fx, 1 - fx, fy * (n / rowsY), (1 - fy) * (n / rowsY));
      const tileM = smooth(g * 0.6, g * 1.6, edge);
      const id = hash2(((tx % n) + n) % n, ty, p.seed);
      const check = p.pattern === "checker" && (tx + ty) % 2 === 1;
      const wav = fbm(u, v, 8, 2, p.seed + 3);
      const c = check ? p.c2 : p.c;
      const grout: RGB = p.pattern === "checker" ? [0.55, 0.53, 0.5] : p.c2;
      const dirt = p.wear * smooth(0.5, 0.9, fbm(u, v, 3, 3, p.seed + 5));
      set(o, tileM > 0.5 ? c : grout, (tileM > 0.5 ? 0.94 + id * 0.1 : 0.85) - dirt * 0.2, tileM * (0.92 + wav * 0.08), lerp(0.9, 0.12 + id * 0.06 + dirt * 0.3, tileM));
    },
  },
  marble: {
    color: "#e6e2da", color2: "#6f6a64", scale: 2, depth: 0.0006, metal: 0,
    synth(u, v, p, o) {
      const t = fbm(u, v, 4, 6, p.seed) * 7;
      const vein = Math.pow(1 - Math.abs(Math.sin((u * 2 + v * 3) * Math.PI * 2 + t)), 10);
      const fine = Math.pow(1 - Math.abs(Math.sin((u * 5 - v * 2) * Math.PI * 2 + t * 1.6)), 30) * 0.5;
      const cloud = fbm(u, v, 3, 4, p.seed + 3);
      const seam = p.pattern === "tiles" ? smooth(0.0, 0.004, Math.min(...[u * 2 % 1, 1 - (u * 2 % 1), v * 2 % 1, 1 - (v * 2 % 1)].map((x) => x / 2))) : 1;
      const c = mix3(p.c, p.c2, clamp01(vein * 0.85 + fine) * 0.9);
      set(o, c, (0.92 + (cloud - 0.5) * 0.12) * lerp(0.5, 1, seam), seam, lerp(0.8, 0.1 + cloud * 0.08, seam));
    },
  },
  metal: {
    color: "#a8a9a8", scale: 0.6, depth: 0.0002, metal: 1,
    synth(u, v, p, o) {
      const s = fbm2(u, v, 2, 220, 3, p.seed);
      const smudge = fbm(u, v, 4, 3, p.seed + 3);
      set(o, p.c, 0.85 + (s - 0.5) * 0.18, s, 0.28 + s * 0.14 + smudge * 0.12 + p.wear * 0.25);
    },
  },
  iron: {
    color: "#3a3d3b", color2: "#7a5a42", scale: 1, depth: 0.0006, metal: 0.6,
    synth(u, v, p, o) {
      const n = fbm(u, v, 8, 4, p.seed), chip = smooth(0.66, 0.74, fbm(u, v, 6, 4, p.seed + 3) * 0.6 + n * 0.4 + p.wear * 0.15);
      const rust = smooth(0.6, 0.85, fbm(u, v, 5, 4, p.seed + 7)) * p.wear;
      const c = mix3(mix3(p.c, [0.55, 0.55, 0.55], chip), p.c2, rust);
      set(o, c, 0.85 + (n - 0.5) * 0.25, n * 0.5 + chip * 0.3, 0.55 + n * 0.15 + rust * 0.3 - chip * 0.15);
      o.metal = lerp(0.35, 0.9, chip) * (1 - rust);
    },
  },
  brass: {
    color: "#b08d4f", color2: "#3d3a2a", scale: 0.5, depth: 0.0003, metal: 1,
    synth(u, v, p, o) {
      const n = fbm(u, v, 6, 4, p.seed), patina = smooth(0.55, 0.85, fbm(u, v, 4, 4, p.seed + 3)) * p.wear;
      set(o, mix3(p.c, p.c2, patina * 0.7), 0.9 + (n - 0.5) * 0.15, n, 0.24 + n * 0.12 + patina * 0.4);
      o.metal = 1 - patina * 0.6;
    },
  },
  fabric: {
    color: "#6d6a62", color2: "#3c3a36", scale: 0.5, depth: 0.0008, metal: 0,
    synth(u, v, p, o) {
      const F = 160;
      const a = Math.sin(u * F * Math.PI * 2), b = Math.sin(v * F * Math.PI * 2);
      const over = (Math.floor(u * F) + Math.floor(v * F)) % 2 === 0 ? a : b;
      const fuzz = fbm(u, v, 32, 3, p.seed);
      let c = p.c;
      if (p.pattern === "stripes") c = Math.floor(u * 10) % 2 === 0 ? p.c : p.c2;
      else if (p.pattern === "plaid") { const s = (Math.floor(u * 8) % 2) + (Math.floor(v * 8) % 2); c = mix3(p.c, p.c2, s * 0.35); }
      const blotch = smooth(0.5, 0.85, fbm(u, v, 3, 3, p.seed + 5)) * p.wear;
      set(o, c, 0.82 + over * 0.07 + (fuzz - 0.5) * 0.2 - blotch * 0.2, 0.5 + over * 0.3 + fuzz * 0.2, 0.92 + fuzz * 0.08);
    },
  },
  velvet: {
    color: "#5a1f2a", scale: 0.8, depth: 0.0004, metal: 0,
    synth(u, v, p, o) {
      const crush = fbm(u, v, 6, 4, p.seed), fine = vnoise(u * 256, v * 256, 256, p.seed + 3);
      set(o, p.c, 0.75 + (crush - 0.5) * 0.5 + fine * 0.05, crush, 0.75 + crush * 0.2);
    },
  },
  leather: {
    color: "#5b3a24", scale: 0.4, depth: 0.0008, metal: 0,
    synth(u, v, p, o) {
      const w = worley(u, v, 36, p.seed);
      const crease = smooth(0.0, 0.18, w.f2 - w.f1);
      const n = fbm(u, v, 6, 3, p.seed + 3);
      const rub = smooth(0.55, 0.85, n) * p.wear;
      set(o, p.c, 0.8 + (n - 0.5) * 0.3 + crease * 0.1 + rub * 0.2, crease, 0.45 + (1 - crease) * 0.2 + rub * 0.2);
    },
  },
  paper: {
    color: "#ddd6c2", scale: 0.4, depth: 0.0002, metal: 0,
    synth(u, v, p, o) {
      const n = fbm(u, v, 16, 4, p.seed), fib = fbm2(u, v, 80, 8, 2, p.seed + 3);
      const age = smooth(0.4, 0.9, fbm(u, v, 3, 3, p.seed + 5)) * p.wear;
      set(o, mix3(p.c, [0.62, 0.52, 0.34], age * 0.5), 0.94 + (n - 0.5) * 0.08 + (fib - 0.5) * 0.05, n * 0.5 + fib * 0.5, 0.95);
    },
  },
  carpet: {
    color: "#6b2a24", color2: "#c5a35a", scale: 1, depth: 0.0015, metal: 0,
    synth(u, v, p, o) {
      const fuzz = vnoise(u * 384, v * 384, 384, p.seed), n = fbm(u, v, 8, 3, p.seed + 3);
      let c = p.c;
      if (p.pattern === "diamond") {
        const d = Math.abs(((u * 6) % 1) - 0.5) + Math.abs(((v * 6) % 1) - 0.5);
        if (Math.abs(d - 0.35) < 0.04) c = p.c2;
      }
      set(o, c, 0.78 + fuzz * 0.12 + (n - 0.5) * 0.15, fuzz * 0.6 + n * 0.4, 1);
    },
  },
  grass: {
    color: "#4f6a2e", color2: "#6b5a3a", scale: 2, depth: 0.004, metal: 0,
    synth(u, v, p, o) {
      const blade = vnoise(u * 300, v * 300, 300, p.seed), clump = fbm(u, v, 8, 4, p.seed + 3);
      const dirt = smooth(0.62, 0.78, fbm(u, v, 4, 4, p.seed + 7));
      const c = mix3(mix3(p.c, [p.c[0] * 1.3, p.c[1] * 1.2, p.c[2] * 0.8], clump), p.c2, dirt * 0.8);
      set(o, c, 0.7 + blade * 0.35, blade * 0.6 + clump * 0.4, 0.92);
    },
  },
  dirt: {
    color: "#6b5640", scale: 2, depth: 0.006, metal: 0,
    synth(u, v, p, o) {
      const n = fbm(u, v, 6, 5, p.seed), w = worley(u, v, 30, p.seed + 3);
      const pebble = smooth(0.25, 0.1, w.f1);
      set(o, p.c, 0.75 + (n - 0.5) * 0.4 + pebble * 0.2, n * 0.6 + pebble * 0.4, 0.95 - (p.wet ? 0.5 : 0));
    },
  },
  asphalt: {
    color: "#3a3a3c", scale: 2, depth: 0.002, metal: 0,
    synth(u, v, p, o) {
      const n = fbm(u, v, 8, 4, p.seed), agg = vnoise(u * 400, v * 400, 400, p.seed + 3);
      const puddle = p.wet ? smooth(0.48, 0.56, fbm(u, v, 3, 4, p.seed + 7)) : 0;
      const k = 0.8 + (n - 0.5) * 0.3 + (agg > 0.8 ? 0.25 : 0) - puddle * 0.35;
      set(o, p.c, k, n * 0.4 + agg * 0.3 + 0.3 - puddle * 0.3, lerp(p.wet ? 0.42 : 0.88, 0.04, puddle));
    },
  },
  wallpaper: {
    color: "#7a6f55", color2: "#5f553f", scale: 1.2, depth: 0.0005, metal: 0,
    synth(u, v, p, o) {
      const n = fbm(u, v, 10, 3, p.seed);
      let t = 0;
      if (p.pattern === "stripes") {
        const x = (u * 8) % 1;
        t = x < 0.5 ? 1 : 0;
        if (Math.abs(x - 0.5) < 0.02 || x < 0.02) t = 0.5;
      } else {
        const cx = (u * 4) % 1 - 0.5, cy = (v * 3) % 1 - 0.5;
        const r = Math.hypot(cx * 1.3, cy), a = Math.atan2(cy, cx);
        const petal = Math.abs(Math.cos(a * 3)) * 0.28 + 0.05;
        t = r < petal ? 1 : 0;
        const ox = ((u * 4 + 0.5) % 1) - 0.5, oy = ((v * 3 + 0.5) % 1) - 0.5;
        if (Math.hypot(ox, oy) < 0.06) t = 1;
      }
      const age = smooth(0.5, 0.9, fbm(u, v, 3, 3, p.seed + 3)) * p.wear;
      set(o, mix3(p.c, p.c2, t), 0.92 + (n - 0.5) * 0.08 - age * 0.25, 0.5 + t * 0.3 + n * 0.2, 0.7 - t * 0.1);
    },
  },
  lacquer: {
    color: "#7d1f17", scale: 1, depth: 0.0002, metal: 0,
    synth(u, v, p, o) {
      const g = fbm2(u, v, 3, 50, 3, p.seed), wear = smooth(0.6, 0.9, fbm(u, v, 5, 3, p.seed + 3)) * p.wear;
      set(o, mix3(p.c, [0.25, 0.14, 0.08], wear), 0.9 + (g - 0.5) * 0.1, g, 0.22 + g * 0.08 + wear * 0.4);
    },
  },
  ceramic: {
    color: "#e8e4dc", scale: 0.5, depth: 0.0002, metal: 0,
    synth(u, v, p, o) {
      const n = fbm(u, v, 6, 3, p.seed);
      set(o, p.c, 0.95 + (n - 0.5) * 0.06, n, 0.16 + n * 0.08);
    },
  },
  plastic: {
    color: "#c8c8c8", scale: 0.5, depth: 0.0001, metal: 0,
    synth(u, v, p, o) { const n = fbm(u, v, 8, 2, p.seed); set(o, p.c, 0.96 + (n - 0.5) * 0.04, n, 0.4 + n * 0.1); },
  },
  rubber: {
    color: "#2a2a2a", scale: 0.5, depth: 0.0002, metal: 0,
    synth(u, v, p, o) { const n = fbm(u, v, 16, 3, p.seed); set(o, p.c, 0.9 + (n - 0.5) * 0.1, n, 0.88); },
  },
  sand: {
    color: "#c9b48a", scale: 2, depth: 0.004, metal: 0,
    synth(u, v, p, o) {
      const rip = 0.5 + 0.5 * Math.sin((v * 14 + fbm(u, v, 3, 3, p.seed) * 2) * Math.PI * 2);
      const g = vnoise(u * 400, v * 400, 400, p.seed + 3);
      set(o, p.c, 0.85 + g * 0.15 + rip * 0.05, rip * 0.7 + g * 0.3, 0.95);
    },
  },
  snow: {
    color: "#eef2f6", scale: 2, depth: 0.004, metal: 0,
    synth(u, v, p, o) { const n = fbm(u, v, 6, 5, p.seed); set(o, p.c, 0.92 + (n - 0.5) * 0.12, n, 0.7 + n * 0.2); },
  },
};
DEFS.ceiling = DEFS.plaster;
DEFS.stucco = DEFS.plaster;
DEFS.planks = DEFS["wood-floor"];
DEFS.steel = DEFS.metal;
DEFS.gold = { ...DEFS.brass, color: "#c9a245" };
DEFS.copper = { ...DEFS.brass, color: "#b06a43", color2: "#3f6d5a" };
DEFS.silver = { ...DEFS.metal, color: "#c9cacc" };
DEFS.porcelain = DEFS.ceramic;
DEFS.cloth = DEFS.fabric;

export const MATERIAL_NAMES = [...Object.keys(DEFS), "glass", "frosted-glass", "water", "emissive", "black"].sort();

export interface TextureSet { map: THREE.DataTexture; normalMap: THREE.DataTexture; roughnessMap: THREE.DataTexture; metalMap: boolean }

/** Paint one material's three maps. size is the texture's edge in pixels (power of two). */
function synthesize(def: MaterialDef, params: SynthParams, size: number): TextureSet {
  const n = size * size;
  const col = new Uint8Array(n * 4), rough = new Uint8Array(n * 4), nor = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  const o: Sample = { r: 0, g: 0, b: 0, h: 0, rough: 0 };
  let metalUsed = false;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      o.metal = undefined;
      def.synth(u, v, params, o);
      const i = y * size + x, j = i * 4;
      col[j] = clamp01(o.r) * 255; col[j + 1] = clamp01(o.g) * 255; col[j + 2] = clamp01(o.b) * 255; col[j + 3] = 255;
      height[i] = o.h;
      const r = clamp01(params.wet ? o.rough * 0.45 : o.rough);
      rough[j] = 255; rough[j + 1] = r * 255; rough[j + 3] = 255;
      if (o.metal !== undefined) { metalUsed = true; rough[j + 2] = clamp01(o.metal) * 255; } else rough[j + 2] = def.metal * 255;
    }
  }
  const texel = def.scale / size;
  const k = def.depth / (2 * texel);
  for (let y = 0; y < size; y++) {
    const yu = ((y + 1) % size) * size, yd = ((y - 1 + size) % size) * size, row = y * size;
    for (let x = 0; x < size; x++) {
      const xr = (x + 1) % size, xl = (x - 1 + size) % size;
      const dx = (height[row + xr] - height[row + xl]) * k;
      const dy = (height[yu + x] - height[yd + x]) * k;
      const len = Math.hypot(dx, dy, 1);
      const j = (row + x) * 4;
      nor[j] = (-dx / len * 0.5 + 0.5) * 255;
      nor[j + 1] = (-dy / len * 0.5 + 0.5) * 255;
      nor[j + 2] = (1 / len * 0.5 + 0.5) * 255;
      nor[j + 3] = 255;
    }
  }
  const tex = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, size, size);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: tex(col, true), normalMap: tex(nor, false), roughnessMap: tex(rough, false), metalMap: metalUsed };
}

export interface MaterialLibrary {
  get(spec: string | MaterialOptions | THREE.Material | undefined, fallback?: string): THREE.Material;
  dispose(): void;
  /** Materials whose picture is still loading. */
  pending: Promise<unknown>[];
}

export function createMaterialLibrary(opts: { textureSize: number; resolveUrl: (ref: string) => string; maxAnisotropy: number }): MaterialLibrary {
  const textureCache = new Map<string, TextureSet>();
  const materialCache = new Map<string, THREE.Material>();
  const owned = new Set<{ dispose(): void }>();
  const pending: Promise<unknown>[] = [];

  function textures(type: string, def: MaterialDef, o: MaterialOptions): TextureSet {
    const params: SynthParams = {
      c: parseColor(o.color, def.color),
      c2: parseColor(o.color2, def.color2 || def.color),
      wear: o.wear ?? 0.35,
      wet: Boolean(o.wet),
      pattern: o.pattern || "",
      seed: o.seed ?? 7,
    };
    const key = JSON.stringify([type, params, opts.textureSize]);
    let set = textureCache.get(key);
    if (!set) {
      set = synthesize(def, params, opts.textureSize);
      for (const t of [set.map, set.normalMap, set.roughnessMap]) { t.anisotropy = opts.maxAnisotropy; owned.add(t); }
      textureCache.set(key, set);
    }
    return set;
  }

  function repeat(t: THREE.Texture, scale: number) {
    const c = t.clone();
    c.repeat.set(1 / scale, 1 / scale);
    c.needsUpdate = true;
    owned.add(c);
    return c;
  }

  function build(o: MaterialOptions): THREE.Material {
    const type = (o.type || "plaster").toLowerCase();
    const side = o.side === "double" ? THREE.DoubleSide : THREE.FrontSide;
    if (type === "glass" || type === "frosted-glass" || type === "water") {
      const frosted = type === "frosted-glass";
      const m = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setStyle(o.color || (type === "water" ? "#2a3f44" : "#c8d4d6"), THREE.SRGBColorSpace),
        metalness: 0, roughness: frosted ? 0.45 : type === "water" ? 0.03 : 0.04,
        transparent: true, opacity: o.opacity ?? (frosted ? 0.55 : 0.16), depthWrite: false,
        side: THREE.DoubleSide, envMapIntensity: 1.4, ior: 1.5, specularIntensity: 1,
      });
      return m;
    }
    if (type === "emissive" || type === "light") {
      const c = new THREE.Color().setStyle(o.color || "#ffe2b0", THREE.SRGBColorSpace);
      return new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: o.glow ?? 4, roughness: 0.4, side });
    }
    if (type === "black") return new THREE.MeshBasicMaterial({ color: 0x000000, side });
    if (o.image) {
      const m = new THREE.MeshStandardMaterial({ color: o.color ? new THREE.Color().setStyle(o.color, THREE.SRGBColorSpace) : 0xffffff, roughness: o.rough ?? 0.8, metalness: o.metal ?? 0, side });
      const url = opts.resolveUrl(o.image);
      pending.push(new Promise<void>((resolve) => {
        const t = new THREE.TextureLoader().load(url, () => { m.needsUpdate = true; resolve(); }, undefined, () => resolve());
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        const s = o.scale ?? 1;
        t.repeat.set(1 / s, 1 / s);
        t.anisotropy = opts.maxAnisotropy;
        owned.add(t);
        m.map = t;
      }));
      owned.add(m);
      return m;
    }
    const def = DEFS[type] || DEFS.plaster;
    const set = textures(type, def, o);
    const scale = o.scale ?? def.scale;
    const metal = o.metal ?? (set.metalMap ? 1 : def.metal);
    const m = new THREE.MeshStandardMaterial({
      map: repeat(set.map, scale),
      normalMap: repeat(set.normalMap, scale),
      roughnessMap: repeat(set.roughnessMap, scale),
      metalnessMap: set.metalMap ? repeat(set.roughnessMap, scale) : null,
      roughness: o.rough ?? 1,
      metalness: metal,
      side,
    });
    if (o.emissive) { m.emissive = new THREE.Color().setStyle(o.emissive, THREE.SRGBColorSpace); m.emissiveIntensity = o.glow ?? 1; }
    if (o.opacity !== undefined && o.opacity < 1) { m.transparent = true; m.opacity = o.opacity; }
    return m;
  }

  return {
    pending,
    get(spec, fallback = "plaster") {
      if (spec && typeof spec === "object" && (spec as THREE.Material).isMaterial) return spec as THREE.Material;
      const o: MaterialOptions = typeof spec === "string" ? { type: spec } : { type: fallback, ...(spec as MaterialOptions | undefined) };
      if (!o.type) o.type = fallback;
      const key = JSON.stringify(o);
      let m = materialCache.get(key);
      if (!m) { m = build(o); materialCache.set(key, m); owned.add(m); }
      return m;
    },
    dispose() {
      for (const o of owned) o.dispose();
      owned.clear(); textureCache.clear(); materialCache.clear();
    },
  };
}
