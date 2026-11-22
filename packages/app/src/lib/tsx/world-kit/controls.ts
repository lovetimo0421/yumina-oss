/**
 * First-person body for the world kit: look with the mouse (pointer lock, or
 * drag where the browser refuses it), walk with WASD / arrows, Shift to run,
 * Space to jump, C or Ctrl to crouch, E to use. On touch screens the left half
 * is an analog thumbstick and the right half drags to look; a tap uses what is
 * under the finger. Collision is a circle against boxes on the floor plan.
 */
import * as THREE from "three";

export interface Collider { cx: number; cz: number; hx: number; hz: number; cos: number; sin: number; top: number; bottom: number; on: () => boolean }

export interface ControlOptions {
  height: number;
  speed: number;
  run: boolean;
  jump: boolean;
  crouch: boolean;
  radius: number;
}

export class Controls {
  yaw = 0;
  pitch = 0;
  pos = new THREE.Vector3();
  crouchT = 0;
  jumpT = -1;
  moving = false;
  moved = 0;
  touch = false;
  enabled = true;
  paused = false;
  locked = false;
  onUse: (x?: number, y?: number) => void = () => {};
  onPause: (paused: boolean) => void = () => {};
  onStick: (x: number, y: number, dx: number, dy: number, on: boolean) => void = () => {};
  private keys = new Set<string>();
  private stick: { id: number; x: number; y: number; dx: number; dy: number } | null = null;
  private lookPtr: { id: number; x: number; y: number; sx: number; sy: number; t: number; moved: number; mouse: boolean } | null = null;
  private cleanups: (() => void)[] = [];
  private bob = 0;
  private wantLock = false;

