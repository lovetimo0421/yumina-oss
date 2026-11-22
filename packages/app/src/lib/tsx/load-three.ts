import type { ThreeKit } from "./three-kit";

let kit: Promise<ThreeKit> | null = null;

/**
 * `loadThree()` in card code: three.js, built in. Card code cannot import npm
 * packages, and a 3D scene used to mean pasting the whole library into the
 * card, which neither a creator nor the assistant can do by hand.
 *
 *   const { THREE, PointerLockControls, OrbitControls, GLTFLoader, parseGLB } = await loadThree();
 *
 * Every card in the page shares one copy. A failed download is not kept, so
 * the next call tries again.
 */
export function loadThree(): Promise<ThreeKit> {
  kit ??= import("./three-kit").then((m) => m.threeKit).catch((error) => {
    kit = null;
    throw error;
  });
  return kit;
}
