// The rig runtime, as built in the rig lab (yumina-workspaces/rig-lab/transfer/v6/web, made a module by its
// card/build_kit.py). Change it there and copy it over, so the lab's tests keep covering what cards run.
// rig6.js: our own 2D character runtime (no Live2D). One rig.json + texture pages.
//
// Each part is a textured triangle mesh. A frame:
//   1. keyforms: every parameter moves the part's vertices (and opacity) by blending the keyforms on either
//      side of its value; parameters add up (blend shapes);
//   2. the head: vertices carry a depth z and a head weight; the head turns as a 3D rotation around the neck
//      with a little perspective, faded into the neck by the weight;
//   3. the body leans / turns around the waist, breathes;
//   4. hair strands swing (pendulum chains driven by how the head moved), offsets added on top;
//   5. drawn back to front; a part can be clipped by another part's coverage (an iris by its eye white), done
//      with a screen-size mask buffer like Cubism's.
// Textures are premultiplied, mipmapped, trilinear + anisotropic, so a small or zoomed character stays clean.
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const VS = `#version 300 es
in vec2 aPos; in vec2 aUV;
uniform vec2 uScale; uniform vec2 uOff;
uniform vec4 uXf; uniform vec2 uXo;     // the layers pulled apart: a per-part affine in picture space (identity otherwise)
out vec2 vUV; out vec2 vScreen;
void main() {
  vec2 a = vec2(uXf.x * aPos.x + uXf.y * aPos.y, uXf.z * aPos.x + uXf.w * aPos.y) + uXo;
  vec2 p = a * uScale + uOff;             // clip space
  vUV = aUV; vScreen = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec2 vUV; in vec2 vScreen;
uniform sampler2D uTex; uniform sampler2D uMask;
uniform float uAlpha; uniform vec4 uMaskCh; uniform float uUseMask; uniform vec3 uTint;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUV);
  c.rgb *= uTint;
  float m = 1.0;
  if (uUseMask > 0.5) m = dot(texture(uMask, vScreen), uMaskCh);
  o = c * (uAlpha * m);
}`;
// writing a mask: the part's coverage into one channel
const FS_MASK = `#version 300 es
precision highp float;
in vec2 vUV; in vec2 vScreen;
uniform sampler2D uTex; uniform vec4 uMaskCh; uniform float uAlpha;
out vec4 o;
void main() { o = uMaskCh * texture(uTex, vUV).a * uAlpha; }`;
// the outline of a layer when they are pulled apart
const FS_LINE = `#version 300 es
precision highp float;
in vec2 vUV; in vec2 vScreen;
uniform vec4 uCol;
out vec4 o;
void main() { o = uCol; }`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, "aPos"); gl.bindAttribLocation(p, 1, "aUV");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

const ease01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

