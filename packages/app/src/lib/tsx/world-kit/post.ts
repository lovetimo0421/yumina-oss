/**
 * The world kit's camera: the scene is drawn into a high-range target, its
 * brightest parts are blurred into a glow at three sizes, and one full-screen
 * pass tone-maps (ACES), grades (cool shadows / warm highlights, contrast,
 * saturation), and adds lens fringe, vignette and film grain. Distilled from
 * the 1984 card's grade. When the device cannot render into float targets the
 * pass falls back to drawing the scene straight to the screen.
 */
import * as THREE from "three";

export interface Look {
  exposure: number;
  bloom: number;
  bloomThreshold: number;
  grain: number;
  vignette: number;
  contrast: number;
  saturation: number;
  fringe: number;
  shadowTint: THREE.Color;
  highlightTint: THREE.Color;
  /** 0..1 fade to black. */
  dark: number;
}

const QUAD_VS = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

const BRIGHT_FS = `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold, uExposure;
varying vec2 vUv;
vec3 pick(vec2 uv) {
  vec3 c = texture2D(tSrc, uv).rgb;
  float l = max(c.r, max(c.g, c.b)) * uExposure;
  return c * smoothstep(uThreshold, uThreshold * 2.2 + 0.2, l);
}
void main() {
  vec3 c = pick(vUv + uTexel * vec2(-1.0, -1.0)) + pick(vUv + uTexel * vec2(1.0, -1.0))
         + pick(vUv + uTexel * vec2(-1.0, 1.0)) + pick(vUv + uTexel * vec2(1.0, 1.0));
  gl_FragColor = vec4(min(c * 0.25, vec3(40.0)), 1.0);
}`;

