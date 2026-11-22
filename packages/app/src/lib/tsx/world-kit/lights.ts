/**
 * Lamps with a body: every light in the kit comes with the thing that makes it
 * (a bulb under a tin shade, a paper lantern, a candle flame, a chandelier), so
 * the light has a visible source that glows into the bloom. Levels are named
 * (candle, dim, lamp, bright, flood) because three.js's physical units are not
 * what anyone guesses.
 */
import * as THREE from "three";
import { cylinder, lathe, sphere, box } from "./geometry";
import type { PropCtx, MatSpec } from "./props";

export function kelvin(k: number): THREE.Color {
  const t = Math.max(1000, Math.min(12000, k)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); b = 255; }
  const c = new THREE.Color();
  c.setRGB(Math.min(255, Math.max(0, r)) / 255, Math.min(255, Math.max(0, g)) / 255, Math.min(255, Math.max(0, b)) / 255, THREE.SRGBColorSpace);
  return c;
}

export const POWER: Record<string, number> = { candle: 1.6, dim: 6, lamp: 16, bright: 40, flood: 110 };

export interface LampOptions {
  kind?: string;
  at?: number[];
  color?: string;
  kelvin?: number;
  power?: string | number;
  range?: number;
  shadow?: boolean;
  /** A visible beam under the lamp (dusty air). */
  cone?: boolean;
  flicker?: number;
  /** A soft wash of this lamp's light thrown at a point [x, y, z]: the far wall, a poster, a door. */
  wash?: number[];
  /** Length of the cable/chain above a hanging lamp, in metres. */
  hang?: number;
  shade?: MatSpec;
  facing?: number | string;
  size?: number;
  on?: boolean;
}

export interface Lamp {
  group: THREE.Group;
  lights: THREE.Light[];
  base: number[];
  glow: THREE.MeshStandardMaterial[];
  glowBase: number[];
  flicker: number;
  cone: THREE.Mesh | null;
  on: boolean;
  set(on: boolean): void;
  setPower(p: string | number): void;
}

function coneBeam(color: THREE.Color, height: number, radius: number): THREE.Mesh {
  const g = new THREE.ConeGeometry(radius, height, 40, 1, true);
  g.translate(0, -height / 2, 0);
  const m = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.06), transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vBeamUv;\nvarying vec3 vBeamN;\nvarying vec3 vBeamV;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBeamUv = uv;\nvBeamN = normalize(normalMatrix * normal);")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvBeamV = -mvPosition.xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vBeamUv;\nvarying vec3 vBeamN;\nvarying vec3 vBeamV;")
      .replace("#include <alphamap_fragment>", `#include <alphamap_fragment>
        float facing = abs(dot(normalize(vBeamN), normalize(vBeamV)));
        diffuseColor.a *= smoothstep(0.0, 0.5, facing) * smoothstep(0.0, 0.35, vBeamUv.y) * smoothstep(0.0, 0.1, 1.0 - vBeamUv.y);`);
  };
  m.customProgramCacheKey = () => "ywk-feathered-beam";
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 3;
  return mesh;
}

