/**
 * People in a world, two kinds behind one handle (`world.person()`):
 *
 * - a live character (动态立绘, the same runtime and pack <RigCharacter> plays): drawn into its own small canvas
 *   by that runtime, then shown in the room as a standee that turns to face the player and is lit by the room's
 *   lamps like everything else. Live characters are drawn from the waist up, so the bottom fades out: stand them
 *   behind a counter, a desk or a bar.
 * - a 3D model (.glb from image-to-3D; a moving character from the character tool, rigged by Hyper3D with its
 *   motions named inside the file, or one rigged elsewhere): a rigged model plays its idle clip, a talk clip while
 *   it speaks (or, without one, nods and moves its head as people do while talking) and a walk clip when it walks,
 *   and turns its head to the player; a model without bones breathes (a slow rise and fall) and turns its body
 *   to the player instead.
 */
import * as THREE from "three";
import { findClip } from "./models";

/* eslint-disable @typescript-eslint/no-explicit-any -- the live-character runtime is plain JavaScript */

export interface PersonHandle {
  object: THREE.Group;
  /** Mouth moving (live) or the talk clip (model) for this many seconds; 0 stops. */
  talk(seconds?: number): void;
  /** A live character's expression or move (nod, happy, surprised, wave, the creator's own), or a model's clip by name. */
  cue(name: string): void;
  mood(m: string): void;
  /** Play a model's clip by name (loops until another is asked for); "idle" goes back to standing. */
  play(name: string): void;
  walkTo(at: number[], o?: { speed?: number; then?: () => void }): void;
  /** Turn to follow the player (default on). */
  follow(on: boolean): void;
  update(t: number, dt: number, camera: THREE.Camera, near: boolean): void;
  dispose(): void;
}

// ---------- the live character as a standee ----------

export async function liveStandee(bytes: ArrayBuffer, o: { size: number; top: number; fade: number; mood?: string; doc: Document; maxAniso: number; coarse: boolean }): Promise<PersonHandle> {
  const [{ Rig }, { Alive }, motion] = await Promise.all([
    import("../../../../sandbox/building-blocks/rig/rig6.js") as Promise<any>,
    import("../../../../sandbox/building-blocks/rig/alive6.js") as Promise<any>,
    (import("../../../../sandbox/building-blocks/rig/motion6.js") as Promise<any>).catch(() => null),
  ]);
  const canvas = o.doc.createElement("canvas");
  const rig = new Rig(canvas, { preserve: true });
  await rig.loadPack(bytes);
  // Crop to the character itself (the pack's frame keeps the picture's empty margins): every part's rest
  // outline, a little room above the hair and at the sides for swaying, nothing below the cut.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const part of rig.parts as { rest?: Float32Array }[]) {
    const r = part.rest;
    if (!r) continue;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
  }
  const fr = rig.R.frame as number[];
  if (!Number.isFinite(x0)) { x0 = fr[0]; y0 = fr[1]; x1 = fr[2]; y1 = fr[3]; }
  const padX = (x1 - x0) * 0.08, padT = (y1 - y0) * 0.05;
  const f = [x0 - padX, y0 - padT, x1 + padX, y1];
  const aspect = (f[2] - f[0]) / Math.max(1, f[3] - f[1]);
  const px = o.coarse ? 640 : 900;
  canvas.height = px; canvas.width = Math.max(64, Math.round(px * aspect));
  rig.fit(f, 0);
  const alive = new Alive(rig, canvas, { input: false });
  if (o.mood) alive.setMood(o.mood);
  if (motion?.MOTION6) alive.perform(motion.MOTION6);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = o.maxAniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const h = o.size, w = h * aspect;
  const fade = { value: o.fade };
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.04, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (s) => {
    s.uniforms.uFade = fade;
    s.fragmentShader = "uniform float uFade;\n" + s.fragmentShader.replace("#include <alphamap_fragment>",
      "#include <alphamap_fragment>\n  diffuseColor.a *= smoothstep(0.0, max(0.001, uFade), vMapUv.y);");
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  // o.top is the top of the hair; the pad above it rides higher
  plane.position.y = o.top + h * (padT / (f[3] - f[1])) - h / 2;
  plane.castShadow = true; plane.receiveShadow = false;
  plane.customDepthMaterial = depth;
  const group = new THREE.Group();
  group.add(plane);
  let following = true, last = -1;
  const toCam = new THREE.Vector3();
  return {
    object: group,
    talk(s = 3) { if (s > 0) alive.talk(s); else alive.stopTalking(); },
    cue(n) { alive.cue(n); },
    mood(m) { alive.setMood(m); },
    play(n) { alive.cue(n); },
    walkTo(at, w2) { group.position.x = at[0]; group.position.z = at[at.length - 1]; w2?.then?.(); },
    follow(on) { following = on; },
    update(_t, dt, camera, near) {
      if (following) {
        camera.getWorldPosition(toCam);
        const want = Math.atan2(toCam.x - group.position.x, toCam.z - group.position.z);
        let d = want - group.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        group.rotation.y += d * Math.min(1, dt * 6);
      }
      // Draw the character only when it can be seen up close; far away it holds its last pose at 10 fps.
      const now = performance.now() / 1000;
      if (!near && now - last < 0.1) return;
      if (o.coarse && now - last < 1 / 30) return;
      const step = last < 0 ? 1 / 60 : Math.min(0.1, now - last);
      last = now;
      alive.frame(now, step);
      tex.needsUpdate = true;
    },
    dispose() { alive.dispose(); rig.dispose(); tex.dispose(); mat.dispose(); depth.dispose(); plane.geometry.dispose(); },
  };
}

