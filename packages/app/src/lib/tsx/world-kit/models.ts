/**
 * AI-made models in a world: what `world.model()` and `world.person()` do to a .glb from an image-to-3D
 * generator (TRELLIS, Hunyuan3D, Tripo, Rodin, Meshy) before it stands in a room.
 *
 * Those files come out of the generator in their own unit cube, centred on the middle of the object, often
 * with every material marked fully metallic, hundreds of thousands of triangles and 2048-4096 px textures.
 * Here they are read (meshopt-compressed files too), given a real size in metres, stood on their bottom,
 * made matte unless they are metal, and their textures held to what the device can carry.
 */
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * A .glb's bytes as a loaded model. Same picture-reader detour as three-kit's parseGLB (the sandbox allows no
 * fetch, so GLTFLoader must take its `<img>` reader for embedded pictures), plus the meshopt decoder: it is
 * WebAssembly compiled from bytes, which the sandbox's policy allows, and it runs without a worker. Draco and
 * KTX2 are not read: both decoders start workers from blob: URLs, which the sandbox does not allow.
 */
export function parseModel(bytes: ArrayBuffer | Uint8Array): Promise<GLTF> {
  const buffer = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));
  const text = new TextDecoder().decode(head);
  if (/KHR_draco_mesh_compression/.test(text)) return Promise.reject(new Error("this model is Draco-compressed, which a card cannot read; export it uncompressed or with meshopt"));
  return new Promise((resolve, reject) => {
    const scope = globalThis as { createImageBitmap?: unknown };
    const had = Object.prototype.hasOwnProperty.call(scope, "createImageBitmap");
    const saved = scope.createImageBitmap;
    try {
      scope.createImageBitmap = undefined;
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.parse(buffer, "", resolve, (error) => reject(error instanceof Error ? error : new Error(String((error as { message?: unknown })?.message ?? error))));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (had) scope.createImageBitmap = saved;
      else delete scope.createImageBitmap;
    }
  });
}

export interface ModelStats { triangles: number; textures: number; maxTexture: number; skinned: boolean; animations: string[]; size: number[] }

export function measure(root: THREE.Object3D, animations: THREE.AnimationClip[] = []): ModelStats {
  let triangles = 0, skinned = false, maxTexture = 0;
  const tex = new Set<THREE.Texture>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) if (v && (v as THREE.Texture).isTexture) tex.add(v as THREE.Texture);
    }
  });
  for (const t of tex) { const img = t.image as { width?: number; height?: number } | undefined; maxTexture = Math.max(maxTexture, img?.width || 0, img?.height || 0); }
  const s = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  return { triangles: Math.round(triangles), textures: tex.size, maxTexture, skinned, animations: animations.map((a) => a.name), size: [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3)] };
}

export interface SizeOptions {
  /** Height in metres (a desk 0.76, a bed 0.55, a person 1.7). */
  height?: number;
  /** Width (x) or depth (z) in metres, when that is the measure you know. */
  width?: number;
  depth?: number;
  /** The longest side, in metres. */
  size?: number;
  /** A plain multiplier, when the file is already in metres but wrong. */
  scale?: number;
}

/**
 * Scale to a real size and move the origin to the bottom centre, so `at` is where it stands on the floor.
 * A file from a generator sits in a unit cube; without a size it is taken as already in metres when it is
 * bigger than that cube, else as a 1 m object (and says so once in the console).
 */
