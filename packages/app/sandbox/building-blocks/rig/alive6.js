// The rig runtime, as built in the rig lab (yumina-workspaces/rig-lab/transfer/v6/web, made a module by its
// card/build_kit.py). Change it there and copy it over, so the lab's tests keep covering what cards run.
// alive6.js: what makes a rig6 character alive, on any canvas (the demo page and a card share this file).
//
//   const alive = new Alive(rig, canvas, { onTouch: (part, x, y) => … });
//   each frame: alive.frame(now, dt)  (poses and draws the rig)
//   alive.cue("happy") · alive.talk(seconds) · alive.setMood("happy" | "calm" | "low") · alive.dispose()
//   alive.hold("mouth", level) — the mouth follows a level you feed it (0..1), e.g. from speech you play
//   alive.listen(audioElement | MediaStream) — lip sync to that sound; returns a function that stops it
//   alive.record(seconds) — a transparent WebM of the canvas (Chromium keeps the alpha); resolves { blob, type }
//   alive.drive({ ParamAngleX, …, mouthOpen, mouthShape } | null) — a face tracker (track6.js) takes over the head,
//   eyes, brows and mouth; the idle sway, pointer gaze and automatic blinks step aside while it does
//   alive.perform(MOTION6 | null) — idle, talking and moods played from real people's performances (motion6.js:
//   head, eyelids, gaze, brows, mouth corners, read from free stock videos) instead of the formula sway and blinks
//
// Idle sway at Cubism's breath periods, breathing, blinks (0.1 s down, 0.05 shut, 0.15 up, sometimes twice), eye
// saccades, the gaze following the pointer (eyes fast, head slow), cues as additive curves, talking in syllables,
// touch: patting the head, poking the cheek, touching the body (and its soft regions spring).
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const env = (t, d, a = 0.25, r = 0.4) => Math.min(ease(t / a), ease((d - t) / r));

// arm joints: [parameter, frequency going out (Hz), coming back, damping ratio]; a gesture leads with the hand (the
// forearm is quicker going out, the upper arm follows and settles with a little sway); coming back the elbow drops
// first and the forearm unfolds last
const ARM_SPRINGS = [["ParamArmRA", 1.7, 3.0, 0.6], ["ParamArmLA", 1.7, 3.0, 0.6], ["ParamArmRB", 4.5, 1.9, 0.55], ["ParamArmLB", 4.5, 1.9, 0.55]];
const MOODS = {
  happy: { speed: 1.25, amp: 1.3, smile: 0.55, brow: 0.25, wind: 0.8, cat: "happy" },
  annoyed: { speed: 1, amp: 0.9, smile: -0.45, brow: -0.35, wind: 0.5, cat: "annoyed" },
  calm: { speed: 1, amp: 1, smile: 0.15, brow: 0, wind: 0.6 },
  low: { speed: 0.75, amp: 0.6, smile: -0.4, brow: -0.5, pitch: -6, wind: 0.4 },
  // drowsy: slow and small, lids half down, slow long blinks, now and then nodding off and catching herself
  sleepy: { speed: 0.55, amp: 0.45, smile: 0.05, brow: -0.15, pitch: -8, eye: 0.5, breath: 5.4, blinkSlow: 2.6, doze: true, wind: 0.35 },
};
// a performance library (motion6.js): clips of real faces as parameter curves; a random 6-10 s stretch of a clip of the
// current kind (talking, else the mood's), crossfaded over a second; the body follows the head late
class Performer {
  constructor(lib) {
    const bin = atob(lib.data), q = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) q[i] = bin.charCodeAt(i) << 24 >> 24;
    this.q = q; this.nc = lib.ch.length; this.sc = lib.sc; this.fps = lib.fps; this.cats = lib.cats;
    this.ix = Object.fromEntries(lib.ch.map((k, i) => [k, i]));
    this.cur = null; this.prev = null; this.bx = 0; this.bz = 0;
  }
  pick(cat, now, len) {
    const L = this.cats[cat] || this.cats.calm, [off, n] = L[Math.floor(Math.random() * L.length)];
    const k = Math.min(n, Math.round(this.fps * (len || 6 + Math.random() * 4)));
    return { cat, a: off + Math.floor(Math.random() * Math.max(1, n - k)), k, t0: now };
  }
  sample(c, now) {
    const f = Math.min(c.k - 1, Math.max(0, (now - c.t0) * this.fps)), i0 = Math.floor(f), w = f - i0, i1 = Math.min(c.k - 1, i0 + 1);
    const o = {}, b0 = (c.a + i0) * this.nc, b1 = (c.a + i1) * this.nc;
    for (const k in this.ix) { const j = this.ix[k]; o[k] = (this.q[b0 + j] * (1 - w) + this.q[b1 + j] * w) * this.sc[j]; }
    return o;
  }
  frame(cat, now, dt) {
    const c = this.cur;
    if (!c || now - c.t0 > c.k / this.fps || (c.cat !== cat && now - c.t0 > 0.6)) { this.prev = c; this.cur = this.pick(cat, now); }
    const a = this.sample(this.cur, now), w = this.prev ? Math.min(1, (now - this.cur.t0) / (this.prev.cat === cat ? 1 : 0.6)) : 1;
    if (this.prev && w < 1) {
      const b = this.sample(this.prev, now);
      for (const k in a) if (k !== "EL" && k !== "ER") a[k] = b[k] * (1 - w) + a[k] * w;
      a.EL = Math.min(a.EL, b.EL); a.ER = Math.min(a.ER, b.ER);   // blinks never blend away
    }
    const r = Math.min(1, dt / 0.45);
    this.bx += (a.AX * 0.3 - this.bx) * r; this.bz += (a.AZ * 0.3 - this.bz) * r;
    a.BX = this.bx; a.BZ = this.bz;
    return a;
  }
}
const SWAY = [["ParamAngleX", 15, 6.5345], ["ParamAngleY", 8, 3.5345], ["ParamAngleZ", 10, 5.5345], ["ParamBodyAngleX", 4, 15.5345]];

