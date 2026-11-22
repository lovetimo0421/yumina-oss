/**
 * What you see through the windows: a painted panorama on a far cylinder and a
 * sky dome, drawn in code (night city, daytime town, golden afternoon with
 * spires, dusk, plain sky) or taken from a picture asset.
 */
import * as THREE from "three";
import { fbm } from "./noise";
import { rng } from "./noise";

export interface OutsideOptions {
  kind?: string;
  image?: string;
  /** Brightness of the view (1 = as painted). */
  glow?: number;
  /** Ground outside, a material name ("asphalt", "grass"…), or false. */
  ground?: unknown;
  distance?: number;
  seed?: number;
}

type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number) => { sky: [string, string] };

function grad(ctx: CanvasRenderingContext2D, h: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

function skyline(ctx: CanvasRenderingContext2D, w: number, _h: number, rand: () => number, o: { base: number; minH: number; maxH: number; color: string; windows: number; warm: number; minW: number; maxW: number; spires?: number }) {
  let x = -20;
  while (x < w + 20) {
    const bw = o.minW + rand() * (o.maxW - o.minW);
    const bh = o.minH + rand() * (o.maxH - o.minH);
    const top = o.base - bh;
    ctx.fillStyle = o.color;
    ctx.fillRect(x, top, bw, bh + 2);
    if (o.spires && rand() < o.spires) {
      ctx.beginPath(); ctx.moveTo(x + bw * 0.2, top); ctx.lineTo(x + bw / 2, top - bh * (0.35 + rand() * 0.4)); ctx.lineTo(x + bw * 0.8, top); ctx.fill();
    } else if (rand() < 0.25) ctx.fillRect(x + bw * 0.3, top - 6 - rand() * 14, bw * 0.15, 20);
    if (o.windows > 0) {
      const cols = Math.max(1, Math.floor(bw / 7)), rows = Math.floor(bh / 9);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (rand() > o.windows) continue;
        const warm = rand() < o.warm;
        const a = 0.35 + rand() * 0.65;
        ctx.fillStyle = warm ? `rgba(255,${190 + rand() * 40 | 0},${110 + rand() * 50 | 0},${a})` : `rgba(${170 + rand() * 40 | 0},${200 + rand() * 30 | 0},255,${a * 0.8})`;
        ctx.fillRect(x + 3 + c * 7, top + 5 + r * 9, 3, 4);
      }
    }
    x += bw + rand() * 4;
  }
}

function clouds(ctx: CanvasRenderingContext2D, w: number, _h: number, top: number, bottom: number, color: string, density: number, seed: number) {
  const img = ctx.getImageData(0, Math.floor(top), w, Math.floor(bottom - top));
  const d = img.data;
  const c = new THREE.Color(color);
  const H = img.height;
  for (let y = 0; y < H; y++) for (let x = 0; x < w; x++) {
    const n = fbm(x / w, (y / H) * 0.25, 6, 5, seed);
    const a = Math.max(0, (n - (1 - density)) / density) * Math.sin((y / H) * Math.PI) * 0.9;
    const i = (y * w + x) * 4;
    d[i] = d[i] * (1 - a) + c.r * 255 * a;
    d[i + 1] = d[i + 1] * (1 - a) + c.g * 255 * a;
    d[i + 2] = d[i + 2] * (1 - a) + c.b * 255 * a;
  }
  ctx.putImageData(img, 0, Math.floor(top));
}

