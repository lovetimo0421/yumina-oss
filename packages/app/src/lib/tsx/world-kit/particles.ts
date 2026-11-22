/**
 * Air in the world: dust in the light, rain past the window, steam off a pot,
 * snow, embers, fireflies and magic sparkles. Each is one draw, moved entirely
 * on the GPU by a time uniform.
 */
import * as THREE from "three";
import { rng } from "./noise";

export interface ParticleOptions {
  kind: string;
  at?: number[];
  size?: number[];
  count?: number;
  color?: string;
  /** Brightness multiplier (HDR: above 1 glows). */
  glow?: number;
  speed?: number;
}

const POINT_VS = `
uniform float uTime, uScale, uSize, uSpeed, uH;
attribute vec4 aSeed;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vec3 p = position;
  float t = uTime * uSpeed;
  float life = 1.0;
  #if MODE == 0
    p += vec3(sin(t * 0.13 + aSeed.x * 6.28) * 0.18, sin(t * 0.09 + aSeed.y * 6.28) * 0.12, cos(t * 0.11 + aSeed.z * 6.28) * 0.18);
    vAlpha = 0.55 + 0.45 * sin(t * 0.7 + aSeed.w * 6.28);
  #elif MODE == 1
    float y = mod(p.y - t * (0.6 + aSeed.x * 0.4), uH);
    p.y = y; p.x += sin(t * 0.8 + aSeed.y * 6.28) * 0.25; p.z += cos(t * 0.7 + aSeed.z * 6.28) * 0.2;
    vAlpha = 1.0;
  #elif MODE == 2
    float k = fract(aSeed.w + t * (0.12 + aSeed.x * 0.05));
    p.y += k * uH; p.x += sin(k * 5.0 + aSeed.y * 6.28) * 0.12 * k; p.z += cos(k * 4.0 + aSeed.z * 6.28) * 0.12 * k;
    vAlpha = sin(k * 3.14159) * (1.0 - k * 0.5);
    life = 1.0 + k * 3.0;
  #elif MODE == 3
    float k = fract(aSeed.w + t * (0.25 + aSeed.x * 0.2));
    p.y += k * uH; p.x += sin(k * 9.0 + aSeed.y * 6.28) * 0.1; p.z += cos(k * 7.0 + aSeed.z * 6.28) * 0.1;
    vAlpha = (1.0 - k) * (0.5 + 0.5 * sin(uTime * 13.0 + aSeed.y * 40.0));
  #else
    p += vec3(sin(t * 0.5 + aSeed.x * 6.28) * 0.5, sin(t * 0.4 + aSeed.y * 6.28) * 0.3, cos(t * 0.45 + aSeed.z * 6.28) * 0.5);
    vAlpha = pow(0.5 + 0.5 * sin(uTime * (1.5 + aSeed.x * 2.0) + aSeed.w * 6.28), 3.0);
  #endif
  vSeed = aSeed.w;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uSize * life * uScale / max(0.1, -mvPosition.z);
  #include <fog_vertex>
}`;

const POINT_FS = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  #if MODE == 2
    a *= a;
  #elif MODE == 0 || MODE == 3 || MODE == 4
    a = a * a * a;
  #endif
  gl_FragColor = vec4(uColor, a * vAlpha * uOpacity);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const RAIN_VS = `
uniform float uTime, uH, uSpeed;
attribute vec3 aSeed;
attribute float aEnd;
varying float vA;
#include <fog_pars_vertex>
void main() {
  vec3 p = position;
  float fall = 7.0 * uSpeed * (0.85 + aSeed.x * 0.3);
  float y = mod(p.y - uTime * fall, uH);
  p.y = y - aEnd * 0.32 * uSpeed;
  p.x += aEnd * 0.03;
  vA = mix(0.0, 1.0, 1.0 - aEnd) * 0.8 + 0.2;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const RAIN_FS = `
