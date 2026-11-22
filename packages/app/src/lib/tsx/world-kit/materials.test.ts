import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as THREE from "three";
import { fbm, vnoise, worley } from "./noise";
import { createMaterialLibrary, MATERIAL_NAMES } from "./materials";

test("noise wraps at its period, so painted surfaces repeat without a seam", () => {
  for (const v of [0.1, 0.37, 0.8]) {
    assert.ok(Math.abs(vnoise(0, v * 8, 8, 3) - vnoise(8, v * 8, 8, 3)) < 1e-9);
    assert.ok(Math.abs(fbm(0, v, 4, 4, 5) - fbm(1, v, 4, 4, 5)) < 1e-9);
    assert.ok(Math.abs(worley(0, v, 6, 2).f1 - worley(1, v, 6, 2).f1) < 1e-9);
  }
});

test("every named surface paints without a picture and edges match across the repeat", () => {
  const lib = createMaterialLibrary({ textureSize: 32, resolveUrl: (s) => s, maxAnisotropy: 1 });
  for (const name of MATERIAL_NAMES) {
    const m = lib.get(name) as THREE.MeshStandardMaterial;
    assert.ok(m.isMaterial, name);
    if (!m.map || !(m.map instanceof THREE.DataTexture)) continue;
    const { data, width, height } = m.map.image as { data: Uint8Array; width: number; height: number };
    assert.equal(data.length, width * height * 4, name);
    // The left and right columns are neighbours once tiled: they should differ about as much as any two
    // neighbouring columns do, not jump.
    let edge = 0, inner = 0;
    for (let y = 0; y < height; y++) {
      const l = (y * width) * 4, r = (y * width + width - 1) * 4, r2 = (y * width + width - 2) * 4;
      edge += Math.abs(data[l] - data[r]);
      inner += Math.abs(data[r] - data[r2]);
    }
    assert.ok(edge <= inner * 3 + height * 12, `${name}: seam ${edge} vs ${inner}`);
  }
  lib.dispose();
});

test("a colour and a picture asset both make a surface", () => {
  const lib = createMaterialLibrary({ textureSize: 16, resolveUrl: (s) => "https://cdn.example/" + s, maxAnisotropy: 1 });
  const a = lib.get({ type: "brick", color: "#334455" });
  const b = lib.get({ type: "brick", color: "#334455" });
  assert.equal(a, b, "same spec, same material");
  const glass = lib.get("glass") as THREE.MeshPhysicalMaterial;
  assert.ok(glass.transparent);
  lib.dispose();
});