// every cue: duration and the parameter offsets over time (s = the side a poke came from)
const CUES = {
  nod: { d: 1.3, f: (t) => ({ ParamAngleY: -12 * Math.sin(Math.PI * clamp(t / 0.45, 0, 1)) - 7 * Math.sin(Math.PI * clamp((t - 0.5) / 0.4, 0, 1)), ParamEyeLSmile: 0.3 * env(t, 1.3), ParamEyeRSmile: 0.3 * env(t, 1.3) }) },
  tilt: { d: 2.4, f: (t) => { const e = env(t, 2.4, 0.35, 0.5); return { ParamAngleZ: 18 * e, ParamAngleX: 6 * e, ParamBrowLY: 0.3 * e, ParamBrowRY: 0.3 * e, ParamMouthForm: 0.3 * e }; } },
  shake: { d: 1.4, f: (t) => ({ ParamAngleX: 16 * Math.sin(2 * Math.PI * t / 0.5) * env(t, 1.4, 0.2, 0.3), ParamBrowLAngle: -0.4 * env(t, 1.4), ParamBrowRAngle: -0.4 * env(t, 1.4) }) },
  shy: { d: 3, f: (t) => { const e = env(t, 3, 0.35, 0.6); return { ParamArmRB: 55 * e, ParamArmLB: 55 * e, ParamAngleY: -14 * e, ParamAngleX: 12 * e, ParamEyeBallX: -0.7 * e, ParamEyeBallY: -0.6 * e, ParamEyeLOpen: 1 - 0.3 * e, ParamEyeROpen: 1 - 0.3 * e, ParamBrowLY: 0.3 * e, ParamBrowRY: 0.3 * e, blush: e }; } },
  // happy, the light way: a squint, a bob and a tilt, brows up, a blush, the mouth left as drawn. Nothing AI-drawn
  // shows, so it holds on every picture; "laugh" below is the big one (drawn smiling eyes and an open smile, arms)
  happy: { d: 2.4, f: (t) => { const e = env(t, 2.4, 0.2, 0.5); const sw = Math.sin(2 * Math.PI * t / 1.1); return { ParamEyeLOpen: 1 - 0.2 * e, ParamEyeROpen: 1 - 0.2 * e, ParamEyeLSmile: 0.4 * e, ParamEyeRSmile: 0.4 * e, ParamAngleZ: 6 * sw * e, ParamAngleY: 5 * e + 2 * Math.abs(sw) * e, ParamBodyAngleY: 1.5 * Math.abs(sw) * e, ParamMouthForm: e, ParamBrowLY: 0.45 * e, ParamBrowRY: 0.45 * e, blush: 0.55 * e }; } },
  laugh: { d: 2.4, f: (t) => { const e = env(t, 2.4, 0.2, 0.5); const bob = Math.abs(Math.sin(2 * Math.PI * t / 1.1)); return { ParamArmRA: 6 * e * bob, ParamArmLA: 6 * e * bob, ParamArmRB: 18 * e, ParamArmLB: 18 * e, ParamEyeLSmile: e, ParamEyeRSmile: e, ParamEyeLOpen: 1 - 0.85 * e, ParamEyeROpen: 1 - 0.85 * e, ParamAngleZ: 6 * Math.sin(2 * Math.PI * t / 1.1) * e, ParamAngleY: 6 * e, ParamMouthForm: e, ParamBrowLY: 0.4 * e, ParamBrowRY: 0.4 * e, blush: 0.5 * e, mouthOpen: 0.75 * e, mouthShape: 3 }; } },
  surprised: { d: 1.8, f: (t) => { const e = env(t, 1.8, 0.08, 0.5); return { ParamArmRA: 10 * e, ParamArmLA: 10 * e, ParamArmRB: 25 * e, ParamArmLB: 25 * e, ParamEyeLOpen: 1 + 0.3 * e, ParamEyeROpen: 1 + 0.3 * e, ParamBrowLY: e, ParamBrowRY: e, ParamAngleY: 8 * e, ParamBodyAngleY: -5 * e, mouthOpen: 0.55 * e, mouthShape: 2, surprised: e }; } },
  angry: { d: 2.2, f: (t) => { const e = env(t, 2.2, 0.15, 0.5); return { ParamBrowLAngle: -e, ParamBrowRAngle: -e, ParamBrowLY: -0.9 * e, ParamBrowRY: -0.9 * e, ParamEyeLOpen: 1 - 0.32 * e, ParamEyeROpen: 1 - 0.32 * e, ParamMouthForm: -1 * e, ParamAngleY: -7 * e, ParamAngleZ: -8 * e, ParamBodyAngleX: -3 * e, blush: 0.25 * e, ParamAngleX: 7 * Math.sin(2 * Math.PI * t / 0.35) * clamp(1 - t / 0.9, 0, 1), angry: e }; } },
  // sad: the drawn sad eyes (teary), the head down and aside, the mouth turned down, a slow breath
  sad: { d: 3.6, f: (t) => { const e = env(t, 3.6, 0.45, 0.7); return { sad: e, ParamAngleY: -10 * e, ParamAngleZ: 5 * e, ParamAngleX: -4 * e, ParamMouthForm: -0.7 * e, ParamBrowLAngle: 0.6 * e, ParamBrowRAngle: 0.6 * e, ParamEyeBallY: -0.4 * e, ParamBodyAngleY: -2 * e, ParamBreath: 0.8 * Math.sin(Math.PI * clamp(t / 2, 0, 1)) }; } },
  sigh: { d: 3, f: (t) => { const e = env(t, 3, 0.5, 0.6); return { ParamAngleY: -14 * e, ParamAngleZ: 4 * e, ParamEyeLOpen: 1 - 0.55 * e, ParamEyeROpen: 1 - 0.55 * e, ParamBrowLAngle: 0.7 * e, ParamBrowRAngle: 0.7 * e, ParamBrowLY: -0.2 * e, ParamBrowRY: -0.2 * e, ParamMouthForm: -0.5 * e, ParamBreath: 1.5 * Math.sin(Math.PI * clamp(t / 1.6, 0, 1)), ParamEyeBallY: -0.5 * e, ParamBodyAngleY: -3 * e }; } },
  poke: { d: 1.4, f: (t, s) => { const e = env(t, 1.4, 0.08, 0.5); return { ParamAngleX: s * 16 * e, ParamAngleZ: -s * 8 * e, ParamEyeBallX: -s * 0.7 * e, ParamEyeLOpen: 1 - 0.6 * e, ParamEyeROpen: 1 - 0.6 * e, ParamBrowLAngle: -0.5 * e, ParamBrowRAngle: -0.5 * e, ParamMouthForm: -0.5 * e, blush: 0.5 * e }; } },
  // nodding off: the lids sink, the head drops, then she catches herself (eyes wide, head up) and settles
  sleepy: { d: 3.4, f: (t) => {
    const sink = ease(t / 1.8), jerk = t > 1.9 ? Math.exp(-(t - 1.9) * 4) : 0, back = env(t, 3.4, 0.2, 0.8);
    return { ParamEyeLOpen: Math.max(0.02, 1 - sink) + 0.35 * jerk, ParamEyeROpen: Math.max(0.02, 1 - sink) + 0.35 * jerk,
             ParamAngleY: (t < 1.9 ? -16 * sink : -16 * Math.exp(-(t - 1.9) * 5)) * back, ParamAngleZ: 5 * sink * (t < 1.9 ? 1 : Math.exp(-(t - 1.9) * 3)),
             ParamBrowLY: 0.6 * jerk, ParamBrowRY: 0.6 * jerk }; } },
  lookdown: { d: 2.6, f: (t) => { const e = env(t, 2.6, 0.4, 0.6); return { ParamAngleY: -18 * e, ParamEyeBallY: -0.8 * e, ParamEyeLOpen: 1 - 0.35 * e, ParamEyeROpen: 1 - 0.35 * e, ParamBodyAngleY: -2 * e }; } },
  // heart eyes light up, a blush, eyes a touch wider
  heart: { d: 3.2, f: (t) => { const e = env(t, 3.2, 0.35, 0.8); return { heart: e, blush: 0.7 * e, ParamEyeLOpen: 1 + 0.08 * e, ParamEyeROpen: 1 + 0.08 * e, ParamBrowLY: 0.3 * e, ParamBrowRY: 0.3 * e }; } },
  // a wink: one eye shut in a smile, the head tipped toward it, a little blush
  wink: { d: 1.6, f: (t) => { const e = env(t, 1.6, 0.12, 0.35); return { ParamEyeLSmile: e, ParamEyeLOpen: 1 - 0.97 * e, ParamEyeRSmile: 0.25 * e, ParamMouthForm: 0.8 * e, ParamAngleZ: 7 * e, ParamAngleX: -3 * e, blush: 0.3 * e }; } },
  // a doubtful look: lids half down, eyes to the side, brows flat, the mouth a little sour
  doubt: { d: 2.6, f: (t) => { const e = env(t, 2.6, 0.25, 0.5); return { ParamEyeLOpen: 1 - 0.42 * e, ParamEyeROpen: 1 - 0.42 * e, ParamEyeBallX: 0.55 * e, ParamEyeBallY: -0.1 * e, ParamBrowLY: -0.25 * e, ParamBrowRY: -0.25 * e, ParamBrowLAngle: -0.2 * e, ParamBrowRAngle: -0.2 * e, ParamMouthForm: -0.45 * e, ParamAngleZ: -4 * e, ParamAngleX: -5 * e }; } },
  // a wave with the right hand (the character's right): the upper arm out, the forearm up, the hand rocking
  wave: { d: 2.6, f: (t) => { const e = env(t, 2.6, 0.45, 0.6); const rock = Math.sin(2 * Math.PI * t / 0.42) * clamp((t - 0.35) / 0.3, 0, 1);
    return { ParamArmRA: 42 * e, ParamArmRB: -(128 + 16 * rock) * e, ParamHandROpen: e, ParamHandRAngle: 14 * rock * e, ParamAngleZ: -5 * e, ParamAngleX: -4 * e, ParamEyeLSmile: 0.6 * e, ParamEyeRSmile: 0.6 * e, ParamMouthForm: 0.7 * e, mouthOpen: 0.4 * e, mouthShape: 3 }; } },
  // a shrug: both forearms out a little, shoulders' arms lifted, head tilted
  shrug: { d: 1.8, f: (t) => { const e = env(t, 1.8, 0.3, 0.5); return { ParamArmRA: 10 * e, ParamArmRB: 34 * e, ParamArmLA: 10 * e, ParamArmLB: 34 * e, ParamAngleZ: 7 * e, ParamBrowLY: 0.5 * e, ParamBrowRY: 0.5 * e, ParamMouthForm: -0.2 * e }; } },
  // hands together in front, a little shy or waiting
  clasp: { d: 3.2, f: (t) => { const e = env(t, 3.2, 0.5, 0.6); return { ParamArmRA: 2 * e, ParamArmLA: 2 * e, ParamArmRB: 70 * e, ParamArmLB: 70 * e, ParamAngleY: -4 * e, ParamMouthForm: 0.3 * e }; } },
  // a hand on the chest
  chest: { d: 2.8, f: (t) => { const e = env(t, 2.8, 0.45, 0.6); return { ParamArmRA: -6 * e, ParamArmRB: 108 * e, ParamAngleY: -3 * e, ParamEyeLOpen: 1 - 0.25 * e, ParamEyeROpen: 1 - 0.25 * e, ParamMouthForm: 0.4 * e }; } },
  // arms open, welcoming
  welcome: { d: 2.6, f: (t) => { const e = env(t, 2.6, 0.45, 0.6); return { ParamArmRA: 30 * e, ParamArmLA: 30 * e, ParamArmRB: -12 * e, ParamArmLB: -12 * e, ParamHandROpen: e, ParamHandLOpen: e, ParamHandRAngle: -10 * e, ParamHandLAngle: -10 * e, ParamAngleY: 5 * e, ParamEyeLSmile: 0.7 * e, ParamEyeRSmile: 0.7 * e, ParamMouthForm: 0.9 * e, mouthOpen: 0.5 * e, mouthShape: 3 }; } },
  recoil: { d: 1.6, f: (t) => { const e = env(t, 1.6, 0.08, 0.5); return { ParamBodyAngleY: -8 * e, ParamAngleY: 8 * e, ParamEyeLOpen: 1 + 0.25 * e, ParamEyeROpen: 1 + 0.25 * e, ParamBrowLY: 0.8 * e, ParamBrowRY: 0.8 * e, blush: 0.8 * e }; } },
};

