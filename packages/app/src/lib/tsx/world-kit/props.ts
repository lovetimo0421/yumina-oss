/**
 * Furniture and things, built in code from softened boxes, lathes and cloth, at
 * real sizes in metres. Each builder returns a group standing on y = 0, centred
 * on x/z, facing +z (its front, the side you sit at or read from).
 */
import * as THREE from "three";
import { box, cylinder, lathe, picturePlane, sphere } from "./geometry";
import { rng } from "./noise";

export type MatSpec = string | Record<string, unknown> | THREE.Material | undefined;

export interface PropCtx {
  mat(spec: MatSpec, fallback: string): THREE.Material;
  canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, srgb?: boolean): THREE.CanvasTexture;
  track<T extends { dispose(): void }>(x: T): T;
}

export type PropOptions = Record<string, unknown> & {
  size?: number[];
  material?: MatSpec;
  color?: string;
  seed?: number;
};

type Builder = (o: PropOptions, c: PropCtx) => THREE.Object3D;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const sz = (o: PropOptions, d: [number, number, number]): [number, number, number] => {
  const s = Array.isArray(o.size) ? o.size : [];
  return [num(s[0], d[0]), num(s[1], d[1]), num(s[2], d[2])];
};
/** The prop's main material: `material`, or `color` on the default type. */
const main = (o: PropOptions, c: PropCtx, type: string, key = "material") => {
  const m = o[key] as MatSpec;
  if (m) return c.mat(typeof m === "string" && o.color && key === "material" ? { type: m, color: o.color } : m, type);
  return c.mat(o.color && key === "material" ? { type, color: o.color as string } : type, type);
};

function add(g: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, c: PropCtx, rot?: [number, number, number]) {
  const mesh = new THREE.Mesh(c.track(geo), m);
  mesh.position.set(x, y, z);
  if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

export function textCanvas(c: PropCtx, o: { text: string; width: number; height: number; color?: string; background?: string; font?: string; vertical?: boolean; weight?: string; padding?: number; align?: CanvasTextAlign; glow?: boolean }) {
  const ppm = 256;
  const W = Math.min(2048, Math.max(64, Math.round(o.width * ppm))), H = Math.min(2048, Math.max(64, Math.round(o.height * ppm)));
  return c.canvasTexture(W, H, (ctx, w, h) => {
    if (o.background && o.background !== "transparent") { ctx.fillStyle = o.background; ctx.fillRect(0, 0, w, h); }
    const lines = String(o.text || "").split("\n");
    const family = o.font === "serif" ? 'Georgia,"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif'
      : o.font === "brush" ? '"STKaiti","KaiTi","Kaiti SC","Noto Serif JP",serif'
      : o.font === "mono" ? 'ui-monospace,Consolas,monospace'
      : 'system-ui,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
    const pad = (o.padding ?? 0.08) * Math.min(w, h);
    ctx.fillStyle = o.color || "#f2ede2";
    ctx.textBaseline = "middle";
    if (o.glow) { ctx.shadowColor = o.color || "#fff"; ctx.shadowBlur = Math.min(w, h) * 0.06; }
    if (o.vertical) {
      const cols = lines.length;
      const maxChars = Math.max(...lines.map((l) => [...l].length), 1);
      const size = Math.min((h - pad * 2) / maxChars, (w - pad * 2) / cols) * 0.92;
      ctx.font = `${o.weight || "700"} ${size}px ${family}`;
      ctx.textAlign = "center";
      lines.forEach((line, i) => {
        const x = w - pad - (i + 0.5) * ((w - pad * 2) / cols);
        [...line].forEach((ch, j) => ctx.fillText(ch, x, pad + (j + 0.5) * ((h - pad * 2) / maxChars)));
      });
    } else {
      let size = (h - pad * 2) / lines.length * 0.78;
      ctx.font = `${o.weight || "700"} ${size}px ${family}`;
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
      if (widest > w - pad * 2) { size *= (w - pad * 2) / widest; ctx.font = `${o.weight || "700"} ${size}px ${family}`; }
      ctx.textAlign = o.align || "center";
      const x = ctx.textAlign === "left" ? pad : ctx.textAlign === "right" ? w - pad : w / 2;
      const lh = (h - pad * 2) / lines.length;
      lines.forEach((line, i) => ctx.fillText(line, x, pad + lh * (i + 0.5)));
    }
  });
}

const bookMats = new WeakMap<PropCtx, THREE.Material>();
/** Book spines: leather grain, two gilt bands and a label, multiplied by each book's colour. */
function bookMaterial(c: PropCtx): THREE.Material {
  let m = bookMats.get(c);
  if (m) return m;
  const rand = rng(91);
  const tex = c.canvasTexture(64, 256, (ctx, w, h) => {
    ctx.fillStyle = "#cfc6b6"; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) { ctx.fillStyle = `rgba(${rand() > 0.5 ? "0,0,0" : "255,255,255"},${rand() * 0.08})`; ctx.fillRect(rand() * w, rand() * h, 2, 2); }
    ctx.fillStyle = "#f2d9a0";
    for (const y of [0.08, 0.12, 0.86, 0.9]) ctx.fillRect(0, h * y, w, h * 0.012);
    ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(0, h * 0.3, w, h * 0.18);
    ctx.fillStyle = "#efe2c4"; ctx.fillRect(w * 0.18, h * 0.33, w * 0.64, h * 0.12);
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, "rgba(0,0,0,.35)"); g.addColorStop(0.25, "rgba(0,0,0,0)"); g.addColorStop(0.75, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.35)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  m = c.track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62 }));
  bookMats.set(c, m);
  return m;
}