  constructor(private canvas: HTMLCanvasElement, private camera: THREE.PerspectiveCamera, public o: ControlOptions, private colliders: Collider[]) {
    const doc = canvas.ownerDocument;
    this.touch = Boolean(doc.defaultView?.matchMedia?.("(pointer: coarse)").matches);
    const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    canvas.tabIndex = 0;
    canvas.style.touchAction = "none";
    canvas.style.outline = "none";
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return Boolean(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable));
    };
    on(doc, "keydown", (e: KeyboardEvent) => {
      if (typing(e) || !this.enabled) return;
      if (e.code === "Escape") { if (!this.locked) this.setPaused(!this.paused); return; }
      if (this.paused) return;
      this.keys.add(e.code);
      if (e.code === "KeyE" && !e.repeat) this.onUse();
      if (e.code === "Space" && this.o.jump && this.jumpT < 0) { this.jumpT = 0; e.preventDefault(); }
      if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
    });
    on(doc, "keyup", (e: KeyboardEvent) => { this.keys.delete(e.code); });
    on(doc.defaultView || window, "blur", () => this.keys.clear());
    on(doc, "pointerlockchange", () => {
      const was = this.locked;
      this.locked = doc.pointerLockElement === canvas;
      // Escape (or the browser) released the mouse: that is the pause key.
      if (was && !this.locked && !this.paused) this.setPaused(true);
    });
    on(canvas, "contextmenu", (e: Event) => e.preventDefault());
    on(canvas, "pointerdown", (e: PointerEvent) => {
      if (!this.enabled) return;
      canvas.focus({ preventScroll: true });
      if (this.paused) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (e.pointerType === "mouse") {
        if (!this.locked && !this.wantLock) {
          // The first click takes the mouse; it does not also use what is under it.
          this.wantLock = true;
          try {
            const p = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
            if (p && typeof p.catch === "function") p.catch(() => {}).finally(() => { this.wantLock = false; });
            else this.wantLock = false;
          } catch { this.wantLock = false; }
          this.lookPtr = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: x, sy: y, t: performance.now(), moved: 10, mouse: true };
          return;
        }
        if (this.locked) { this.onUse(); return; }
        this.lookPtr = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: x, sy: y, t: performance.now(), moved: 0, mouse: true };
        return;
      }
      this.touch = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
      if (x < r.width * 0.42 && y > r.height * 0.35 && !this.stick) {
        this.stick = { id: e.pointerId, x, y, dx: 0, dy: 0 };
        this.onStick(x, y, 0, 0, true);
      } else if (!this.lookPtr) {
        this.lookPtr = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: x, sy: y, t: performance.now(), moved: 0, mouse: false };
      }
    });
    on(canvas, "pointermove", (e: PointerEvent) => {
      if (this.paused || !this.enabled) return;
      if (this.locked && e.pointerType === "mouse") { this.look(e.movementX, e.movementY, 0.0022); return; }
      if (this.stick && e.pointerId === this.stick.id) {
        const r = canvas.getBoundingClientRect();
        let dx = e.clientX - r.left - this.stick.x, dy = e.clientY - r.top - this.stick.y;
        const len = Math.hypot(dx, dy), max = 46;
        if (len > max) { dx *= max / len; dy *= max / len; }
        this.stick.dx = dx; this.stick.dy = dy;
        this.onStick(this.stick.x, this.stick.y, dx, dy, true);
        return;
      }
      if (this.lookPtr && e.pointerId === this.lookPtr.id) {
        const dx = e.clientX - this.lookPtr.x, dy = e.clientY - this.lookPtr.y;
        this.lookPtr.x = e.clientX; this.lookPtr.y = e.clientY;
        this.lookPtr.moved += Math.abs(dx) + Math.abs(dy);
        this.look(dx, dy, this.lookPtr.mouse ? 0.0035 : 0.0055);
      }
    });
    const up = (e: PointerEvent) => {
      if (this.stick && e.pointerId === this.stick.id) { this.stick = null; this.onStick(0, 0, 0, 0, false); }
      if (this.lookPtr && e.pointerId === this.lookPtr.id) {
        const p = this.lookPtr;
        this.lookPtr = null;
        if (!this.paused && p.moved < 8 && performance.now() - p.t < 400) this.onUse(p.sx, p.sy);
      }
    };
    on(canvas, "pointerup", up);
    on(canvas, "pointercancel", up);
  }

  setPaused(p: boolean) {
    if (this.paused === p) return;
    this.paused = p;
    this.keys.clear();
    if (p && this.locked) { try { this.canvas.ownerDocument.exitPointerLock(); } catch { /* fine */ } }
    this.onPause(p);
  }

  resume() {
    this.setPaused(false);
    if (!this.touch) {
      try {
        const p = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch { /* drag still works */ }
    }
    this.canvas.focus({ preventScroll: true });
  }

  private look(dx: number, dy: number, k: number) {
    this.yaw -= dx * k;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - dy * k));
  }

  private blocked(x: number, z: number, footY: number): boolean {
    const r = this.o.radius;
    for (const c of this.colliders) {
      if (!c.on()) continue;
      if (footY + 0.3 > c.top || footY + this.o.height < c.bottom) continue;
      const dx = x - c.cx, dz = z - c.cz;
      const lx = dx * c.cos + dz * c.sin, lz = -dx * c.sin + dz * c.cos;
      const nx = Math.max(-c.hx, Math.min(c.hx, lx)), nz = Math.max(-c.hz, Math.min(c.hz, lz));
      if ((lx - nx) ** 2 + (lz - nz) ** 2 < r * r) return true;
    }
    return false;
  }

  /** Move by a world-space displacement, sliding along whatever is in the way. */
  displace(dx: number, dz: number, footY = 0) {
    const len = Math.hypot(dx, dz), steps = Math.max(1, Math.ceil(len / 0.07));
    for (let i = 0; i < steps; i++) {
      const x = this.pos.x + dx / steps, z = this.pos.z + dz / steps;
      if (!this.blocked(x, this.pos.z, footY)) this.pos.x = x;
      if (!this.blocked(this.pos.x, z, footY)) this.pos.z = z;
    }
  }

  update(dt: number) {
    const k = this.keys;
    let f = 0, s = 0;
    if (!this.paused && this.enabled) {
      f = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
      s = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
      if (this.stick) {
        const mag = Math.hypot(this.stick.dx, this.stick.dy) / 46;
        if (mag > 0.12) { f = -this.stick.dy / 46; s = this.stick.dx / 46; }
      }
    }
    const crouching = !this.paused && this.o.crouch && (k.has("KeyC") || k.has("ControlLeft") || k.has("ControlRight"));
    this.crouchT += ((crouching ? 1 : 0) - this.crouchT) * Math.min(1, dt * 10);
    const running = this.o.run && (k.has("ShiftLeft") || k.has("ShiftRight")) && !crouching;
    const mag = Math.min(1, Math.hypot(f, s));
    this.moving = mag > 0.05;
    let foot = 0;
    if (this.jumpT >= 0) {
      this.jumpT += dt;
      const T = 0.56;
      if (this.jumpT >= T) this.jumpT = -1; else foot = 4 * 0.42 * (this.jumpT / T) * (1 - this.jumpT / T);
    }
    if (this.moving) {
      const speed = this.o.speed * (running ? 1.75 : 1) * (crouching ? 0.45 : 1) * mag;
      const n = Math.hypot(f, s) || 1;
      const ff = (f / n) * speed * dt, ss = (s / n) * speed * dt;
      const before = this.pos.clone();
      this.displace(-Math.sin(this.yaw) * ff + Math.cos(this.yaw) * ss, -Math.cos(this.yaw) * ff - Math.sin(this.yaw) * ss, foot);
      const d = before.distanceTo(this.pos);
      this.moved += d;
      this.bob += d * (running ? 7 : 8.5);
    }
    const eye = this.o.height - this.crouchT * (this.o.height * 0.4);
    const bobY = foot > 0 ? 0 : Math.sin(this.bob) * 0.022 * (this.moving ? 1 : 0);
    this.camera.position.set(this.pos.x, foot + eye + bobY, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  dispose() {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    try { if (this.canvas.ownerDocument.pointerLockElement === this.canvas) this.canvas.ownerDocument.exitPointerLock(); } catch { /* fine */ }
  }
}
