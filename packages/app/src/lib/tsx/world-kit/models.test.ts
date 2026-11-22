import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { findClip, fitToSize, fixMaterials } from "./models";

const track = <T,>(x: T) => x;

function unitCube(metal = 1) {
  // what a generator hands back: a 1 m cube centred on the origin, every material fully metallic
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ metalness: metal, roughness: 0.2 })));
  return root;
}

test("a generated model is sized in metres and stands on its bottom centre", () => {
  const root = unitCube();
  root.position.set(0.3, -0.5, 0.1);
  const k = fitToSize(root, { height: 0.76 }, "desk");
  assert.ok(Math.abs(k - 0.76) < 1e-6);
  const b = new THREE.Box3().setFromObject(root);
  assert.ok(Math.abs(b.min.y) < 1e-6, "rests on the floor");
  assert.ok(Math.abs(b.max.y - 0.76) < 1e-6);
  assert.ok(Math.abs((b.min.x + b.max.x) / 2) < 1e-6 && Math.abs((b.min.z + b.max.z) / 2) < 1e-6, "centred on its spot");
});

test("width, depth and the longest side size it too", () => {
  const box = () => { const r = new THREE.Group(); r.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 0.5))); return r; };
  const a = box(); fitToSize(a, { width: 1 }, "w");
  assert.ok(Math.abs(new THREE.Box3().setFromObject(a).getSize(new THREE.Vector3()).x - 1) < 1e-6);
  const c = box(); fitToSize(c, { size: 1 }, "s");
  assert.ok(Math.abs(new THREE.Box3().setFromObject(c).getSize(new THREE.Vector3()).x - 1) < 1e-6);
});

test("generator metal is taken back unless the thing is metal", () => {
  const wood = unitCube();
  fixMaterials(wood, { maxTexture: 2048, anisotropy: 4, shadows: true }, track, {} as Document);
  const m = (wood.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  assert.equal(m.metalness, 0);
  assert.ok(m.roughness >= 0.45, "no plastic shine");
  const steel = unitCube();
  fixMaterials(steel, { metal: true, maxTexture: 2048, anisotropy: 4, shadows: true }, track, {} as Document);
  assert.equal(((steel.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).metalness, 1);
});

test("a metal map is kept but held low", () => {
  const root = unitCube();
  const m = (root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  m.metalnessMap = new THREE.Texture();
  fixMaterials(root, { maxTexture: 2048, anisotropy: 4, shadows: false }, track, {} as Document);
  assert.ok(m.metalness <= 0.25);
  assert.equal((root.children[0] as THREE.Mesh).castShadow, false);
});

test("clips are found by role", () => {
  const clip = (n: string) => new THREE.AnimationClip(n, 1, []);
  const clips = [clip("Armature|clip0|baselayer"), clip("Armature|Idle|baselayer"), clip("Armature|Talk_with_Hands_Open|baselayer"), clip("walk")];
  assert.equal(findClip(clips, "idle")?.name, "Armature|Idle|baselayer");
  assert.equal(findClip(clips, "talk", "chat")?.name, "Armature|Talk_with_Hands_Open|baselayer");
  assert.equal(findClip(clips, "walk")?.name, "walk");
  assert.equal(findClip(clips, "run"), null);
});