const BLUR_FS = `
uniform sampler2D tSrc; uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const GRADE_FS = `
uniform sampler2D tScene, tBloom1, tBloom2, tBloom3;
uniform vec2 uTexel;
uniform float uTime, uBloom, uGrain, uVignette, uContrast, uSaturation, uFringe, uDark, uSmooth, uHasBloom;
uniform vec3 uShadowTint, uHighTint;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = vUv, c = uv - 0.5;
  float edge = dot(c, c);
  vec2 fr = c * edge * 0.012 * uFringe;
  vec3 col = vec3(texture2D(tScene, uv - fr).r, texture2D(tScene, uv).g, texture2D(tScene, uv + fr).b);
  if (uSmooth > 0.5) {
    vec3 n = texture2D(tScene, uv + vec2(0.0, uTexel.y)).rgb, s = texture2D(tScene, uv - vec2(0.0, uTexel.y)).rgb;
    vec3 e = texture2D(tScene, uv + vec2(uTexel.x, 0.0)).rgb, w = texture2D(tScene, uv - vec2(uTexel.x, 0.0)).rgb;
    vec4 L = vec4(dot(n, vec3(.3, .59, .11)), dot(s, vec3(.3, .59, .11)), dot(e, vec3(.3, .59, .11)), dot(w, vec3(.3, .59, .11)));
    float lo = min(min(L.x, L.y), min(L.z, L.w)), hi = max(max(L.x, L.y), max(L.z, L.w));
    float k = (hi - lo) / (hi + 0.06);
    col = mix(col, (n + s + e + w + col) * 0.2, smoothstep(0.18, 0.6, k) * 0.7);
  }
  if (uHasBloom > 0.5) {
    vec3 b = texture2D(tBloom1, uv).rgb * 0.5 + texture2D(tBloom2, uv).rgb * 0.8 + texture2D(tBloom3, uv).rgb * 1.1;
    col += b * uBloom * 0.35;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  vec3 g = clamp(gl_FragColor.rgb, 0.0, 1.0);
  float l = dot(g, vec3(.2126, .7152, .0722));
  // Split tone: shadows lean one way, highlights the other.
  g *= mix(uShadowTint, vec3(1.0), smoothstep(0.0, 0.35, l));
  g *= mix(vec3(1.0), uHighTint, smoothstep(0.25, 0.85, l));
  g = clamp(g, 0.0, 1.0);
  g = mix(g, g * g * (3.0 - 2.0 * g), uContrast);
  float l2 = dot(g, vec3(.2126, .7152, .0722));
  g = mix(vec3(l2), g, uSaturation);
  float v = smoothstep(1.05, 0.25, length(c * vec2(1.0, 0.8)));
  g *= mix(1.0 - 0.55 * uVignette, 1.0, v);
  g *= 1.0 - uDark;
  g += (hash(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5) * 0.022 * uGrain * (1.0 - abs(l2 * 2.0 - 1.0) * 0.6);
  gl_FragColor.rgb = max(g, vec3(0.0));
  #include <colorspace_fragment>
}`;

export class Post {
  readonly enabled: boolean;
  private renderer: THREE.WebGLRenderer;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private bloomRT: THREE.WebGLRenderTarget[] = [];
  private tmpRT: THREE.WebGLRenderTarget[] = [];
  private quad: THREE.Mesh;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bright: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private grade: THREE.ShaderMaterial;
  private size = new THREE.Vector2();
  scale = 1;
  bloomOn = true;
  failed: string | null = null;
  private frames = 0;
  look: Look;

  constructor(renderer: THREE.WebGLRenderer, opts: { msaa: boolean }) {
    this.renderer = renderer;
    const caps = renderer.capabilities;
    const ext = renderer.extensions;
    const has = (n: string) => { try { return Boolean(ext.has(n)); } catch { return false; } };
    const half = caps.isWebGL2 ? has("EXT_color_buffer_float") || has("EXT_color_buffer_half_float") : false;
    this.enabled = caps.isWebGL2;
    const type = half ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.look = {
      exposure: 1, bloom: 0.6, bloomThreshold: 1, grain: 0.6, vignette: 0.5, contrast: 0.3, saturation: 1, fringe: 0.4,
      shadowTint: new THREE.Color(1, 1, 1), highlightTint: new THREE.Color(1, 1, 1), dark: 0,
    };
    if (this.enabled) {
      this.sceneRT = new THREE.WebGLRenderTarget(2, 2, { type, samples: opts.msaa ? 4 : 0, depthBuffer: true });
      for (let i = 0; i < 3; i++) {
        this.bloomRT.push(new THREE.WebGLRenderTarget(2, 2, { type, depthBuffer: false }));
        this.tmpRT.push(new THREE.WebGLRenderTarget(2, 2, { type, depthBuffer: false }));
      }
    }
    this.bright = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uExposure: { value: 1 } },
      vertexShader: QUAD_VS, fragmentShader: BRIGHT_FS, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.grade = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tBloom1: { value: null }, tBloom2: { value: null }, tBloom3: { value: null },
        uTexel: { value: new THREE.Vector2() }, uTime: { value: 0 }, uBloom: { value: 0.6 }, uGrain: { value: 0.6 },
        uVignette: { value: 0.5 }, uContrast: { value: 0.3 }, uSaturation: { value: 1 }, uFringe: { value: 0.4 },
        uDark: { value: 0 }, uSmooth: { value: opts.msaa ? 0 : 1 }, uHasBloom: { value: 1 },
        uShadowTint: { value: new THREE.Color(1, 1, 1) }, uHighTint: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: QUAD_VS, fragmentShader: GRADE_FS, depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.grade);
    this.quad.frustumCulled = false;
    this.postScene.add(this.quad);
  }

  private pass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.postScene, this.postCam);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, time: number) {
    const r = this.renderer;
    r.toneMappingExposure = this.look.exposure;
    if (!this.enabled || this.failed || !this.sceneRT) { r.setRenderTarget(null); r.render(scene, camera); return; }
    r.getDrawingBufferSize(this.size);
    const w = Math.max(2, Math.round(this.size.x * this.scale)), h = Math.max(2, Math.round(this.size.y * this.scale));
    if (this.sceneRT.width !== w || this.sceneRT.height !== h) {
      this.sceneRT.setSize(w, h);
      for (let i = 0; i < 3; i++) {
        const d = 2 << i;
        this.bloomRT[i].setSize(Math.max(2, w / d | 0), Math.max(2, h / d | 0));
        this.tmpRT[i].setSize(Math.max(2, w / d | 0), Math.max(2, h / d | 0));
      }
    }
    r.setRenderTarget(this.sceneRT);
    this.frames++;
    if (this.frames === 4) {
      const gl = r.getContext();
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.failed = "framebuffer"; r.setRenderTarget(null); r.render(scene, camera); return;
      }
    }
    r.render(scene, camera);
    const L = this.look;
    const bloom = this.bloomOn && L.bloom > 0.01;
    if (bloom) {
      let src: THREE.Texture = this.sceneRT.texture;
      for (let i = 0; i < 3; i++) {
        const t = this.bloomRT[i], tmp = this.tmpRT[i];
        if (i === 0) {
          this.bright.uniforms.tSrc.value = src;
          this.bright.uniforms.uTexel.value.set(0.5 / w, 0.5 / h);
          this.bright.uniforms.uThreshold.value = L.bloomThreshold;
          this.bright.uniforms.uExposure.value = L.exposure;
          this.pass(this.bright, t);
        } else {
          this.blur.uniforms.tSrc.value = src;
          this.blur.uniforms.uDir.value.set(0, 0);
          this.pass(this.blur, t);
        }
        this.blur.uniforms.tSrc.value = t.texture;
        this.blur.uniforms.uDir.value.set(1 / t.width, 0);
        this.pass(this.blur, tmp);
        this.blur.uniforms.tSrc.value = tmp.texture;
        this.blur.uniforms.uDir.value.set(0, 1 / t.height);
        this.pass(this.blur, t);
        src = t.texture;
      }
    }
    const u = this.grade.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom1.value = this.bloomRT[0].texture; u.tBloom2.value = this.bloomRT[1].texture; u.tBloom3.value = this.bloomRT[2].texture;
    u.uHasBloom.value = bloom ? 1 : 0;
    u.uTexel.value.set(1 / w, 1 / h);
    u.uTime.value = time;
    u.uBloom.value = L.bloom; u.uGrain.value = L.grain; u.uVignette.value = L.vignette; u.uContrast.value = L.contrast;
    u.uSaturation.value = L.saturation; u.uFringe.value = L.fringe; u.uDark.value = L.dark;
    u.uShadowTint.value.copy(L.shadowTint); u.uHighTint.value.copy(L.highlightTint);
    this.pass(this.grade, null);
    if (this.frames === 8 || this.frames === 60) this.checkBlack(scene, camera);
  }

  /** Some engines (seen in Safari) draw the graded picture black; fall back to a direct draw if so. */
  private checkBlack(scene: THREE.Scene, camera: THREE.Camera) {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const black = () => {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      for (const [x, y] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7], [0.5, 0.15], [0.5, 0.85]]) {
        gl.readPixels(Math.floor(x * (w - 1)), Math.floor(y * (h - 1)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (px[0] || px[1] || px[2]) return false;
      }
      return true;
    };
    try {
      if (!black()) return;
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      if (!black()) this.failed = "black-output";
    } catch { /* A probe never breaks a frame. */ }
  }

  dispose() {
    this.sceneRT?.dispose();
    for (const t of [...this.bloomRT, ...this.tmpRT]) t.dispose();
    this.bright.dispose(); this.blur.dispose(); this.grade.dispose();
    this.quad.geometry.dispose();
  }
}