const BOOK_COLOURS = ["#5a1e1b", "#273d2a", "#1d2a44", "#5b3a1e", "#8a6a2e", "#2a2422", "#6b2f3a", "#3e4a3a", "#7a4a26", "#30343f", "#8c7b5a", "#4d2526"];

function books(g: THREE.Object3D, c: PropCtx, x0: number, x1: number, y: number, z: number, depth: number, maxH: number, rand: () => number, fill = 0.9) {
  const geo = c.track(new THREE.BoxGeometry(1, 1, 1));
  const m = bookMaterial(c);
  const list: { x: number; w: number; h: number; d: number; lean: number; col: string }[] = [];
  let x = x0 + 0.01;
  while (x < x1 - 0.03) {
    if (rand() > fill) { x += 0.04 + rand() * 0.12; continue; }
    const w = 0.022 + rand() * 0.035, h = maxH * (0.62 + rand() * 0.34), d = Math.min(depth, 0.14 + rand() * 0.1);
    let lean = 0;
    if (rand() < 0.06 && x + h * 0.5 < x1) lean = 0.25 + rand() * 0.3;
    list.push({ x: x + w / 2, w, h, d, lean, col: BOOK_COLOURS[Math.floor(rand() * BOOK_COLOURS.length)] });
    x += w + (lean ? h * Math.sin(lean) : 0.002);
  }
  const inst = new THREE.InstancedMesh(geo, m, Math.max(1, list.length));
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  list.forEach((b, i) => {
    q.setFromEuler(new THREE.Euler(0, 0, -b.lean));
    s.set(b.w, b.h, b.d);
    p.set(b.x + (b.lean ? Math.sin(b.lean) * b.h * 0.5 : 0), y + Math.cos(b.lean) * b.h / 2, z - (depth - b.d) / 2 + 0.01);
    mtx.compose(p, q, s);
    inst.setMatrixAt(i, mtx);
    inst.setColorAt(i, col.set(b.col).multiplyScalar(0.8 + rand() * 0.4));
  });
  inst.count = list.length;
  inst.castShadow = true; inst.receiveShadow = true;
  g.add(inst);
}