uniform vec3 uColor; uniform float uOpacity;
varying float vA;
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4(uColor, uOpacity * vA);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const MODES: Record<string, { mode: number; color: string; size: number; count: number; opacity: number; blending: THREE.Blending; glow: number; speed: number }> = {
  dust: { mode: 0, color: "#e6e0cc", size: 0.014, count: 260, opacity: 0.35, blending: THREE.AdditiveBlending, glow: 1.2, speed: 1 },
  snow: { mode: 1, color: "#ffffff", size: 0.05, count: 900, opacity: 0.9, blending: THREE.NormalBlending, glow: 1, speed: 1 },
  steam: { mode: 2, color: "#e8e8e8", size: 0.32, count: 70, opacity: 0.055, blending: THREE.NormalBlending, glow: 1, speed: 1 },
  smoke: { mode: 2, color: "#5a5a5a", size: 0.7, count: 50, opacity: 0.15, blending: THREE.NormalBlending, glow: 1, speed: 0.7 },
  embers: { mode: 3, color: "#ff8a3a", size: 0.03, count: 60, opacity: 1, blending: THREE.AdditiveBlending, glow: 6, speed: 1 },
  fireflies: { mode: 4, color: "#d8ff7a", size: 0.04, count: 50, opacity: 1, blending: THREE.AdditiveBlending, glow: 6, speed: 0.6 },
  sparkles: { mode: 4, color: "#ffe6a8", size: 0.035, count: 140, opacity: 1, blending: THREE.AdditiveBlending, glow: 5, speed: 0.5 },
};

export interface Particles { object: THREE.Object3D; update(time: number): void; setScale(s: number): void; dispose(): void }

export function createParticles(o: ParticleOptions): Particles {
  const at = o.at && o.at.length >= 2 ? (o.at.length === 2 ? [o.at[0], 0, o.at[1]] : o.at) : [0, 0, 0];
  const size = o.size && o.size.length >= 2 ? (o.size.length === 2 ? [o.size[0], 3, o.size[1]] : o.size) : [6, 3, 6];
  const rand = rng(Math.round(at[0] * 1000 + at[2] * 37 + 5));
  if (o.kind === "rain") {
    const count = o.count ?? Math.round(size[0] * size[2] * 34);
    const pos = new Float32Array(count * 6), seed = new Float32Array(count * 6), end = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = at[0] + (rand() - 0.5) * size[0], y = rand() * size[1], z = at[2] + (rand() - 0.5) * size[2];
      const s = [rand(), rand(), rand()];
      for (let k = 0; k < 2; k++) {
        pos.set([x, y, z], (i * 2 + k) * 3);
        seed.set(s, (i * 2 + k) * 3);
        end[i * 2 + k] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uH: { value: size[1] }, uSpeed: { value: o.speed ?? 1 }, uColor: { value: new THREE.Color(o.color || "#b8c8d8").multiplyScalar(o.glow ?? 1) }, uOpacity: { value: 0.2 } }]),
      vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    const lines = new THREE.LineSegments(g, m);
    lines.position.y = at[1];
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    return { object: lines, update(t) { m.uniforms.uTime.value = t; }, setScale() {}, dispose() { g.dispose(); m.dispose(); } };
  }
  const def = MODES[o.kind] || MODES.dust;
  const count = o.count ?? (def.mode === 0 || def.mode === 4 ? Math.round(def.count * Math.max(0.3, (size[0] * size[2]) / 40)) : def.count);
  const pos = new Float32Array(count * 3), seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const spread = def.mode === 2 || def.mode === 3 ? 1 : 1;
    pos[i * 3] = at[0] + (rand() - 0.5) * size[0] * spread;
    pos[i * 3 + 1] = def.mode === 2 || def.mode === 3 ? at[1] : at[1] + rand() * size[1];
    pos[i * 3 + 2] = at[2] + (rand() - 0.5) * size[2] * spread;
    seed.set([rand(), rand(), rand(), rand()], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  const m = new THREE.ShaderMaterial({
    defines: { MODE: def.mode },
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uScale: { value: 400 }, uSize: { value: def.size }, uSpeed: { value: (o.speed ?? 1) * def.speed }, uH: { value: size[1] },
      uColor: { value: new THREE.Color(o.color || def.color).multiplyScalar(o.glow ?? def.glow) }, uOpacity: { value: def.opacity },
    }]),
    vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, blending: def.blending, fog: true,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  return {
    object: pts,
    update(t) { m.uniforms.uTime.value = t; },
    setScale(s) { m.uniforms.uScale.value = s; },
    dispose() { g.dispose(); m.dispose(); },
  };
}
