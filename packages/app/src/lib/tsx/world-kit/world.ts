/**
 * createWorld(): a walkable, lit, graded 3D place for card code, assembled from
 * a few calls (rooms, things, lamps, sun, outside, air) instead of raw three.js.
 * The look is distilled from the 1984 card: physical lights with visible sources,
 * one sun with real shadows and light shafts through the windows, procedural PBR
 * surfaces, a light probe for bounce light, contact shadows, fog, ACES tone
 * mapping, bloom, grade, grain and vignette, and a first-person body.
 */
import * as THREE from "three";
import { box, contactTexture, cylinder, picturePlane, sphere } from "./geometry";
import { createMaterialLibrary, MATERIAL_NAMES, type MaterialOptions } from "./materials";
import { build as buildProp, PROP_NAMES, textCanvas, type MatSpec, type PropCtx, type PropOptions } from "./props";
import { buildLamp, kelvin, type Lamp, type LampOptions } from "./lights";
import { createParticles, type ParticleOptions, type Particles } from "./particles";
import { createOutside, OUTSIDE_KINDS, type OutsideOptions } from "./backdrop";
import { Controls, type Collider } from "./controls";
import { createOverlay, type Lang, type Overlay } from "./overlay";
import { Post } from "./post";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { fitToSize, fixMaterials, measure, parseModel, type ModelStats, type SizeOptions } from "./models";
import { liveStandee, modelPerson, type PersonHandle } from "./people";
import { Soundscape, SOUND_KINDS, type SoundHandle, type SoundKind, type SoundOptions } from "./sound";

type Vec = number[];
type Facing = number | string | undefined;

export interface LookOptions {
  preset?: string;
  exposure?: number;
  fog?: string;
  fogDensity?: number;
  background?: string;
  ambient?: number;
  sky?: string;
  ground?: string;
  bounce?: number;
  bloom?: number;
  grain?: number;
  vignette?: number;
  contrast?: number;
  saturation?: number;
  fringe?: number;
  shadows?: string;
  highlights?: string;
}

const LOOKS: Record<string, Required<Omit<LookOptions, "preset">>> = {
  gloomy: { exposure: 1.25, fog: "#2b363c", fogDensity: 0.03, background: "#1f282c", ambient: 0.3, sky: "#a9b8c6", ground: "#3a3630", bounce: 0.55, bloom: 0.7, grain: 1, vignette: 0.75, contrast: 0.45, saturation: 0.82, fringe: 0.7, shadows: "#c4d6e4", highlights: "#f8f4ea" },
  night: { exposure: 1.3, fog: "#0e121a", fogDensity: 0.028, background: "#07090d", ambient: 0.12, sky: "#6a7a9a", ground: "#2a2420", bounce: 0.42, bloom: 1, grain: 0.7, vignette: 0.6, contrast: 0.38, saturation: 1.05, fringe: 0.5, shadows: "#d8e2ff", highlights: "#fff0d6" },
  day: { exposure: 1.05, fog: "#c9d2da", fogDensity: 0.01, background: "#9fb3c8", ambient: 0.9, sky: "#d6e4ff", ground: "#8a7a66", bounce: 0.75, bloom: 0.35, grain: 0.35, vignette: 0.35, contrast: 0.25, saturation: 1.02, fringe: 0.3, shadows: "#eef2ff", highlights: "#fffaf0" },
  golden: { exposure: 1.1, fog: "#cdb88e", fogDensity: 0.014, background: "#a9b8c0", ambient: 0.4, sky: "#ffe6bd", ground: "#6a5a40", bounce: 0.7, bloom: 0.75, grain: 0.45, vignette: 0.5, contrast: 0.32, saturation: 1.1, fringe: 0.4, shadows: "#e2e8ff", highlights: "#ffefcf" },
  dusk: { exposure: 1.2, fog: "#3a2e3a", fogDensity: 0.02, background: "#1d2340", ambient: 0.25, sky: "#e09a7a", ground: "#2a2028", bounce: 0.6, bloom: 0.8, grain: 0.55, vignette: 0.55, contrast: 0.35, saturation: 1.08, fringe: 0.45, shadows: "#dcd8ff", highlights: "#ffe6cc" },
  candlelit: { exposure: 1.4, fog: "#120d0a", fogDensity: 0.03, background: "#060403", ambient: 0.07, sky: "#7a6a5a", ground: "#2a1a10", bounce: 0.5, bloom: 1.1, grain: 0.7, vignette: 0.7, contrast: 0.35, saturation: 1.05, fringe: 0.5, shadows: "#e0e4ff", highlights: "#ffe8c8" },
  overcast: { exposure: 1.1, fog: "#9aa2a8", fogDensity: 0.018, background: "#8f979c", ambient: 0.75, sky: "#c9d0d6", ground: "#5a5a55", bounce: 0.7, bloom: 0.3, grain: 0.5, vignette: 0.45, contrast: 0.28, saturation: 0.85, fringe: 0.35, shadows: "#e8eef6", highlights: "#f6f6f2" },
  noir: { exposure: 1.25, fog: "#15171a", fogDensity: 0.03, background: "#0a0b0c", ambient: 0.12, sky: "#9aa4ae", ground: "#2a2a2a", bounce: 0.45, bloom: 0.8, grain: 1.2, vignette: 0.8, contrast: 0.55, saturation: 0.15, fringe: 0.6, shadows: "#e6ecff", highlights: "#fff6e8" },
};

export interface PlayerOptions { at?: Vec; facing?: Facing; height?: number; speed?: number; run?: boolean; jump?: boolean; crouch?: boolean }

export interface WorldOptions {
  api?: { resolveAssetUrl?: (ref: string) => string; fetchAsset?: (ref: string) => Promise<{ ok?: boolean; bytes?: ArrayBuffer | Uint8Array; error?: string }> };
  look?: string | LookOptions;
  player?: PlayerOptions;
  name?: string;
  place?: string | [string, string];
  lang?: Lang;
  ui?: boolean;
  hints?: boolean;
  /** "auto" adapts to the device; "high" / "low" pin it. */
  quality?: "auto" | "high" | "low";
}

export interface Opening {
  wall: "north" | "south" | "east" | "west";
  kind?: "door" | "window" | "opening";
  at?: number;
  width?: number;
  height?: number;
  /** Height of the bottom edge above the floor (windows default 0.9). */
  bottom?: number;
  panes?: [number, number];
  blinds?: boolean;
  curtains?: string | false;
  glass?: boolean;
  frame?: MatSpec;
  door?: { open?: number; opens?: boolean; material?: MatSpec; label?: string; labelClose?: string };
}

export interface RoomOptions {
  id?: string;
  at?: Vec;
  size?: Vec;
  floor?: MatSpec;
  walls?: MatSpec;
  ceiling?: MatSpec | false;
  /** Lower part of the walls: a different colour or material up to `height`. */
  dado?: { height?: number; color?: string; material?: MatSpec; rail?: boolean };
  trim?: MatSpec;
  skirting?: boolean;
  cornice?: boolean;
  /** Walls left out (an open side, or shared with the next room). */
  open?: ("north" | "south" | "east" | "west")[];
  openings?: Opening[];
  /** How dark corners and wall bases get (0..1). */
  occlusion?: number;
  /** Ceiling beams across the room: { every: metres apart, material, along: "x" | "z" }. */
  beams?: { every?: number; material?: MatSpec; along?: "x" | "z"; size?: number } | boolean;
}

interface RoomRec { id: string; x0: number; x1: number; z0: number; z1: number; h: number; windows: { o: Opening; side: string; a: number; b: number; y0: number; y1: number }[] }
interface Interactable { root: THREE.Object3D; label: string; onUse: (() => void) | null; range: number; id: string }

const SIDES = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const;
const COMPASS: Record<string, number> = { south: 0, east: 90, north: 180, west: 270, s: 0, e: 90, n: 180, w: 270, southeast: 45, northeast: 135, northwest: 225, southwest: 315 };

function facingRad(f: Facing, d = 0): number {
  if (typeof f === "number" && Number.isFinite(f)) return THREE.MathUtils.degToRad(f);
  if (typeof f === "string" && f.toLowerCase() in COMPASS) return THREE.MathUtils.degToRad(COMPASS[f.toLowerCase()]);
  return THREE.MathUtils.degToRad(d);
}
function pos3(at: Vec | undefined, y = 0): THREE.Vector3 {
  if (!at || at.length < 2) return new THREE.Vector3(0, y, 0);
  return at.length === 2 ? new THREE.Vector3(at[0], y, at[1]) : new THREE.Vector3(at[0], at[1], at[2]);
}
function srgb(hex: string): THREE.Color {
  const c = new THREE.Color(hex);
  const o = { r: 1, g: 1, b: 1 };
  c.getRGB(o, THREE.SRGBColorSpace);
  return new THREE.Color().setRGB(o.r, o.g, o.b, THREE.LinearSRGBColorSpace);
}