function leafTexture(c: PropCtx, kind: string) {
  return c.canvasTexture(128, 256, (ctx, w, h) => {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    if (kind === "fern") {
      ctx.fillRect(w / 2 - 2, 0, 4, h);
      for (let i = 0; i < 18; i++) {
        const y = h * (0.05 + i * 0.05), len = w * 0.45 * Math.sin((i / 18) * Math.PI * 0.9 + 0.2);
        ctx.beginPath(); ctx.ellipse(w / 2 - len / 2, y, len / 2, 5, -0.3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(w / 2 + len / 2, y, len / 2, 5, 0.3, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      ctx.moveTo(w / 2, 2);
      ctx.bezierCurveTo(w * 0.98, h * 0.3, w * 0.8, h * 0.8, w / 2, h - 2);
      ctx.bezierCurveTo(w * 0.2, h * 0.8, w * 0.02, h * 0.3, w / 2, 2);
      ctx.fill();
    }
  }, false);
}

const B: Record<string, Builder> = {
  box(o, c) {
    const [w, h, d] = sz(o, [0.5, 0.5, 0.5]);
    const g = new THREE.Group();
    add(g, box(w, h, d, num(o.bevel, 0.01)), main(o, c, "wood"), 0, h / 2, 0, c);
    return g;
  },
  cylinder(o, c) {
    const [w, h] = sz(o, [0.4, 0.8, 0.4]);
    const g = new THREE.Group();
    add(g, cylinder(w / 2, w / 2, h, 32), main(o, c, "metal"), 0, h / 2, 0, c);
    return g;
  },
  sphere(o, c) {
    const [w] = sz(o, [0.4, 0.4, 0.4]);
    const g = new THREE.Group();
    add(g, sphere(w / 2, 32), main(o, c, "ceramic"), 0, w / 2, 0, c);
    return g;
  },
  table(o, c) {
    const [w, h, d] = sz(o, o.round ? [1, 0.75, 1] : [1.4, 0.76, 0.8]);
    const g = new THREE.Group();
    const top = main(o, c, "wood", o.top ? "top" : "material");
    const wood = main(o, c, "wood");
    const t = 0.04;
    if (o.round) {
      add(g, cylinder(w / 2, w / 2, t, 48), top, 0, h - t / 2, 0, c);
      add(g, cylinder(0.05, 0.06, h - t, 16), wood, 0, (h - t) / 2, 0, c);
      add(g, cylinder(w * 0.25, w * 0.28, 0.04, 32), wood, 0, 0.02, 0, c);
      return g;
    }
    add(g, box(w, t, d, 0.008), top, 0, h - t / 2, 0, c);
    add(g, box(w - 0.12, 0.09, d - 0.12, 0.004), wood, 0, h - t - 0.045, 0, c);
    for (const sx of [-1, 1]) for (const sz2 of [-1, 1]) add(g, box(0.055, h - t, 0.055, 0.006), wood, sx * (w / 2 - 0.07), (h - t) / 2, sz2 * (d / 2 - 0.07), c);
    return g;
  },
  desk(o, c) {
    const [w, h, d] = sz(o, [1.3, 0.76, 0.65]);
    const g = new THREE.Group();
    const wood = main(o, c, "wood");
    const brass = c.mat("brass", "brass");
    add(g, box(w, 0.04, d, 0.008), main(o, c, "wood", o.top ? "top" : "material"), 0, h - 0.02, 0, c);
    add(g, box(0.42, h - 0.04, d - 0.04, 0.006), wood, w / 2 - 0.23, (h - 0.04) / 2, 0, c);
    for (let i = 0; i < 3; i++) {
      const y = 0.14 + i * ((h - 0.2) / 3);
      add(g, box(0.38, (h - 0.24) / 3 - 0.02, 0.02, 0.004), wood, w / 2 - 0.23, y + 0.08, d / 2 - 0.01, c);
      add(g, box(0.08, 0.015, 0.02, 0.003), brass, w / 2 - 0.23, y + 0.08, d / 2 + 0.012, c);
    }
    for (const sz2 of [-1, 1]) add(g, box(0.05, h - 0.04, 0.05, 0.006), wood, -w / 2 + 0.06, (h - 0.04) / 2, sz2 * (d / 2 - 0.06), c);
    add(g, box(w - 0.45, 0.08, 0.02, 0.003), wood, -0.2, h - 0.08, d / 2 - 0.04, c);
    return g;
  },
  chair(o, c) {
    const [w, h, d] = sz(o, [0.46, 0.92, 0.46]);
    const g = new THREE.Group();
    const wood = main(o, c, "wood");
    const seatH = 0.46;
    add(g, box(w, 0.035, d, 0.006), o.seat ? main(o, c, "leather", "seat") : wood, 0, seatH, 0, c);
    for (const sx of [-1, 1]) {
      add(g, box(0.04, seatH, 0.04, 0.005), wood, sx * (w / 2 - 0.03), seatH / 2, d / 2 - 0.03, c);
      add(g, box(0.04, h, 0.04, 0.005), wood, sx * (w / 2 - 0.03), h / 2, -d / 2 + 0.03, c);
    }
    for (let i = 0; i < 3; i++) add(g, box(w - 0.06, 0.05, 0.018, 0.004), wood, 0, seatH + 0.17 + i * ((h - seatH - 0.22) / 2), -d / 2 + 0.03, c);
    add(g, box(w - 0.08, 0.025, 0.02, 0.003), wood, 0, 0.16, d / 2 - 0.03, c);
    add(g, box(w - 0.08, 0.025, 0.02, 0.003), wood, 0, 0.16, -d / 2 + 0.03, c);
    return g;
  },
  armchair(o, c) {
    const [w, h, d] = sz(o, [0.85, 0.95, 0.85]);
    const g = new THREE.Group();
    const cloth = main(o, c, "velvet");
    const wood = c.mat(o.legs as MatSpec || "wood", "wood");
    add(g, box(w, 0.22, d, 0.05), cloth, 0, 0.3, 0, c);
    add(g, box(w - 0.24, 0.12, d - 0.12, 0.05), cloth, 0, 0.47, 0.04, c);
    add(g, box(w, h - 0.2, 0.18, 0.06), cloth, 0, 0.2 + (h - 0.2) / 2, -d / 2 + 0.09, c);
    for (const sx of [-1, 1]) add(g, box(0.14, 0.42, d, 0.05), cloth, sx * (w / 2 - 0.07), 0.4, 0, c);
    for (const sx of [-1, 1]) for (const sz2 of [-1, 1]) add(g, cylinder(0.02, 0.016, 0.2, 10), wood, sx * (w / 2 - 0.08), 0.1, sz2 * (d / 2 - 0.08), c);
    return g;
  },
  sofa(o, c) {
    const [w, h, d] = sz(o, [1.9, 0.85, 0.85]);
    return B.armchair({ ...o, size: [w, h, d] }, c);
  },
  stool(o, c) {
    const [w, h] = sz(o, [0.36, 0.72, 0.36]);
    const g = new THREE.Group();
    const wood = main(o, c, "wood");
    const r = w / 2;
    add(g, cylinder(r, r * 0.95, 0.045, 32), o.seat ? main(o, c, "leather", "seat") : wood, 0, h - 0.0225, 0, c);
    if (o.seat) add(g, cylinder(r * 0.97, r * 0.97, 0.03, 32), main(o, c, "leather", "seat"), 0, h + 0.012, 0, c);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = add(g, cylinder(0.016, 0.02, h * 1.02, 10), wood, Math.cos(a) * r * 0.75, h / 2, Math.sin(a) * r * 0.75, c);
      leg.rotation.set(Math.sin(a) * 0.09, 0, -Math.cos(a) * 0.09);
    }
    const ring = new THREE.Mesh(c.track(new THREE.TorusGeometry(r * 0.88, 0.01, 8, 32)), c.mat(o.legs as MatSpec || "iron", "iron"));
    ring.rotation.x = Math.PI / 2; ring.position.y = h * 0.32; ring.castShadow = true;
    g.add(ring);
    return g;
  },
  bench(o, c) {
    const [w, h, d] = sz(o, [1.6, 0.45, 0.36]);
    const g = new THREE.Group();
    const wood = main(o, c, "wood");
    add(g, box(w, 0.05, d, 0.008), wood, 0, h - 0.025, 0, c);
    for (const sx of [-1, 1]) add(g, box(0.05, h - 0.05, d - 0.06, 0.006), wood, sx * (w / 2 - 0.12), (h - 0.05) / 2, 0, c);
    return g;
  },
  bed(o, c) {
    const [w, h, d] = sz(o, [1.0, 0.55, 2.0]);
    const g = new THREE.Group();
    const frame = main(o, c, "wood", o.frame ? "frame" : "material");
    const sheet = c.mat(o.sheets as MatSpec || { type: "fabric", color: "#d8d2c4" }, "fabric");
    const blanket = c.mat(o.blanket as MatSpec || { type: "fabric", color: "#4a4f45", pattern: "plaid", color2: "#3a3d35" }, "fabric");
    add(g, box(w, 0.2, d, 0.01), frame, 0, 0.22, 0, c);
    for (const sx of [-1, 1]) for (const sz2 of [-1, 1]) add(g, box(0.06, 0.25, 0.06, 0.006), frame, sx * (w / 2 - 0.03), 0.125, sz2 * (d / 2 - 0.03), c);
    add(g, box(w, h + 0.4, 0.06, 0.012), frame, 0, (h + 0.4) / 2, -d / 2 + 0.03, c);
    add(g, box(w - 0.04, 0.18, d - 0.08, 0.06), sheet, 0, 0.41, 0.01, c);
    const bl = add(g, box(w + 0.04, 0.08, d * 0.62, 0.035), blanket, 0, 0.5, d * 0.17, c);
    bl.rotation.x = 0.01;
    add(g, box(w * 0.62, 0.12, 0.34, 0.055), sheet, 0, 0.56, -d / 2 + 0.28, c, [0.15, 0.03, 0]);
    return g;
  },
  bookshelf(o, c) {
    const [w, h, d] = sz(o, [1.0, 2.2, 0.36]);
    const g = new THREE.Group();
    const wood = main(o, c, "wood");
    const t = 0.03;
    add(g, box(t, h, d, 0.004), wood, -w / 2 + t / 2, h / 2, 0, c);
    add(g, box(t, h, d, 0.004), wood, w / 2 - t / 2, h / 2, 0, c);
    add(g, box(w, 0.015, d, 0.002), wood, 0, h / 2, -d / 2 + 0.0075, c, [Math.PI / 2, 0, 0]).scale.set(1, 1, h / d);
    add(g, box(w + 0.04, 0.05, d + 0.03, 0.008), wood, 0, h - 0.025, 0.005, c);
    add(g, box(w, 0.08, d, 0.004), wood, 0, 0.04, 0, c);
    const shelves = Math.max(2, Math.round(num(o.shelves, Math.round((h - 0.15) / 0.36))));
    const gap = (h - 0.13) / shelves;
    const rand = rng(num(o.seed, 3) * 977 + 11);
    for (let i = 0; i < shelves; i++) {
      const y = 0.08 + i * gap;
      if (i > 0) add(g, box(w - 2 * t, 0.022, d - 0.02, 0.003), wood, 0, y, 0.005, c);
      if (o.books !== false) books(g, c, -w / 2 + t, w / 2 - t, y + 0.011, 0.01, d - 0.03, gap - 0.04, rand, num(o.fill, 0.9));
    }
    return g;
  },
  shelf(o, c) {
    const [w, , d] = sz(o, [1.0, 0.04, 0.24]);
    const g = new THREE.Group();
    const wood = main(o, c, "wood");
    add(g, box(w, 0.03, d, 0.004), wood, 0, 0, 0, c);
    for (const sx of [-1, 1]) add(g, box(0.02, 0.14, d * 0.8, 0.003), c.mat("iron", "iron"), sx * (w / 2 - 0.1), -0.08, -d * 0.1, c);
    const rand = rng(num(o.seed, 5) * 131 + 7);
    const items = String(o.items || "");
    if (items === "books") books(g, c, -w / 2, w / 2, 0.015, 0, d - 0.02, 0.28, rand, 0.8);
    else if (items) {
      let x = -w / 2 + 0.06;
      while (x < w / 2 - 0.06) {
        const kind = items === "mixed" ? ["bottle", "jar", "bowl"][Math.floor(rand() * 3)] : items.replace(/s$/, "");
        const thing = build(kind, { seed: Math.floor(rand() * 1e6) }, c);
        thing.position.set(x, 0.015, (rand() - 0.5) * d * 0.3);
        thing.rotation.y = rand() * Math.PI;
        g.add(thing);
        x += 0.08 + rand() * 0.08;
      }
    }
    return g;
  },
  counter(o, c) {
    const [w, h, d] = sz(o, [2.4, 1.05, 0.6]);
    const g = new THREE.Group();
    const body = main(o, c, "wood-panel", o.body ? "body" : "material");
    const top = c.mat((o.top as MatSpec) || "wood", "wood");
    add(g, box(w, h - 0.05, d - 0.06, 0.006), body, 0, (h - 0.05) / 2, -0.03, c);
    add(g, box(w + 0.06, 0.05, d + 0.08, 0.01), top, 0, h - 0.025, 0.01, c);
    add(g, box(w, 0.1, 0.02, 0.004), c.mat("wood", "wood"), 0, 0.05, d / 2 - 0.05, c);
    return g;
  },
  cabinet(o, c) {
    const [w, h, d] = sz(o, [0.9, 1.0, 0.45]);
    const g = new THREE.Group();
    const wood = main(o, c, "wood");
    const brass = c.mat(o.handles as MatSpec || "brass", "brass");
    add(g, box(w, h, d, 0.008), wood, 0, h / 2, 0, c);
    const rows = Math.max(1, Math.round(num(o.drawers, 0)));
    if (rows) {
      for (let i = 0; i < rows; i++) {
        const y = 0.08 + (i + 0.5) * ((h - 0.12) / rows);
        add(g, box(w - 0.06, (h - 0.12) / rows - 0.02, 0.02, 0.004), wood, 0, y, d / 2 + 0.005, c);
        add(g, box(0.1, 0.015, 0.02, 0.003), brass, 0, y, d / 2 + 0.02, c);
      }
    } else {
      for (const sx of [-1, 1]) {
        add(g, box(w / 2 - 0.04, h - 0.1, 0.02, 0.004), wood, sx * (w / 4), h / 2, d / 2 + 0.005, c);
        add(g, box(0.015, 0.1, 0.02, 0.003), brass, sx * 0.04, h / 2, d / 2 + 0.02, c);
      }
    }
    return g;
  },
  crate(o, c) {
    const [w, h, d] = sz(o, [0.6, 0.5, 0.5]);
    const g = new THREE.Group();
    const wood = main(o, c, "wood");
    add(g, box(w - 0.02, h - 0.02, d - 0.02, 0.003), wood, 0, h / 2, 0, c);
    for (const sy of [-1, 1]) for (const sz2 of [-1, 1]) add(g, box(w, 0.05, 0.03, 0.004), wood, 0, h / 2 + sy * (h / 2 - 0.025), sz2 * (d / 2 - 0.005), c);
    for (const sx of [-1, 1]) for (const sz2 of [-1, 1]) add(g, box(0.03, h, 0.05, 0.004), wood, sx * (w / 2 - 0.005), h / 2, sz2 * (d / 2 - 0.02), c);
    return g;
  },
  barrel(o, c) {
    const [w, h] = sz(o, [0.6, 0.85, 0.6]);
    const r = w / 2;
    const g = new THREE.Group();
    const prof: [number, number][] = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10; prof.push([r * (0.84 + 0.16 * Math.sin(t * Math.PI)), t * h]); }
    add(g, lathe(prof, 32), main(o, c, "wood"), 0, 0, 0, c);
    add(g, cylinder(r * 0.83, r * 0.83, 0.01, 32), main(o, c, "wood"), 0, h - 0.01, 0, c);
    for (const t of [0.12, 0.35, 0.65, 0.88]) {
      const rr = r * (0.84 + 0.16 * Math.sin(t * Math.PI)) + 0.004;
      const hoop = new THREE.Mesh(c.track(new THREE.TorusGeometry(rr, 0.008, 6, 40)), c.mat("iron", "iron"));
      hoop.rotation.x = Math.PI / 2; hoop.position.y = t * h; hoop.scale.z = 3; g.add(hoop);
    }
    return g;
  },
  plant(o, c) {
    const [w, h] = sz(o, [0.5, 1.1, 0.5]);
    const g = new THREE.Group();
    const potH = Math.min(0.35, h * 0.32), r = Math.min(0.2, w * 0.35);
    add(g, lathe([[r * 0.7, 0], [r, potH * 0.9], [r * 1.06, potH], [r * 0.96, potH]], 24), c.mat(o.pot as MatSpec || { type: "ceramic", color: "#9a5a3a", rough: 3 }, "ceramic"), 0, 0, 0, c);
    add(g, cylinder(r * 0.94, r * 0.94, 0.01, 24), c.mat({ type: "dirt", color: "#3b2c20" }, "dirt"), 0, potH * 0.94, 0, c);
    const kind = String(o.kind || "leafy");
    const tex = leafTexture(c, kind);
    const leafMat = c.track(new THREE.MeshStandardMaterial({ color: o.color ? new THREE.Color(o.color as string) : new THREE.Color("#3f6b2c"), alphaMap: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7 }));
    const leafLen = kind === "fern" ? h * 0.55 : Math.min(0.32, h * 0.3);
    const leafGeo = new THREE.PlaneGeometry(leafLen * 0.45, leafLen, 1, 4);
    const lp = leafGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) { const y = lp.getY(i) / leafLen + 0.5; lp.setZ(i, -y * y * leafLen * 0.35); }
    leafGeo.translate(0, leafLen / 2, 0);
    leafGeo.computeVertexNormals();
    c.track(leafGeo);
    const rand = rng(num(o.seed, 9) * 71 + 3);
    const count = kind === "fern" ? 14 : 34;
    const inst = new THREE.InstancedMesh(leafGeo, leafMat, count);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const a = i * 2.39996 + rand() * 0.4;
      const t = i / count;
      const tilt = kind === "fern" ? 0.5 + t * 0.6 : 0.2 + t * 1.0;
      q.setFromEuler(new THREE.Euler(tilt, a, 0, "YXZ"));
      const y = kind === "fern" ? potH : potH + (h - potH - leafLen * 0.7) * (1 - t) * 0.9;
      m4.compose(new THREE.Vector3(Math.sin(a) * 0.02, y, Math.cos(a) * 0.02), q, new THREE.Vector3(1, 1, 1).multiplyScalar(0.8 + rand() * 0.4));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, col.setHSL(0.27 + rand() * 0.06, 0.45, 0.6 + rand() * 0.4));
    }
    inst.castShadow = true;
    g.add(inst);
    if (kind !== "fern") add(g, cylinder(0.008, 0.012, h - potH - leafLen * 0.3, 6), c.mat({ type: "wood", color: "#4a3a22" }, "wood"), 0, potH + (h - potH - leafLen * 0.3) / 2, 0, c);
    return g;
  },
  rug(o, c) {
    const [w, , d] = sz(o, [2.4, 0.01, 1.6]);
    const g = new THREE.Group();
    const col = (o.color as string) || "#6b2a24", col2 = (o.color2 as string) || "#c5a35a", col3 = (o.color3 as string) || "#1f2a3a";
    const tex = c.canvasTexture(512, Math.round(512 * d / w), (ctx, W, H) => {
      ctx.fillStyle = col; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = col2; ctx.lineWidth = W * 0.02; ctx.strokeRect(W * 0.04, H * 0.06, W * 0.92, H * 0.88);
      ctx.fillStyle = col3; ctx.fillRect(W * 0.07, H * 0.11, W * 0.86, H * 0.78);
      ctx.fillStyle = col; ctx.fillRect(W * 0.09, H * 0.14, W * 0.82, H * 0.72);
      ctx.fillStyle = col2;
      ctx.beginPath(); ctx.ellipse(W / 2, H / 2, W * 0.16, H * 0.22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col3;
      ctx.beginPath(); ctx.ellipse(W / 2, H / 2, W * 0.1, H * 0.14, 0, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 6000; i++) { ctx.fillStyle = `rgba(${Math.random() > 0.5 ? "0,0,0" : "255,240,220"},${Math.random() * 0.06})`; ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    });
    const m = c.track(new THREE.MeshStandardMaterial({ map: tex, roughness: 1, normalMap: (c.mat("carpet", "carpet") as THREE.MeshStandardMaterial).normalMap }));
    const mesh = add(g, box(w, 0.012, d, 0.004), m, 0, 0.006, 0, c);
    const uv = mesh.geometry.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / w + 0.5, uv.getY(i) / d + 0.5);
    mesh.castShadow = false;
    return g;
  },
  bottle(o, c) {
    const rand = rng(num(o.seed, 1));
    const h = num((o.size as number[] | undefined)?.[1], 0.24 + rand() * 0.1);
    const r = h * 0.15;
    const glass = c.mat(o.material as MatSpec || { type: "glass", color: ["#2f5a30", "#5a3a1a", "#3a4f5a", "#6a6a50"][Math.floor(rand() * 4)], opacity: 0.55 }, "glass");
    const g = new THREE.Group();
    add(g, lathe([[0.001, 0], [r, 0.002], [r, h * 0.62], [r * 0.4, h * 0.78], [r * 0.32, h], [0.001, h]], 18), glass, 0, 0, 0, c);
    if (rand() > 0.4) add(g, cylinder(r * 1.01, r * 1.01, h * 0.22, 18, true), c.mat({ type: "paper", color: ["#d8ccb0", "#e8e0d0", "#b8442c"][Math.floor(rand() * 3)] }, "paper"), 0, h * 0.35, 0, c);
    return g;
  },
  jar(o, c) {
    const rand = rng(num(o.seed, 2));
    const h = 0.12 + rand() * 0.08, r = 0.05 + rand() * 0.03;
    const g = new THREE.Group();
    add(g, lathe([[0.001, 0], [r, 0.004], [r * 1.05, h * 0.5], [r, h * 0.92], [r * 0.7, h], [0.001, h]], 20), c.mat({ type: "ceramic", color: ["#c9b99a", "#5a4632", "#7d8a7a", "#2b2b2b"][Math.floor(rand() * 4)] }, "ceramic"), 0, 0, 0, c);
    return g;
  },
  bowl(o, c) {
    const [w] = sz(o, [0.18, 0.08, 0.18]);
    const r = w / 2, h = r * 0.75;
    const g = new THREE.Group();
    const m = main(o, c, "ceramic");
    const outer: [number, number][] = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8; outer.push([r * 0.45 + r * 0.55 * Math.sin(t * Math.PI / 2), t * h]); }
    const inner = outer.slice().reverse().map(([x, y]) => [x - 0.004, y + 0.003] as [number, number]);
    add(g, lathe([[0.001, 0], ...outer, ...inner, [0.001, 0.006]], 28), m, 0, 0, 0, c);
    if (o.food) {
      const broth = c.track(new THREE.MeshStandardMaterial({ color: o.food === "ramen" ? "#b4783a" : "#7a5a3a", roughness: 0.15 }));
      add(g, cylinder(r * 0.86, r * 0.86, 0.004, 28), broth, 0, h * 0.72, 0, c);
      if (o.food === "ramen") {
        const egg = c.mat({ type: "ceramic", color: "#f0e6c8" }, "ceramic");
        add(g, sphere(r * 0.22, 16), egg, r * 0.35, h * 0.72, r * 0.2, c).scale.set(1, 0.4, 1.3);
        add(g, box(r * 0.5, 0.002, r * 0.7, 0.001), c.mat({ type: "paper", color: "#1d2219" }, "paper"), -r * 0.4, h * 0.73, -r * 0.2, c, [0.3, 0.4, 0.5]);
        add(g, cylinder(r * 0.3, r * 0.3, 0.012, 20), c.mat({ type: "ceramic", color: "#d9a07a" }, "ceramic"), -r * 0.1, h * 0.73, r * 0.35, c);
      }
    }
    return g;
  },
  cup(o, c) {
    const g = new THREE.Group();
    add(g, lathe([[0.001, 0], [0.032, 0.002], [0.036, 0.085], [0.033, 0.085], [0.029, 0.006], [0.001, 0.006]], 20), main(o, c, "ceramic"), 0, 0, 0, c);
    return g;
  },
  plate(o, c) {
    const g = new THREE.Group();
    add(g, lathe([[0.001, 0], [0.08, 0.002], [0.12, 0.018], [0.118, 0.02], [0.078, 0.006], [0.001, 0.006]], 28), main(o, c, "ceramic"), 0, 0, 0, c);
    return g;
  },
  pot(o, c) {
    const [w, h] = sz(o, [0.4, 0.35, 0.4]);
    const g = new THREE.Group();
    const m = main(o, c, "metal");
    add(g, cylinder(w / 2, w / 2 * 0.95, h, 32, true), c.mat({ type: typeof o.material === "string" ? o.material : "metal", side: "double" }, "metal"), 0, h / 2, 0, c);
    add(g, cylinder(w / 2 * 0.95, w / 2 * 0.95, 0.01, 32), m, 0, 0.005, 0, c);
    add(g, cylinder(w / 2 * 0.96, w / 2 * 0.96, 0.006, 32), c.track(new THREE.MeshStandardMaterial({ color: (o.liquid as string) || "#b07a3e", roughness: 0.1 })), 0, h * 0.85, 0, c);
    for (const sx of [-1, 1]) add(g, box(0.06, 0.02, 0.03, 0.005), c.mat("iron", "iron"), sx * (w / 2 + 0.03), h * 0.85, 0, c);
    return g;
  },
  candle(o, c) {
    const [, h] = sz(o, [0.05, 0.2, 0.05]);
    const g = new THREE.Group();
    add(g, cylinder(0.022, 0.024, h, 16), c.mat({ type: "paper", color: (o.color as string) || "#efe6cf", rough: 0.6 }, "paper"), 0, h / 2, 0, c);
    add(g, cylinder(0.05, 0.04, 0.02, 20), c.mat("brass", "brass"), 0, 0.01, 0, c);
    return g;
  },
  books(o, c) {
    const g = new THREE.Group();
    const rand = rng(num(o.seed, 4) * 31 + 1);
    const n = Math.round(num(o.count, 4));
    let y = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.16 + rand() * 0.08, d = 0.22 + rand() * 0.08, t = 0.025 + rand() * 0.03;
      const m = c.mat({ type: "leather", color: BOOK_COLOURS[Math.floor(rand() * BOOK_COLOURS.length)], wear: 0.6 }, "leather");
      add(g, box(w, t, d, 0.004), m, 0, y + t / 2, 0, c, [0, (rand() - 0.5) * 0.5, 0]);
      add(g, box(w - 0.006, t - 0.008, d - 0.004, 0.001), c.mat({ type: "paper", color: "#e5dcc4" }, "paper"), 0.004, y + t / 2, 0, c, [0, (g.children[g.children.length - 1] as THREE.Mesh).rotation.y, 0]);
      y += t;
    }
    return g;
  },
  globe(o, c) {
    const [w] = sz(o, [0.45, 1.0, 0.45]);
    const r = w / 2;
    const g = new THREE.Group();
    const tex = c.canvasTexture(512, 256, (ctx, W, H) => {
      ctx.fillStyle = "#3d5a6a"; ctx.fillRect(0, 0, W, H);
      const rand = rng(77);
      ctx.fillStyle = "#b9a477";
      for (let i = 0; i < 14; i++) {
        const x = rand() * W, y = H * 0.2 + rand() * H * 0.6;
        ctx.beginPath();
        for (let k = 0; k < 9; k++) { const a = (k / 9) * Math.PI * 2, rr = 20 + rand() * 50; ctx.lineTo(x + Math.cos(a) * rr * 1.4, y + Math.sin(a) * rr); }
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(240,230,200,.25)"; ctx.lineWidth = 1;
      for (let i = 1; i < 12; i++) { ctx.beginPath(); ctx.moveTo(i * W / 12, 0); ctx.lineTo(i * W / 12, H); ctx.stroke(); }
      for (let i = 1; i < 6; i++) { ctx.beginPath(); ctx.moveTo(0, i * H / 6); ctx.lineTo(W, i * H / 6); ctx.stroke(); }
    });
    const ball = new THREE.Mesh(c.track(new THREE.SphereGeometry(r, 40, 28)), c.track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45 })));
    ball.position.y = 0.62 + r; ball.rotation.z = 0.41; ball.castShadow = true; g.add(ball);
    const brass = c.mat("brass", "brass");
    const ring = new THREE.Mesh(c.track(new THREE.TorusGeometry(r + 0.02, 0.008, 8, 48)), brass);
    ring.position.y = 0.62 + r; ring.rotation.set(0, Math.PI / 2, 0.41); g.add(ring);
    add(g, cylinder(0.025, 0.04, 0.62, 12), main(o, c, "wood"), 0, 0.31, 0, c);
    add(g, cylinder(0.18, 0.2, 0.04, 24), main(o, c, "wood"), 0, 0.02, 0, c);
    return g;
  },
  pillar(o, c) {
    const [w, h] = sz(o, [0.5, 3, 0.5]);
    const g = new THREE.Group();
    const m = main(o, c, "stone");
    add(g, box(w * 1.3, 0.2, w * 1.3, 0.01), m, 0, 0.1, 0, c);
    add(g, cylinder(w / 2, w / 2 * 1.05, h - 0.4, 32), m, 0, h / 2, 0, c);
    add(g, box(w * 1.3, 0.2, w * 1.3, 0.01), m, 0, h - 0.1, 0, c);
    return g;
  },
  beam(o, c) {
    const [w, h, d] = sz(o, [4, 0.22, 0.18]);
    const g = new THREE.Group();
    add(g, box(w, h, d, 0.01), main(o, c, "wood"), 0, -h / 2, 0, c);
    return g;
  },
  radiator(o, c) {
    const [w, h] = sz(o, [0.8, 0.6, 0.12]);
    const g = new THREE.Group();
    const m = main(o, c, "iron");
    const n = Math.round(w / 0.06);
    for (let i = 0; i < n; i++) add(g, box(0.045, h, 0.1, 0.012), m, -w / 2 + 0.03 + i * (w / n), h / 2 + 0.1, 0, c);
    add(g, cylinder(0.015, 0.015, w, 10), m, 0, 0.14, 0, c, [0, 0, Math.PI / 2]);
    add(g, cylinder(0.015, 0.015, w, 10), m, 0, h + 0.06, 0, c, [0, 0, Math.PI / 2]);
    for (const sx of [-1, 1]) add(g, box(0.04, 0.1, 0.04, 0.005), m, sx * (w / 2 - 0.05), 0.05, 0, c);
    return g;
  },
  curtain(o, c) {
    const [w, h] = sz(o, [1.2, 2.4, 0.1]);
    const g = new THREE.Group();
    const folds = Math.max(3, Math.round(w / 0.12));
    const seg = new THREE.PlaneGeometry(w, h, folds * 4, 4);
    const sp = seg.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) sp.setZ(i, Math.sin((sp.getX(i) / w + 0.5) * folds * Math.PI * 2) * 0.035);
    seg.computeVertexNormals();
    const uv = seg.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
    const m = c.mat(typeof o.material === "object" ? o.material as MatSpec : { type: (o.material as string) || "velvet", color: (o.color as string) || "#5a1f2a", side: "double" }, "velvet");
    add(g, seg, m, 0, h / 2, 0, c);
    return g;
  },
  banner(o, c) {
    const [w, h] = sz(o, [1.2, 0.9, 0.02]);
    const g = new THREE.Group();
    const strips = Math.max(1, Math.round(num(o.strips, 1)));
    const tex = textCanvas(c, { text: String(o.text || ""), width: w, height: h, color: (o.textColor as string) || "#f3efe6", background: (o.color as string) || "#1f2a44", font: (o.font as string) || "brush", vertical: Boolean(o.vertical), padding: 0.14 });
    const fabric = c.mat({ type: "fabric", color: "#ffffff" }, "fabric") as THREE.MeshStandardMaterial;
    const m = c.track(new THREE.MeshStandardMaterial({ map: tex, normalMap: fabric.normalMap, roughness: 0.95, side: THREE.DoubleSide }));
    const sw = w / strips;
    for (let i = 0; i < strips; i++) {
      const geo = new THREE.PlaneGeometry(sw - (strips > 1 ? 0.012 : 0), h, 6, 8);
      const pp = geo.getAttribute("position") as THREE.BufferAttribute;
      const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
      for (let k = 0; k < pp.count; k++) {
        const fy = 0.5 - pp.getY(k) / h;
        pp.setZ(k, Math.sin(pp.getX(k) * 9 + i * 1.7) * 0.012 * fy + fy * fy * 0.03 * Math.sin(i * 2.1));
        uv.setX(k, (i + uv.getX(k)) / strips);
      }
      geo.computeVertexNormals();
      add(g, geo, m, -w / 2 + sw * (i + 0.5), -h / 2, 0, c);
    }
    add(g, cylinder(0.012, 0.012, w + 0.1, 10), c.mat("wood", "wood"), 0, 0.01, 0, c, [0, 0, Math.PI / 2]);
    return g;
  },
  sign(o, c) {
    const [w, h] = sz(o, [1.0, 0.35, 0.03]);
    const g = new THREE.Group();
    const neon = Boolean(o.neon);
    const tex = textCanvas(c, { text: String(o.text || ""), width: w, height: h, color: (o.textColor as string) || (neon ? (o.color as string) || "#ff4f7a" : "#f2ead8"), background: neon ? "#000000" : (o.background as string) || "#2a1d14", font: (o.font as string) || (neon ? "sans" : "serif"), vertical: Boolean(o.vertical), glow: neon, padding: 0.12 });
    if (neon) {
      const m = c.track(new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true }));
      m.color.setScalar(num(o.glow, 6));
      const mesh = add(g, picturePlane(w, h), m, 0, 0, 0.012, c);
      mesh.castShadow = false;
      const back = add(g, box(w, h, 0.02, 0.004), c.mat({ type: "metal", color: "#151515" }, "metal"), 0, 0, -0.005, c);
      back.visible = o.backing !== false;
    } else {
      add(g, box(w, h, 0.03, 0.006), main(o, c, "wood"), 0, 0, 0, c);
      const face = c.track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
      add(g, picturePlane(w * 0.97, h * 0.94), face, 0, 0, 0.0155, c).castShadow = false;
    }
    return g;
  },
  pipe(o, c) {
    const [w, h] = sz(o, [0.06, 3, 0.06]);
    const g = new THREE.Group();
    add(g, cylinder(w / 2, w / 2, h, 12), main(o, c, "iron"), 0, h / 2, 0, c);
    return g;
  },
};
B.wardrobe = (o, c) => B.cabinet({ ...o, size: sz(o, [1.0, 2.0, 0.55]) }, c);
B.dresser = (o, c) => B.cabinet({ drawers: 3, ...o, size: sz(o, [1.0, 0.85, 0.5]) }, c);
B.nightstand = (o, c) => B.cabinet({ drawers: 2, ...o, size: sz(o, [0.45, 0.55, 0.4]) }, c);
B.column = B.pillar;
B.mug = B.cup;

export const PROP_NAMES = Object.keys(B).sort();

export function build(kind: string, o: PropOptions, c: PropCtx): THREE.Object3D {
  const f = B[kind] || B[kind.replace(/s$/, "")];
  if (!f) throw new Error(`world.add: no thing called "${kind}". Things: ${PROP_NAMES.join(", ")}`);
  const g = f(o, c);
  g.name = kind;
  return g;
}
