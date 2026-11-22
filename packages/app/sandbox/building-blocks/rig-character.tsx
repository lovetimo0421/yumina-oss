/**
 * <RigCharacter> — a live character made from one picture (the Studio
 * assistant's make_live_character, or POST /api/rig/jobs): it breathes,
 * blinks, follows the pointer, talks, shows expressions and reacts to touch.
 *
 *   <RigCharacter pack="@rig:…" mood="calm" voice ctl={ref} onTouch={(part, soft) => …} />
 *   pack: "@rig:<id>" names the character (the version the creator uses now, with the settings they made on the
 *         generation page: feel, default mood, which drawing of each expression, their own expressions);
 *         "@asset:<id>" is one fixed pack, as built
 *   ref.current.cue("happy") · .cue("angry", { seconds: 5, strength: 0.7 }) · .talk(seconds) · .stopTalking()
 *   ref.current.setMood("happy" | "calm" | "annoyed" | "low" | "sleepy")
 *   ref.current.hold(any cue or own expression | "heart" | "blush" | "eyes" | "mouth", level 0..1 | null)
 *   ref.current.blink(false) stops the automatic blinks, blink(true) brings them back (a face that lowers the lids
 *   never blinks under it anyway)
 *   Names: the ids below, or the label the generation page shows ("Look down", "Smitten", "低头"), any case; the
 *   creator's own expressions by the name they gave them (cue and hold take the same names)
 *   cues: nod tilt shake shy happy laugh surprised angry sad sigh lookdown sleepy heart wink doubt
 *         (happy is a light one: a squint, a bob, a blush; laugh is the big one with drawn smiling eyes and an open
 *         smile; angry, sad and surprised show the expression drawn for the character, on characters made with them)
 *         The creator switches moves on and off for each character (settings.off; laugh, angry and sad start off):
 *         one that's off plays a gentler one instead (laugh → happy, angry → doubt, sad → sigh, others → nod).
 *         and the creator's own expressions by the name they gave them (cue("坏笑"))
 *         and with arms (characters made with them): wave clasp chest welcome shrug
 *   voice: the mouth moves while the platform reads a reply aloud (by its loudness when the host measures it)
 *   performance (on unless false): idling, talking and moods play real people's head, eye, brow and mouth-corner
 *   movements (./rig/motion6.js, read from free stock videos) instead of a formula sway
 *
 * The sandbox can't fetch, so the pack (.rig6, one asset) comes in as bytes
 * through api.fetchAsset. The runtime (./rig) loads only when a card uses it.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useYumina } from "../sandbox-context";

const MOODS = ["happy", "calm", "annoyed", "low", "sleepy"] as const;
const CUES = ["nod", "tilt", "shake", "shy", "happy", "laugh", "surprised", "angry", "sad", "sigh", "lookdown", "sleepy", "heart", "wink", "doubt", "wave", "clasp", "chest", "welcome", "shrug"] as const;
export type RigMood = (typeof MOODS)[number];
export type RigCue = (typeof CUES)[number] | "poke" | "recoil";
export interface RigCueOptions {
  /** how long it shows (a face rests at its strongest; a nod or shake repeats); default: the move's own length */
  seconds?: number;
  /** 0..1.5, default 1 */
  strength?: number;
}
export interface RigControls {
  /** A built-in cue (by id or its label on the generation page), or one of the creator's own expressions by name. */
  cue: (id: RigCue | (string & {}), opts?: RigCueOptions) => void;
  talk: (seconds?: number) => void;
  stopTalking: () => void;
  setMood: (mood: RigMood) => void;
  /** Holds a face (any cue, or one of the creator's own) or a level ("heart" | "blush" | "eyes" | "mouth") at 0..1 until set to null. */
  hold: (what: RigCue | "heart" | "blush" | "eyes" | "mouth" | (string & {}), value: number | null) => void;
  /** Automatic blinks on (default) or off. */
  blink: (on: boolean) => void;
}
export interface RigCharacterProps {
  pack: string;
  mood?: RigMood;
  ctl?: { current: RigControls | null };
  onTouch?: (part: string, soft: boolean) => void;
  /** Move the mouth while the platform's voice readout plays. */
  voice?: boolean;
  /** Real people's performances for idling, talking and moods (default on); false keeps the formula sway. */
  performance?: boolean;
  /** Called once the character is drawn and `ctl` answers (again after a new pack loads). */
  onReady?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the runtime is plain JS */
type Runtime = { rig: any; alive: any };

export function RigCharacter({ pack, mood, ctl, onTouch, voice, performance: performed = true, onReady, className, style }: RigCharacterProps) {
  const api = useYumina();
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useRef<Runtime | null>(null);
  const latest = useRef({ mood, onTouch, api, performed, onReady });
  latest.current = { mood, onTouch, api, performed, onReady };
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !pack) return;
    let dead = false;
    let raf = 0;
    let last = 0;
    let ro: ResizeObserver | null = null;
    setStatus("loading");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none";
    host.appendChild(canvas);
    const fit = () => {
      let r = host.getBoundingClientRect();
      // A parent without a height leaves the character a sliver (seen on testing: a root <div> with no height around
      // a 100%-high layout). Give it a height of its own rather than nothing.
      if (r.height < 40 && !host.style.minHeight) { host.style.minHeight = "320px"; r = host.getBoundingClientRect(); }
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      const rig = live.current?.rig;
      if (rig?.R) rig.fit(rig.R.frame, 8 * dpr);
    };
    void (async () => {
      try {
        const [{ Rig }, { Alive }, motion, got] = await Promise.all([
          import("./rig/rig6.js") as Promise<any>,
          import("./rig/alive6.js") as Promise<any>,
          latest.current.performed ? (import("./rig/motion6.js") as Promise<any>).catch(() => null) : null,
          latest.current.api.fetchAsset(pack),
        ]);
        if (!got?.ok || !got.bytes) throw new Error(got?.error || "the character file could not be read");
        if (dead) return;
        // An ArrayBuffer from the host; a view from older hosts and test harnesses.
        const b = got.bytes as ArrayBuffer | Uint8Array;
        const buf = b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        const rig = new Rig(canvas);
        await rig.loadPack(buf);
        if (dead) { rig.dispose(); return; }
        const alive = new Alive(rig, canvas, {
          onTouch: (part: string, _x: number, _y: number, soft: boolean) => latest.current.onTouch?.(part, soft),
        });
        if (latest.current.mood && (MOODS as readonly string[]).includes(latest.current.mood)) alive.setMood(latest.current.mood);
        if (motion?.MOTION6) alive.perform(motion.MOTION6);
        live.current = { rig, alive };
        fit();
        ro = new ResizeObserver(fit);
        ro.observe(host);
        setStatus("ready");
        latest.current.onReady?.();
        const tick = () => {
          raf = requestAnimationFrame(tick);
          // The runtime stamps cues and talk with performance.now(): run on the same clock.
          const now = performance.now() / 1000;
          const dt = last ? Math.min(0.05, Math.max(0.001, now - last)) : 1 / 60;
          last = now;
          alive.frame(now, dt);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        console.log(`[RigCharacter] ${(e as Error)?.message ?? e}`);
        if (!dead) setStatus("error");
      }
    })();
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      live.current?.alive.dispose();
      live.current?.rig.dispose();
      live.current = null;
      canvas.remove();
    };
    // Only a new pack reloads the character. The host hands a new api object on every state change (each streamed
    // token): depending on it reloaded the character all through a reply, so it vanished while talking (testing,
    // 2026-11-01).
  }, [pack]);

  // A mood is one of four; an expression name passed as one (an assistant wrote mood="shy") plays as that cue instead.
  useEffect(() => {
    const alive = live.current?.alive;
    if (status !== "ready" || !mood || !alive) return;
    if ((MOODS as readonly string[]).includes(mood)) alive.setMood(mood);
    else { alive.setMood("calm"); if ((CUES as readonly string[]).includes(mood)) alive.cue(mood); }
  }, [mood, status]);

  // the voice readout: by its measured loudness when the host sends one, else talking for as long as it plays
  const playback = api.ttsState?.playback ?? null;
  const speaking = !!voice && playback?.status === "playing";
  const level = speaking ? playback?.level : undefined;
  useEffect(() => {
    const alive = live.current?.alive;
    if (status !== "ready" || !alive) return;
    if (!speaking) { alive.hold("mouth", null); alive.stopTalking(); return; }
    if (typeof level === "number") { alive.stopTalking(); alive.hold("mouth", Math.min(1, level * 4)); }
    else alive.talk(600);
  }, [speaking, level, status]);

  const controls = useMemo<RigControls>(() => ({
    cue: (id, opts) => live.current?.alive.cue(id, opts && typeof opts === "object" ? opts : undefined),
    talk: (seconds) => live.current?.alive.talk(seconds ?? 3),
    stopTalking: () => live.current?.alive.stopTalking(),
    setMood: (m) => live.current?.alive.setMood(m),
    hold: (what, value) => live.current?.alive.hold(what, value),
    blink: (on) => live.current?.alive.blinking(on !== false),
  }), []);
  if (ctl) ctl.current = controls;

  return (
    <div ref={hostRef} className={className} data-rig-status={status}
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", ...style }}>
      {status === "loading" && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "rgba(255,255,255,.6)", fontSize: 13 }}>…</div>
      )}
    </div>
  );
}