export function buildLamp(o: LampOptions, c: PropCtx, ceilingAbove: (x: number, z: number, y: number) => number, shadowsLeft: () => boolean): Lamp {
  const kind = o.kind || "bulb";
  const at = o.at && o.at.length === 3 ? o.at : o.at && o.at.length === 2 ? [o.at[0], 2.4, o.at[1]] : [0, 2.4, 0];
  const paperColor = new THREE.Color().setStyle(o.color || "#c0281e");
  let color = o.color && kind !== "lantern" ? new THREE.Color().setStyle(o.color) : kelvin(o.kelvin ?? (kind === "candle" || kind === "chandelier" ? 1900 : kind === "lantern" ? 2300 : kind === "tube" ? 5200 : 2700));
  if (kind === "lantern") color = color.clone().lerp(paperColor, 0.3);
  const power = typeof o.power === "number" ? o.power : POWER[o.power || (kind === "candle" ? "candle" : kind === "chandelier" ? "bright" : kind === "lantern" ? "dim" : "lamp")] ?? POWER.lamp;
  const range = o.range ?? (power < 3 ? 4 : power < 10 ? 7 : power < 30 ? 10 : 16);
  const group = new THREE.Group();
  group.name = "lamp:" + kind;
  group.position.set(at[0], at[1], at[2]);
  const lights: THREE.Light[] = [];
  const glow: THREE.MeshStandardMaterial[] = [];
  const glowBase: number[] = [];
  const glowMat = (strength: number, tint = color) => {
    const m = c.track(new THREE.MeshStandardMaterial({ color: tint.clone().lerp(new THREE.Color(1, 1, 1), 0.5), emissive: tint, emissiveIntensity: strength, roughness: 0.4 }));
    glow.push(m); glowBase.push(strength);
    return m;
  };
  const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, shadow = true) => {
    const me = new THREE.Mesh(c.track(geo), m);
    me.position.set(x, y, z);
    me.castShadow = shadow; me.receiveShadow = true;
    group.add(me);
    return me;
  };
  const point = (p: number, y = 0, dist = range) => {
    const l = new THREE.PointLight(color, p, dist, 2);
    l.position.set(0, y, 0);
    group.add(l); lights.push(l);
    return l;
  };
  const spot = (p: number, y: number, angle: number, wantShadow: boolean) => {
    const l = new THREE.SpotLight(color, p, range * 1.4, angle, 1, 2);
    l.position.set(0, y, 0);
    l.target.position.set(0, y - 3, 0);
    group.add(l, l.target); lights.push(l);
    if (wantShadow && shadowsLeft()) {
      l.castShadow = true;
      l.shadow.mapSize.set(1024, 1024);
      l.shadow.bias = -0.0004; l.shadow.normalBias = 0.02;
      l.shadow.camera.near = 0.1; l.shadow.camera.far = range * 1.4;
      l.shadow.radius = 3;
    }
    return l;
  };
  const cord = (top: number, from: number, mat: THREE.Material, r = 0.004) => {
    const len = Math.max(0.05, top - from);
    mesh(cylinder(r, r, len, 6), mat, 0, from + len / 2, 0, false);
  };
  const ceiling = ceilingAbove(at[0], at[2], at[1]);
  const dark = c.mat({ type: "iron", color: "#2a2d2b" }, "iron");
  const shadeMat = o.shade ? c.mat(typeof o.shade === "string" ? { type: o.shade, side: "double" } : o.shade, "metal") : c.mat({ type: "metal", color: "#3a423e", side: "double", wear: 0.5 }, "metal");
  let cone: THREE.Mesh | null = null;

  switch (kind) {
    case "pendant": {
      cord(o.hang !== undefined ? o.hang + 0.12 : ceiling - at[1], 0.12, dark);
      const shade = mesh(lathe([[0.02, 0.14], [0.05, 0.12], [0.16, 0.02], [0.2, 0]], 32), shadeMat, 0, 0, 0);
      shade.castShadow = true;
      mesh(sphere(0.042, 16), glowMat(14), 0, 0.03, 0, false);
      // Most of a shaded bulb's light goes down; a little reaches the ceiling.
      point(power * 0.12, -0.02);
      spot(power * 2.0, 0.0, 1.05, o.shadow !== false);
      break;
    }
    case "bulb": {
      cord(o.hang !== undefined ? o.hang + 0.06 : ceiling - at[1], 0.06, dark, 0.003);
      mesh(cylinder(0.014, 0.014, 0.04, 10), c.mat("brass", "brass"), 0, 0.05, 0);
      mesh(sphere(0.035, 16), glowMat(18), 0, 0, 0, false);
      const l = point(power, 0);
      if (o.shadow && shadowsLeft()) { l.castShadow = true; l.shadow.mapSize.set(512, 512); l.shadow.bias = -0.002; l.shadow.radius = 4; }
      break;
    }
    case "lantern": {
      const s = o.size ?? 0.42;
      cord(o.hang !== undefined ? o.hang + s * 0.55 : ceiling - at[1], s * 0.55, dark, 0.005);
      const prof: [number, number][] = [];
      for (let i = 0; i <= 12; i++) { const t = i / 12; prof.push([s * 0.32 * Math.sin(0.12 + t * (Math.PI - 0.24)), -s / 2 + t * s]); }
      const paper = new THREE.MeshStandardMaterial({ color: 0x050403, emissive: paperColor.clone().lerp(new THREE.Color(1, 0.5, 0.2), 0.1), emissiveIntensity: 1.4, roughness: 0.9, side: THREE.DoubleSide });
      c.track(paper); glow.push(paper); glowBase.push(1.4);
      mesh(lathe(prof, 28), paper, 0, 0, 0, false);
      for (let i = 1; i < 7; i++) {
        const y = -s / 2 + (i / 7) * s, rr = s * 0.32 * Math.sin(0.12 + (i / 7) * (Math.PI - 0.24));
        const rib = new THREE.Mesh(c.track(new THREE.TorusGeometry(rr + 0.002, 0.003, 4, 28)), dark);
        rib.rotation.x = Math.PI / 2; rib.position.y = y; group.add(rib);
      }
      mesh(cylinder(s * 0.12, s * 0.12, 0.04, 16), dark, 0, s / 2, 0);
      mesh(cylinder(s * 0.12, s * 0.12, 0.04, 16), dark, 0, -s / 2, 0);
      point(power, 0);
      break;
    }
    case "candle": {
      mesh(cylinder(0.022, 0.024, 0.16, 14), c.mat({ type: "paper", color: "#efe6cf", rough: 0.6 }, "paper"), 0, -0.08, 0);
      mesh(cylinder(0.05, 0.04, 0.02, 18), c.mat("brass", "brass"), 0, -0.17, 0);
      const flame = mesh(sphere(0.012, 10), glowMat(30, kelvin(1700)), 0, 0.02, 0, false);
      flame.scale.set(1, 2.2, 1);
      point(power, 0.06, range);
      break;
    }
    case "chandelier": {
      const R = o.size ?? 0.6;
      const brass = c.mat("brass", "brass");
      cord(o.hang !== undefined ? o.hang : ceiling - at[1], 0.1, brass, 0.008);
      const ring = new THREE.Mesh(c.track(new THREE.TorusGeometry(R, 0.02, 8, 48)), brass);
      ring.rotation.x = Math.PI / 2; ring.castShadow = true; group.add(ring);
      mesh(sphere(0.08, 16), brass, 0, 0, 0);
      const n = 8;
      const fl = glowMat(28, kelvin(1800));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, x = Math.cos(a) * R, z = Math.sin(a) * R;
        mesh(cylinder(0.035, 0.03, 0.03, 12), brass, x, 0.03, z);
        mesh(cylinder(0.016, 0.017, 0.12, 10), c.mat({ type: "paper", color: "#efe6cf" }, "paper"), x, 0.1, z);
        const f = mesh(sphere(0.01, 8), fl, x, 0.18, z, false); f.scale.set(1, 2.2, 1);
      }
      point(power, 0.15, range);
      break;
    }
    case "desk": {
      const brass = c.mat("brass", "brass");
      mesh(cylinder(0.08, 0.09, 0.02, 24), brass, 0, 0.01, 0);
      mesh(cylinder(0.008, 0.008, 0.36, 8), brass, 0, 0.19, 0);
      const sh = mesh(lathe([[0.03, 0.08], [0.06, 0.06], [0.11, 0]], 24), o.shade ? shadeMat : c.mat({ type: "metal", color: "#264a35", side: "double" }, "metal"), 0, 0.3, 0.02);
      sh.rotation.x = 0.35;
      mesh(sphere(0.025, 12), glowMat(14), 0, 0.31, 0.03, false);
      point(power * 0.35, 0.3);
      const s = spot(power * 1.6, 0.3, 0.9, Boolean(o.shadow));
      s.position.z = 0.03; s.target.position.set(0, -1, 0.35);
      break;
    }
    case "floor": {
      const brass = c.mat("brass", "brass");
      mesh(cylinder(0.14, 0.16, 0.03, 24), brass, 0, -1.5 + 0.015, 0);
      mesh(cylinder(0.012, 0.012, 1.5, 8), brass, 0, -0.75, 0);
      const fab = new THREE.MeshStandardMaterial({ color: 0x0a0806, emissive: color.clone().lerp(new THREE.Color("#e8dcc0"), 0.4), emissiveIntensity: 1.6, roughness: 1, side: THREE.DoubleSide });
      c.track(fab); glow.push(fab); glowBase.push(1.6);
      mesh(lathe([[0.12, 0.2], [0.2, 0]], 28), fab, 0, -0.05, 0, false);
      point(power, 0);
      break;
    }
    case "sconce": {
      const brass = c.mat("brass", "brass");
      mesh(box(0.08, 0.16, 0.03, 0.008), brass, 0, 0, -0.1);
      mesh(cylinder(0.01, 0.01, 0.12, 8), brass, 0, 0, -0.04).rotation.x = Math.PI / 2;
      const fab = new THREE.MeshStandardMaterial({ color: 0x0a0806, emissive: color.clone().lerp(new THREE.Color("#efe1c4"), 0.4), emissiveIntensity: 1.8, roughness: 1, side: THREE.DoubleSide });
      c.track(fab); glow.push(fab); glowBase.push(1.8);
      mesh(lathe([[0.05, 0.12], [0.08, 0]], 20), fab, 0, 0.02, 0.02, false);
      point(power, 0.06);
      break;
    }
    case "tube": {
      const len = o.size ?? 1.2;
      mesh(box(len + 0.06, 0.05, 0.1, 0.01), c.mat({ type: "metal", color: "#cfd2d0" }, "metal"), 0, 0.04, 0);
      const t = mesh(cylinder(0.016, 0.016, len, 12), glowMat(10), 0, 0, 0, false);
      t.rotation.z = Math.PI / 2;
      for (const x of [-len / 3, len / 3]) { const l = point(power * 0.5, -0.05); l.position.x = x; }
      break;
    }
    case "fire": {
      const s = o.size ?? 0.6;
      const embers = glowMat(8, kelvin(1500));
      for (let i = 0; i < 5; i++) {
        const log = mesh(cylinder(0.05, 0.05, s * 0.9, 10), c.mat({ type: "wood", color: "#2a1a10" }, "wood"), (i - 2) * 0.06, 0.05 + (i % 2) * 0.05, 0);
        log.rotation.set(Math.PI / 2, 0, (i - 2) * 0.4);
      }
      for (let i = 0; i < 6; i++) {
        const f = mesh(sphere(0.06, 10), embers, (Math.random() - 0.5) * s * 0.5, 0.12 + Math.random() * 0.1, (Math.random() - 0.5) * 0.2, false);
        f.scale.set(1, 2.5, 1);
      }
      point(power, 0.35, range);
      break;
    }
    default: {
      point(power, 0);
    }
  }
  if (o.wash && o.wash.length === 3) {
    const l = new THREE.SpotLight(color, power * 1.4, 0, 0.7, 1, 2);
    l.position.set(0, -0.05, 0);
    group.add(l, l.target);
    lights.push(l);
    // The target is placed in world space once the lamp is in the scene.
    l.userData.washAt = o.wash;
  }
  if (o.cone) {
    const h = Math.max(0.5, at[1] - 0.02);
    cone = coneBeam(color, h, Math.tan(0.62) * h);
    group.add(cone);
  }
  const base = lights.map((l) => l.intensity);
  let current = power;
  const lamp: Lamp = {
    group, lights, base, glow, glowBase, flicker: o.flicker ?? (kind === "candle" || kind === "chandelier" || kind === "fire" ? 0.5 : 0), cone, on: o.on !== false,
    set(on: boolean) {
      lamp.on = on;
      lights.forEach((l, i) => { l.intensity = on ? base[i] : 0; });
      glow.forEach((m, i) => { m.emissiveIntensity = on ? glowBase[i] : 0.02; });
      if (cone) cone.visible = on;
    },
    setPower(p) {
      const v = typeof p === "number" ? p : POWER[p] ?? current;
      const k = v / current;
      current = v;
      base.forEach((b, i) => { base[i] = b * k; });
      lamp.set(lamp.on);
    },
  };
  if (!lamp.on) lamp.set(false);
  return lamp;
}
