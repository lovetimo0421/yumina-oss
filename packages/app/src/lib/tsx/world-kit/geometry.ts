/**
 * Geometry helpers for the world kit. Every shape gets UVs in metres from a box
 * projection of its own (unscaled) vertices, so one material looks the same size
 * on a matchbox and on a wall, and nothing is stretched.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export function metreUVs<G extends THREE.BufferGeometry>(g: G): G {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  let nor = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!nor) { g.computeVertexNormals(); nor = g.getAttribute("normal") as THREE.BufferAttribute; }
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ny >= nx && ny >= nz) { uv[i * 2] = x; uv[i * 2 + 1] = z; }
    else if (nx >= nz) { uv[i * 2] = z; uv[i * 2 + 1] = y; }
    else { uv[i * 2] = x; uv[i * 2 + 1] = y; }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

/** A box with softened edges (catches highlights the way real joinery does). */
export function box(w: number, h: number, d: number, bevel = 0.006): THREE.BufferGeometry {
  const r = Math.min(bevel, w * 0.45, h * 0.45, d * 0.45);
  const g = r > 0.0015 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d);
  return metreUVs(g);
}

export function cylinder(rTop: number, rBottom: number, h: number, seg = 24, open = false): THREE.BufferGeometry {
  return cylUVs(new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open), (rTop + rBottom) / 2, h);
}

/** Cylinders keep their wrap-around UVs, scaled to metres. */
function cylUVs(g: THREE.BufferGeometry, r: number, h: number): THREE.BufferGeometry {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const circ = Math.PI * 2 * r;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
  uv.needsUpdate = true;
  return g;
}

export function sphere(r: number, seg = 24): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, seg, Math.max(8, Math.round(seg * 0.66)));
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * Math.PI * r);
  return g;
}

export function plane(w: number, h: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}

/** A plane whose UVs stay 0..1 (pictures, screens, signs). */
export function picturePlane(w: number, h: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h);
}

/** A lathe from a profile of [radius, height] points (bowls, vases, shades, bottles). */
export function lathe(profile: [number, number][], seg = 28): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y)), seg);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const maxR = Math.max(...profile.map((p) => p[0]));
  const h = Math.max(...profile.map((p) => p[1])) - Math.min(...profile.map((p) => p[1]));
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * maxR, uv.getY(i) * h);
  return g;
}

/** A soft dark blob for under furniture: contact shadow without a shadow map. */
export function contactTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(0.45, "rgba(0,0,0,.7)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function softDot(color = "rgba(255,255,255,1)"): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, color);
  g.addColorStop(0.3, color.replace(/[\d.]+\)$/, ".35)"));
  g.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