export function createWorld(container: HTMLElement, options: WorldOptions = {}) {
  if (!container || !(container as HTMLElement).appendChild) throw new Error("createWorld needs the element to draw into.");
  const doc = container.ownerDocument;
  const win = doc.defaultView || window;
  const coarse = Boolean(win.matchMedia?.("(pointer: coarse)").matches);
  const cjk = /[\u3040-\u30ff\u3400-\u9fff]/.test(JSON.stringify([options.name, options.place]));
  const lang: Lang = options.lang || (cjk || /^zh/i.test(doc.documentElement.lang || "") ? "zh" : "en");
  const resolveUrl = (ref: string) => {
    if (/^(https?:|data:|blob:)/.test(ref)) return ref;
    const r = options.api?.resolveAssetUrl;
    return r ? r(ref.startsWith("@asset:") ? ref : "@asset:" + ref) : ref;
  };
  if (getComputedStyle(container).position === "static") container.style.position = "relative";

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
  } catch (e) {
    throw new Error("3D could not start on this device: " + ((e as Error)?.message || String(e)));
  }
  const dpr = Math.min(win.devicePixelRatio || 1, coarse ? 1.5 : 2);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: "block", width: "100%", height: "100%", position: "absolute", inset: "0", opacity: "0", transition: "opacity 1.4s ease" });
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(coarse ? 72 : 66, 1, 0.04, 120);
  camera.rotation.order = "YXZ";
  scene.add(camera);
  const post = new Post(renderer, { msaa: !coarse && renderer.capabilities.isWebGL2 });

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const lib = createMaterialLibrary({ textureSize: coarse ? 256 : 512, resolveUrl, maxAnisotropy: Math.min(8, maxAniso) });
  const owned = new Set<{ dispose(): void }>();
  const track = <T extends { dispose(): void }>(x: T): T => { owned.add(x); return x; };
  const ctx: PropCtx = {
    mat: (spec, fallback) => lib.get(spec as string | MaterialOptions | THREE.Material | undefined, fallback),
    canvasTexture(w, h, draw, srgbTex = true) {
      const c = doc.createElement("canvas");
      c.width = w; c.height = h;
      draw(c.getContext("2d")!, w, h);
      const t = new THREE.CanvasTexture(c);
      if (srgbTex) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, maxAniso);
      return track(t);
    },
    track,
  };

  const colliders: Collider[] = [];
  const blockers: THREE.Object3D[] = [];
  const interactables = new Map<THREE.Object3D, Interactable>();
  const rooms: RoomRec[] = [];
  const lamps: Lamp[] = [];
  const particles: Particles[] = [];
  const shafts: THREE.Object3D[] = [];
  const animated: ((t: number, dt: number) => void)[] = [];
  const pending: Promise<unknown>[] = [];
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const emit = (name: string, ...a: unknown[]) => { for (const f of listeners[name] || []) { try { f(...a); } catch (e) { console.error(e); } } };
  let shadowCasters = 0;
  const shadowsLeft = () => shadowCasters < 3 && (shadowCasters++, true);
  let sunLight: THREE.DirectionalLight | null = null;
  let sunOpts: { shafts: boolean; strength: number; color: THREE.Color } | null = null;
  let outside: ReturnType<typeof createOutside> | null = null;
  let envRT: THREE.WebGLRenderTarget | null = null;
  let started = false, destroyed = false, firstFrame = false;
  let hemi: THREE.HemisphereLight;
  let currentRoom: string | null = null;
  const contact = track(contactTexture());
  const contactMat = track(new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: contact, transparent: true, opacity: 0.55, depthWrite: false }));

  // ---------- look ----------
  const look = { ...LOOKS.gloomy };
  function setLook(l: string | LookOptions | undefined) {
    const preset = typeof l === "string" ? l : l?.preset;
    Object.assign(look, LOOKS[preset || "gloomy"] || LOOKS.gloomy);
    if (l && typeof l === "object") for (const [k, v] of Object.entries(l)) if (k !== "preset" && v !== undefined) (look as Record<string, unknown>)[k] = v;
    scene.background = new THREE.Color(look.background);
    scene.fog = new THREE.FogExp2(new THREE.Color(look.fog), look.fogDensity);
    if (!hemi) { hemi = new THREE.HemisphereLight(look.sky, look.ground, look.ambient); scene.add(hemi); }
    hemi.color.set(look.sky); hemi.groundColor.set(look.ground); hemi.intensity = look.ambient;
    scene.environmentIntensity = look.bounce;
    const L = post.look;
    L.exposure = look.exposure; L.bloom = look.bloom; L.grain = look.grain; L.vignette = look.vignette;
    L.contrast = look.contrast; L.saturation = look.saturation; L.fringe = look.fringe;
    L.shadowTint.copy(srgb(look.shadows)); L.highlightTint.copy(srgb(look.highlights));
  }
  setLook(options.look);

  // ---------- helpers ----------
  /** Shelves and other raised things the player walks under: not solid, but a model can stand on them. */
  const supports: Collider[] = [];
  function addCollider(obj: THREE.Object3D, on: () => boolean = () => true, into: Collider[] = colliders): Collider | null {
    const rot = obj.rotation.y, p = obj.position.clone();
    obj.rotation.y = 0; obj.position.set(0, 0, 0); obj.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj);
    obj.rotation.y = rot; obj.position.copy(p); obj.updateMatrixWorld(true);
    if (b.isEmpty()) return null;
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const cos = Math.cos(rot), sin = Math.sin(rot);
    // Local centre rotated into the world (three's Y rotation: x' = x cos + z sin, z' = -x sin + z cos).
    const rec: Collider = { cx: p.x + c.x * cos + c.z * sin, cz: p.z - c.x * sin + c.z * cos, hx: s.x / 2, hz: s.z / 2, cos: Math.cos(-rot), sin: Math.sin(-rot), top: p.y + b.max.y, bottom: p.y + b.min.y, on };
    into.push(rec);
    return rec;
  }
  /** The top of whatever stands under (x, z) lower than `under` metres (a counter, a desk, a shelf), else the floor. */
  function surfaceAt(x: number, z: number, under = 1.9): number {
    let top = 0;
    for (const c of [...colliders, ...supports]) {
      if (!c.on() || c.top >= under || c.top <= top) continue;
      const dx = x - c.cx, dz = z - c.cz;
      const lx = dx * c.cos + dz * c.sin, lz = -dx * c.sin + dz * c.cos;
      if (Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz) top = c.top;
    }
    return top;
  }
  function addContact(obj: THREE.Object3D, strength = 1) {
    if (obj.position.y > 0.05) return;
    const rot = obj.rotation.y, p = obj.position.clone();
    obj.rotation.y = 0; obj.position.set(0, 0, 0); obj.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj);
    obj.rotation.y = rot; obj.position.copy(p); obj.updateMatrixWorld(true);
    if (b.isEmpty()) return;
    const s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    if (s.y < 0.05) return;
    const m = new THREE.Mesh(track(new THREE.PlaneGeometry(s.x * 1.35 + 0.15, s.z * 1.35 + 0.15)), strength === 1 ? contactMat : track(Object.assign(contactMat.clone(), { opacity: 0.55 * strength })));
    m.rotation.x = -Math.PI / 2;
    m.position.set(c.x, 0.004, c.z);
    m.renderOrder = 1;
    obj.add(m);
  }
  function makeUsable(root: THREE.Object3D, o: { use?: unknown; onUse?: unknown; range?: unknown; id?: unknown }) {
    if (!o.use && typeof o.onUse !== "function") return;
    interactables.set(root, {
      root, label: typeof o.use === "string" ? o.use : lang === "zh" ? "查看" : "Look",
      onUse: typeof o.onUse === "function" ? (o.onUse as () => void) : null,
      range: typeof o.range === "number" ? o.range : 2.4, id: typeof o.id === "string" ? o.id : root.name,
    });
  }
  function place(obj: THREE.Object3D, at: Vec | undefined, facing: Facing, y = 0) {
    obj.position.copy(pos3(at, y));
    obj.rotation.y = facingRad(facing);
    scene.add(obj);
    obj.updateMatrixWorld(true);
  }
  function ceilingAbove(x: number, z: number, y: number) {
    for (const r of rooms) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return r.h;
    return y + 0.6;
  }

  // ---------- room finish: corner occlusion, base grime, dado colour ----------
  function finish(material: THREE.Material, kind: "wall" | "floor" | "ceiling", r: RoomRec, occl: number, dado?: { height: number; color: THREE.Color | null }) {
    const m = material.clone() as THREE.MeshStandardMaterial;
    track(m);
    const bounds = new THREE.Vector4(r.x0, r.x1, r.z0, r.z1);
    const dadoH = dado?.height ?? -1, dadoC = dado?.color ?? new THREE.Color(1, 1, 1);
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uRoom = { value: bounds };
      shader.uniforms.uRoomH = { value: r.h };
      shader.uniforms.uOcc = { value: occl };
      shader.uniforms.uDadoH = { value: dadoH };
      shader.uniforms.uDadoC = { value: dadoC };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRoomP;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRoomP = (modelMatrix * vec4(position, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec3 vRoomP; uniform vec4 uRoom; uniform float uRoomH, uOcc, uDadoH; uniform vec3 uDadoC;
          float rHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
          float rNoise(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(rHash(i), rHash(i + vec3(1,0,0)), f.x), mix(rHash(i + vec3(0,1,0)), rHash(i + vec3(1,1,0)), f.x), f.y),
                       mix(mix(rHash(i + vec3(0,0,1)), rHash(i + vec3(1,0,1)), f.x), mix(rHash(i + vec3(0,1,1)), rHash(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          ${kind === "wall" ? `
            float wear = rNoise(vRoomP * vec3(7.0, 11.0, 7.0));
            if (uDadoH > 0.0) {
              float edgeY = uDadoH + (wear - 0.5) * 0.012;
              float lower = 1.0 - smoothstep(edgeY - 0.002, edgeY + 0.003, vRoomP.y);
              diffuseColor.rgb *= mix(vec3(1.0), uDadoC, lower);
            }
            float grime = (1.0 - smoothstep(0.06, 0.4, vRoomP.y)) * (0.6 + wear * 0.4);
            diffuseColor.rgb *= 1.0 - grime * 0.16 * uOcc;
          ` : ""}`)
        .replace("#include <aomap_fragment>", `#include <aomap_fragment>
          float rOcc = 1.0;
          float dx = min(vRoomP.x - uRoom.x, uRoom.y - vRoomP.x), dz = min(vRoomP.z - uRoom.z, uRoom.w - vRoomP.z);
          ${kind === "floor" ? `
            rOcc = mix(0.38, 1.0, smoothstep(0.0, 0.6, min(dx, dz)));
          ` : kind === "ceiling" ? `
            rOcc = mix(0.42, 1.0, smoothstep(0.0, 0.7, min(dx, dz)));
          ` : `
            // On a wall one of dx/dz is ~0 (its own plane); the other is the distance to the corner.
            float along = max(dx, dz);
            float vert = min(vRoomP.y, uRoomH - vRoomP.y);
            rOcc = mix(0.45, 1.0, smoothstep(0.0, 0.55, vert)) * mix(0.55, 1.0, smoothstep(0.0, 0.5, along));
          `}
          rOcc = mix(1.0, rOcc, uOcc);
          reflectedLight.indirectDiffuse *= rOcc;
          reflectedLight.indirectSpecular *= mix(1.0, rOcc, 0.7);`);
    };
    m.customProgramCacheKey = () => "ywk-finish-" + kind;
    return m;
  }

  // ---------- rooms ----------
  function room(o: RoomOptions = {}) {
    const c = pos3(o.at);
    const size = o.size || [6, 3, 6];
    const W = size[0] ?? 6, H = size[1] ?? 3, D = size[2] ?? 6;
    const rec: RoomRec = { id: o.id || "room" + (rooms.length + 1), x0: c.x - W / 2, x1: c.x + W / 2, z0: c.z - D / 2, z1: c.z + D / 2, h: H, windows: [] };
    rooms.push(rec);
    const T = 0.2;
    const occ = o.occlusion ?? 1;
    const dadoColor = o.dado?.color ? srgb(o.dado.color) : o.dado ? srgb("#7a8a7c") : null;
    const wallMat = finish(lib.get(o.walls as string, "plaster"), "wall", rec, occ, o.dado && !o.dado.material ? { height: o.dado.height ?? 1.1, color: dadoColor } : undefined);
    const dadoMat = o.dado?.material ? finish(lib.get(o.dado.material as string, "wood-panel"), "wall", rec, occ) : null;
    const floorMat = finish(lib.get(o.floor as string, "wood-floor"), "floor", rec, occ);
    const trimMat = lib.get(o.trim as string || { type: "paint", color: "#3b3a33" }, "paint");
    const group = new THREE.Group();
    group.name = "room:" + rec.id;
    scene.add(group);
    const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, cast = true) => {
      const me = new THREE.Mesh(track(geo), m);
      me.position.set(x, y, z);
      me.castShadow = cast; me.receiveShadow = true;
      group.add(me);
      return me;
    };
    // Floor and ceiling slabs. Floor top at y = 0.
    const floor = mesh(box(W + 2 * T, 0.1, D + 2 * T, 0), floorMat, c.x, -0.05, c.z, false);
    blockers.push(floor);
    if (o.ceiling !== false) {
      const ceilMat = finish(lib.get(o.ceiling as string, "plaster"), "ceiling", rec, occ);
      const ceil = mesh(box(W + 2 * T, 0.12, D + 2 * T, 0), ceilMat, c.x, H + 0.06, c.z, true);
      blockers.push(ceil);
    }
    if (o.beams && o.ceiling !== false) {
      const b = o.beams === true ? {} : o.beams;
      const along = b.along || (W >= D ? "z" : "x");
      const every = b.every ?? 1.6, sz = b.size ?? 0.2;
      const bm = lib.get(b.material as string || { type: "wood", color: "#3a2616" }, "wood");
      const span = along === "z" ? W : D, len = along === "z" ? D : W;
      const n = Math.max(1, Math.floor(span / every));
      for (let i = 1; i <= n; i++) {
        const off = -span / 2 + (i * span) / (n + 1);
        const geo = along === "z" ? box(sz, sz * 1.2, len, 0.01) : box(len, sz * 1.2, sz, 0.01);
        mesh(geo, bm, along === "z" ? c.x + off : c.x, H - sz * 0.6, along === "z" ? c.z : c.z + off, true);
      }
    }
    const open = new Set(o.open || []);
    for (const side of ["north", "south", "east", "west"] as const) {
      if (open.has(side)) continue;
      const along = side === "north" || side === "south" ? W : D;
      const ext = side === "north" || side === "south" ? T : 0;
      const [nx, nz] = SIDES[side];
      const ops = (o.openings || []).filter((op) => op.wall === side).map((op) => {
        const kind = op.kind || "window";
        const width = op.width ?? (kind === "door" ? 0.95 : 1.4);
        const bottom = op.bottom ?? (kind === "window" ? 0.9 : 0);
        const height = op.height ?? (kind === "door" ? 2.1 : kind === "window" ? Math.min(1.5, H - bottom - 0.35) : Math.min(2.4, H - 0.2));
        const at = op.at ?? 0;
        return { op, kind, a: at - width / 2, b: at + width / 2, y0: bottom, y1: Math.min(H, bottom + height) };
      }).sort((p, q) => p.a - q.a);
      // A point on this wall: s along it, at height y, depth d into the wall (0 = inner face).
      const pt = (s: number, d: number) => side === "north" || side === "south"
        ? [c.x + s, c.z + nz * (D / 2 + d)]
        : [c.x + nx * (W / 2 + d), c.z + s];
      const piece = (s0: number, s1: number, y0: number, y1: number, m: THREE.Material = wallMat) => {
        if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return;
        const len = s1 - s0, [px, pz] = pt((s0 + s1) / 2, T / 2);
        const geo = side === "north" || side === "south" ? box(len, y1 - y0, T, 0) : box(T, y1 - y0, len, 0);
        const me = mesh(geo, m, px, (y0 + y1) / 2, pz, true);
        blockers.push(me);
        if (y0 < 1.2) {
          const lx = side === "north" || side === "south" ? len : T, lz = side === "north" || side === "south" ? T : len;
          colliders.push({ cx: px, cz: pz, hx: lx / 2, hz: lz / 2, cos: 1, sin: 0, top: y1, bottom: y0, on: () => true });
        }
        // Trim along the inner face.
        const trim = (h: number, depth: number, y: number, m2: THREE.Material) => {
          const [tx, tz] = pt((s0 + s1) / 2, -depth / 2);
          const g = side === "north" || side === "south" ? box(len, h, depth, 0.004) : box(depth, h, len, 0.004);
          mesh(g, m2, tx, y, tz, false);
        };
        if (o.skirting !== false && y0 === 0) trim(0.12, 0.022, 0.06, trimMat);
        if (o.cornice !== false && y1 >= H - 0.001) { trim(0.07, 0.05, H - 0.035, trimMat); trim(0.04, 0.09, H - 0.09, trimMat); }
        if (o.dado && o.dado.rail !== false) {
          const dh = o.dado.height ?? 1.1;
          if (y0 < dh && y1 > dh + 0.05) trim(0.045, 0.028, dh, trimMat);
        }
        if (dadoMat) {
          const dh = o.dado?.height ?? 1.1;
          if (y0 < dh) {
            const [dx, dz] = pt((s0 + s1) / 2, -0.012);
            const top = Math.min(dh, y1);
            const g = side === "north" || side === "south" ? box(len, top - y0, 0.024, 0.003) : box(0.024, top - y0, len, 0.003);
            mesh(g, dadoMat, dx, (y0 + top) / 2, dz, false);
          }
        }
      };
      let cursor = -along / 2 - ext;
      for (const p of ops) {
        piece(cursor, p.a, 0, H);
        if (p.y0 > 0) piece(p.a, p.b, 0, p.y0);
        if (p.y1 < H) piece(p.a, p.b, p.y1, H);
        cursor = p.b;
        dressOpening(p, side, pt, group, rec);
      }
      piece(cursor, along / 2 + ext, 0, H);
    }
    return group;
  }

  function dressOpening(p: { op: Opening; kind: string; a: number; b: number; y0: number; y1: number }, side: keyof typeof SIDES, pt: (s: number, d: number) => number[], group: THREE.Group, rec: RoomRec) {
    const op = p.op;
    const frameMat = lib.get(op.frame as string || { type: "paint", color: "#4a4d44", wear: 0.5 }, "paint");
    const isNS = side === "north" || side === "south";
    // Rotation so local +z points into the room from this wall.
    const rotY = side === "north" ? 0 : side === "south" ? Math.PI : side === "west" ? Math.PI / 2 : -Math.PI / 2;
    const g = new THREE.Group();
    const [cx, cz] = pt((p.a + p.b) / 2, 0);
    g.position.set(cx, 0, cz);
    g.rotation.y = rotY;
    group.add(g);
    // Local frame: x across the opening (a..b), y up, z into the room; the wall's inner face is z = 0.
    const w = p.b - p.a, T = 0.2;
    const sx = side === "north" || side === "west" ? 1 : -1;
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, cast = true) => {
      const me = new THREE.Mesh(track(geo), m);
      me.position.set(x * sx, y, z); me.castShadow = cast; me.receiveShadow = true; g.add(me); return me;
    };
    // Reveal linings inside the wall thickness and an architrave on the room face.
    add(box(0.03, p.y1 - p.y0, T, 0), frameMat, -w / 2 + 0.015, (p.y0 + p.y1) / 2, -T / 2);
    add(box(0.03, p.y1 - p.y0, T, 0), frameMat, w / 2 - 0.015, (p.y0 + p.y1) / 2, -T / 2);
    add(box(w, 0.03, T, 0), frameMat, 0, p.y1 - 0.015, -T / 2);
    const arch = 0.07;
    add(box(arch, p.y1 - p.y0 + arch, 0.025, 0.004), frameMat, -w / 2 - arch / 2, (p.y0 + p.y1 + arch) / 2, 0.012);
    add(box(arch, p.y1 - p.y0 + arch, 0.025, 0.004), frameMat, w / 2 + arch / 2, (p.y0 + p.y1 + arch) / 2, 0.012);
    add(box(w + arch * 2, arch, 0.025, 0.004), frameMat, 0, p.y1 + arch / 2, 0.012);
    if (p.kind === "window") {
      rec.windows.push({ o: op, side, a: p.a, b: p.b, y0: p.y0, y1: p.y1 });
      add(box(w + 0.16, 0.04, T + 0.14, 0.006), frameMat, 0, p.y0 - 0.02, 0.07 - T / 2);
      const [cols, rows] = op.panes || [2, 2];
      const glassZ = -T * 0.6;
      if (op.glass !== false) {
        const glass = new THREE.Mesh(track(picturePlane(w - 0.04, p.y1 - p.y0 - 0.04)), lib.get("glass"));
        glass.position.set(0, (p.y0 + p.y1) / 2, glassZ); glass.castShadow = false; glass.renderOrder = 6;
        g.add(glass);
      }
      for (let i = 1; i < cols; i++) add(box(0.045, p.y1 - p.y0, 0.05, 0.004), frameMat, -w / 2 + (i * w) / cols, (p.y0 + p.y1) / 2, glassZ);
      for (let i = 1; i < rows; i++) add(box(w, 0.045, 0.05, 0.004), frameMat, 0, p.y0 + (i * (p.y1 - p.y0)) / rows, glassZ);
      if (op.blinds) {
        const slatMat = lib.get({ type: "wood", color: "#8a8270" }, "wood");
        const n = Math.max(4, Math.round((p.y1 - p.y0) / 0.11));
        for (let i = 0; i < n; i++) {
          const s = add(box(w - 0.06, 0.006, 0.07, 0.002), slatMat, 0, p.y0 + 0.08 + (i * (p.y1 - p.y0 - 0.1)) / n, 0.05);
          s.rotation.x = -0.35;
        }
        add(box(w - 0.02, 0.05, 0.08, 0.006), frameMat, 0, p.y1 - 0.03, 0.05);
      }
      if (op.curtains) {
        for (const k of [-1, 1]) {
          const cur = buildProp("curtain", { size: [0.55, p.y1 - p.y0 + 0.5, 0.1], color: op.curtains }, ctx);
          cur.position.set(k * (w / 2 + 0.2) * sx, p.y0 - 0.2, 0.12);
          g.add(cur);
        }
        add(cylinder(0.015, 0.015, w + 1.0, 10), lib.get("brass"), 0, p.y1 + 0.32, 0.12).rotation.z = Math.PI / 2;
      }
    } else if (p.kind === "door") {
      const d = op.door || {};
      const leafMat = lib.get(d.material as string || { type: "paint", color: "#3b3f38", wear: 0.5 }, "paint");
      const hinge = new THREE.Group();
      hinge.position.set((-w / 2 + 0.03) * sx, 0, -0.02);
      g.add(hinge);
      const lw = w - 0.06, lh = p.y1 - 0.01;
      const leaf = new THREE.Group();
      leaf.position.set((lw / 2) * sx, 0, 0);
      hinge.add(leaf);
      const lm = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => { const me = new THREE.Mesh(track(geo), m); me.position.set(x, y, z); me.castShadow = true; me.receiveShadow = true; leaf.add(me); return me; };
      lm(box(lw, lh, 0.045, 0.004), leafMat, 0, lh / 2, 0);
      for (const [py, ph] of [[0.25, 0.75], [1.05, 0.85]] as const) for (const k of [-1, 1]) {
        lm(box(lw * 0.36, ph * (lh / 2.1), 0.012, 0.004), leafMat, k * lw * 0.22, (py + ph / 2) * (lh / 2.1), 0.026);
        lm(box(lw * 0.36, ph * (lh / 2.1), 0.012, 0.004), leafMat, k * lw * 0.22, (py + ph / 2) * (lh / 2.1), -0.026);
      }
      const knob = lib.get("brass");
      lm(sphere(0.028, 12), knob, (lw / 2 - 0.08) * sx, 1.0, 0.05);
      lm(sphere(0.028, 12), knob, (lw / 2 - 0.08) * sx, 1.0, -0.05);
      let angle = THREE.MathUtils.degToRad(d.open ?? 0), target = angle;
      hinge.rotation.y = angle * sx;
      const [wx, wz] = pt((p.a + p.b) / 2, 0.01);
      colliders.push({ cx: wx, cz: wz, hx: isNS ? w / 2 : 0.05, hz: isNS ? 0.05 : w / 2, cos: 1, sin: 0, top: lh, bottom: 0, on: () => Math.abs(angle) < 0.35 });
      blockers.push(leaf);
      if (d.opens) {
        interactables.set(leaf, {
          root: leaf, range: 2.2, id: "door",
          get label() { return Math.abs(target) < 0.1 ? d.label || (lang === "zh" ? "开门" : "Open") : d.labelClose || (lang === "zh" ? "关门" : "Close"); },
          onUse: () => { target = Math.abs(target) < 0.1 ? THREE.MathUtils.degToRad(95) : 0; },
        } as Interactable);
        animated.push((_t, dt) => {
          if (Math.abs(angle - target) < 0.001) return;
          angle += (target - angle) * Math.min(1, dt * 5);
          if (Math.abs(angle - target) < 0.002) angle = target;
          hinge.rotation.y = angle * sx;
          renderer.shadowMap.needsUpdate = true;
        });
      }
    }
  }
  const ns = (side: string) => side === "north" || side === "south";

  // ---------- things ----------
  function add(kind: string, o: PropOptions & { at?: Vec; facing?: Facing; collide?: boolean; shadow?: boolean; use?: string; onUse?: () => void; range?: number; id?: string; y?: number } = {}) {
    const obj = buildProp(kind, o, ctx);
    place(obj, o.at, o.facing);
    const b = new THREE.Box3().setFromObject(obj);
    const h = b.max.y - b.min.y;
    if (o.collide ?? (h > 0.25 && obj.position.y < 0.3 && kind !== "rug")) addCollider(obj);
    else if (kind !== "rug" && obj.position.y >= 0.3) addCollider(obj, () => true, supports);
    if (o.shadow !== false && kind !== "rug") addContact(obj);
    makeUsable(obj, o);
    renderer.shadowMap.needsUpdate = true;
    return obj;
  }

  function lamp(o: LampOptions & { use?: string; onUse?: () => void; id?: string } = {}) {
    const l = buildLamp(o, ctx, ceilingAbove, shadowsLeft);
    scene.add(l.group);
    l.group.rotation.y = facingRad(o.facing);
    for (const li of l.lights) {
      const at = li.userData.washAt as number[] | undefined;
      if (at) { const s = li as THREE.SpotLight; scene.add(s.target); s.target.position.set(at[0], at[1], at[2]); }
    }
    lamps.push(l);
    makeUsable(l.group, o);
    return l;
  }

  function sun(o: { from?: string | number; height?: number; direction?: Vec; color?: string; kelvin?: number; power?: number; shadow?: boolean; shafts?: boolean | number } = {}) {
    let dir: THREE.Vector3;
    if (o.direction && o.direction.length === 3) dir = new THREE.Vector3(o.direction[0], o.direction[1], o.direction[2]).normalize();
    else {
      const az = facingRad(o.from as Facing, 270);
      const el = THREE.MathUtils.degToRad(o.height ?? 30);
      // Light travels from the `from` side toward the opposite side, downward.
      dir = new THREE.Vector3(-Math.sin(az) * Math.cos(el), -Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    }
    const color = o.color ? new THREE.Color(o.color) : kelvin(o.kelvin ?? 5600);
    const l = new THREE.DirectionalLight(color, o.power ?? 3);
    l.userData.dir = dir;
    if (o.shadow !== false) {
      l.castShadow = true;
      l.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
      l.shadow.bias = -0.0002;
      l.shadow.normalBias = 0.03;
      l.shadow.radius = 2.5;
      l.shadow.intensity = 0.85;
    }
    scene.add(l, l.target);
    sunLight = l;
    sunOpts = { shafts: o.shafts !== false, strength: typeof o.shafts === "number" ? o.shafts : 1, color };
    return l;
  }

  function buildShafts() {
    for (const s of shafts) { scene.remove(s); }
    shafts.length = 0;
    if (!sunLight || !sunOpts?.shafts) return;
    const dir = sunLight.userData.dir as THREE.Vector3;
    const mat = track(new THREE.MeshBasicMaterial({ color: sunOpts.color.clone().multiplyScalar(0.04 * sunOpts.strength), transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: true }));
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vShaftUv;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvShaftUv = uv;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec2 vShaftUv;").replace("#include <alphamap_fragment>", `#include <alphamap_fragment>
        diffuseColor.a *= smoothstep(0.0, 0.3, vShaftUv.x) * smoothstep(0.0, 0.3, 1.0 - vShaftUv.x) * smoothstep(0.0, 0.12, vShaftUv.y) * smoothstep(0.0, 0.45, 1.0 - vShaftUv.y);`);
    };
    mat.customProgramCacheKey = () => "ywk-shaft";
    for (const r of rooms) for (const win of r.windows) {
      const [nx, nz] = SIDES[win.side as keyof typeof SIDES];
      // Inward normal is -n; the sun must travel into the room.
      if (dir.x * -nx + dir.z * -nz < 0.05 || dir.y > -0.05) continue;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const P = (s: number, y: number) => ns(win.side)
        ? new THREE.Vector3(cx + s, y, nz < 0 ? r.z0 : r.z1)
        : new THREE.Vector3(nx < 0 ? r.x0 : r.x1, y, cz + s);
      // Like the 1984 room: strips of light across the window, each a sheet swept from a line on the
      // window down along the sun to the floor, at the top, middle and bottom of the opening.
      const width = win.b - win.a;
      const strips = Math.max(3, Math.round(width / 0.55));
      const pitch = width / strips;
      const positions: number[] = [], uvs: number[] = [];
      for (const fy of [0.92, 0.55, 0.15]) {
        const y = win.y0 + fy * (win.y1 - win.y0);
        const t = Math.min(14, y / -dir.y);
        for (let k = 0; k < strips; k++) {
          const s0 = win.a + pitch * (k + 0.2), s1 = win.a + pitch * (k + 0.8);
          const a0 = P(s0, y), a1 = P(s1, y);
          const b0 = a0.clone().addScaledVector(dir, t), b1 = a1.clone().addScaledVector(dir, t);
          positions.push(...a0.toArray(), ...a1.toArray(), ...b1.toArray(), ...a0.toArray(), ...b1.toArray(), ...b0.toArray());
          uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
        }
      }
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 2;
      m.frustumCulled = false;
      scene.add(m);
      shafts.push(m);
    }
  }

  function air(o: ParticleOptions) {
    const p = createParticles(o);
    particles.push(p);
    scene.add(p.object);
    track(p);
    return p.object;
  }

  function outsideView(o: OutsideOptions = {}) {
    if (outside) { scene.remove(outside.group); outside.dispose(); }
    const centre = new THREE.Vector3();
    if (rooms.length) { for (const r of rooms) centre.add(new THREE.Vector3((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2)); centre.divideScalar(rooms.length); }
    outside = createOutside(o, centre, resolveUrl);
    scene.add(outside.group);
    if (o.ground !== false) {
      const g = new THREE.Mesh(track(new THREE.PlaneGeometry(200, 200)), lib.get((o.ground as string) || "concrete", "concrete"));
      const uv = g.geometry.getAttribute("uv") as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 200, uv.getY(i) * 200);
      g.rotation.x = -Math.PI / 2; g.position.set(centre.x, -0.12, centre.z); g.receiveShadow = true;
      outside.group.add(g);
    }
    return outside.group;
  }

  function texFrom(o: { image?: string; video?: string; draw?: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void; text?: string; color?: string; background?: string; font?: string }, w: number, h: number, fps: number) {
    if (o.video) {
      const v = doc.createElement("video");
      v.src = resolveUrl(o.video); v.muted = true; v.loop = true; v.playsInline = true; v.crossOrigin = "anonymous"; v.autoplay = true;
      v.play().catch(() => {});
      const t = new THREE.VideoTexture(v); t.colorSpace = THREE.SRGBColorSpace;
      owned.add({ dispose() { v.pause(); v.removeAttribute("src"); v.load(); } });
      return track(t);
    }
    if (o.image) {
      // Fill the surface like CSS object-fit: cover, so a 16:9 picture on a 4:3 screen is cropped, not squashed.
      const t = new THREE.TextureLoader().load(resolveUrl(o.image), (loaded) => {
        const img = loaded.image as { width?: number; height?: number } | undefined;
        if (!img?.width || !img?.height) return;
        const ia = img.width / img.height, pa = w / h;
        if (ia > pa) { loaded.repeat.set(pa / ia, 1); loaded.offset.set((1 - pa / ia) / 2, 0); }
        else { loaded.repeat.set(1, ia / pa); loaded.offset.set(0, (1 - ia / pa) / 2); }
        loaded.updateMatrix();
      });
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(8, maxAniso);
      return track(t);
    }
    if (o.draw) {
      const c = doc.createElement("canvas");
      const ppm = 400;
      c.width = Math.min(1024, Math.round(w * ppm)); c.height = Math.min(1024, Math.round(h * ppm));
      const g = c.getContext("2d")!;
      const t = track(new THREE.CanvasTexture(c)); t.colorSpace = THREE.SRGBColorSpace;
      const draw = o.draw;
      draw(g, c.width, c.height, 0);
      if (fps > 0) {
        let last = 0;
        animated.push((time) => { if (time - last >= 1 / fps) { last = time; try { draw(g, c.width, c.height, time); t.needsUpdate = true; } catch (e) { console.error(e); } } });
      }
      return t;
    }
    return textCanvas(ctx, { text: o.text || "", width: w, height: h, color: o.color, background: o.background || "#e8e0cc", font: o.font || "serif" });
  }

  function picture(o: { at?: Vec; facing?: Facing; size?: Vec; image?: string; draw?: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void; text?: string; color?: string; background?: string; font?: string; frame?: MatSpec | false; poster?: boolean; glow?: number; use?: string; onUse?: () => void; id?: string } = {}) {
    const w = o.size?.[0] ?? 0.6, h = o.size?.[1] ?? 0.8;
    const g = new THREE.Group();
    const tex = texFrom(o, w, h, 0);
    const m = track(new THREE.MeshStandardMaterial({ map: tex, roughness: o.poster ? 0.92 : 0.6 }));
    if (o.glow) { m.emissive = new THREE.Color(1, 1, 1); m.emissiveMap = tex; m.emissiveIntensity = o.glow; }
    const geo = o.poster ? new THREE.PlaneGeometry(w, h, 8, 8) : picturePlane(w, h);
    if (o.poster) {
      const p = geo.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 7) * 0.004 + Math.max(0, p.getY(i) / h - 0.3) * 0.012 * (p.getX(i) / w));
      geo.computeVertexNormals();
    }
    const face = new THREE.Mesh(track(geo), m);
    face.position.z = o.poster || o.frame === false ? 0.004 : 0.02;
    face.receiveShadow = true;
    g.add(face);
    if (!o.poster && o.frame !== false) {
      const fm = lib.get(o.frame as string || { type: "wood", color: "#3a2a1a" }, "wood");
      const t = Math.min(0.06, Math.max(0.025, (w + h) * 0.03));
      for (const [x, y, fw, fh] of [[0, h / 2 + t / 2, w + 2 * t, t], [0, -h / 2 - t / 2, w + 2 * t, t], [-w / 2 - t / 2, 0, t, h], [w / 2 + t / 2, 0, t, h]]) {
        const bar = new THREE.Mesh(track(box(fw, fh, 0.04, 0.006)), fm);
        bar.position.set(x, y, 0.02); bar.castShadow = true; bar.receiveShadow = true; g.add(bar);
      }
    }
    place(g, o.at, o.facing, 1.5);
    makeUsable(g, o);
    return g;
  }

  const SCREEN_FS = `
    uniform sampler2D map; uniform mat3 uMapT; uniform float uTime, uGlow, uCrt, uMono, uOn; uniform vec3 uTint;
    varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      if (uCrt > 0.5) { vec2 c = uv - 0.5; uv = 0.5 + c * (1.0 + dot(c, c) * 0.1); }
      vec3 col = texture2D(map, (uMapT * vec3(uv, 1.0)).xy).rgb;
      if (uMono > 0.5) col = vec3(dot(col, vec3(0.299, 0.587, 0.114)));
      col *= uTint;
      if (uCrt > 0.5) {
        col *= 0.8 + 0.2 * sin(uv.y * 900.0);
        col *= 1.0 + 0.05 * smoothstep(0.0, 0.08, 0.04 - abs(fract(uv.y - uTime * 0.07) - 0.5));
        col *= 1.0 + 0.02 * sin(uTime * 47.0);
        col += (h(floor(uv * vec2(640.0, 480.0)) + floor(uTime * 18.0)) - 0.5) * 0.06;
        vec2 p = uv - 0.5;
        col *= 1.0 - 0.6 * dot(p * vec2(0.9, 1.1), p * vec2(0.9, 1.1)) * 2.0;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
      }
      gl_FragColor = vec4(max(col, 0.0) * uGlow * uOn, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  function screen(o: { at?: Vec; facing?: Facing; size?: Vec; image?: string; video?: string; draw?: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void; fps?: number; text?: string; color?: string; background?: string; style?: "crt" | "flat"; mono?: boolean; tint?: string; glow?: number; light?: number; frame?: MatSpec | false; use?: string; onUse?: () => void; id?: string } = {}) {
    const w = o.size?.[0] ?? 0.8, h = o.size?.[1] ?? 0.6;
    const g = new THREE.Group();
    const crt = (o.style || "crt") === "crt";
    let tex = texFrom(o, w, h, o.fps ?? (o.draw ? 12 : 0));
    const uniforms = { map: { value: tex as THREE.Texture }, uMapT: { value: new THREE.Matrix3() }, uTime: { value: 0 }, uGlow: { value: o.glow ?? 1.6 }, uCrt: { value: crt ? 1 : 0 }, uMono: { value: o.mono ? 1 : 0 }, uOn: { value: 1 }, uTint: { value: srgb(o.tint || (crt ? "#dfe9ef" : "#ffffff")) } };
    const m = track(new THREE.ShaderMaterial({ uniforms, vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }", fragmentShader: SCREEN_FS }));
    const face = new THREE.Mesh(track(picturePlane(w, h)), m);
    face.position.z = crt ? 0.025 : 0.012;
    g.add(face);
    if (o.frame !== false) {
      const fm = lib.get(o.frame as string || { type: "iron", color: "#202322", wear: 0.3 }, "iron");
      const part = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
        const me = new THREE.Mesh(track(geo), m); me.position.set(x, y, z); me.castShadow = true; me.receiveShadow = true; g.add(me); return me;
      };
      if (crt) {
        // A cabinet set: deep body, a thick bezel, a speaker grille and a pilot lamp under the glass.
        const bw = w + 0.2, bh = h + 0.34;
        part(box(bw, bh, 0.34, 0.05), fm, 0, -0.07, -0.15);
        part(box(bw - 0.03, bh - 0.03, 0.04, 0.02), lib.get({ type: "plastic", color: "#151716" }, "plastic"), 0, -0.07, 0.0);
        const grille = lib.get({ type: "metal", color: "#3a3c3a" }, "metal");
        for (let i = 0; i < 5; i++) part(box(w * 0.55, 0.008, 0.01, 0.002), grille, -w * 0.12, -h / 2 - 0.08 - i * 0.022, 0.025);
        const pilot = track(new THREE.MeshStandardMaterial({ color: "#ff3b1f", emissive: "#ff2a10", emissiveIntensity: 6 }));
        part(sphere(0.016, 12), pilot, w / 2 - 0.05, -h / 2 - 0.12, 0.03);
      } else {
        part(box(w + 0.04, h + 0.04, 0.05, 0.01), fm, 0, 0, -0.02);
      }
    }
    const lightPower = o.light ?? 6;
    const spot = new THREE.SpotLight(new THREE.Color().setStyle(o.tint || "#b8c6cf"), lightPower, 7, 0.9, 1, 2);
    spot.position.set(0, 0, 0.08); spot.target.position.set(0, -0.6, 3);
    g.add(spot, spot.target);
    animated.push((t) => { uniforms.uTime.value = t; uniforms.uMapT.value.copy(uniforms.map.value.matrix); });
    place(g, o.at, o.facing, 1.5);
    if (o.frame !== false && g.position.y < 2.2) addCollider(g);
    makeUsable(g, o);
    return {
      object: g,
      setImage(ref: string) { tex = texFrom({ image: ref }, w, h, 0); uniforms.map.value = tex; },
      setVideo(ref: string) { tex = texFrom({ video: ref }, w, h, 0); uniforms.map.value = tex; },
      setOn(on: boolean) { uniforms.uOn.value = on ? 1 : 0; spot.intensity = on ? lightPower : 0; },
      setGlow(v: number) { uniforms.uGlow.value = v; },
    };
  }

  // ---------- models (AI-made .glb) and people ----------
  const maxTexture = coarse ? 1024 : 2048;
  const modelStats: (ModelStats & { asset: string; ms: number })[] = [];
  const settles: (() => void)[] = [];
  let settled = false;
  const people: PersonHandle[] = [];
  const glbCache = new Map<string, Promise<Awaited<ReturnType<typeof parseModel>>>>();
  function fetchBytes(ref: string): Promise<ArrayBuffer> {
    const fetchAsset = options.api?.fetchAsset;
    if (!fetchAsset) return Promise.reject(new Error("a model, person or sound file needs createWorld(el, { api }) to fetch it."));
    return fetchAsset(/^@rig:/.test(ref) ? ref : ref.replace(/^@asset:/, "")).then((res) => {
      if (!res || res.ok === false || !res.bytes) throw new Error(ref + " could not be loaded" + (res?.error ? ": " + res.error : ""));
      const b = res.bytes;
      return b instanceof Uint8Array ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer : b;
    });
  }
  async function loadGLB(asset: string, o: SizeOptions & { turn?: number; metal?: boolean; rough?: number; shadow?: boolean }, label: string, fallbackHeight?: number) {
    const t0 = performance.now();
    // One download and parse per file; every copy (five stools, three bowls) shares its geometry and textures.
    let parsed = glbCache.get(asset);
    if (!parsed) { parsed = fetchBytes(asset).then(parseModel); glbCache.set(asset, parsed); parsed.catch(() => glbCache.delete(asset)); }
    const gltf = await parsed;
    let skinned = false;
    gltf.scene.traverse((x) => { if ((x as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
    const inner = skinned ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
    // The real height the generator stored in the file (asset.extras.heightM, or the scene's), used when the
    // card gives no size of its own.
    const stored = Number((gltf.asset as { extras?: { heightM?: unknown } } | undefined)?.extras?.heightM ?? inner.userData?.heightM);
    if (!(o.height || o.width || o.depth || o.size) && stored > 0 && stored < 50) o = { ...o, height: stored };
    else if (!(o.height || o.width || o.depth || o.size || o.scale) && fallbackHeight) o = { ...o, height: fallbackHeight };
    inner.rotation.y = THREE.MathUtils.degToRad(o.turn || 0);
    const holder = new THREE.Group();
    holder.add(inner);
    fitToSize(inner, o, label);
    fixMaterials(inner, { metal: o.metal, rough: o.rough, maxTexture, anisotropy: Math.min(8, maxAniso), shadows: o.shadow !== false }, track, doc);
    const stats = measure(inner, gltf.animations);
    modelStats.push({ ...stats, asset, ms: Math.round(performance.now() - t0) });
    if (stats.triangles > 150000 || stats.maxTexture > 2048) console.warn(`[world] ${label} is heavy for a phone (${stats.triangles} triangles, ${stats.maxTexture}px textures); about 50k triangles and 1024-2048px suit a world`);
    return { holder, inner, animations: gltf.animations };
  }
  /** Now if every model is in, else once they are (so a bowl finds the counter under it whichever loads first). */
  function whenSettled(fn: () => void) { if (settled) fn(); else settles.push(fn); }

  type ModelOptions = SizeOptions & {
    /** Same as height (the name the asset library stores it under). */
    heightM?: number;
    asset: string; at?: Vec; facing?: Facing; turn?: number; y?: number; collide?: boolean; metal?: boolean; rough?: number;
    shadow?: boolean; use?: string; onUse?: () => void; range?: number; id?: string;
  };
  /**
   * A .glb in the world: sized in metres (height / width / depth / size), standing on the floor or on whatever
   * is under it (a counter, a desk), facing `facing` (turn: degrees when the file's own front is not +Z),
   * matte unless metal, solid to walk into when it is furniture-sized.
   */
  function model(o: ModelOptions): Promise<THREE.Group> {
    const job = (async () => {
      const { holder } = await loadGLB(o.asset, o.heightM && !o.height ? { ...o, height: o.heightM } : o, o.id || o.asset);
      const at = pos3(o.at);
      place(holder, o.at, o.facing, o.y ?? (at.y || 0));
      const size = new THREE.Box3().setFromObject(holder).getSize(new THREE.Vector3());
      const small = Math.max(size.x, size.z) < 0.4 && size.y < 0.6;
      whenSettled(() => {
        if (o.y === undefined && !(o.at && o.at.length === 3)) { holder.position.y = surfaceAt(at.x, at.z, 1.9); holder.updateMatrixWorld(true); }
        if (o.collide ?? !(small || holder.position.y > 0.05)) addCollider(holder);
        if (holder.position.y < 0.05) addContact(holder);
        renderer.shadowMap.needsUpdate = true;
      });
      makeUsable(holder, o);
      return holder;
    })();
    pending.push(job.catch((e) => { console.warn("[world]", (e as Error)?.message || e); return null; }));
    return job;
  }

  type PersonOptions = SizeOptions & {
    heightM?: number;
    /** A live character: "@rig:<id>" (or its pack, "@asset:<id>"). */
    live?: string;
    /** A 3D model .glb ("@asset:<id>"), rigged or not. */
    model?: string;
    /** More .glb files whose animations (idle, talk, walk…) play on the model's skeleton. */
    clips?: string[];
    at?: Vec; facing?: Facing; turn?: number;
    /** Live character: where the top of the head is (m), how tall the drawn part is (m), how much of its bottom fades. */
    top?: number; drawn?: number; fade?: number;
    mood?: string; name?: string; color?: string; follow?: boolean;
    use?: string; onUse?: () => void; range?: number; id?: string;
  };
  /** Someone in the room: a live character (standee) or a 3D model, with idle life, talking and turning to the player. */
  function person(o: PersonOptions) {
    let h: PersonHandle | null = null;
    const queue: ((p: PersonHandle) => void)[] = [];
    const run = (f: (p: PersonHandle) => void) => { if (h) f(h); else queue.push(f); };
    const facing = facingRad(o.facing);
    const job = (async () => {
      let p: PersonHandle;
      if (o.live) {
        const top = o.top ?? o.height ?? 1.62;
        p = await liveStandee(await fetchBytes(o.live), { size: o.drawn ?? top * 0.52, top, fade: o.fade ?? 0.14, mood: o.mood, doc, maxAniso: Math.min(8, maxAniso), coarse });
      } else if (o.model) {
        const sized: SizeOptions = o.height || o.width || o.depth || o.size || o.scale ? o : o.heightM ? { height: o.heightM } : {};
        const { holder, animations } = await loadGLB(o.model, { ...sized, turn: o.turn, metal: false }, o.name || o.model, 1.72);
        const extra = await Promise.all((o.clips || []).map((c) => fetchBytes(c).then(parseModel).then((g) => g.animations).catch((e) => { console.warn("[world] clip", c, e); return [] as THREE.AnimationClip[]; })));
        p = modelPerson(holder, [...animations, ...extra.flat()], { facing });
      } else throw new Error("person() needs live (a live character) or model (a .glb).");
      place(p.object, o.at, o.facing);
      colliders.push({ cx: p.object.position.x, cz: p.object.position.z, hx: 0.24, hz: 0.24, cos: 1, sin: 0, top: 1.8, bottom: 0, on: () => true });
      if (o.follow === false) p.follow(false);
      makeUsable(p.object, { use: o.use ?? (o.onUse ? (lang === "zh" ? "说话" : "Talk") : undefined), onUse: o.onUse, range: o.range, id: o.id || o.name });
      animated.push((t, dt) => {
        const d = Math.hypot(camera.position.x - p.object.position.x, camera.position.z - p.object.position.z);
        p.update(t, dt, camera, d < 8);
      });
      people.push(p);
      h = p;
      for (const f of queue.splice(0)) f(p);
      renderer.shadowMap.needsUpdate = true;
      return p.object;
    })();
    pending.push(job.catch((e) => { console.warn("[world]", (e as Error)?.message || e); return null; }));
    return {
      ready: job,
      get object() { return h?.object ?? null; },
      /** A caption under this person's name, the mouth (or the talk clip) moving while it reads. */
      say(text: string, so: { hold?: number } = {}) {
        const hold = so.hold ?? (text ? 2.5 + String(text).length * 0.07 : 0);
        say(text, { who: o.name, color: o.color, hold });
        run((p) => p.talk(Math.min(hold, 1.2 + String(text || "").length * 0.06)));
      },
      talk: (s?: number) => run((p) => p.talk(s)),
      quiet: () => run((p) => p.talk(0)),
      cue: (name: string) => run((p) => p.cue(name)),
      mood: (m: string) => run((p) => p.mood(m)),
      play: (name: string) => run((p) => p.play(name)),
      walkTo: (to: Vec, wo?: { speed?: number; then?: () => void }) => run((p) => p.walkTo(to, wo)),
      follow: (on = true) => run((p) => p.follow(on)),
    };
  }

  // ---------- sound ----------
  const sounds = new Soundscape(win, container);
  let soundUsed = false;
  function soundAt(at: unknown): Vec | undefined {
    if (Array.isArray(at)) return at as Vec;
    const obj = (at as { object?: THREE.Object3D } | null)?.object || (at as THREE.Object3D | null);
    if (obj && (obj as THREE.Object3D).isObject3D) { const c = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3()); return [c.x, c.y, c.z]; }
    return undefined;
  }
  /**
   * sound("rain") everywhere, sound("hum", { at: [x, y, z] }) from a point (or { at: tv } from a thing), fading
   * with distance; sound("@asset:<id>", { at, loop }) plays the card's own audio file the same way.
   */
  function sound(kind: string, o: Omit<SoundOptions, "at"> & { at?: Vec | THREE.Object3D | { object: THREE.Object3D | null } } = {}): SoundHandle {
    if (!soundUsed && overlay) { soundUsed = true; overlay.sound = { get muted() { return sounds.isMuted; }, toggle() { sounds.setMuted(!sounds.isMuted); } }; }
    const opts: SoundOptions = { ...o, at: soundAt(o.at) };
    if ((SOUND_KINDS as readonly string[]).includes(kind)) return sounds.add(kind as SoundKind, opts);
    if (/^@?asset:|^[0-9a-f]{8}-/i.test(kind)) return sounds.add(null, opts, () => fetchBytes(kind).catch((e) => { console.warn("[world] sound", e); return null; }));
    console.warn(`[world] no sound "${kind}"; there are ${SOUND_KINDS.join(", ")}, or "@asset:<id>"`);
    return sounds.add("room", { ...opts, volume: 0 });
  }

  function interact(target: THREE.Object3D | { object: THREE.Object3D }, o: { label?: string; use?: string; onUse?: () => void; range?: number; id?: string }) {
    const root = (target as { object?: THREE.Object3D }).object || (target as THREE.Object3D);
    makeUsable(root, { use: o.label || o.use || (lang === "zh" ? "查看" : "Look"), onUse: o.onUse, range: o.range, id: o.id });
  }

  // ---------- player ----------
  const po = options.player || {};
  const controls = new Controls(canvas, camera, { height: po.height ?? 1.62, speed: po.speed ?? 2.1, run: po.run !== false, jump: po.jump !== false, crouch: po.crouch !== false, radius: 0.24 }, colliders);
  const startPos = pos3(po.at);
  controls.pos.set(startPos.x, 0, startPos.z);
  controls.yaw = facingRad(po.facing, 180) + Math.PI;
  controls.update(0);

  const ui = options.ui !== false;
  const overlay: Overlay | null = ui ? createOverlay(container, lang) : null;
  let paused = false;
  controls.onPause = (p) => { paused = p; overlay?.pause(p, options.name || ""); sounds.setDuck(p ? 0.35 : 1); emit(p ? "pause" : "resume"); };
  if (overlay) overlay.onResume = () => controls.resume();
  controls.onStick = (x, y, dx, dy, on) => overlay?.stick(x, y, dx, dy, on);
  if (overlay && options.place) {
    const [t, s] = Array.isArray(options.place) ? options.place : [options.place, ""];
    setTimeout(() => overlay.place(t, s), 900);
  }

  // ---------- interaction targeting ----------
  const ray = new THREE.Raycaster();
  let target: Interactable | null = null;
  function pick(x?: number, y?: number): Interactable | null {
    const ndc = new THREE.Vector2(0, 0);
    if (x !== undefined && y !== undefined) {
      const r = canvas.getBoundingClientRect();
      ndc.set((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
    }
    ray.setFromCamera(ndc, camera);
    ray.far = 6;
    const roots = [...interactables.keys()];
    if (!roots.length) return null;
    const hits = ray.intersectObjects([...roots, ...blockers], true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !interactables.has(o)) o = o.parent;
      if (!o) return null;
      const it = interactables.get(o)!;
      return h.distance <= it.range + (x !== undefined ? 1 : 0) ? it : null;
    }
    return null;
  }
  function use(it: Interactable | null) {
    if (!it) return;
    try { it.onUse?.(); } catch (e) { console.error(e); }
    emit("use", it.id, it.label);
  }
  controls.onUse = (x, y) => { if (paused) return; use(x !== undefined ? pick(x, y) : target); };

  // ---------- captions ----------
  let sayTimer = 0;
  let queuedSay: [string, { who?: string; color?: string; hold?: number }] | null = null;
  function say(text: string, o: { who?: string; color?: string; hold?: number } = {}) {
    if (!overlay) return;
    // A line said while the world is still loading waits for the first frame, so nobody misses it.
    if (!firstFrame) { queuedSay = [text, o]; return; }
    clearTimeout(sayTimer);
    overlay.say(text || "", o.who, o.color);
    const hold = o.hold ?? (text ? 2.5 + String(text).length * 0.07 : 0);
    if (hold > 0 && text) sayTimer = win.setTimeout(() => overlay.clearSay(), hold * 1000);
  }

  // ---------- sizing ----------
  let vw = 1, vh = 1;
  const resize = () => {
    vw = Math.max(1, container.clientWidth); vh = Math.max(1, container.clientHeight);
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh;
    camera.fov = vw < vh ? 78 : coarse ? 72 : 66;
    camera.updateProjectionMatrix();
    const scale = (vh * renderer.getPixelRatio()) / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    for (const p of particles) p.setScale(scale);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // ---------- quality ----------
  const LEVELS = [{ scale: 1, bloom: true }, { scale: 0.85, bloom: true }, { scale: 0.7, bloom: true }, { scale: 0.7, bloom: false }, { scale: 0.55, bloom: false }];
  let level = options.quality === "low" ? 3 : coarse ? 1 : 0, ceiling = options.quality === "high" ? 0 : 0, clock = 0, changedAt = 0, raisedAt = -1e9;
  const frameTimes: number[] = [];
  function applyLevel(n: number) {
    level = Math.max(0, Math.min(LEVELS.length - 1, n));
    post.scale = LEVELS[level].scale; post.bloomOn = LEVELS[level].bloom;
    frameTimes.length = 0; changedAt = clock;
  }
  applyLevel(level);
  function recordFrame(ms: number) {
    if (options.quality === "high" || options.quality === "low" || !(ms > 0) || ms > 1000) return;
    clock += ms / 1000; frameTimes.push(ms); if (frameTimes.length > 60) frameTimes.shift();
    if (clock < 3 || frameTimes.length < 10 || clock - changedAt < 1.5) return;
    const p75 = [...frameTimes].sort((a, b) => a - b)[Math.floor(frameTimes.length * 0.75)];
    if (p75 > 24 && level < LEVELS.length - 1) {
      if (clock - raisedAt < 8) ceiling = Math.min(LEVELS.length - 1, level + 1);
      applyLevel(level + (p75 > 50 ? 2 : 1));
    } else if (p75 < 13 && level > ceiling && clock - changedAt > 8) { raisedAt = clock; applyLevel(level - 1); }
  }

  // ---------- start + loop ----------
  function fitSun() {
    if (!sunLight) return;
    const b = new THREE.Box3();
    for (const r of rooms) b.expandByPoint(new THREE.Vector3(r.x0, 0, r.z0)).expandByPoint(new THREE.Vector3(r.x1, r.h, r.z1));
    if (b.isEmpty()) b.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 4, 10));
    const centre = b.getCenter(new THREE.Vector3()), radius = b.getSize(new THREE.Vector3()).length() / 2 + 1;
    const dir = sunLight.userData.dir as THREE.Vector3;
    sunLight.position.copy(centre).addScaledVector(dir, -radius * 2.5);
    sunLight.target.position.copy(centre);
    const cam = sunLight.shadow.camera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius; cam.near = 0.5; cam.far = radius * 5;
    cam.updateProjectionMatrix();
  }

  function captureBounce() {
    if (envRT) { envRT.dispose(); envRT = null; }
    const hidden: THREE.Object3D[] = [...shafts, ...particles.map((p) => p.object)];
    for (const h of hidden) h.visible = false;
    const pm = new THREE.PMREMGenerator(renderer);
    const probe = rooms.length ? new THREE.Vector3((rooms[0].x0 + rooms[0].x1) / 2, Math.min(1.6, rooms[0].h * 0.55), (rooms[0].z0 + rooms[0].z1) / 2) : new THREE.Vector3(controls.pos.x, 1.6, controls.pos.z);
    const savedEnv = scene.environment;
    scene.environment = null;
    renderer.shadowMap.needsUpdate = true;
    envRT = pm.fromScene(scene, 0.035, 0.05, 80, { size: 128, position: probe });
    pm.dispose();
    for (const h of hidden) h.visible = true;
    scene.environment = envRT.texture;
    void savedEnv;
  }

  const earDir = new THREE.Vector3();
  let last = performance.now(), time = 0, hintsShown = false, hintClock = 0, pickClock = 0;
  const timings: Record<string, number> = { created: Math.round(performance.now()) };
  async function start() {
    if (started || destroyed) return;
    started = true;
    timings.start = Math.round(performance.now());
    try {
      await Promise.race([Promise.all([...pending, ...lib.pending]), new Promise((r) => setTimeout(r, 12000))]);
    } catch { /* a failed picture or model does not stop the world */ }
    if (destroyed) return;
    timings.assets = Math.round(performance.now());
    settled = true;
    for (const f of settles.splice(0)) { try { f(); } catch (e) { console.warn("[world]", e); } }
    fitSun();
    buildShafts();
    renderer.shadowMap.needsUpdate = true;
    try { renderer.compile(scene, camera); } catch { /* compile lazily instead */ }
    timings.compiled = Math.round(performance.now());
    try { captureBounce(); } catch (e) { console.warn("[world] bounce light skipped", e); }
    timings.bounce = Math.round(performance.now());
    renderer.shadowMap.needsUpdate = true;
    resize();
    renderer.setAnimationLoop(frame);
    return new Promise<void>((resolve) => { readyResolvers.push(resolve); });
  }
  const readyResolvers: (() => void)[] = [];
  let shadowFrames = 3;

  function frame() {
    const now = performance.now();
    const ms = now - last; last = now;
    const dt = Math.min(0.05, ms / 1000);
    if (doc.hidden) return;
    time += dt;
    controls.update(paused ? 0 : dt);
    for (const f of animated) f(time, dt);
    for (const p of particles) p.update(time);
    for (const l of lamps) {
      if (!l.flicker || !l.on) continue;
      const k = 1 + (Math.sin(time * 13.1 + l.base[0]) * 0.5 + Math.sin(time * 7.3) * 0.3 + Math.sin(time * 23.7) * 0.2) * 0.12 * l.flicker;
      l.lights.forEach((li, i) => { li.intensity = l.base[i] * k; });
    }
    pickClock += dt;
    if (pickClock > 0.08 && !controls.touch) {
      pickClock = 0;
      const t = paused ? null : pick();
      if (t !== target) { target = t; overlay?.target(t ? t.label : null, false); }
      else if (t && overlay) overlay.target(t.label, false);
    }
    // Rooms the player walks into.
    const px = controls.pos.x, pz = controls.pos.z;
    let inRoom: string | null = null;
    for (const r of rooms) if (px >= r.x0 && px <= r.x1 && pz >= r.z0 && pz <= r.z1) { inRoom = r.id; break; }
    if (inRoom !== currentRoom) { currentRoom = inRoom; if (inRoom) emit("enter", inRoom); }
    if (overlay && options.hints !== false) {
      hintClock += dt;
      const show = hintClock > 1.2 && hintClock < 14 && controls.moved < 3 && !paused;
      if (show !== hintsShown) { hintsShown = show; overlay.hints(show, controls.touch, { jump: controls.o.jump, crouch: controls.o.crouch, run: controls.o.run }); }
    }
    if (sounds.started) {
      camera.getWorldDirection(earDir);
      sounds.listen(camera.position.x, camera.position.y, camera.position.z, earDir.x, earDir.y, earDir.z);
    }
    emit("frame", dt, time);
    if (shadowFrames > 0) { renderer.shadowMap.needsUpdate = true; shadowFrames--; }
    post.render(scene, camera, time);
    recordFrame(ms);
    if (!firstFrame) {
      firstFrame = true;
      timings.firstFrame = Math.round(performance.now());
      canvas.style.opacity = "1";
      overlay?.ready();
      for (const r of readyResolvers.splice(0)) r();
      if (queuedSay) { const [t, o] = queuedSay; queuedSay = null; setTimeout(() => say(t, o), 900); }
      emit("ready");
    }
  }

  // Forgetting start() is harmless: the world starts itself once the card's code has run.
  const autoStart = setTimeout(() => { void start(); }, 0);

  function dispose() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(autoStart);
    clearTimeout(sayTimer);
    renderer.setAnimationLoop(null);
    ro.disconnect();
    controls.dispose();
    overlay?.dispose();
    sounds.dispose();
    for (const p of people) { try { p.dispose(); } catch { /* fine */ } }
    if (outside) outside.dispose();
    envRT?.dispose();
    post.dispose();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mm of mats) mm.dispose();
    });
    for (const o of owned) { try { o.dispose(); } catch { /* fine */ } }
    lib.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    canvas.remove();
  }

  const api = {
    THREE, scene, camera, renderer,
    room, add, lamp, sun, air, outside: outsideView, picture, screen, model, person, sound, interact, say,
    /** Mute or unmute the world's sound (the pause menu has the same switch). */
    mute(m = true) { sounds.setMuted(m); },
    material: (spec: string | MaterialOptions) => lib.get(spec),
    look: (l: string | LookOptions) => { setLook(l); },
    place: (title: string, sub?: string) => overlay?.place(title, sub),
    on(name: string, fn: (...a: unknown[]) => void) { (listeners[name] ||= []).push(fn); return () => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); }; },
    get player() { return { x: controls.pos.x, z: controls.pos.z, facing: ((THREE.MathUtils.radToDeg(controls.yaw - Math.PI) % 360) + 360) % 360, room: currentRoom }; },
    moveTo(at: Vec, facing?: Facing) { const p = pos3(at); controls.pos.set(p.x, 0, p.z); if (facing !== undefined) controls.yaw = facingRad(facing) + Math.PI; },
    lookAt(at: Vec) { const p = pos3(at, 1.5); const dx = p.x - controls.pos.x, dz = p.z - controls.pos.z; controls.yaw = Math.atan2(-dx, -dz); controls.pitch = Math.atan2(p.y - camera.position.y, Math.hypot(dx, dz)); },
    pause(p = true) { if (p) controls.setPaused(true); else controls.resume(); },
    /** Freeze walking and looking (a cutscene, a dialog the card shows). */
    freeze(f = true) { controls.enabled = !f; },
    fade(to: number) { post.look.dark = Math.max(0, Math.min(1, to)); },
    relight() { try { captureBounce(); } catch { /* fine */ } renderer.shadowMap.needsUpdate = true; },
    refreshShadows() { renderer.shadowMap.needsUpdate = true; },
    start, dispose,
    get quality() { return { timings, level, scale: post.scale, bloom: post.bloomOn, post: post.enabled && !post.failed, failed: post.failed, models: modelStats, sound: { started: sounds.started, muted: sounds.isMuted } }; },
    names: { things: PROP_NAMES, materials: MATERIAL_NAMES, outside: OUTSIDE_KINDS, looks: Object.keys(LOOKS), lamps: ["pendant", "bulb", "lantern", "candle", "chandelier", "desk", "floor", "sconce", "tube", "fire", "glow"], air: ["dust", "rain", "snow", "steam", "smoke", "embers", "fireflies", "sparkles"], sounds: SOUND_KINDS },
  };
  // For checking a world from the browser console (the sandbox page holds one card).
  (win as unknown as { __yuminaWorld?: unknown }).__yuminaWorld = api;
  return api;
}

export type World = ReturnType<typeof createWorld>;