const PAINTERS: Record<string, Painter> = {
  "night-city"(ctx, w, h, rand) {
    ctx.fillStyle = grad(ctx, h, [[0, "#05070d"], [0.45, "#101a2b"], [0.62, "#2a2a3a"], [0.7, "#3b2e36"], [1, "#0b0b10"]]);
    ctx.fillRect(0, 0, w, h);
    skyline(ctx, w, h, rand, { base: h * 0.72, minH: h * 0.12, maxH: h * 0.34, color: "#121722", windows: 0.22, warm: 0.6, minW: 30, maxW: 90 });
    ctx.fillStyle = "rgba(60,70,95,.25)"; ctx.fillRect(0, h * 0.4, w, h * 0.35);
    skyline(ctx, w, h, rand, { base: h * 0.78, minH: h * 0.1, maxH: h * 0.26, color: "#0b0e15", windows: 0.3, warm: 0.7, minW: 40, maxW: 110 });
    for (let i = 0; i < 26; i++) {
      const x = rand() * w, y = h * (0.5 + rand() * 0.25), cw = 10 + rand() * 30, ch = 4 + rand() * 10;
      const col = ["#ff3d6e", "#3dd6ff", "#ffb03d", "#b64dff", "#4dff9a"][Math.floor(rand() * 5)];
      ctx.shadowColor = col; ctx.shadowBlur = 16; ctx.fillStyle = col; ctx.fillRect(x, y, cw, ch);
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = grad(ctx, h, [[0.7, "rgba(20,20,26,0)"], [0.78, "#0a0a0e"], [1, "#050507"]]);
    ctx.fillRect(0, h * 0.7, w, h * 0.3);
    return { sky: ["#05070d", "#101a2b"] };
  },
  city(ctx, w, h, rand) {
    ctx.fillStyle = grad(ctx, h, [[0, "#6f8fb5"], [0.55, "#b9c7d3"], [0.7, "#d9d6cc"], [1, "#6d6a62"]]);
    ctx.fillRect(0, 0, w, h);
    clouds(ctx, w, h, h * 0.05, h * 0.5, "#f4f2ec", 0.45, 3);
    skyline(ctx, w, h, rand, { base: h * 0.74, minH: h * 0.1, maxH: h * 0.3, color: "#9aa3aa", windows: 0, warm: 0, minW: 30, maxW: 90 });
    skyline(ctx, w, h, rand, { base: h * 0.8, minH: h * 0.08, maxH: h * 0.22, color: "#6b7177", windows: 0, warm: 0, minW: 40, maxW: 110 });
    ctx.fillStyle = "#4a4943"; ctx.fillRect(0, h * 0.8, w, h * 0.2);
    return { sky: ["#5b7aa3", "#9fb3c8"] };
  },
  golden(ctx, w, h, rand) {
    ctx.fillStyle = grad(ctx, h, [[0, "#6d8fb0"], [0.35, "#c9c3a6"], [0.62, "#f2cf8e"], [0.72, "#e9b779"], [1, "#4a4a33"]]);
    ctx.fillRect(0, 0, w, h);
    clouds(ctx, w, h, h * 0.08, h * 0.55, "#fff1d2", 0.4, 11);
    ctx.fillStyle = "rgba(120,130,140,.55)";
    for (let i = 0; i < 4; i++) { ctx.beginPath(); const cx = rand() * w; ctx.ellipse(cx, h * 0.73, 300 + rand() * 300, 60 + rand() * 40, 0, Math.PI, 0); ctx.fill(); }
    skyline(ctx, w, h, rand, { base: h * 0.74, minH: h * 0.05, maxH: h * 0.2, color: "rgba(92,96,96,.85)", windows: 0, warm: 0, minW: 20, maxW: 60, spires: 0.6 });
    ctx.fillStyle = "#3f4a2a";
    for (let x = 0; x < w; x += 6) { const th = 20 + rand() * 40; ctx.beginPath(); ctx.arc(x, h * 0.77, th * 0.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#4a5530"; ctx.fillRect(0, h * 0.77, w, h * 0.23);
    return { sky: ["#6d8fb0", "#a9b8c0"] };
  },
  dusk(ctx, w, h, rand) {
    ctx.fillStyle = grad(ctx, h, [[0, "#1d2340"], [0.35, "#5a3b5e"], [0.6, "#d0704a"], [0.7, "#f0a060"], [1, "#2a2020"]]);
    ctx.fillRect(0, 0, w, h);
    clouds(ctx, w, h, h * 0.15, h * 0.55, "#e08a6a", 0.35, 5);
    skyline(ctx, w, h, rand, { base: h * 0.75, minH: h * 0.08, maxH: h * 0.25, color: "#22202a", windows: 0.08, warm: 0.9, minW: 30, maxW: 90 });
    ctx.fillStyle = "#151318"; ctx.fillRect(0, h * 0.75, w, h * 0.25);
    return { sky: ["#1d2340", "#5a3b5e"] };
  },
  sky(ctx, w, h) {
    ctx.fillStyle = grad(ctx, h, [[0, "#5d82b8"], [0.6, "#bcd0e2"], [1, "#e6e8e4"]]);
    ctx.fillRect(0, 0, w, h);
    clouds(ctx, w, h, h * 0.1, h * 0.75, "#ffffff", 0.45, 9);
    return { sky: ["#5d82b8", "#bcd0e2"] };
  },
  night(ctx, w, h, rand) {
    ctx.fillStyle = grad(ctx, h, [[0, "#03050a"], [0.6, "#0d1626"], [0.75, "#141c26"], [1, "#05070a"]]);
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) { ctx.fillStyle = `rgba(255,255,255,${rand() * 0.8})`; ctx.fillRect(rand() * w, rand() * h * 0.6, 1, 1); }
    ctx.fillStyle = "#06080b";
    for (let x = 0; x < w; x += 5) { const th = 15 + rand() * 50; ctx.beginPath(); ctx.arc(x, h * 0.76, th * 0.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillRect(0, h * 0.76, w, h * 0.24);
    return { sky: ["#03050a", "#0d1626"] };
  },
};
PAINTERS.day = PAINTERS.city;
PAINTERS.afternoon = PAINTERS.golden;
PAINTERS.sunset = PAINTERS.dusk;
PAINTERS.garden = PAINTERS.golden;

export const OUTSIDE_KINDS = Object.keys(PAINTERS).sort();

export function createOutside(o: OutsideOptions, centre: THREE.Vector3, resolveUrl: (s: string) => string): { group: THREE.Group; skyTop: THREE.Color; dispose(): void } {
  const group = new THREE.Group();
  group.name = "outside";
  const R = o.distance ?? 40;
  const disposables: { dispose(): void }[] = [];
  let tex: THREE.Texture;
  let skyTop = new THREE.Color("#5d82b8");
  if (o.image) {
    tex = new THREE.TextureLoader().load(resolveUrl(o.image));
  } else {
    const c = document.createElement("canvas");
    c.width = 2048; c.height = 512;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const painter = PAINTERS[o.kind || "sky"] || PAINTERS.sky;
    const { sky } = painter(ctx, c.width, c.height, rng(o.seed ?? 42));
    skyTop = new THREE.Color(sky[0]);
    tex = new THREE.CanvasTexture(c);
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  disposables.push(tex);
  const H = R * 0.9;
  const cyl = new THREE.CylinderGeometry(R, R, H, 64, 1, true);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false });
  mat.color.setScalar(o.glow ?? 1);
  const mesh = new THREE.Mesh(cyl, mat);
  // The painted horizon (about 72% down the picture) sits a little below eye height.
  mesh.position.set(centre.x, H * 0.5 - H * 0.26 + 1.2, centre.z);
  mesh.renderOrder = -10;
  group.add(mesh);
  const domeMat = new THREE.MeshBasicMaterial({ color: skyTop.clone().multiplyScalar(o.glow ?? 1), side: THREE.BackSide, fog: false, depthWrite: false });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R * 1.05, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2.2), domeMat);
  dome.position.set(centre.x, 0, centre.z);
  dome.renderOrder = -11;
  group.add(dome);
  disposables.push(cyl, mat, dome.geometry, domeMat);
  return { group, skyTop, dispose() { for (const d of disposables) d.dispose(); } };
}