// the moves by the names the generation page shows them under, in every language it speaks ("Look down", "低头"),
// so a card can call one either way; matched without case, spaces or punctuation
const LABELS = { "armsopen": "welcome", "asentir": "nod", "bajarlamirada": "lookdown", "brazosabiertos": "welcome", "contenta": "happy", "doubtful": "doubt", "dudar": "doubt", "enamorada": "heart", "encogersedehombros": "shrug", "enfadada": "angry", "guiñar": "wink", "handonchest": "chest", "handstogether": "clasp", "ladearlacabeza": "tilt", "manoalpecho": "chest", "manosjuntas": "clasp", "negar": "shake", "reír": "laugh", "saludar": "wave", "shakehead": "shake", "smitten": "heart", "sorprendida": "surprised", "suspirar": "sigh", "tilthead": "tilt", "triste": "sad", "tímida": "shy", "うつむく": "lookdown", "うなずく": "nod", "うれしい": "happy", "ため息": "sigh", "ときめき": "heart", "ウインク": "wink", "両手を広げる": "welcome", "低头": "lookdown", "低頭": "lookdown", "双手交握": "clasp", "叹气": "sigh", "嘆氣": "sigh", "大笑": "laugh", "大笑い": "laugh", "害羞": "shy", "开心": "happy", "张开双手": "welcome", "張開雙手": "welcome", "心动": "heart", "心動": "heart", "怀疑": "doubt", "怒り": "angry", "悲しい": "sad", "惊讶": "surprised", "懷疑": "doubt", "手を振る": "wave", "手を組む": "clasp", "手放胸前": "chest", "挥手": "wave", "揮手": "wave", "搖頭": "shake", "摇头": "shake", "歪头": "tilt", "歪頭": "tilt", "点头": "nod", "照れる": "shy", "生气": "angry", "生氣": "angry", "疑う": "doubt", "眨单眼": "wink", "眨單眼": "wink", "耸肩": "shrug", "聳肩": "shrug", "肩をすくめる": "shrug", "胸に手を当てる": "chest", "開心": "happy", "难过": "sad", "雙手交握": "clasp", "難過": "sad", "首をかしげる": "tilt", "首を振る": "shake", "驚き": "surprised", "驚訝": "surprised", "點頭": "nod" };
const norm = (s) => String(s).toLowerCase().replace(/[\s_\-·.,，。!！?？'’]/g, "");
// moves that repeat to fill a longer cue (a held nod or shake would freeze the head mid-turn); the rest hold their
// strongest moment
const REPEAT = ["nod", "shake", "poke", "recoil", "wave", "sleepy"];
// what a face is made of, for the strength of expressions (the head and arms keep their size)
const FACE = /^(Param(Eye[LR](Open|Smile)|Brow|Mouth)|mouthOpen$|blush$|heart$|angry$|sad$|surprised$|x[1-4]$)/;
// the moment a move shows most (its envelope's peak), where a longer cue or a hold rests
const peakOf = (c) => {
  if (c._peak != null) return c._peak;
  let best = 0, at = c.d / 2;
  for (let i = 1; i < 48; i++) {
    const t = (c.d * i) / 48, o = c.f(t, 1);
    let m = 0;
    for (const [k, v] of Object.entries(o)) if (k !== "mouthShape") m += Math.abs(/Open$/.test(k) && k.startsWith("ParamEye") ? 1 - v : /^ParamAngle|^ParamBody|^ParamArm|^ParamHand/.test(k) ? v / 30 : v);
    if (m > best) { best = m; at = t; }
  }
  return (c._peak = at);
};

// what a creator can switch off for a character (the rest are reactions to touch and dozing, not theirs to pick),
// what is off until they switch it on, and what plays instead of one that is off (a card asking for it still gets
// a reaction). "laugh" off also keeps the drawn smiling eyes and open smile out of the wave, the welcome and a pat.
const CHOOSABLE = ["happy", "laugh", "surprised", "heart", "wink", "shy", "nod", "shake", "tilt", "doubt", "sigh", "lookdown", "angry", "sad", "wave", "welcome", "clasp", "chest", "shrug", "x1", "x2", "x3", "x4"];
const DEFAULT_OFF = ["laugh", "angry", "sad"];
const INSTEAD = { laugh: "happy", angry: "doubt", sad: "sigh", surprised: "recoil", heart: "happy", wink: "happy", shy: "happy", wave: "nod", welcome: "nod" };

class Alive {
  constructor(rig, canvas, opts = {}) {
    this.rig = rig; this.canvas = canvas; this.opts = opts;
    this.mood = MOODS.calm; this.moodId = "calm";
    this.blinkState = { next: 1.5, t: -1 }; this.noBlink = false;
    this.gaze = { x: 0, y: 0, hx: 0, hy: 0, tx: 0, ty: 0, last: -10, sx: 0, sy: 0, snext: 1 };
    this.cues = []; this.pat = { until: 0, dir: 0, t0: 0 }; this.talkState = { until: 0, t0: 0 };
    this.manual = {}; this.freeze = false; this.down = null; this.perf = null;
    // levels a card holds over time (heart eyes, blush, eyelids), eased toward the value it sets
    this.held = {}; this.heldNow = {};
    // moves a card holds (any face by name, at a strength), eased in and out like the levels above
    this.heldMoves = {}; this.heldMovesNow = {};
    this.bounce = -1;                       // when the iris last sprang back after a blink
    this.lip = { open: 0, shape: 0, was: 0 };  // lip sync from a level (held "mouth" or a listened sound)
    // the moves that need a drawing, and whether this character has it (a creator can leave them out when making it)
    const ids = (rig.parts || []).map((q) => String(q.id)), has = (re) => ids.some((i) => re.test(i));
    this.drawnMoves = { laugh: has(/^v_smileclosed/), heart: has(/^v_heart/), angry: has(/^v_expr_angry/), sad: has(/^v_expr_sad/), surprised: has(/^v_expr_surprised/) };
    this.setSettings(rig.R && rig.R.settings);
    const on = (el, ev, fn) => { el.addEventListener(ev, fn); (this._off = this._off || []).push(() => el.removeEventListener(ev, fn)); };
    if (opts.input !== false) {
      on(canvas, "pointermove", (e) => this._move(e));
      on(canvas, "pointerdown", (e) => this._down(e));
      on(window, "pointerup", () => { this.down = null; });
      on(window, "pointercancel", () => { this.down = null; });
    }
  }
  dispose() { this.unlisten(); for (const f of this._off || []) f(); }
  static get CUES() { return Object.keys(CUES); }
  static get CHOOSABLE() { return CHOOSABLE.slice(); }
  static get DEFAULT_OFF() { return DEFAULT_OFF.slice(); }
  // is this built-in move switched off for the character (settings.off, or the defaults when the creator never chose)
  isOff(id) {
    if (this.drawnMoves && this.drawnMoves[id] === false) return true;   // the character was made without its drawing
    const off = this.settings && Array.isArray(this.settings.off) ? this.settings.off : DEFAULT_OFF;
    return CHOOSABLE.includes(id) && off.includes(id);
  }
  // the creator's settings for this character (the pack carries them as R.settings): the feel of each kind of
  // motion as a factor (1 = as built, 0 = still, 2 = twice), the default mood, which drawing of each expression shows,
  // and the names of their own expressions (slots x1..x4)
  setSettings(s) {
    s = s && typeof s === "object" ? s : {};
    this.settings = s;
    const t = s.tuning || {}, f = (k) => (Number.isFinite(t[k]) ? clamp(t[k], 0, 2.5) : 1);
    this.tuning = { turn: f("turn"), nod: f("nod"), tilt: f("tilt"), body: f("body"), idle: f("idle"), gaze: f("gaze"),
      blink: Math.max(0.2, f("blink")), breath: f("breath"), wind: f("wind"), gesture: f("gesture"), mouth: f("mouth"), expr: f("expr") };
    if (this.rig.applySettings) this.rig.applySettings(s);
    if (s.mood && MOODS[s.mood] && !this._moodSet) { this.mood = MOODS[s.mood]; this.moodId = s.mood; }
  }
  // an expression by its name: a built-in one, or one of the creator's own by the name they gave it (or its slot)
  _slot(id) {
    if (["angry", "sad", "surprised", "x1", "x2", "x3", "x4"].includes(id)) return id;
    const k = norm(id), c = ((this.settings && this.settings.custom) || []).find((x) => x && (x.name === id || x.slot === id || norm(x.name) === k));
    return c && /^x[1-4]$/.test(c.slot) ? c.slot : null;
  }
  // any name a card might use for a move: its id, its label on the generation page in any language, any case or
  // spacing ("Look down", "lookDown", "低头"), or one of the creator's own expressions by name or slot
  _name(id) {
    if (typeof id !== "string") return id;
    if (CUES[id] || this._slot(id)) return CUES[id] ? id : this._slot(id);
    const k = norm(id);
    for (const c of Object.keys(CUES)) if (norm(c) === k) return c;
    return LABELS[k] || this._slot(id) || id;
  }
  // cue(name, { seconds, strength }): a move or expression played once. seconds keeps it showing that long (a face
  // rests at its strongest; a nod or a shake repeats), strength 0..1.5 scales it. A number as the second argument is
  // the side a poke came from.
  cue(id, opts) {
    const o = typeof opts === "number" ? { side: opts } : (opts || {});
    const side = o.side ?? 1, k = Number.isFinite(o.strength) ? clamp(o.strength, 0, 1.5) : 1;
    const secs = Number.isFinite(o.seconds) && o.seconds > 0 ? Math.min(o.seconds, 600) : 0;
    id = this._name(id);
    let c = CUES[id];
    if (c) {
      if (this.isOff(id)) { const alt = INSTEAD[id] || "nod"; if (alt === id || !CUES[alt] || this.isOff(alt)) return; id = alt; c = CUES[alt]; }
    } else {
      // one of the creator's own expressions (or a drawn one by slot): shown for a few seconds, fading in and out
      const sl = this._slot(id);
      if (!sl || this.isOff(sl)) return;
      c = this._exprCue(sl); id = sl;
    }
    this.cues.push({ c, id, t0: performance.now() / 1000, s: side, k, len: secs ? Math.max(secs, c.d) : c.d });
  }
  _exprCue(sl) { const m = this._exprCues || (this._exprCues = {}); return m[sl] || (m[sl] = { d: 3.2, f: (t) => ({ [sl]: env(t, 3.2, 0.3, 0.6) }) }); }
  // the time inside a move for a cue that runs longer than the move: up to its strongest moment, held there, then
  // the rest of it; a nod or a shake starts over instead
  _warp(r, t) {
    const d = r.c.d;
    if (!r.len || r.len <= d) return t;
    if (REPEAT.includes(r.id)) return t < r.len - d ? t % d : t - (r.len - d);
    const pk = peakOf(r.c), extra = r.len - d;
    return t < pk ? t : t < pk + extra ? pk : t - extra;
  }
  // automatic blinks on (the default) or off; while a face lowers or closes the lids she never blinks either way
  blinking(on = true) { this.noBlink = !on; }
  talk(seconds = 3) { const now = performance.now() / 1000; this.talkState = { t0: now, until: now + seconds }; }
  stopTalking() { this.talkState.until = 0; }
  perform(lib) { this.perf = lib && lib.data ? new Performer(lib) : null; }
  setMood(id) { if (MOODS[id]) { this.mood = MOODS[id]; this.moodId = id; this._moodSet = true; } }
  // hold a level until changed: "heart" (0..1, heart eyes), "blush" (0..1), "eyes" (lids: 1 open .. 0 shut),
  // "angry" / "sad" / "surprised" / the creator's own (0..1, the drawn expression; one shows at a time, the strongest),
  // or any move by name at a strength (hold("doubt", 0.6): the face at its strongest moment, scaled), null to let go
  hold(what, value) {
    what = this._name(what);
    const sl = this._slot(what);
    if (sl) what = sl;
    else if (CUES[what] && !["heart"].includes(what)) {
      if (value != null && this.isOff(what)) return;
      if (value == null) delete this.heldMoves[what]; else this.heldMoves[what] = clamp(value, 0, 1.5);
      return;
    }
    if (value != null && this.isOff(what)) return;            // a drawn expression the creator switched off stays off
    if (value == null) delete this.held[what]; else this.held[what] = value;
  }

  params(now, dt) {
    const rig = this.rig, P = {}, mood = this.mood, gaze = this.gaze, blink = this.blinkState, TN = this.tuning;
    for (const q of rig.R.params) P[q.id] = q.def;
    // what plays now: the cues (each at its strength; one longer than its move rests at its strongest moment) and the
    // moves a card holds, eased in and out
    this.cues = this.cues.filter((r) => now - r.t0 < (r.len || r.c.d));
    for (const id of Object.keys(this.heldMoves)) if (!(id in this.heldMovesNow)) this.heldMovesNow[id] = 0;
    for (const id of Object.keys(this.heldMovesNow)) {
      const want = this.heldMoves[id] ?? 0, cur = this.heldMovesNow[id], nx = cur + (want - cur) * (1 - Math.exp(-dt * 5));
      if (!(id in this.heldMoves) && nx < 0.002) delete this.heldMovesNow[id]; else this.heldMovesNow[id] = nx;
    }
    const plays = this.cues.map((r) => ({ o: r.c.f(this._warp(r, now - r.t0), r.s), k: r.k ?? 1 }));
    for (const [id, lv] of Object.entries(this.heldMovesNow)) if (CUES[id]) plays.push({ o: CUES[id].f(peakOf(CUES[id]), 1), k: lv });
    // the strength: the cue's own, times the creator's for every face (tuning "expr"); lids scale toward open
    for (const pl of plays) {
      const o = {};
      for (const [key, v] of Object.entries(pl.o)) {
        if (key === "mouthShape") { o[key] = v; continue; }
        const k = pl.k * (FACE.test(key) ? TN.expr : 1);
        o[key] = /^ParamEye[LR]Open$/.test(key) ? 1 - (1 - v) * k : v * k;
      }
      pl.o = o;
    }
    // a face that lowers or closes the lids (a sigh, a doubtful look, a smile, a pat on the head) holds blinks back:
    // a blink over half-shut eyes looks wrong. blinking(false) holds them back always.
    let quiet = this.noBlink || now < this.pat.until ? 1 : 0;
    for (const { o } of plays) {
      const push = Math.max(1 - Math.min(o.ParamEyeLOpen ?? 1, o.ParamEyeROpen ?? 1), 0.6 * Math.max(o.ParamEyeLSmile ?? 0, o.ParamEyeRSmile ?? 0), o.heart ?? 0);
      quiet = Math.max(quiet, clamp(push * 5, 0, 1));
    }
    quiet = Math.max(quiet, clamp((1 - (this.heldNow.eyes ?? 1)) * 5, 0, 1));
    const T = now * mood.speed;
    // a tracked face drives the base pose (it stops counting half a second after its last frame)
    const D = this.driven && now - this.driven.t < 0.5 ? this.driven.v : null;
    // a performance from the library: the head, lids, gaze, brows and mouth corners of a real face
    const talking = now < this.talkState.until || this.lip.open > 0.08 || (this.held.mouth ?? 0) > 0.05;
    if (talking) this._talkSeen = now;
    const PF = this.perf && !this.freeze && !D ? this.perf.frame(now - (this._talkSeen || -9) < 0.8 ? "talk" : mood.cat || "calm", now, dt) : null;
    if (PF) {
      const g = 0.7 * Math.max(0.5, mood.amp) * TN.idle;
      P.ParamAngleX += g * PF.AX; P.ParamAngleY += g * PF.AY; P.ParamAngleZ += g * PF.AZ;
      P.ParamBodyAngleX += g * PF.BX; P.ParamBodyAngleZ += g * PF.BZ;
    }
    if (!this.freeze && !D && !PF) for (const [id, amp, per] of SWAY) P[id] += amp * mood.amp * TN.idle * Math.sin(2 * Math.PI * T / per) * (id === "ParamAngleZ" ? 0.5 : 0.6);
    P.ParamAngleY += mood.pitch || 0;
    // the arms hang loose: a little out from the body, swinging slowly and a touch after the body's sway
    if (!this.freeze) {
      const sw = Math.sin(2 * Math.PI * (T - 0.6) / 15.5345) * mood.amp;
      P.ParamArmRA = 2.5 + 2.2 * sw + 0.8 * Math.sin(2 * Math.PI * T / 4.1); P.ParamArmLA = 2.5 - 2.2 * sw + 0.8 * Math.sin(2 * Math.PI * T / 4.7 + 1);
      P.ParamArmRB = 3 + 1.5 * Math.sin(2 * Math.PI * T / 5.3); P.ParamArmLB = 3 + 1.5 * Math.sin(2 * Math.PI * T / 6.1 + 2);
    }
    P.ParamBreath = 0.5 + 0.5 * TN.breath * Math.sin(2 * Math.PI * now / (mood.breath || (this.moodId === "low" ? 4.4 : 3.2345)));
    if (mood.eye) { P.ParamEyeLOpen *= mood.eye; P.ParamEyeROpen *= mood.eye; }
    // drowsy: every so often she nods off on her own
    if (mood.doze) {
      if (!this.nextDoze) this.nextDoze = now + 6 + Math.random() * 6;
      if (now > this.nextDoze) { this.cue("sleepy"); this.nextDoze = now + 9 + Math.random() * 9; }
    } else this.nextDoze = 0;
    P.ParamMouthForm = mood.smile;
    P.ParamBrowLY = P.ParamBrowRY = mood.brow;
    if (PF) {
      P.ParamMouthForm = clamp(P.ParamMouthForm + 0.8 * PF.MF, -1, 1);
      P.ParamBrowLY += 0.8 * PF.BL; P.ParamBrowRY += 0.8 * PF.BR;
      P.ParamEyeLSmile = (P.ParamEyeLSmile || 0) + PF.SM; P.ParamEyeRSmile = (P.ParamEyeRSmile || 0) + PF.SM;
      P.ParamEyeLOpen *= PF.EL + (1 - PF.EL) * quiet; P.ParamEyeROpen *= PF.ER + (1 - PF.ER) * quiet;
    }
    // gaze: the pointer when it moved lately, else small saccades; eyes jump fast, the head follows slowly
    const active = now - gaze.last < 3;
    if (!active && now > gaze.snext) { gaze.sx = (Math.random() - 0.5) * 0.5; gaze.sy = (Math.random() - 0.5) * 0.3; gaze.snext = now + 0.6 + Math.random() * 2.2; }
    const gx = active ? gaze.tx : PF ? 0.8 * PF.GX : gaze.sx, gy = active ? gaze.ty : PF ? 0.8 * PF.GY : gaze.sy;
    gaze.x += (gx - gaze.x) * (1 - Math.exp(-dt * 28)); gaze.y += (gy - gaze.y) * (1 - Math.exp(-dt * 28));
    // the head follows the eyes slowly (a performance already moves its own head: then only the pointer pulls it)
    const hgx = PF && !active ? 0 : gx, hgy = PF && !active ? 0 : gy;
    gaze.hx += (hgx - gaze.hx) * (1 - Math.exp(-dt * 4)); gaze.hy += (hgy - gaze.hy) * (1 - Math.exp(-dt * 4));
    P.ParamEyeBallX = gaze.x; P.ParamEyeBallY = gaze.y;
    if (!D) {
      // a small turn toward the pointer: a head turned far shows the drawing's weakest angles (the back of the hair,
      // a face stretched thin), so the pointer moves it half as far as it used to
      P.ParamAngleX += 12 * TN.gaze * gaze.hx; P.ParamAngleY += 9 * TN.gaze * gaze.hy; P.ParamBodyAngleX += 2 * TN.gaze * gaze.hx;
      P.ParamAngleZ += -3 * gaze.hx * gaze.hy;
    } else {
      for (const [k, v] of Object.entries(D)) if (k in P && k !== "ParamEyeLOpen" && k !== "ParamEyeROpen") P[k] = v;
      P.ParamEyeLOpen *= D.ParamEyeLOpen ?? 1; P.ParamEyeROpen *= D.ParamEyeROpen ?? 1;
    }
    let blush = this.moodId === "happy" ? 0.15 : 0, mouthOpen = 0, mouthShape = 0, heart = 0;
    const EXPR = ["angry", "sad", "surprised", "x1", "x2", "x3", "x4"], expr = { angry: 0, sad: 0, surprised: 0, x1: 0, x2: 0, x3: 0, x4: 0 };
    for (const k of ["heart", "blush", "eyes", ...EXPR]) {
      const want = k in this.held ? this.held[k] : (k === "eyes" ? 1 : 0), cur = this.heldNow[k] ?? want;
      this.heldNow[k] = cur + (want - cur) * (1 - Math.exp(-dt * 5));
    }
    heart = this.heldNow.heart; blush = Math.max(blush, this.heldNow.blush);
    for (const k of EXPR) expr[k] = this.heldNow[k] * TN.expr;
    P.ParamEyeLOpen *= this.heldNow.eyes; P.ParamEyeROpen *= this.heldNow.eyes;
    // a one-arm move (a wave, a hand on the chest) made with the arm the character has, when only one moves (the
    // other is hidden, held still, or not an arm the split gave): mirrored, the head tilting the other way too
    const arms = (this.rig.R && this.rig.R.arms) || {}, onlyL = !arms.r && !!arms.l;
    const mirror = (o) => {
      if (!onlyL || Object.keys(o).some((k) => /^Param(Arm|Hand)L/.test(k))) return o;
      const m = {};
      for (const [k, v] of Object.entries(o)) {
        const k2 = k.replace(/^Param(Arm|Hand)R/, "Param$1L");
        m[k2] = k === "ParamAngleZ" || k === "ParamAngleX" || k === "ParamBodyAngleX" ? -v : v;
      }
      return m;
    };
    const noLaugh = this.isOff("laugh");   // the open smile and the drawn smiling eyes stay out
    for (const pl of plays) {
      const o = mirror(pl.o), smile = noLaugh && o.mouthShape === 3;   // an open smile held back: the mouth stays as drawn
      for (const [k, v] of Object.entries(o)) {
        if (k === "blush") blush = Math.max(blush, v);
        else if (k === "heart") heart = Math.max(heart, v);
        else if (k in expr) expr[k] = Math.max(expr[k], v);
        else if (k === "mouthOpen") mouthOpen = Math.max(mouthOpen, smile ? 0 : v);
        else if (k === "mouthShape") mouthShape = smile ? 0 : v;
        else if (k === "ParamEyeLOpen" || k === "ParamEyeROpen") P[k] *= v;   // eye targets multiply, the rest add
        // the creator's gesture size: how high the upper arm lifts and how much the wrist swings (the forearm's
        // bend stays: scaled, a wave would flatten into an arm held out)
        else if (/^Param(Arm[RL]A|Hand[RL]Angle)$/.test(k)) P[k] = (P[k] || 0) + v * TN.gesture;
        else P[k] = (P[k] || 0) + v;
      }
    }
    const pat = this.pat;
    if (now < pat.until) {
      const e = Math.min(1, (pat.until - now) / 0.4, (now - pat.t0) / 0.25);
      P.ParamAngleZ += pat.dir * 8 * e; P.ParamAngleY -= 6 * e;
      const shut = this.isOff("laugh") ? 0.2 : 0.9;     // without the laugh, a squint instead of the drawn smiling eyes
      P.ParamEyeLSmile += e; P.ParamEyeRSmile += e; P.ParamEyeLOpen *= 1 - shut * e; P.ParamEyeROpen *= 1 - shut * e;
      P.ParamMouthForm += 0.6 * e; blush = Math.max(blush, 0.8 * e);
    }
    // a drawn expression: the strongest one alone (two patches over each other would show both pairs of eyes); its
    // eyes are drawn, so no blink starts under it
    const top = EXPR.reduce((a, k) => (expr[k] > expr[a] ? k : a), EXPR[0]);
    for (const k of EXPR) P["ParamExpr" + k[0].toUpperCase() + k.slice(1)] = k === top ? Math.min(1, expr[k]) : 0;
    if ((expr[top] > 0.3 || quiet > 0.5) && blink.t < 0) blink.next = Math.max(blink.next, now + 0.6);
    if (D || PF) { blink.t = -1; blink.next = now + 1; }     // tracked or performed eyes blink for themselves
    if (blink.t < 0 && now > blink.next) blink.t = now;
    if (blink.t >= 0) {
      const k = mood.blinkSlow || 1, b = (now - blink.t) / k;
      const v0 = b < 0.1 ? 1 - b / 0.1 : b < 0.15 ? 0 : b < 0.3 ? (b - 0.15) / 0.15 : 1, v = v0 + (1 - v0) * quiet;
      P.ParamEyeLOpen *= v; P.ParamEyeROpen *= v;
      if (b >= 0.17 && this.bounce < blink.t) this.bounce = now;   // the eye opening again: the iris springs
      if (b >= 0.3) { blink.t = -1; blink.next = now + (Math.random() < 0.15 ? 0.25 : (1.5 + Math.random() * 5) / TN.blink) * k; }
    }
    P.ParamCheek = blush; P.ParamHeart = heart;
    // the brows come down a little as the lids close (any closing: blinks, smiles, dozing)
    P.ParamBrowLY -= 0.22 * (1 - clamp(P.ParamEyeLOpen, 0, 1)); P.ParamBrowRY -= 0.22 * (1 - clamp(P.ParamEyeROpen, 0, 1));
    // after a blink the iris overshoots: a quick squash and stretch that dies away in half a second
    let isx = 1, isy = 1;
    if (this.bounce >= 0) {
      const q = (now - this.bounce) / 0.5;
      if (q >= 1) this.bounce = -1;
      else { const d = Math.exp(-2.4 * q), w = Math.sin(q * Math.PI * 4); isx = 1 + 0.06 * w * d; isy = 1 - 0.07 * w * d; }
    }
    rig.fx.iris = [isx, isy];
    rig.fx.wind = this.freeze ? 0 : (mood.wind ?? 0.6) * TN.wind;
    // talking: syllables (open fast, close slower), a vowel per syllable chosen while the mouth is shut
    const tk = this.talkState;
    if (now < tk.until) {
      const t = now - tk.t0, syl = 0.21, k = (t % syl) / syl, n = Math.floor(t / syl);
      const amp = 0.45 + 0.55 * Math.abs(Math.sin(n * 2.399));
      const e = k < 0.35 ? k / 0.35 : 1 - (k - 0.35) / 0.65;
      const fade = Math.min(1, t / 0.15, (tk.until - now) / 0.2);
      mouthOpen = Math.max(mouthOpen, amp * e * fade);
      mouthShape = [0, 1, 0, 2, 0, 1, 2, 0][n % 8];
      if (!PF) { P.ParamAngleY += 2.5 * e * fade; P.ParamAngleX += 3 * Math.sin(t * 1.3) * fade; }
    }
    // lip sync: a level from outside (held "mouth", or a sound being listened to); each new syllable (the level
    // rising out of a near-closed mouth) picks a vowel, so the shape changes only while the mouth is nearly shut
    const lvl = Math.max(this.held.mouth ?? 0, this._listenLevel ? this._listenLevel() : 0);
    if (D && D.mouthOpen > mouthOpen) { mouthOpen = D.mouthOpen; mouthShape = D.mouthShape ?? 0; }
    const lp = this.lip;
    lp.open += (lvl - lp.open) * (1 - Math.exp(-dt * (lvl > lp.open ? 30 : 14)));
    if (lp.open > 0.18 && lp.was <= 0.18) lp.shape = [0, 1, 2, 0, 1][Math.floor(Math.random() * 5)];
    lp.was = lp.open;
    if (lp.open > mouthOpen) { mouthOpen = lp.open; mouthShape = lp.shape; }
    mouthOpen = Math.min(1, mouthOpen * TN.mouth);
    P.ParamMouthOpenY = mouthOpen; P.ParamMouthShape = mouthShape;
    rig.fx.jaw = mouthOpen * [1, 0.45, 0.85, 0.7][mouthShape | 0];
    // the arms follow their targets through springs (ARM_SPRINGS), so a gesture flows and settles instead of starting
    // and stopping all at once; raising an arm lifts that shoulder, the body leaning a little the other way
    if (!this.freeze) {
      const S = this.armS || (this.armS = {});
      const n = Math.max(1, Math.ceil(Math.min(dt, 0.1) / (1 / 240))), h = Math.min(dt, 0.1) / n;
      for (const [k, fo, fi, z] of ARM_SPRINGS) {
        const want = P[k] || 0, s = S[k] || (S[k] = { x: want, v: 0 }), w = 2 * Math.PI * (Math.abs(want) > Math.abs(s.x) ? fo : fi);
        for (let i = 0; i < n; i++) { s.v += h * (w * w * (want - s.x) - 2 * z * w * s.v); s.x += h * s.v; }
        P[k] = s.x;
      }
      const lift = (S.ParamArmRA ? S.ParamArmRA.x : 0) - (S.ParamArmLA ? S.ParamArmLA.x : 0);
      const reach = Math.abs(S.ParamArmRB ? S.ParamArmRB.v : 0) + Math.abs(S.ParamArmLB ? S.ParamArmLB.v : 0);
      P.ParamBodyAngleZ = (P.ParamBodyAngleZ || 0) - 0.06 * lift;
      P.ParamAngleZ = (P.ParamAngleZ || 0) + 0.035 * lift;
      P.ParamBodyAngleY = (P.ParamBodyAngleY || 0) + clamp(0.004 * reach, 0, 1.2);
      // a hand trails its forearm a little when it moves fast, then settles (the wrist is loose)
      P.ParamHandRAngle = (P.ParamHandRAngle || 0) - clamp(0.06 * (S.ParamArmRB ? S.ParamArmRB.v : 0), -14, 14);
      P.ParamHandLAngle = (P.ParamHandLAngle || 0) - clamp(0.06 * (S.ParamArmLB ? S.ParamArmLB.v : 0), -14, 14);
    }
    // the creator's ranges: how far the head turns, nods and tilts, how much the body moves
    P.ParamAngleX *= TN.turn; P.ParamAngleY *= TN.nod; P.ParamAngleZ *= TN.tilt;
    P.ParamBodyAngleX = (P.ParamBodyAngleX || 0) * TN.body; P.ParamBodyAngleY = (P.ParamBodyAngleY || 0) * TN.body; P.ParamBodyAngleZ = (P.ParamBodyAngleZ || 0) * TN.body;
    for (const [k, v] of Object.entries(this.manual)) P[k] = v;
    return P;
  }
  drive(v) { this.driven = v ? { v, t: performance.now() / 1000 } : null; }
  // lip sync to a sound: an <audio>/<video> element (played through here as well) or a MediaStream (a microphone)
  listen(src) {
    this.unlisten();
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC || !src) return () => {};
    const ac = this._ac || (this._ac = new AC());
    if (ac.state === "suspended") ac.resume().catch(() => {});
    let node;
    if (src instanceof MediaStream) node = ac.createMediaStreamSource(src);
    else { node = src.__rigNode || (src.__rigNode = ac.createMediaElementSource(src)); node.connect(ac.destination); }
    const an = ac.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.2;
    node.connect(an);
    const buf = new Float32Array(an.fftSize);
    let floor = 0.004, peak = 0.05;
    this._listenLevel = () => {
      an.getFloatTimeDomainData(buf);
      let e = 0; for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
      const rms = Math.sqrt(e / buf.length);
      floor = Math.min(floor * 1.002 + 1e-6, Math.max(rms, 0.001)); peak = Math.max(peak * 0.995, rms, floor * 4);
      return clamp((rms - floor * 1.5) / (peak - floor * 1.5), 0, 1) ** 0.7;
    };
    this._unlisten = () => { try { node.disconnect(an); } catch (_) {} this._listenLevel = null; };
    return () => this.unlisten();
  }
  unlisten() { if (this._unlisten) { this._unlisten(); this._unlisten = null; } }
  // a transparent video of the canvas as it plays
  record(seconds = 5, { fps = 30, bits } = {}) {
    const c = this.canvas;
    if (typeof MediaRecorder === "undefined" || !c.captureStream) return Promise.reject(new Error("recording is not supported here"));
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) return Promise.reject(new Error("no video format available"));
    const stream = c.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bits || Math.round(clamp(c.width * c.height * fps * 0.12, 4e6, 40e6)) });
    const chunks = [];
    return new Promise((res, rej) => {
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = (e) => { stream.getTracks().forEach((t) => t.stop()); rej(e.error || new Error("recording failed")); };
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); res({ blob: new Blob(chunks, { type: type.split(";")[0] }), type }); };
      rec.start(250);
      setTimeout(() => rec.state !== "inactive" && rec.stop(), seconds * 1000);
    });
  }
  frame(now, dt) {
    Object.assign(this.rig.P, this.params(now, dt));
    this.rig.pose(dt);
    this.rig.draw();
  }

  // ---- input ------------------------------------------------------------------------------------------------
  toRig(e) {
    const r = this.canvas.getBoundingClientRect(), dpr = this.canvas.width / r.width, v = this.rig.view;
    return [((e.clientX - r.left) * dpr - v.x) / v.scale, ((e.clientY - r.top) * dpr - v.y) / v.scale];
  }
  _look(e) {
    const [x, y] = this.toRig(e), A = this.rig.R.anchors;
    // the eyes go at most 0.6 of the way to their corners after the pointer (all the way, the whites show wide)
    this.gaze.tx = clamp((x - A.head_c[0]) / (2.2 * A.unit), -0.6, 0.6);
    this.gaze.ty = clamp(-(y - A.eye_y) / (2.2 * A.unit), -0.6, 0.6);
    this.gaze.last = performance.now() / 1000;
  }
  hitOf([x, y]) {
    const A = this.rig.R.anchors;
    const dx = (x - A.head_c[0]) / (A.Rx * 1.25), dyTop = (y - A.eye_y) / (A.Rx * 1.5);
    if (y < A.eye_y - 0.35 * A.unit && dx * dx + dyTop * dyTop < 1) return "head";
    if (Math.abs(x - A.head_c[0]) < A.Rx && y >= A.eye_y - 0.35 * A.unit && y < A.chin) return "face";
    if (Math.abs(x - A.head_c[0]) < 2.6 * A.unit && y > A.chin + 0.5 * A.unit) return "body";
    return null;
  }
  _move(e) {
    if (!this.rig.R) return;
    this._look(e);
    if (this.down && this.down.part === "head") {
      const [x] = this.toRig(e), now = performance.now() / 1000;
      if (Math.abs(x - this.down.x) > 4) { this.pat.dir = x > this.down.x ? 1 : -1; this.down.x = x; }
      this.pat.until = Math.max(this.pat.until, now + 0.9);
    }
  }
  _down(e) {
    if (!this.rig.R) return;
    this._look(e);
    const p = this.toRig(e), part = this.hitOf(p), now = performance.now() / 1000;
    this.down = { part, x: p[0] };
    const soft = this.rig.poke ? this.rig.poke(p[0], p[1]) : false;
    if (part === "head") this.pat = { until: now + 1.6, dir: 0, t0: now };
    else if (part === "face") this.cue("poke", p[0] < this.rig.R.anchors.head_c[0] ? 1 : -1);
    else if (part === "body") this.cue("recoil");
    if (this.opts.onTouch && (part || soft)) this.opts.onTouch(part || "body", p[0], p[1], soft);
  }
}
export { Alive };