export function fitToSize(root: THREE.Object3D, o: SizeOptions, label: string): number {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root);
  const s = b.getSize(new THREE.Vector3());
  let k = 1;
  if (o.height) k = o.height / Math.max(1e-4, s.y);
  else if (o.width) k = o.width / Math.max(1e-4, s.x);
  else if (o.depth) k = o.depth / Math.max(1e-4, s.z);
  else if (o.size) k = o.size / Math.max(1e-4, s.x, s.y, s.z);
  else if (o.scale) k = o.scale;
  else if (Math.max(s.x, s.y, s.z) <= 2.05) console.info(`[world] ${label}: no height given, so it is drawn about ${Math.max(s.x, s.y, s.z).toFixed(2)} m across; give model({ height }) in metres`);
  if (o.scale && (o.height || o.width || o.depth || o.size)) k *= o.scale;
  root.scale.multiplyScalar(k);
  root.updateMatrixWorld(true);
  const c = new THREE.Box3().setFromObject(root);
  const centre = c.getCenter(new THREE.Vector3());
  root.position.x -= centre.x; root.position.z -= centre.z; root.position.y -= c.min.y;
  root.updateMatrixWorld(true);
  return k;
}

export interface MaterialFix {
  /** The model is metal (a steel cabinet, a lamp): keep its metalness. */
  metal?: boolean;
  /** Lowest roughness allowed (AI textures come out plastic-shiny when this is low). */
  rough?: number;
  /** Largest texture side kept on this device. */
  maxTexture: number;
  anisotropy: number;
  /** Cast shadows (people and furniture yes; a cup on a table needs not). */
  shadows: boolean;
}

/**
 * Generators mark materials fully metallic with no map to say where (Hunyuan), or give a metal map that is
 * noise on cloth, wood and skin (TRELLIS). In a room lit by a few lamps a "metal" chair turns into a dark
 * mirror of the room. Unless the card says the thing is metal, metalness goes to 0 (no map) or is held low
 * (with a map), roughness gets a floor, and the colour stays the generator's.
 */
export function fixMaterials(root: THREE.Object3D, o: MaterialFix, track: <T extends { dispose(): void }>(x: T) => T, doc: Document): void {
  const seen = new Set<THREE.Material>();
  const shrunk = new Map<THREE.Texture, THREE.Texture>();
  const shrink = (t: THREE.Texture | null): THREE.Texture | null => {
    if (!t) return t;
    t.anisotropy = o.anisotropy;
    const img = t.image as (HTMLImageElement & { width: number; height: number }) | undefined;
    if (!img || !(img.width > o.maxTexture || img.height > o.maxTexture)) return t;
    if (shrunk.has(t)) return shrunk.get(t)!;
    const k = o.maxTexture / Math.max(img.width, img.height);
    const c = doc.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    try { c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height); } catch { return t; }
    const n = track(new THREE.CanvasTexture(c));
    n.colorSpace = t.colorSpace; n.flipY = t.flipY; n.wrapS = t.wrapS; n.wrapT = t.wrapT; n.channel = t.channel;
    n.anisotropy = o.anisotropy;
    shrunk.set(t, n);
    t.dispose();
    return n;
  };
  root.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = o.shadows; m.receiveShadow = true;
    for (const raw of Array.isArray(m.material) ? m.material : [m.material]) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      track(raw);
      const mat = raw as THREE.MeshStandardMaterial;
      if (!mat.isMeshStandardMaterial) continue;
      if (!o.metal) {
        if (!mat.metalnessMap) mat.metalness = 0;
        else mat.metalness = Math.min(mat.metalness, 0.25);
      }
      mat.roughness = Math.max(mat.roughness, o.rough ?? 0.45);
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"] as const) {
        const t = mat[key];
        if (t) mat[key] = shrink(t) as never;
      }
      // Generators often set double-sided to hide holes; keep that, and shadow it from the front face.
      if (mat.side === THREE.DoubleSide) mat.shadowSide = THREE.FrontSide;
      mat.needsUpdate = true;
    }
    m.geometry && track(m.geometry);
  });
}

/** A clip by role: an exact name, then a name containing it ("idle" finds "Armature|Idle_02"). */
export function findClip(clips: THREE.AnimationClip[], ...names: string[]): THREE.AnimationClip | null {
  for (const n of names) {
    const lower = n.toLowerCase();
    const hit = clips.find((c) => c.name.toLowerCase() === lower) || clips.find((c) => c.name.toLowerCase().includes(lower));
    if (hit) return hit;
  }
  return null;
}