// ---------- a 3D model person ----------

export function modelPerson(root: THREE.Object3D, clips: THREE.AnimationClip[], o: { facing: number }): PersonHandle {
  const group = new THREE.Group();
  group.add(root);
  const mixer = clips.length ? new THREE.AnimationMixer(root) : null;
  const actions = new Map<THREE.AnimationClip, THREE.AnimationAction>();
  const action = (c: THREE.AnimationClip) => { let a = actions.get(c); if (!a && mixer) { a = mixer.clipAction(c); actions.set(c, a); } return a!; };
  // A walk clip that moves the root walks away from its spot; keep the hips where the world puts them.
  for (const c of clips) for (const tr of c.tracks) if (/(hips|root|pelvis)[^.]*\.position$/i.test(tr.name)) {
    const v = tr.values; for (let i = 0; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
  }
  const idle = findClip(clips, "idle", "stand", "breath") || clips.find((c) => !/walk|run|talk|chat/i.test(c.name)) || null;
  const talkClip = findClip(clips, "talk", "chat", "convers", "speak");
  const walkClip = findClip(clips, "walk");
  let current: THREE.AnimationAction | null = null;
  const fadeTo = (c: THREE.AnimationClip | null, t = 0.35) => {
    if (!mixer || !c) return;
    const next = action(c);
    if (current === next) return;
    next.reset().setEffectiveWeight(1).play();
    if (current) current.crossFadeTo(next, t, false);
    current = next;
  };
  fadeTo(idle, 0);
  let head: THREE.Object3D | null = null, neck: THREE.Object3D | null = null, hips: THREE.Object3D | null = null;
  root.traverse((x) => {
    if ((x as THREE.Bone).isBone || x.type === "Object3D") {
      if (!head && /head(?!.*(end|top))/i.test(x.name)) head = x;
      if (!neck && /neck/i.test(x.name)) neck = x;
      if (!hips && /hips|pelvis/i.test(x.name)) hips = x;
    }
  });
  // Which way the hips point at rest, in the hips' own frame: idle clips that look around turn the whole body
  // away from the player; that turn is measured against this and mostly taken back.
  group.updateMatrixWorld(true);
  const hipsFwd = hips ? new THREE.Vector3(0, 0, 1).applyQuaternion((hips as THREE.Object3D).getWorldQuaternion(new THREE.Quaternion()).invert()) : null;
  const rigged = Boolean(mixer && head);
  const base = o.facing;
  let following = true, talkUntil = 0, playing: THREE.AnimationClip | null = null;
  let walk: { to: THREE.Vector3; speed: number; then?: () => void } | null = null;
  let turn = 0, headYaw = 0, headPitch = 0, talkAmt = 0;
  const cam = new THREE.Vector3(), hp = new THREE.Vector3();
  const untouched = new Map<THREE.Object3D, THREE.Quaternion>();
  const baseScale = root.scale.clone();
  const handle: PersonHandle = {
    object: group,
    talk(s = 3) { talkUntil = s > 0 ? performance.now() / 1000 + s : 0; },
    cue(n) { handle.play(n); },
    mood() { /* a model has no moods */ },
    play(n) {
      if (/^idle$/i.test(n)) { playing = null; fadeTo(idle); return; }
      const c = findClip(clips, n);
      if (c) { playing = c; fadeTo(c); }
    },
    walkTo(at, w) { walk = { to: new THREE.Vector3(at[0], 0, at[at.length - 1]), speed: w?.speed ?? 1.2, then: w?.then }; },
    follow(on) { following = on; },
    update(t, dt, camera) {
      camera.getWorldPosition(cam);
      const now = performance.now() / 1000;
      if (walk) {
        const d = walk.to.clone().sub(group.position); d.y = 0;
        const dist = d.length();
        if (dist < 0.05) { const then = walk.then; walk = null; fadeTo(playing || idle); then?.(); }
        else {
          const step = Math.min(dist, walk.speed * dt);
          group.position.addScaledVector(d.normalize(), step);
          const want = Math.atan2(d.x, d.z);
          let e = want - group.rotation.y; e = Math.atan2(Math.sin(e), Math.cos(e));
          group.rotation.y += e * Math.min(1, dt * 8);
          fadeTo(walkClip || idle, 0.25);
        }
      } else if (!playing) {
        fadeTo(now < talkUntil && talkClip ? talkClip : idle);
      }
      // undo last frame's head turn first: a clip that does not move the head would otherwise add it up
      for (const [b, q] of untouched) b.quaternion.copy(q);
      mixer?.update(dt);
      for (const b of [head, neck, hips] as (THREE.Object3D | null)[]) if (b) untouched.set(b, b.quaternion.clone());
      // where the player is, from where this person stands, relative to the way they face
      const dx = cam.x - group.position.x, dz = cam.z - group.position.z;
      const dist = Math.hypot(dx, dz);
      const facingNow = walk ? group.rotation.y : base + turn;
      let rel = Math.atan2(dx, dz) - facingNow; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      const watching = following && !walk && dist < 6;
      if (rigged) {
        // the head (and a little of the neck) turns toward the player, as far as a neck turns
        const wantYaw = watching ? THREE.MathUtils.clamp(rel, -1.0, 1.0) : 0;
        (head as unknown as THREE.Object3D).getWorldPosition(hp);
        const wantPitch = watching ? THREE.MathUtils.clamp(Math.atan2(cam.y - hp.y, dist), -0.35, 0.35) : 0;
        headYaw += (wantYaw - headYaw) * Math.min(1, dt * 4);
        headPitch += (wantPitch - headPitch) * Math.min(1, dt * 4);
        // No talk clip (the character tool's library has none): small nods and a sway of the head carry the speech.
        const speaking = !talkClip && now < talkUntil;
        talkAmt += ((speaking ? 1 : 0) - talkAmt) * Math.min(1, dt * 5);
        const nodPitch = talkAmt * (Math.sin(t * 5.3) * 0.045 + Math.sin(t * 2.1 + 1) * 0.03);
        const nodYaw = talkAmt * Math.sin(t * 1.7) * 0.06;
        const qy = new THREE.Quaternion(), qx = new THREE.Quaternion();
        const turnBone = (b: THREE.Object3D | null, k: number) => {
          if (!b || !b.parent) return;
          // rotate about the world up and the person's own side axis, expressed in the bone's parent space
          const pq = b.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pq);
          const yaw = headYaw + nodYaw, pitch = headPitch - nodPitch;
          const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), group.rotation.y + yaw * k).applyQuaternion(pq);
          qy.setFromAxisAngle(up, yaw * k); qx.setFromAxisAngle(side, -pitch * k);
          b.quaternion.premultiply(qy).premultiply(qx);
        };
        if (hips && hipsFwd && !walk && (hips as THREE.Object3D).parent) {
          const h = hips as THREE.Object3D;
          const gq = group.getWorldQuaternion(new THREE.Quaternion()).invert();
          const f = hipsFwd.clone().applyQuaternion(h.getWorldQuaternion(new THREE.Quaternion())).applyQuaternion(gq);
          const drift = Math.atan2(f.x, f.z);
          if (Math.abs(drift) > 0.02) {
            const pq = h.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
            h.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(pq), -drift * 0.85));
            h.updateMatrixWorld(true);
          }
        }
        turnBone(neck, 0.35); turnBone(head, neck ? 0.65 : 1);
        if (!walk) { const want = base; let e = want - group.rotation.y; e = Math.atan2(Math.sin(e), Math.cos(e)); group.rotation.y += e * Math.min(1, dt * 3); }
      } else if (!walk) {
        // no bones: the whole body turns part of the way, breathes, and sways a little while talking
        const want = watching ? THREE.MathUtils.clamp(rel, -0.7, 0.7) * 0.6 : 0;
        turn += (want - turn) * Math.min(1, dt * 2.2);
        group.rotation.y = base + turn;
        const talking = now < talkUntil;
        const breath = Math.sin(t * (Math.PI * 2) / 4.2);
        root.scale.set(baseScale.x * (1 + breath * 0.004), baseScale.y * (1 + breath * 0.009 + (talking ? Math.sin(t * 9) * 0.004 : 0)), baseScale.z * (1 + breath * 0.006));
        root.rotation.z = Math.sin(t * 0.7) * 0.008 + (talking ? Math.sin(t * 3.1) * 0.012 : 0);
        root.rotation.x = Math.sin(t * 0.5 + 1) * 0.006;
      }
    },
    dispose() { mixer?.stopAllAction(); },
  };
  return handle;
}