class Rig {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: !!opts.preserve });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.prog = compile(gl, VS, FS);
    this.progMask = compile(gl, VS, FS_MASK);
    this.progLine = compile(gl, VS, FS_LINE);
    for (const pg of [this.prog, this.progMask, this.progLine]) { gl.useProgram(pg.p); this._xf(pg, null); }
    // the layers pulled apart in depth, the stack turned to show them (t 0 = the character as one, 1 = apart;
    // yaw / pitch in radians). Set by whoever shows it; nothing here animates it.
    this.explode = null;
    this.aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    this.P = {};
    this.view = { scale: 1, x: 0, y: 0 };
    this.physicsOn = true;
    // small effects the live layer drives each frame: the iris's squash after a blink (scale across, down), the jaw
    // opening with the mouth (0..1), a breeze in the hair (0..1)
    this.fx = { iris: [1, 1], jaw: 0, wind: 0 };
    // the creator's feel for this character (settings.tuning; 1 = as built): here only the hair's give
    this.tune = { hair: 1 };
    this._clock = 0;
  }

  // a folder (rig.json + texture pages) or one packed .rig6 file (a URL ending in .rig6, or its bytes)
  async load(base, file = "rig.json") {
    if (base instanceof ArrayBuffer || /\.rig6(\?|#|$)/.test(base)) return this.loadPack(base);
    const R = await (await fetch(base + file)).json();
    return this._build(R, (f, i) => fetch(base + f).then((r) => r.blob()));
  }
  async loadPack(src) {
    const buf = src instanceof ArrayBuffer ? src : await (await fetch(src)).arrayBuffer();
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "RIG6") throw new Error("not a .rig6 pack");
    const hl = dv.getUint32(4, true);
    const R = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
    const base = 8 + hl, B = R.blocks;
    const view = (b) => {
      const off = base + B[b].off, n = B[b].len;
      return B[b].type === "f32" ? new Float32Array(buf, off, n / 4) : B[b].type === "u32" ? new Uint32Array(buf, off, n / 4)
        : B[b].type === "u16" ? new Uint16Array(buf, off, n / 2) : new Uint8Array(buf, off, n);
    };
    const un = (x) => (x && typeof x === "object" && "$b" in x ? view(x.$b) : x);
    for (const P of R.parts) {
      for (const k of ["v", "uv", "z", "hw", "bw", "t"]) if (P[k]) P[k] = un(P[k]);
      for (const kf of P.kf || []) if (kf.d) kf.d = un(kf.d);
      for (const g of P.kf2 || []) g.d = g.d.map((row) => row.map(un));
    }
    return this._build(R, (f, i) => Promise.resolve(new Blob([view(R.texBlocks[i])], { type: "image/webp" })));
  }
  async _build(R, getBlob) {
    const gl = this.gl;
    this.R = R;
    this.tex = await Promise.all(R.textures.map(async (f, ti) => {
      const blob = await getBlob(f, ti);
      // premultiplied at decode: WebGL ignores UNPACK_PREMULTIPLY_ALPHA for ImageBitmaps, and straight alpha
      // under premultiplied blending shows as bright halos along every soft edge
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: "premultiply", colorSpaceConversion: "none" });
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      return t;
    }));
    this.parts = R.parts.map((pt) => this._initPart(pt));
    this.byId = Object.fromEntries(this.parts.map((p) => [p.id, p]));
    this._sanity();
    // soft regions: each a 2D damped spring; an anchor vertex (the part vertex nearest the centre) tells where the
    // body carries it each frame
    this.springs = (R.springs || []).map((sp, si) => {
      let best = null, bd = 1e18;
      for (const p of this.parts) {
        if (!p.sw) continue;
        for (let j = 0; j < p.sw.length; j += 3) if (p.sw[j + 1] === si) {
          const i = p.sw[j], dx = p.rest[2 * i] - sp.c[0], dy = p.rest[2 * i + 1] - sp.c[1], d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = [p, i]; }
        }
      }
      return Object.assign({}, sp, { anchor: best, o: [0, 0], v: [0, 0], T: [0, 0], Tp: [0, 0], Tpp: [0, 0], started: false });
    });
    for (const p of R.params) this.P[p.id] = p.def;
    // masks: every part used as a clip gets a channel of a mask buffer (4 per buffer)
    const clipIds = [...new Set(this.parts.flatMap((p) => p.clip ? [p.clip] : []))];
    this.maskOf = {};
    clipIds.forEach((id, i) => { this.maskOf[id] = { buf: Math.floor(i / 4), ch: i % 4 }; });
    this.maskBufs = [];
    for (let i = 0; i < Math.ceil(clipIds.length / 4); i++) this.maskBufs.push(this._fbo());
    this.applySettings(R.settings);
    return this;
  }
  // the creator's choices for this character (they travel with it, outside the built pack): which drawing of each
  // expression shows ({ expr: { angry: 1 } }, 0 = the one the build judged best) and the feel (tuning)
  applySettings(s) {
    this.settings = s && typeof s === "object" ? s : {};
    const pick = this.settings.expr || {};
    for (const p of this.parts || []) if (p.expr != null) p.hidden = (p.variant | 0) !== ((pick[p.expr] | 0) || 0);
    const t = this.settings.tuning || {};
    this.tune.hair = Number.isFinite(t.hair) ? clamp(t.hair, 0, 2.5) : 1;
  }

  _fbo() {
    const gl = this.gl, t = gl.createTexture(), f = gl.createFramebuffer();
    return { t, f, w: 0, h: 0 };
  }
  _sizeFbo(m, w, h) {
    if (m.w === w && m.h === h) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, m.t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, m.t, 0);
    m.w = w; m.h = h;
  }

  // A turn keyform no head could cause is left out. The fit that makes them follows each layer through generated
  // frames of the head turning, and on a layer it loses (long back hair, mostly) it runs away: the layer ends up
  // a third of the picture from where it belongs, as a lump over the head. A wrong shape is worse than none, and
  // the 3D turn in pose() still carries the layer with the head. The face is the measure: it is the layer the fit
  // follows best, and nothing on a head moves several times as far as the face does.
  _sanity() {
    const face = this.byId.face;
    if (!face) return;
    const reach = (d) => {
      const m = new Float32Array(d.length >> 1);
      for (let i = 0; i < m.length; i++) m[i] = Math.hypot(d[2 * i], d[2 * i + 1]);
      m.sort();
      return m[Math.floor(m.length * 0.95)] || 0;
    };
    const TURN = /^ParamAngle[XYZ]$/, LIMIT = 2.5;
    const ref = {};
    for (const [param, arr] of Object.entries(face.keys)) if (TURN.test(param)) ref[param] = Math.max(0, ...arr.map((k) => (k.d ? reach(k.d) : 0)));
    this.dropped = [];
    const drop = (p, param) => {
      for (const k of p.keys[param] || []) if (k.d) { k.d = null; this.dropped.push(p.id + " " + param + " " + k.v); }
    };
    for (const p of this.parts) {
      if (p === face) continue;
      for (const [param, arr] of Object.entries(p.keys)) {
        if (!ref[param] || !arr.some((k) => k.d && reach(k.d) > LIMIT * ref[param])) continue;
        // every key of that turn goes, not only the one that ran away: half a turn fitted and half not would jump
        drop(p, param);
        // what is painted behind the hair moves with the hair or not at all
        if (p.id === "back hair" && this.byId.backfill) drop(this.byId.backfill, param);
      }
    }
  }

  _initPart(pt) {
    const gl = this.gl;
    const n = pt.v.length / 2;
    const p = Object.assign({}, pt);
    p.n = n;
    p.rest = Float32Array.from(pt.v);
    p.local = new Float32Array(n * 2);
    p.out = new Float32Array(n * 2);
    p.z = pt.z ? Float32Array.from(pt.z) : new Float32Array(n);
    p.hw = pt.hw ? Float32Array.from(pt.hw) : new Float32Array(n);
    p.bw = pt.bw ? Float32Array.from(pt.bw) : new Float32Array(n).fill(1);
    // keyforms grouped by parameter, sorted by value; the rest pose is the implicit key at the default
    p.keys = {};
    for (const k of pt.kf || []) (p.keys[k.p] = p.keys[k.p] || []).push({ v: k.v, d: k.d ? Float32Array.from(k.d) : null, o: k.o });
    for (const arr of Object.values(p.keys)) arr.sort((a, b) => a.v - b.v);
    // 2D grids: deltas at every (a, b) pair of two parameters' key values, blended bilinearly
    p.grids = (pt.kf2 || []).map((g) => ({ pa: g.pa, pb: g.pb, va: g.va, vb: g.vb, d: g.d.map((row) => row.map((x) => Float32Array.from(x))) }));
    p.vao = gl.createVertexArray();
    gl.bindVertexArray(p.vao);
    p.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, p.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, p.rest, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const uvb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvb);
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(pt.uv), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    const idx = n > 65535 ? Uint32Array.from(pt.t) : Uint16Array.from(pt.t);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    p.idxType = n > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    p.count = pt.t.length;
    gl.bindVertexArray(null);
    p.opacity = 1;
    if (p.phys) this._initPhys(p);
    return p;
  }

  // ---- keyforms ---------------------------------------------------------------------------------------
  _keyforms(p) {
    const L = p.local;
    L.set(p.rest);
    let op = pt_base(p);
    for (const [param, arr] of Object.entries(p.keys)) {
      const def = this.R.paramDef[param];
      const v = this.P[param] ?? def;
      // bracket v between keys (the default value is the rest key: no offset, base opacity)
      let lo = { v: def, d: null, o: undefined }, hi = null;
      const all = arr.some((k) => k.v === def) ? arr : [...arr, lo].sort((a, b) => a.v - b.v);
      if (v <= all[0].v) { lo = all[0]; hi = null; }
      else if (v >= all[all.length - 1].v) { lo = all[all.length - 1]; hi = null; }
      else for (let i = 0; i < all.length - 1; i++) if (v >= all[i].v && v <= all[i + 1].v) { lo = all[i]; hi = all[i + 1]; break; }
      const f = hi ? (v - lo.v) / (hi.v - lo.v || 1) : 0;
      const wl = 1 - f, wh = f;
      if (lo.d) for (let i = 0; i < L.length; i++) L[i] += wl * lo.d[i];
      if (hi && hi.d) for (let i = 0; i < L.length; i++) L[i] += wh * hi.d[i];
      if (lo.o !== undefined || (hi && hi.o !== undefined)) {
        const ol = lo.o !== undefined ? lo.o : 1, oh = hi ? (hi.o !== undefined ? hi.o : 1) : ol;
        op *= ol * wl + oh * wh;
      }
    }
    for (const g of p.grids) {
      const br = (vals, v) => {
        if (v <= vals[0]) return [0, 0, 0];
        if (v >= vals[vals.length - 1]) return [vals.length - 1, vals.length - 1, 0];
        for (let i = 0; i < vals.length - 1; i++) if (v <= vals[i + 1]) return [i, i + 1, (v - vals[i]) / (vals[i + 1] - vals[i])];
      };
      const [a0, a1, fa] = br(g.va, this.P[g.pa] ?? this.R.paramDef[g.pa]);
      const [b0, b1, fb] = br(g.vb, this.P[g.pb] ?? this.R.paramDef[g.pb]);
      const corners = [[a0, b0, (1 - fa) * (1 - fb)], [a1, b0, fa * (1 - fb)], [a0, b1, (1 - fa) * fb], [a1, b1, fa * fb]];
      for (const [i, j, w] of corners) {
        if (w < 1e-5) continue;
        const d = g.d[i][j];
        for (let k = 0; k < L.length; k++) L[k] += w * d[k];
      }
    }
    p.opacity = op;
  }

  // ---- the head and body as 3D-ish transforms ---------------------------------------------------------
  pose(dt) {
    const R = this.R, P = this.P, A = R.anchors;
    if (!R.paramDef) R.paramDef = Object.fromEntries(R.params.map((q) => [q.id, q.def]));
    const k = R.turn;     // degrees per parameter unit and perspective
    const yaw = clamp(P.ParamAngleX || 0, -30, 30) / 30 * k.yaw * DEG;
    const pitch = clamp(P.ParamAngleY || 0, -30, 30) / 30 * k.pitch * DEG;
    const roll = -clamp(P.ParamAngleZ || 0, -30, 30) / 30 * k.roll * DEG;
    const byaw = clamp(P.ParamBodyAngleX || 0, -10, 10) / 10 * k.byaw * DEG;
    const broll = -clamp(P.ParamBodyAngleZ || 0, -10, 10) / 10 * k.broll * DEG;
    const bpitch = clamp(P.ParamBodyAngleY || 0, -10, 10) / 10 * k.bpitch * DEG;
    const breath = P.ParamBreath || 0;
    const hp = A.head_pivot, bp = A.body_pivot, F = k.focal;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const cby = Math.cos(byaw), sby = Math.sin(byaw), cbp = Math.cos(bpitch), sbp = Math.sin(bpitch), cbr = Math.cos(broll), sbr = Math.sin(broll);
    const chestTop = A.chin, unit = A.unit;
    this._clock += Math.max(0, dt || 0);
    if (this._mouthY === undefined) {
      const m = this.byId.mouth;
      let lo = Infinity, hi = -Infinity;
      if (m) for (let i = 1; i < m.rest.length; i += 2) { lo = Math.min(lo, m.rest[i]); hi = Math.max(hi, m.rest[i]); }
      this._mouthY = m ? (lo + hi) / 2 : A.eye_y + 0.62 * (A.chin - A.eye_y);
    }
    const fx = this.fx, jaw = clamp(fx.jaw || 0, 0, 1.2) * 0.024 * unit, my = this._mouthY, jawSpan = Math.max(1, A.chin - my);
    const [isx, isy] = fx.iris;
    for (const p of this.parts) {
      this._keyforms(p);
      // the iris (and what is drawn on it) squashes about its own centre after a blink
      if ((isx !== 1 || isy !== 1) && /^(irides|v_heart|v_heartglow)-[lr]$/.test(p.id)) {
        const L = p.local; let cx = 0, cy = 0;
        for (let i = 0; i < p.n; i++) { cx += L[2 * i]; cy += L[2 * i + 1]; }
        cx /= p.n; cy /= p.n;
        for (let i = 0; i < p.n; i++) { L[2 * i] = cx + (L[2 * i] - cx) * isx; L[2 * i + 1] = cy + (L[2 * i + 1] - cy) * isy; }
      }
      // the arms: the upper arm turns about the shoulder, the forearm also about the (turned) elbow, by how far down
      // the arm a vertex is; all in the picture's rest space, before the body carries it
      if (p.arm && R.arms) this._arms(p);
      // the jaw: below the mouth the face (and the mouth drawn on it) drops a little as the mouth opens, most at the chin
      if (jaw > 0 && (p.id === "face" || p.id === "mouth" || p.id.startsWith("v_mouth-"))) {
        const L = p.local;
        for (let i = 0; i < p.n; i++) {
          const y = L[2 * i + 1];
          if (y > my) L[2 * i + 1] = y + jaw * ease01((y - my) / jawSpan);
        }
      }
      const L = p.local, O = p.out, Z = p.z, HW = p.hw, BW = p.bw;
      for (let i = 0; i < p.n; i++) {
        let x = L[2 * i], y = L[2 * i + 1], z = Z[i];
        const hw = HW[i];
        if (hw > 0) {
          // yaw about the vertical axis, then pitch, then roll in the picture plane; weak perspective
          let X = x - hp[0], Y = y - hp[1], Zc = z;
          let x1 = X * cy + Zc * sy, z1 = -X * sy + Zc * cy;
          let y1 = Y * cp - z1 * sp; z1 = Y * sp + z1 * cp;
          const s = F / (F - z1 + z);              // nearer parts grow a touch
          const x2 = (x1 * cr - y1 * sr) * s, y2 = (x1 * sr + y1 * cr) * s;
          x += hw * (x2 + hp[0] - x); y += hw * (y2 + hp[1] - y);
        }
        // breathing: chest and shoulders rise, the chest widens a hair
        if (p.breath) {
          const up = clamp(1 - (y - chestTop) / (5 * unit), 0, 1) * (1 - hw);
          y -= breath * 0.012 * unit * 3 * up; x += breath * 0.004 * (x - hp[0]) * up;
        }
        const bw = BW[i];
        if (bw > 0) {
          let X = x - bp[0], Y = y - bp[1], Zc = z * 0.6;
          let x1 = X * cby + Zc * sby, z1 = -X * sby + Zc * cby;
          let y1 = Y * cbp - z1 * sbp;
          const x2 = x1 * cbr - y1 * sbr, y2 = x1 * sbr + y1 * cbr;
          x += bw * (x2 + bp[0] - x); y += bw * (y2 + bp[1] - y);
        }
        O[2 * i] = x; O[2 * i + 1] = y;
      }
    }
    if (this.physicsOn && dt > 0) { this._physics(dt); this._springs(dt); }
    for (const p of this.parts) if (p.phys) this._applyPhys(p);
    for (const p of this.parts) if (p.sw) this._applySprings(p);
  }

  _arms(p) {
    const L = p.local, P = this.P, R = this.R;
    const set = { 1: R.arms.r, 2: R.arms.l };
    const ang = {
      1: [(P.ParamArmRA || 0) * DEG, -(P.ParamArmRB || 0) * DEG],
      2: [-(P.ParamArmLA || 0) * DEG, (P.ParamArmLB || 0) * DEG],
    };
    // a hand drawn on (its own part): first it turns at the wrist, + toward the body like the forearm's bend
    if (p.wrist) {
      const h = p.arm[0] === 1 ? -(P.ParamHandRAngle || 0) * DEG : (P.ParamHandLAngle || 0) * DEG;
      if (h) {
        const c = Math.cos(h), s = Math.sin(h), wx = p.wrist[0], wy = p.wrist[1];
        for (let i = 0; i < p.n; i++) {
          const x = L[2 * i] - wx, y = L[2 * i + 1] - wy;
          L[2 * i] = x * c - y * s + wx; L[2 * i + 1] = x * s + y * c + wy;
        }
      }
    }
    const reach = p.armReach || (p.armReach = this._armReach(p, set));
    for (let i = 0; i < p.n; i++) {
      const sd = p.arm[i];
      if (!sd || !set[sd] || !reach[i]) continue;
      const [a0, b0] = ang[sd];
      if (!a0 && !b0) continue;
      const a = a0 * reach[i], b = b0 * reach[i];
      const S = set[sd].shoulder, E = set[sd].elbow;
      const ca = Math.cos(a), sa = Math.sin(a);
      let x = L[2 * i] - S[0], y = L[2 * i + 1] - S[1];
      let x1 = x * ca - y * sa + S[0], y1 = x * sa + y * ca + S[1];
      const w = p.armlow[i];
      if (w > 0 && b) {
        const ex = (E[0] - S[0]) * ca - (E[1] - S[1]) * sa + S[0], ey = (E[0] - S[0]) * sa + (E[1] - S[1]) * ca + S[1];
        const cb = Math.cos(b * w), sb = Math.sin(b * w);
        const dx = x1 - ex, dy = y1 - ey;
        x1 = dx * cb - dy * sb + ex; y1 = dx * sb + dy * cb + ey;
      }
      L[2 * i] = x1; L[2 * i + 1] = y1;
    }
  }

  // How much of an arm's turn each of its vertices takes. None for a vertex the arm can't reach (past an upper arm's
  // length from the shoulder-elbow segment and the forearm's reach beyond the elbow, with a fade to 1.25 of it) or on
  // the far side of the body (past the body's midline by over a third of an upper arm). A good split keeps every arm
  // vertex within 0.75 of the arm and on its own side (hands drawn on included); a split that gave the arm the other
  // sleeve too (a picture with a scene behind and a hand raised to the hair, 2026-11-16) flung that sleeve round the
  // shoulder at every laugh and surprise.
  _armReach(p, set) {
    const out = new Float32Array(p.n), V = p.rest;
    const A0 = this.R.anchors || {}, mid = (A0.body_pivot || A0.head_pivot || [NaN])[0];
    for (let i = 0; i < p.n; i++) {
      const sd = p.arm[i], A = set[sd];
      if (!sd || !A) continue;
      const S = A.shoulder, E = A.elbow, dx = E[0] - S[0], dy = E[1] - S[1], up = Math.hypot(dx, dy) || 1;
      const x = V[2 * i], y = V[2 * i + 1];
      const t = Math.max(0, Math.min(1, ((x - S[0]) * dx + (y - S[1]) * dy) / (up * up)));
      const toUpper = Math.hypot(x - S[0] - t * dx, y - S[1] - t * dy);
      const pastForearm = Math.max(0, Math.hypot(x - E[0], y - E[1]) - Math.max(0, (A.len || up) - up));
      const d = Math.min(toUpper, pastForearm) / up;
      const near = d <= 1 ? 1 : d >= 1.25 ? 0 : (1.25 - d) / 0.25;
      // how far past the midline, toward the other arm's side, in upper arms (negative: on its own side)
      const across = Number.isFinite(mid) ? (mid - x) * Math.sign(S[0] - mid) / up : -1;
      const side = across <= 0.25 ? 1 : across >= 0.35 ? 0 : (0.35 - across) / 0.1;
      out[i] = Math.min(near, side);
    }
    return out;
  }

  // ---- hair: pendulum chains -----------------------------------------------------------------------------
  _initPhys(p) {
    for (const st of p.phys.strands) {
      const n = st.p.length;
      st.o = new Float32Array(2 * n);     // offset from where the rig carries each point (what the mesh reads)
      st.x = new Float32Array(2 * n);     // simulated positions
      st.xp = new Float32Array(2 * n);    // previous positions (Verlet)
      st.T = new Float32Array(2 * n);     // where the rig carries the chain this frame
      st.Tp = new Float32Array(2 * n);    // ... and last step (to damp motion relative to the head, not absolute)
      st.len = new Float32Array(n);       // rest segment lengths
      for (let i = 1; i < n; i++) st.len[i] = Math.hypot(st.p[i][0] - st.p[i - 1][0], st.p[i][1] - st.p[i - 1][1]);
      st.started = false;
      st.phase = (st.p[0][0] * 0.0137 + st.p[0][1] * 0.0071) % (2 * Math.PI);
    }
  }
  // hair: pendulum chains, position based (Verlet + fixed segment lengths), like Cubism's physics: each segment is
  // pulled back toward its rest direction (stiff at the root, loose at the tip), long hair also hangs toward
  // gravity, and every step loses a little speed. It cannot blow up whatever the frame rate.
  _physics(dt) {
    dt = clamp(dt, 0.004, 0.05);
    const sub = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / sub;
    const wind = clamp(this.fx.wind || 0, 0, 1) * 0.18, clk = this._clock;
    for (const p of this.parts) {
      if (!p.phys) continue;
      const ph = p.phys;
      const keep = Math.pow(ph.keep, h * 60);          // velocity kept per step (60 fps reference)
      for (const st of ph.strands) {
        const n = st.p.length;
        if (st.started) st.Tp.set(st.T);
        for (let i = 0; i < n; i++) { const vi = st.vi[i]; st.T[2 * i] = p.out[2 * vi]; st.T[2 * i + 1] = p.out[2 * vi + 1]; }
        if (!st.started) { st.x.set(st.T); st.xp.set(st.T); st.Tp.set(st.T); st.started = true; }
        for (let s = 0; s < sub; s++) {
          // the root rides the head
          st.x[0] = st.T[0]; st.x[1] = st.T[1]; st.xp[0] = st.T[0]; st.xp[1] = st.T[1];
          for (let i = 1; i < n; i++) {
            const t = st.t[i];
            // the head's own motion carries the hair; only the hair's motion relative to it dies away
            const ax = (st.T[2 * i] - st.Tp[2 * i]) / sub, ay = (st.T[2 * i + 1] - st.Tp[2 * i + 1]) / sub;
            const vx = ax + (st.x[2 * i] - st.xp[2 * i] - ax) * keep, vy = ay + (st.x[2 * i + 1] - st.xp[2 * i + 1] - ay) * keep;
            st.xp[2 * i] = st.x[2 * i]; st.xp[2 * i + 1] = st.x[2 * i + 1];
            st.x[2 * i] += vx; st.x[2 * i + 1] += vy + ph.gravity * t * h * h;
          }
          for (let i = 1; i < n; i++) {
            const t = st.t[i];
            // where this point would be if the segment kept the direction the rig gives it
            const rx = st.T[2 * i] - st.T[2 * i - 2], ry = st.T[2 * i + 1] - st.T[2 * i - 1];
            let tx = st.x[2 * i - 2] + rx, ty = st.x[2 * i - 1] + ry;
            // a breeze: the rest direction itself wanders a little, more toward the tip, never in step strand to strand
            if (wind) tx += wind * st.seg * t * (0.64 * Math.sin(clk * 0.8 + st.phase) + 0.36 * Math.sin(clk * 1.9 + 2.3 * st.phase));
            // the creator's hair setting: under 1 stiffer and shorter swings, over 1 looser and longer
            const soft = Math.max(0.2, this.tune.hair), k = 1 - Math.pow(1 - Math.min(0.95, (ph.k0 * (1 - t) + ph.k1 * t) / soft), h * 60);
            st.x[2 * i] += (tx - st.x[2 * i]) * k; st.x[2 * i + 1] += (ty - st.x[2 * i + 1]) * k;
            // the segment keeps its length
            const dx = st.x[2 * i] - st.x[2 * i - 2], dy = st.x[2 * i + 1] - st.x[2 * i - 1];
            const d = Math.hypot(dx, dy) || 1, L = st.len[i];
            st.x[2 * i] = st.x[2 * i - 2] + dx * L / d; st.x[2 * i + 1] = st.x[2 * i - 1] + dy * L / d;
          }
        }
        for (let i = 0; i < n; i++) {
          let ox = st.x[2 * i] - st.T[2 * i], oy = st.x[2 * i + 1] - st.T[2 * i + 1];
          const lim = st.seg * ph.limit * Math.max(1, i) * this.tune.hair;
          const m = Math.hypot(ox, oy);
          if (m > lim) { ox *= lim / m; oy *= lim / m; }
          st.o[2 * i] = ox; st.o[2 * i + 1] = oy;
        }
      }
    }
  }
  // soft regions: lag behind the body's acceleration, overshoot, settle; a touch kicks them
  _springs(dt) {
    dt = clamp(dt, 0.004, 0.05);
    this.clock = (this.clock || 0) + dt;
    for (const sp of this.springs) {
      if (!sp.anchor) continue;
      const [p, i] = sp.anchor;
      sp.Tpp[0] = sp.Tp[0]; sp.Tpp[1] = sp.Tp[1]; sp.Tp[0] = sp.T[0]; sp.Tp[1] = sp.T[1];
      sp.T[0] = p.out[2 * i]; sp.T[1] = p.out[2 * i + 1];
      if (!sp.started) { sp.Tp = sp.T.slice(); sp.Tpp = sp.T.slice(); sp.started = true; continue; }
      const sub = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / sub;
      const ax = (sp.T[0] - 2 * sp.Tp[0] + sp.Tpp[0]) / (dt * dt), ay = (sp.T[1] - 2 * sp.Tp[1] + sp.Tpp[1]) / (dt * dt);
      // natural frequency from stiffness (per 60 fps step), damping as velocity kept per step
      const w0 = 60 * Math.sqrt(sp.stiff), keep = Math.pow(sp.damp, h * 60);
      for (let s = 0; s < sub; s++) for (let a = 0; a < 2; a++) {
        const acc = -w0 * w0 * sp.o[a] - (a ? ay : ax) * 1.6;
        sp.v[a] = (sp.v[a] + acc * h) * keep;
        sp.o[a] += sp.v[a] * h;
      }
      const lim = 0.35 * Math.min(sp.r[0], sp.r[1]), m = Math.hypot(sp.o[0], sp.o[1]);
      if (m > lim) { sp.o[0] *= lim / m; sp.o[1] *= lim / m; }
    }
  }
  _applySprings(p) {
    const W = p.sw, O = p.out, t = this.clock || 0;
    for (const sp of this.springs) {
      // a beating wing: its angle around the hinge this frame (a quick down-stroke, a slower up-stroke)
      if (!sp.flap || !sp.anchor) { sp.rot = 0; continue; }
      const ph = (t * sp.flap.hz) % 1, beat = ph < 0.4 ? Math.sin(Math.PI * ph / 0.4) : -0.35 * Math.sin(Math.PI * (ph - 0.4) / 0.6);
      sp.rot = beat * sp.flap.deg * Math.PI / 180 * (sp.hinge && sp.c[0] < sp.hinge[0] ? -1 : 1);
      // where the hinge is now (carried by the body, like the anchor)
      const [ap, ai] = sp.anchor;
      sp.hx = sp.hinge[0] + (ap.out[2 * ai] - ap.rest[2 * ai]); sp.hy = sp.hinge[1] + (ap.out[2 * ai + 1] - ap.rest[2 * ai + 1]);
    }
    for (let j = 0; j < W.length; j += 3) {
      const sp = this.springs[W[j + 1]]; if (!sp) continue;
      const i = W[j], w = W[j + 2];
      let x = O[2 * i] + w * sp.o[0], y = O[2 * i + 1] + w * sp.o[1];
      if (sp.rot) {
        // fades out at the region's rim (where the weight fades) so the wing doesn't tear from what's around it
        const a = sp.rot * Math.min(1, w * 3), dx = x - sp.hx, dy = y - sp.hy;
        x = sp.hx + dx * Math.cos(a) - dy * Math.sin(a); y = sp.hy + dx * Math.sin(a) + dy * Math.cos(a);
      }
      O[2 * i] = x; O[2 * i + 1] = y;
    }
  }
  // a touch at a point of the rest picture: the soft region under it springs (velocity in px/s)
  poke(x, y, vx = 0, vy = 900) {
    let hit = false;
    for (const sp of this.springs) {
      const d = ((x - sp.c[0]) / sp.r[0]) ** 2 + ((y - sp.c[1]) / sp.r[1]) ** 2;
      if (d < 1.4) { sp.v[0] += vx * (1 - d / 1.4); sp.v[1] += vy * (1 - d / 1.4); hit = true; }
    }
    return hit;
  }

  _applyPhys(p) {
    const W = p.phys.w, S = p.phys.strands, O = p.out;
    for (let i = 0; i < p.n; i++) {
      const ws = W[i]; if (!ws) continue;
      for (let j = 0; j < ws.length; j += 3) { const st = S[ws[j]], q = ws[j + 1], w = ws[j + 2]; O[2 * i] += w * st.o[2 * q]; O[2 * i + 1] += w * st.o[2 * q + 1]; }
    }
  }

  // ---- drawing --------------------------------------------------------------------------------------------
  fit(box, pad = 0) {
    const w = this.canvas.width, h = this.canvas.height;
    const s = Math.min((w - 2 * pad) / (box[2] - box[0]), (h - 2 * pad) / (box[3] - box[1]));
    this.view = { scale: s, x: w / 2 - (box[0] + box[2]) / 2 * s, y: h / 2 - (box[1] + box[3]) / 2 * s };
  }
  // Each layer's place when the character is pulled apart: its own depth (draw order, back to front; a part
  // clipped by another and the variants drawn over a layer travel with it), then the stack turned around its
  // middle with a little perspective. Per part an affine in picture space, m = [a, b, c, d, e, f].
  _explodeXf() {
    const ex = this.explode;
    if (!ex || !(ex.t > 0.001)) return null;
    this._layerIndex();
    const f = this.R.frame, t = ex.t;
    const cx = (f[0] + f[2]) / 2, cy = (f[1] + f[3]) / 2, wd = f[2] - f[0];
    const D = 1.15 * wd * t, F = 3.2 * wd;
    const yaw = ex.yaw ?? 0.62 * t, pit = ex.pitch ?? 0.16 * t;
    const cY = Math.cos(yaw), sY = Math.sin(yaw), cP = Math.cos(pit), sP = Math.sin(pit);
    const k = 1 - 0.3 * t, N = Math.max(1, this._layers - 1), out = {};
    for (const p of this.parts) {
      const d = (this._layerOf[p.id] / N - 0.5) * D;
      // perspective from the layer's middle
      const o = p.out; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let i = 0; i < o.length; i += 2) { const x = o[i], y = o[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const X = (x0 + x1) / 2 - cx, Y = (y0 + y1) / 2 - cy;
      const Z1 = -sY * X + cY * d, Z2 = sP * Y + cP * Z1;
      const s = k * F / (F - Z2);
      out[p.id] = { m: [s * cY, 0, s * sP * sY, s * cP, cx - s * cY * cx + s * sY * d, cy - s * sP * sY * cx - s * cP * cy - s * sP * cY * d], box: [x0, y0, x1, y1] };
    }
    return out;
  }
  _layerIndex() {
    if (this._layerOf) return;
    const L = {}; let n = -1, lastBase = 0;
    for (const p of this.parts) {
      if (p.clip && L[p.clip] != null) L[p.id] = L[p.clip];
      else if (/^v_/.test(p.id)) L[p.id] = lastBase;
      else { L[p.id] = ++n; lastBase = n; }
    }
    this._layerOf = L; this._layers = n + 1;
  }
  _xf(prog, xf) {
    const gl = this.gl, m = xf ? xf.m : null;
    if (m) { gl.uniform4f(prog.u.uXf, m[0], m[1], m[2], m[3]); gl.uniform2f(prog.u.uXo, m[4], m[5]); }
    else { gl.uniform4f(prog.u.uXf, 1, 0, 0, 1); gl.uniform2f(prog.u.uXo, 0, 0); }
  }
  // what the character is drawn from: its parts (every drawing, the expressions and mouth shapes included) and how
  // many separate depths they sit at
  layerCount() {
    if (!this.parts || !this.parts.length) return { parts: 0, layers: 0 };
    this._layerIndex();
    return { parts: this.parts.length, layers: this._layers };
  }
  draw() {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height, v = this.view;
    const sx = 2 * v.scale / W, sy = -2 * v.scale / H, ox = 2 * v.x / W - 1, oy = 1 - 2 * v.y / H;
    const XF = this._explodeXf();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const p of this.parts) if (p.opacity > 0.001 || this.maskOf[p.id]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, p.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.out);
    }
    // masks first
    if (this.maskBufs.length) {
      const pm = this.progMask;
      gl.useProgram(pm.p);
      gl.uniform2f(pm.u.uScale, sx, sy); gl.uniform2f(pm.u.uOff, ox, oy);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.maskBufs.forEach((m, bi) => {
        this._sizeFbo(m, W, H);
        gl.bindFramebuffer(gl.FRAMEBUFFER, m.f);
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        for (const [id, mk] of Object.entries(this.maskOf)) {
          if (mk.buf !== bi) continue;
          const p = this.byId[id];
          const ch = [0, 0, 0, 0]; ch[mk.ch] = 1;
          gl.uniform4fv(pm.u.uMaskCh, ch); gl.uniform1f(pm.u.uAlpha, 1); this._xf(pm, XF && XF[id]);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[p.tex]); gl.uniform1i(pm.u.uTex, 0);
          gl.bindVertexArray(p.vao); gl.drawElements(gl.TRIANGLES, p.count, p.idxType, 0);
        }
      });
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const pr = this.prog;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u.uScale, sx, sy); gl.uniform2f(pr.u.uOff, ox, oy);
    gl.uniform1i(pr.u.uTex, 0); gl.uniform1i(pr.u.uMask, 1);
    // the picture's bottom edge: hands drawn on below it show only once an arm lifts them above it
    const floor = !XF && this.R && this.R.floor;
    if (floor) {
      const yf = Math.max(0, Math.min(H, Math.round(floor * v.scale + v.y)));
      gl.enable(gl.SCISSOR_TEST); gl.scissor(0, H - yf, W, yf);
    }
    for (const p of this.parts) {
      if (p.opacity <= 0.001 || p.hidden) continue;
      gl.uniform1f(pr.u.uAlpha, p.opacity);
      const t = p.tint || [1, 1, 1];
      gl.uniform3f(pr.u.uTint, t[0], t[1], t[2]);
      if (XF) this._xf(pr, XF[p.id]);
      if (p.clip && this.maskOf[p.clip]) {
        const mk = this.maskOf[p.clip], ch = [0, 0, 0, 0]; ch[mk.ch] = 1;
        gl.uniform1f(pr.u.uUseMask, 1); gl.uniform4fv(pr.u.uMaskCh, ch);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.maskBufs[mk.buf].t);
      } else gl.uniform1f(pr.u.uUseMask, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[p.tex]);
      gl.bindVertexArray(p.vao); gl.drawElements(gl.TRIANGLES, p.count, p.idxType, 0);
    }
    if (floor) gl.disable(gl.SCISSOR_TEST);
    if (XF) { this._xf(pr, null); this._drawFrames(XF, sx, sy, ox, oy); }
    gl.bindVertexArray(null);
  }

  // a thin frame round each layer while apart (one per depth, round everything drawn at it), so the stack reads
  _drawFrames(XF, sx, sy, ox, oy) {
    const gl = this.gl, pl = this.progLine, t = this.explode.t;
    if (!this._lineBuf) {
      this._lineBuf = gl.createBuffer(); this._lineVao = gl.createVertexArray();
      gl.bindVertexArray(this._lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, this._lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, 8 * 4, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }
    const byLayer = new Map();
    for (const p of this.parts) {
      if (p.hidden || !(p.opacity > 0.001)) continue;
      const L = this._layerOf[p.id], b = XF[p.id].box, cur = byLayer.get(L);
      if (!cur) byLayer.set(L, { m: XF[p.id].m, b: b.slice() });
      else { cur.b[0] = Math.min(cur.b[0], b[0]); cur.b[1] = Math.min(cur.b[1], b[1]); cur.b[2] = Math.max(cur.b[2], b[2]); cur.b[3] = Math.max(cur.b[3], b[3]); }
    }
    gl.useProgram(pl.p);
    gl.uniform2f(pl.u.uScale, sx, sy); gl.uniform2f(pl.u.uOff, ox, oy);
    const a = 0.32 * t;
    gl.uniform4f(pl.u.uCol, a, a, a, a);
    gl.bindVertexArray(this._lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, this._lineBuf);
    const q = new Float32Array(8);
    for (const { m, b } of byLayer.values()) {
      const pad = 0.02 * (b[2] - b[0] + b[3] - b[1]);
      q.set([b[0] - pad, b[1] - pad, b[2] + pad, b[1] - pad, b[2] + pad, b[3] + pad, b[0] - pad, b[3] + pad]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, q);
      gl.uniform4f(pl.u.uXf, m[0], m[1], m[2], m[3]); gl.uniform2f(pl.u.uXo, m[4], m[5]);
      gl.drawArrays(gl.LINE_LOOP, 0, 4);
    }
    this._xf(pl, null);
  }

  // free the GPU side before loading another character on the same canvas
  dispose() {
    const gl = this.gl;
    for (const t of this.tex || []) gl.deleteTexture(t);
    for (const p of this.parts || []) { gl.deleteBuffer(p.vbo); gl.deleteVertexArray(p.vao); }
    for (const m of this.maskBufs || []) { gl.deleteTexture(m.t); gl.deleteFramebuffer(m.f); }
    if (this._lineBuf) { gl.deleteBuffer(this._lineBuf); gl.deleteVertexArray(this._lineVao); this._lineBuf = null; }
    this.parts = []; this.tex = []; this._layerOf = null;
  }

  // where a point of the rest picture is now (for touch areas, blush, a speech bubble)
  meshDump() {
    return { scale: this.view.scale, offset: [this.view.x, this.view.y], parts: this.parts.map((p) => ({ id: p.id, rest: chunk(p.rest), posed: chunk(p.out), t: Array.from(p.t) })) };
  }
}
function pt_base(p) { return p.baseOpacity ?? 1; }
function chunk(a) { const o = []; for (let i = 0; i < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; }

export { Rig };
