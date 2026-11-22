/**
 * What `loadThree()` hands card code: three.js and the three add-ons a scene
 * you walk around in needs. Its own chunk, fetched the first time a card asks
 * (lib/tsx/load-three.ts), so cards without 3D never download it.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
// The 3D tool's models are meshopt-compressed (47 MB becomes 3): the decoder is WebAssembly carried in this
// module, so it needs no download, which the sandbox would refuse anyway.
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * A .glb's bytes (from `api.fetchAsset`) as a loaded model.
 *
 * GLTFLoader reads a model's embedded pictures with `fetch(blob:…)` wherever
 * the browser has createImageBitmap, and the card sandbox allows no fetch at
 * all (connect-src 'none'), so every textured model came out untextured with
 * an error per picture. The loader picks its picture reader while `parse` is
 * starting; with createImageBitmap out of sight for that moment it takes the
 * `<img>` reader, which the sandbox does allow for blob: pictures.
 */
function parseGLB(bytes: ArrayBuffer | Uint8Array): Promise<GLTF> {
  const buffer = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
  return new Promise((resolve, reject) => {
    const scope = globalThis as { createImageBitmap?: unknown };
    const had = Object.prototype.hasOwnProperty.call(scope, "createImageBitmap");
    const saved = scope.createImageBitmap;
    try {
      scope.createImageBitmap = undefined;
      new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(buffer, "", resolve, (error) => reject(error instanceof Error ? error : new Error(String((error as { message?: unknown })?.message ?? error))));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (had) scope.createImageBitmap = saved;
      else delete scope.createImageBitmap;
    }
  });
}

export const threeKit = { THREE, OrbitControls, PointerLockControls, GLTFLoader, parseGLB };
export type ThreeKit = typeof threeKit;
