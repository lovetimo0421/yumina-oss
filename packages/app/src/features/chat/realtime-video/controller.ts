/**
 * Realtime video controller: one per play session, shared by the debug panel (?rtv=1) and by
 * cards that drive video through `api.realtimeVideo` and place it in their own layout.
 *
 * Engines:
 *  - fal: one H3 Max Director WebRTC stream steered by text ($0.08/s, refuses nudity)
 *  - shorts: a short film per reply, made on the server a few minutes after the reply is written
 *    (turn-video.ts); the films play here one after another and the last frame holds between them
 *  - comfy-h3 / comfy-causal: a chain of ~5 s Comfy Cloud clips, each starting on the previous
 *    clip's last frame (≈$0.03 per clip, no content filter); no longer offered
 *
 * The card's opening plays shot by shot, then every finished assistant reply becomes the next
 * shot: a `<shot>…</shot>` the card's AI wrote itself is used as-is, otherwise a small director
 * model writes one from the reply.
 */
import { createFalClient } from "@fal-ai/client";
import { wma, type WmaRealtimeSession } from "@fal-ai/client/realtime";
import { useChatStore } from "@/stores/chat";
import { useAudioStore } from "@/stores/audio";
import { useUserProfileStore } from "@/stores/user-profile";
import { filmTurn, turnFilmNotes, turnVideoClips, type TurnShotState } from "@/features/chat/turn-video";

const apiBase = import.meta.env.VITE_API_URL || "";
/** fal bills a session's first minute up front (the server meters the rest). */
const FAL_MIN_BILLED_SEC = 60;
/** H3 clips render this many at once; each continues the latest finished clip of its scene.
 *  A guided 1024x576 / 6-step clip takes ~87 s for ~9 s of film (a fresh one ~80-115 s), so three
 *  lanes run well behind playback; the film shows "next clip" while it catches up (owner's call
 *  2026-10-07: picture quality first, speed after; more lanes would crowd out other players). */
const COMFY_LANES = 3;
/** A clip still rendering this long is skipped when a later one is ready (Comfy Cloud queue tails). */
const COMFY_STUCK_MS = 170_000;
/** A clip of a scene whose first clip is still rendering waits this long for it before starting cold. */
const COMFY_SCENE_WAIT_MS = 100_000;
/** Continuations in a row before the next clip starts fresh: every continuation inherits the last
 *  frames of the one before, and by the fourth the drift shows (flatter shading, junk shapes); a
 *  fresh shot (the style sentence and portraits, no guide) resets it, like a cut to a new angle. */
const COMFY_MAX_CHAIN = 3;
/** Seconds one H3 clip plays. */
const COMFY_CLIP_SEC = 9.2;
/** With less than this many seconds of film left to play and no story to shoot, the shot is held longer. */
const COMFY_FILL_BELOW_SEC = 12;
/** While the story is quiet the last shot is held longer, each time from another angle. */
const HOLD_SHOTS = [
  " The shot then holds a little longer: everyone stays where they are, breathing, glancing around and reacting quietly with small natural movements while the camera drifts slowly. Nothing new happens and no one new arrives.",
  " Then the camera slowly pulls back to a wide view of the whole place: the light, the surroundings, the people in it keeping still and waiting. Nothing new happens and no one new arrives.",
  " Then a slow close-up on the faces of the people present, one after another: small expressions, breathing, eyes moving, quiet ambient sound. Nothing new happens and no one new arrives.",
];

export type VideoEngine = "fal" | "shorts" | "comfy-h3" | "comfy-causal";
const COMFY_MODEL: Record<Exclude<VideoEngine, "fal" | "shorts">, string> = { "comfy-h3": "h3-turbo", "comfy-causal": "causal-forcing" };

export type VideoStepKind = "opening" | "user" | "reply" | "shot" | "info" | "error";
export interface VideoStep {
  id: number;
  t: number;
  kind: VideoStepKind;
  text: string;
  shot?: string;
  version?: number;
  status?: string;
  /** Shots: the story passage this shot films. */
  excerpt?: string;
  /** Shots: seconds into the film when its picture reached the screen. */
  shownAt?: number;
}

export interface VideoStartOptions {
  engine?: VideoEngine;
  /** "source" keeps the cover's art style; "live" | "anime" | "painted" force one. */
  style?: string;
  /** Seconds before the stream stops on its own. */
  limitSeconds?: number;
  /** fal only: stop after this long without a new shot (saves money when nobody plays). */
  idleSeconds?: number;
  /** Opening shots to cut the greeting into. */
  openingBeats?: number;
  /** OpenRouter model that turns replies into camera directions. */
  directorModel?: string;
  /** First frame: the card's cover, an image the player uploaded (data URL), or none. */
  firstFrame?: "cover" | "upload" | "none";
  uploadedFrame?: string;
  /** Get ready while the player is still busy (e.g. filling a character form): direct the
   *  opening and start shooting its first shot, but hold the rest until release(). */
  hold?: boolean;
  /** false: always start from the opening, ignoring where this session's film was left. */
  resume?: boolean;
  /** The card asked the player which engine to use: `engine` is the player's own choice. */
  playerChoice?: boolean;
}

/** Director models offered to players; the first is the default. */
export const DIRECTOR_MODELS: { id: string; label: string }[] = [
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "x-ai/grok-4.7", label: "Grok 4.7" },
  { id: "z-ai/glm-5.3", label: "GLM 5.3" },
];

export interface VideoScene {
  id: string;
  sheet: string;
  /** Small picture of how the scene last looked (for the scene list). */
  thumb?: string;
}

export interface VideoState {
  status: "idle" | "starting" | "live" | "ended" | "error";
  engine: VideoEngine;
  elapsed: number;
  /** What this film has cost so far in USD of mushies (credits / 1000), kept for cards. */
  cost: number;
  /** Mushies this film has been charged so far (what the server actually took). */
  credits: number;
  /** The player has not turned scene video on yet: the player asks before anything starts. */
  consent?: boolean;
  /** This server offers scene video to this player. */
  offered?: boolean;
  /** The player turned scene video on (Settings › Display, or the first-use question). */
  optedIn?: boolean;
  /** Engines a card may offer the player here (start with { engine, playerChoice: true }). */
  engines?: VideoEngine[];
  clips: number;
  /** Comfy chain: the next clip is still rendering and the player holds the last frame.
   *  Shorts: no film is playing right now (the last frame holds). */
  waiting: boolean;
  /** Shorts: the newest reply's film while it is being made (writing the shots, then shooting
   *  them), or why it was not made; null once it has landed. */
  short?: { status: "writing" | "shooting" | "failed"; shots: number; done: number; reason?: string } | null;
  /** Shorts: the film on screen: which reply (the opening or the n-th reply), shot `shot` of
   *  `total`, the passage it films, and every shot's state (`at` is the one on screen; a film
   *  still being made plays its finished shots while the rest render). */
  shortNow?: { messageId: string; reply: number; opening: boolean; shot: number; total: number; text: string; cells: TurnShotState[]; at: number; making: boolean } | null;
  /** Shorts: the other films being made (or that failed), oldest first. */
  shortQueue?: { messageId: string; reply: number; opening: boolean; status: "writing" | "shooting" | "failed"; cells: TurnShotState[]; reason?: string }[];
  /** The latest shot sent, and what happened to it. */
  currentShot: string;
  currentStatus: string;
  /** Sound is off (the default, and the fallback when the browser refuses to play sound). */
  muted: boolean;
  /** Started with hold: the first shot is ready and the rest waits for release(). */
  held?: boolean;
  /** Where the film is in the story: opening beat i of n, or shot i of n for this turn, and the
   *  passage of text being filmed (cards highlight it). */
  progress?: { phase: "opening" | "turn"; shot: number; total: number; excerpt: string } | null;
  /** A next shot is waiting for the current one to play out; skip() sends it now. */
  skippable?: boolean;
  /** The player fast-forwarded: the picture shows a tape fast-forward until shot `to` is on screen. */
  fastForward?: { at: number; to: number } | null;
  /** The player rewound: the picture shows a tape rewind until shot `to` is on screen. */
  rewind?: { at: number; to: number } | null;
  /** There is an earlier shot to rewind to. */
  rewindable?: boolean;
  /** This session was filmed before and not cut by the player: start() picks up where it left off. */
  resumable?: boolean;
  error?: string;
  steps: VideoStep[];
  /** Scene book: every place/time the film has been, for intercutting. */
  scenes: VideoScene[];
  currentScene: string | null;
  /** Bumped on every cut, so the player can show a transition. */
  cut: { at: number; kind: "cut" | "return"; scene: string } | null;
}

type CastMember = { name: string; look: string };
type Listener = (s: VideoState) => void;

const SHOT_TAG = /<shot>([\s\S]*?)<\/shot>/i;

/** The camera direction a card's AI wrote into its reply, if any. */
export function extractShot(text: string): string | null {
  const m = SHOT_TAG.exec(text);
  return m ? m[1].trim() : null;
}

/** A film request the server refused: code is INSUFFICIENT_CREDITS, FILM_OPT_IN_REQUIRED or FILM_UNAVAILABLE. */
export class FilmError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
/** Errors the player sees as a sentence of their own (the floating player translates them). */
export const FILM_STOP_CODES = new Set(["INSUFFICIENT_CREDITS", "FILM_OPT_IN_REQUIRED", "FILM_UNAVAILABLE"]);

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase}/api/realtime-video/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data.code ? new FilmError(data.error || res.statusText, data.code) : new Error(data.error || res.statusText);
  return data as T;
}

/** Engine the player picked in the floating player's settings; a card cannot override it. */
export const FILM_SETTINGS_KEY = "yumina:rtv-settings";
export const DEFAULT_ENGINE: VideoEngine = "fal";
/** Engines this player can use here: fal where the server holds a fal key, and short films.
 *  The Comfy clip chains are closed: their picture was not good enough (owner, 2026-10-07). */
function enginesOffered(): VideoEngine[] {
  const profile = useUserProfileStore.getState().profile;
  return [...(profile?.filmFalOffered === true ? ["fal" as const] : []), "shorts"];
}
/** fal looks pinned with keyframes (falFrame/pinLook): admin-only until tested on prod. */
function lookPins(): boolean {
  return useUserProfileStore.getState().profile?.role === "admin";
}
function engineAllowed(e: unknown): e is VideoEngine {
  return (enginesOffered() as unknown[]).includes(e);
}
/** A card that asked the player which engine (start with playerChoice) makes it their choice. */
function rememberEngine(engine: VideoEngine) {
  try {
    const saved = JSON.parse(localStorage.getItem(FILM_SETTINGS_KEY) || "{}") as Record<string, unknown>;
    localStorage.setItem(FILM_SETTINGS_KEY, JSON.stringify({ ...saved, engine }));
  } catch { /* storage blocked */ }
}
function playerEngine(): VideoEngine {
  try {
    const e = (JSON.parse(localStorage.getItem(FILM_SETTINGS_KEY) || "{}") as { engine?: string }).engine;
    return engineAllowed(e) ? e : DEFAULT_ENGINE;
  } catch {
    return DEFAULT_ENGINE;
  }
}

/** Whether this server offers scene video and the player turned it on. A card can start its film
 *  as the page opens, before the profile has loaded (or from a profile cached before the feature
 *  shipped): ask the server once before saying no. */
async function filmFlags(): Promise<{ offered: boolean; optedIn: boolean }> {
  const read = () => {
    const p = useUserProfileStore.getState().profile;
    return { offered: p?.filmOffered === true, optedIn: p?.preferences?.experimentalFilm === true };
  };
  if (read().offered) return read();
  await useUserProfileStore.getState().forceFetchProfile().catch(() => {});
  return read();
}

function toDataUrl(source: CanvasImageSource, w: number, h: number): string {
  const scale = Math.min(1, 1024 / w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

async function coverFrame(url: string): Promise<string> {
  const u = new URL(url, window.location.href);
  // A cover can live on another host's CDN (a card copied from production); try it there first.
  let res = u.origin !== window.location.origin ? await fetch(u.href).catch(() => null) : null;
  if (!res?.ok) res = await fetch(`${apiBase}${u.pathname}${u.search}`, { credentials: "include" });
  if (!res.ok) throw new Error(`cover download failed ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  return toDataUrl(bmp, bmp.width, bmp.height);
}

async function lastFrameOf(blobUrl: string): Promise<string> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = blobUrl;
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error("clip decode failed"));
  });
  v.currentTime = Math.max(0, v.duration - 0.05);
  await new Promise<void>((resolve) => { v.onseeked = () => resolve(); });
  return toDataUrl(v, v.videoWidth, v.videoHeight);
}

/** Where a fal film was when the player left, per session, so coming back picks up there. */
interface ResumePoint {
  style: string;
  cast: CastMember[];
  scenes: { id: string; sheet: string }[];
  currentScene: string | null;
  /** The last shot sent, and the passage it filmed. */
  shot: string;
  excerpt: string;
  /** The last reply already filmed. */
  replyId: string | null;
  /** Opening not finished: its beats and the one on screen. */
  opening: { beats: { text: string; shot: string; scene?: string }[]; at: number } | null;
}
const resumeKey = (sessionId: string) => `yumina:rtv-resume:${sessionId}`;
/** Short films were on for this session and not paused by the player: coming back carries on
 *  (with the look they were filmed in). */
const shortsKey = (sessionId: string) => `yumina:rtv-shorts:${sessionId}`;
function shortsStyle(sessionId: string): string {
  try {
    const v = localStorage.getItem(shortsKey(sessionId));
    return v && v !== "1" ? v : "source";
  } catch {
    return "source";
  }
}
function shortsOn(sessionId: string, on?: boolean, style?: string): boolean {
  try {
    if (on === true) localStorage.setItem(shortsKey(sessionId), style || "1");
    else if (on === false) localStorage.removeItem(shortsKey(sessionId));
    return !!localStorage.getItem(shortsKey(sessionId));
  } catch {
    return false;
  }
}
function loadResume(sessionId: string): ResumePoint | null {
  try {
    const raw = localStorage.getItem(resumeKey(sessionId));
    const p = raw ? (JSON.parse(raw) as ResumePoint) : null;
    return p && typeof p.shot === "string" && p.shot && Array.isArray(p.cast) ? p : null;
  } catch {
    return null;
  }
}

export class RealtimeVideoController {
  readonly video: HTMLVideoElement;
  private listeners = new Set<Listener>();
  private state: VideoState = { status: "idle", engine: "comfy-h3", elapsed: 0, cost: 0, credits: 0, clips: 0, waiting: false, currentShot: "", currentStatus: "", muted: true, steps: [], scenes: [], currentScene: null, cut: null };
  /** Full-size last frame of each scene, to resume a Comfy chain exactly where it left off. */
  private sceneFrames = new Map<string, string>();
  private opts: Required<VideoStartOptions> = { engine: DEFAULT_ENGINE, style: "source", limitSeconds: 600, idleSeconds: 120, openingBeats: 7, directorModel: DIRECTOR_MODELS[0].id, firstFrame: "none", uploadedFrame: "", hold: false, resume: true, playerChoice: false };
  private falSession: WmaRealtimeSession | null = null;
  private running = false;
  private startedAt = 0;
  private lastShotAt = 0;
  private version = 0;
  private stepId = 0;
  private sentAt = new Map<number, number>();
  private prevShot = "";
  private cast: CastMember[] = [];
  /** The cover's art style in words (style "source"): every shot and clip opens with it. */
  private look = "";
  private openingDone = false;
  /** fal opening beats go out one by one; a player action speeds up the rest, never skips it. */
  private openingTimer: ReturnType<typeof setTimeout> | null = null;
  private openingNext: (() => void) | null = null;
  /** Run fn once shot v is on screen and has had dwell ms there (or after fallbackMs if it never shows). */
  private onScreenWaiters = new Map<number, () => void>();
  private waitTimers = new Set<ReturnType<typeof setTimeout>>();
  private afterOnScreen(v: number, dwell: () => number, fallbackMs: number, fn: () => void, replay = false) {
    let done = false;
    const run = () => {
      if (done || !this.running) return;
      done = true;
      if (this.skipNow === run) this.skipNow = null;
      if (this.state.skippable) this.set({ skippable: false });
      // Rewound: the story's next shot waits until the replay has caught up.
      if (this.replay && !replay) { this.deferred.push(fn); return; }
      fn();
    };
    const later = (ms: number) => { const t = setTimeout(() => { this.waitTimers.delete(t); run(); }, ms); this.waitTimers.add(t); };
    this.onScreenWaiters.set(v, () => later(dwell()));
    later(fallbackMs);
    this.skipNow = run;
    this.set({ skippable: true });
  }
  /** The shot waiting on the current one, sent at once by skip(). */
  private skipNow: (() => void) | null = null;
  /** Fast-forward: stop waiting for the current shot to play out and send the next one. */
  skip() {
    if (this.running && this.state.engine === "shorts") return this.skipShort();
    const go = this.skipNow;
    if (!go || !this.running || this.state.held) return;
    this.addStep({ kind: "info", text: "玩家快进：直接拍下一镜" });
    const before = this.version;
    go();
    if (this.version > before) this.seekEffect("ff");
  }
  /** A live stream cannot play faster or backwards: the picture runs a tape fast-forward or
   *  rewind (sound turned down) until the shot just sent is on screen (7-14 s on fal). */
  private seekEffect(dir: "ff" | "rw") {
    if (this.ffTimer) clearTimeout(this.ffTimer);
    this.ffTimer = setTimeout(() => this.endFastForward(), 25_000);
    const mark = { at: Date.now(), to: this.version };
    this.set(dir === "ff" ? { fastForward: mark, rewind: null } : { rewind: mark, fastForward: null });
    this.syncAudio();
  }
  private ffTimer: ReturnType<typeof setTimeout> | null = null;
  private endFastForward() {
    if (this.ffTimer) clearTimeout(this.ffTimer);
    this.ffTimer = null;
    if (!this.state.fastForward && !this.state.rewind) return;
    this.set({ fastForward: null, rewind: null });
    this.syncAudio();
  }

  // ── reel: every shot filmed, so the player can rewind ──
  private reel: { shot: string; excerpt?: string; scene?: string; kind: VideoStepKind }[] = [];
  /** Which reel shot was sent last. */
  private cursor = -1;
  /** Rewound: the reel replays from the cursor up to the latest shot, then the story goes on. */
  private replay: { token: number } | null = null;
  private replayToken = 0;
  private replaying = false;
  private deferred: (() => void)[] = [];

  /** Rewind: film the previous shot again, then replay the reel back up to the latest shot. */
  rewind() {
    if (this.running && this.state.engine === "shorts") return this.rewindShort();
    if (!this.running || this.state.held || this.state.engine !== "fal" || this.cursor <= 0) return;
    const token = ++this.replayToken;
    this.replay = { token };
    this.addStep({ kind: "info", text: "玩家回退：重拍上一镜" });
    this.playReel(this.cursor - 1, token);
    this.seekEffect("rw");
  }
  private playReel(i: number, token: number) {
    if (!this.running || !this.replay || this.replay.token !== token) return;
    const r = this.reel[i];
    if (!r) return this.endReplay();
    this.cursor = i;
    this.replaying = true;
    this.nextExcerpt = r.excerpt ?? null;
    this.sendShot(r.shot, `回放第 ${i + 1}/${this.reel.length} 镜`, r.kind, r.scene, "return");
    this.replaying = false;
    const last = i + 1 >= this.reel.length;
    this.afterOnScreen(this.version, () => (last ? 3000 : 7000), 30_000, () => (last ? this.endReplay() : this.playReel(i + 1, token)), true);
  }
  private endReplay() {
    if (!this.replay) return;
    this.replay = null;
    this.cursor = this.reel.length - 1;
    this.set({ rewindable: this.cursor > 0 });
    const later = this.deferred;
    this.deferred = [];
    for (const fn of later) fn();
  }
  private openingRush = false;
  /** A reply that finished during the opening is filmed right after it. */
  private pendingReply = false;
  /** Film while the reply is still being written: its first shot goes out early, the rest after. */
  private early: { at: number; shot: string; len: number; v: number } | null = null;
  private earlyWork: Promise<void> | null = null;
  private lastAssistantId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: (() => void)[] = [];
  private queue: ClipItem[] = [];
  /** Comfy clips by version: rendering, rendered and waiting to play, or given up on. */
  private rendering = new Map<number, ClipItem>();
  private rendered = new Map<number, { url: string; hold: boolean; info: string }>();
  /** Versions still to play, in story order. */
  private playOrder: number[] = [];
  private renderStart = new Map<number, number>();
  private droppedClips = new Set<number>();
  /** Which clip a scene's (and the film's) latest continuation source came from. */
  private refVersion = new Map<string, number>();
  private lastRefVersion = 0;
  /** Player turns so far: a new turn replaces shots of older turns that have not started rendering. */
  private turnNo = 0;
  private holds = 0;
  /** Failed clips in a row, and no new clip starts before pauseUntil (a down server is not hammered). */
  private failStreak = 0;
  private pauseUntil = 0;
  /** H3: Comfy output path of the last clip, and of the last clip in each scene, to continue from. */
  private lastRef = "";
  private sceneRefs = new Map<string, string>();
  /** How many continuations deep each clip is (a fresh shot is 0). */
  private chainDepth = new Map<string, number>();
  private queuedScene: string | null = null;
  private seenScenes = new Set<string>();
  private lastFrame = "";

  constructor(readonly sessionId: string) {
    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;background:#000";
    this.video.addEventListener("ended", () => {
      if (this.state.engine === "shorts") this.shortEnded();
      else if (this.state.engine !== "fal") this.playNext();
    });
    this.state.resumable = !!loadResume(sessionId);
    // Cards see whether scene video is offered and which engines they may offer the player.
    const syncOffer = () => {
      const profile = useUserProfileStore.getState().profile;
      const offered = profile?.filmOffered === true;
      const optedIn = profile?.preferences?.experimentalFilm === true;
      // Scene video is experimental and off by default: cards offer it only to players who
      // turned it on (owner, 2026-10-08).
      const engines = offered && optedIn ? enginesOffered() : [];
      if (offered !== this.state.offered || optedIn !== this.state.optedIn || engines.join() !== (this.state.engines ?? []).join()) this.set({ offered, optedIn, engines });
    };
    syncOffer();
    useUserProfileStore.subscribe(syncOffer);
  }

  private openingBeats: { text: string; shot: string; scene?: string }[] = [];
  private openingAt = 0;
  private saveResume() {
    if (this.state.engine !== "fal" || !this.prevShot) return;
    const point: ResumePoint = {
      style: this.opts.style,
      cast: this.cast,
      scenes: this.state.scenes.map(({ id, sheet }) => ({ id, sheet })),
      currentScene: this.state.currentScene,
      shot: this.prevShot,
      excerpt: this.state.progress?.excerpt ?? "",
      replyId: this.lastAssistantId,
      opening: this.openingDone ? null : { beats: this.openingBeats, at: this.openingAt },
    };
    try { localStorage.setItem(resumeKey(this.sessionId), JSON.stringify(point)); } catch { /* storage full or blocked */ }
    if (!this.state.resumable) this.set({ resumable: true });
  }
  private clearResume() {
    try { localStorage.removeItem(resumeKey(this.sessionId)); } catch { /* blocked */ }
    if (this.state.resumable) this.set({ resumable: false });
  }

  // ── observable state ──
  subscribe(fn: Listener): () => void {
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  getState(): VideoState {
    return this.state;
  }
  get lastShot(): string {
    return this.prevShot;
  }
  /** Set what is being filmed; the next sendShot attaches it to its step. */
  private setProgress(p: NonNullable<VideoState["progress"]>, patch: Partial<VideoState> = {}) {
    this.nextExcerpt = p.excerpt;
    this.set({ ...patch, progress: p });
  }
  private nextExcerpt: string | null = null;

  private set(patch: Partial<VideoState>) {
    this.state = { ...this.state, ...patch };
    // While the film plays with sound, the world's music, effects and voice readout stay silent.
    const filming = (this.state.status === "live" || this.state.status === "starting") && !this.state.muted && !(this.state.engine === "shorts" && this.state.waiting);
    if (useAudioStore.getState().filmHold !== filming) useAudioStore.getState().setFilmHold(filming);
    for (const fn of this.listeners) fn(this.state);
  }
  private now() {
    return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
  }
  private addStep(s: Omit<VideoStep, "id" | "t">) {
    const step = { ...s, id: ++this.stepId, t: this.now() };
    this.set({ steps: [...this.state.steps, step].slice(-200) });
  }
  private patchShot(version: number, status: string) {
    const shown = status.startsWith("画面已出") ? this.now() : undefined;
    const steps = this.state.steps.map((s) => (s.version === version ? { ...s, status, ...(shown != null && s.shownAt == null ? { shownAt: shown } : {}) } : s));
    this.set({ steps, ...(version === this.version ? { currentStatus: status } : {}) });
    const seek = this.state.fastForward ?? this.state.rewind;
    if (shown != null && seek && version >= seek.to) this.endFastForward();
  }

  setMuted(muted: boolean) {
    this.set({ muted });
    this.syncAudio();
    if (!muted && (this.video.srcObject || this.video.src)) this.play();
  }

  // The film's own sound is quiet ambience (about -30 to -38 LUFS, very uneven), so it goes
  // through a fixed chain: rumble cut, +18 dB, compression, limiter, -1 dB. Measured on recorded
  // fal films: about -15 LUFS, loudness range ~9 LU, peaks under -1 dBFS.
  // A WebRTC stream (fal) enters as a MediaStream source and the <video> stays muted: Chrome
  // gives silence when a media element playing a remote stream is used as the source.
  // Comfy clips are plain files and enter through the element. Muting is the chain's last gain.
  private audioCtx: AudioContext | null = null;
  private audioIn: AudioNode | null = null;
  private audioOut: GainNode | null = null;
  private elementSource: MediaElementAudioSourceNode | null = null;
  private streamSource: MediaStreamAudioSourceNode | null = null;

  private buildAudio(): AudioContext | null {
    if (this.audioCtx || typeof AudioContext === "undefined") return this.audioCtx;
    try {
      const ctx = new AudioContext();
      const cut = ctx.createBiquadFilter();
      cut.type = "highpass"; cut.frequency.value = 60; cut.Q.value = 0.7;
      const lift = ctx.createGain();
      lift.gain.value = 10 ** (18 / 20);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -32; comp.knee.value = 10; comp.ratio.value = 8; comp.attack.value = 0.004; comp.release.value = 0.3;
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -6; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.001; limit.release.value = 0.1;
      const out = ctx.createGain();
      out.gain.value = 0;
      cut.connect(lift).connect(comp).connect(limit).connect(out).connect(ctx.destination);
      this.audioCtx = ctx; this.audioIn = cut; this.audioOut = out;
    } catch {
      this.audioCtx = null;
    }
    return this.audioCtx;
  }

  /** Route whatever the video is playing into the chain and open or close the last gain. */
  private syncAudio() {
    const stream = this.video.srcObject instanceof MediaStream ? this.video.srcObject : null;
    if (stream) this.video.muted = true;
    if (this.state.muted) {
      if (this.audioOut) this.audioOut.gain.value = 0;
      if (!stream && !this.elementSource) this.video.muted = true;
      return;
    }
    const ctx = this.buildAudio();
    if (!ctx || !this.audioIn || !this.audioOut) {
      // No WebAudio: plain element sound.
      this.video.muted = false;
      return;
    }
    if (stream && stream.getAudioTracks().length && this.streamSource?.mediaStream !== stream) {
      this.streamSource?.disconnect();
      this.streamSource = ctx.createMediaStreamSource(stream);
      this.streamSource.connect(this.audioIn);
    }
    if (!stream) {
      if (!this.elementSource) {
        this.elementSource = ctx.createMediaElementSource(this.video);
        this.elementSource.connect(this.audioIn);
      }
      this.video.muted = false;
    }
    const out = this.audioOut;
    const opened = ctx.state === "running" ? Promise.resolve() : ctx.resume();
    void Promise.race([opened.then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 600))]).then(() => {
      if (ctx.state === "running") {
        out.gain.value = 10 ** (-1 / 20) * (this.state.fastForward || this.state.rewind ? 0.3 : 1);
      } else if (!this.state.muted) {
        // The browser wants a click before sound: keep the picture going and offer "sound on".
        out.gain.value = 0;
        if (!stream) this.video.muted = true;
        this.set({ muted: true });
      }
    });
  }

  private play() {
    this.syncAudio();
    this.video.play().catch(() => {
      if (this.video.muted) return;
      this.video.muted = true;
      this.set({ muted: true });
      this.video.play().catch(() => {});
    });
  }

  // Several places can show the video (the floating player, a card's stage). The newest holder
  // wins; when it lets go, the video goes back to the previous one.
  private holders: HTMLElement[] = [];
  attach(el: HTMLElement) {
    this.holders = this.holders.filter((h) => h !== el);
    this.holders.push(el);
    el.appendChild(this.video);
    // Taking the video off the page pauses it (a card hides it under its map or settings), and
    // putting it back does not restart it: the picture froze while the sound, which goes
    // through WebAudio, played on.
    // (A short film that played to its end holds its last frame: it does not start over.)
    if (this.running && (this.video.srcObject || this.video.src) && this.video.paused && !this.video.ended && !this.state.held) this.play();
    // Short films: the film waiting for a screen plays now (from its start).
    if (this.running && this.state.engine === "shorts") {
      const unseen = this.shortUnseen;
      this.shortUnseen = null;
      if (unseen) this.playShort(unseen, 0);
      else if (this.state.waiting) this.syncShorts();
    }
  }
  detach(el: HTMLElement) {
    this.holders = this.holders.filter((h) => h !== el);
    const prev = this.holders[this.holders.length - 1];
    if (prev) prev.appendChild(this.video);
    else if (this.video.parentElement === el) this.video.remove();
    if ((!this.video.paused && !this.video.ended) || this.video.srcObject) this.play();
  }

  /** The player left with short films on (not paused): carry on, and follow the films still
   *  being made. Shows the film window unless a card's stage takes the picture. */
  async resumeShorts() {
    if (this.running || this.startPending || this.state.status === "starting" || !shortsOn(this.sessionId)) return;
    // The session's messages may still be loading.
    for (let i = 0; i < 30 && !useChatStore.getState().messages.some((m) => m.role === "assistant"); i++) await new Promise((r) => setTimeout(r, 500));
    if (this.running || !useChatStore.getState().messages.some((m) => m.role === "assistant")) return;
    // Only for a player who still has scene video on (no first-use question here).
    const flags = await filmFlags();
    if (!flags.offered || !flags.optedIn || !engineAllowed("shorts")) return;
    const r = await this.start({ engine: "shorts", playerChoice: true, style: shortsStyle(this.sessionId) });
    if ("ok" in r) setTimeout(() => { if (this.running && !this.holders.length) this.openWindow(); }, 1500);
  }

  // The host's film window listens (chat-view); the chat's own menu asks it to open.
  private windowOpeners = new Set<() => void>();
  onOpenWindow(fn: () => void): () => void {
    this.windowOpeners.add(fn);
    return () => this.windowOpeners.delete(fn);
  }
  openWindow() {
    for (const fn of this.windowOpeners) fn();
  }

  // ── lifecycle ──
  private consentAnswer: ((ok: boolean) => void) | null = null;
  /** The player answered the first-use question (experimental, what it costs). */
  async answerConsent(ok: boolean) {
    const answer = this.consentAnswer;
    this.consentAnswer = null;
    this.set({ consent: false });
    if (ok) {
      const res = await fetch(`${apiBase}/api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ preferences: { experimentalFilm: true } }),
      }).catch(() => null);
      if (res?.ok) await useUserProfileStore.getState().forceFetchProfile();
      else ok = false;
    }
    answer?.(ok);
  }

  private startPending = false;
  async start(options: VideoStartOptions = {}): Promise<{ ok: true } | { error: string }> {
    // Short films already carrying on (resumed when the player came back): a card that asks to
    // film them again is answered yes.
    if (this.running && options.engine === "shorts" && this.state.engine === "shorts") return { ok: true };
    if (this.running || this.state.status === "starting" || this.startPending) return { error: "already running" };
    this.startPending = true;
    try {
      return await this.startFilm(options);
    } finally {
      this.startPending = false;
    }
  }

  private async startFilm(options: VideoStartOptions): Promise<{ ok: true } | { error: string }> {
    const flags = await filmFlags();
    if (!flags.offered) return { error: "Scene video is not available." };
    if (!flags.optedIn) {
      const ok = await new Promise<boolean>((resolve) => { this.consentAnswer = resolve; this.set({ consent: true }); });
      if (!ok) return { error: "The player did not turn on scene video." };
    }
    // The player's own engine choice wins over what a card asks for.
    // The player's engine wins over a card's, unless the card asked the player (playerChoice).
    const asked = options.playerChoice && engineAllowed(options.engine) ? options.engine : null;
    if (asked) rememberEngine(asked);
    const engine0 = asked ?? playerEngine();
    if (!engineAllowed(engine0)) return { error: "Scene video is not available here." };
    this.opts = { ...this.opts, ...options, engine: engine0, openingBeats: options.openingBeats ?? (engine0 !== "fal" ? 3 : 7) } as Required<VideoStartOptions>;
    const engine = this.opts.engine;
    this.version = 0;
    this.sentAt.clear();
    this.openingDone = false;
    this.queue = [];
    this.resetClips();
    this.stepId = 0;
    this.sceneFrames.clear();
    this.sceneRefs.clear();
    this.seenScenes.clear();
    this.lastRef = "";
    this.queuedScene = null;
    this.turnBusy = false;
    this.turnRush = false;
    this.early = null;
    this.reel = [];
    this.cursor = -1;
    this.replay = null;
    this.deferred = [];
    this.earlyWork = null;
    this.pendingReply = false;
    this.set({ status: "starting", engine, elapsed: 0, cost: 0, credits: 0, clips: 0, waiting: false, currentShot: "", currentStatus: "", error: undefined, steps: [], scenes: [], currentScene: null, cut: null, short: null });
    if (engine === "shorts") return this.startShorts();
    try {
      const msgs = useChatStore.getState().messages;
      const greeting = msgs.find((m) => m.role === "assistant");
      if (!greeting) throw new Error("no opening message yet");
      const latest = [...msgs].reverse().find((m) => m.role === "assistant");
      this.lastAssistantId = latest?.id ?? null;
      // Coming back to a session filmed before: pick up where the film was left (fal only).
      const saved = engine === "fal" && options.resume !== false ? loadResume(this.sessionId) : null;
      // The story moved past the greeting with no film running: film from the latest reply.
      const late = engine === "fal" && !saved && options.resume !== false && !!latest && latest.id !== greeting.id;
      const t0 = performance.now();
      let op: { cast: CastMember[]; scenes?: VideoScene[]; beats: { text: string; shot: string; scene?: string }[]; coverUrl?: string | null; look?: string | null; credits?: number };
      if (saved) {
        this.opts.style = options.style ?? saved.style;
        op = { cast: saved.cast, scenes: saved.scenes, beats: saved.opening?.beats ?? [] };
        this.addStep({ kind: "info", text: "接着上次离开的地方拍" });
      } else {
        this.addStep({ kind: "info", text: "导演读开场白、拆镜头…" });
        op = await post<typeof op>("opening", {
          sessionId: this.sessionId, style: this.opts.style, beats: late ? 1 : this.opts.openingBeats, greeting: greeting.content.replace(SHOT_TAG, ""), model: this.opts.directorModel,
        });
        if ((this.state.status as VideoState["status"]) !== "starting") return { error: "stopped" };
        this.addCredits(op.credits);
        this.addStep({ kind: "info", text: `拆成 ${op.beats.length} 镜，认出 ${op.cast.length} 个角色（${((performance.now() - t0) / 1000).toFixed(1)}s）：${op.cast.map((c) => c.name).join("、")}` });
      }
      this.cast = op.cast;
      this.look = op.look ?? "";
      this.set({ scenes: (op.scenes ?? []).filter((x) => x && x.id && x.sheet).map((x) => ({ id: String(x.id), sheet: String(x.sheet) })) });
      this.subscribeChat();

      const uploaded = this.opts.firstFrame === "upload" && this.opts.uploadedFrame ? this.opts.uploadedFrame : "";
      if (engine !== "fal") {
        // H3 can start from nothing; like fal it only opens on the cover when asked to.
        const needsFrame = engine !== "comfy-h3" || this.opts.firstFrame === "cover";
        this.lastFrame = "";
        if (uploaded) this.lastFrame = uploaded;
        else if (needsFrame && op.coverUrl) this.lastFrame = await coverFrame(op.coverUrl);
        else if (needsFrame) throw new Error("this card has no cover; upload a first frame");
        this.begin();
        // Held: the clips render as usual; playback waits for release().
        if (this.opts.hold) this.set({ held: true });
        for (const b of op.beats) this.sendShot(b.shot, b.text.replace(/\s+/g, " ").slice(0, 90), "opening", b.scene);
        this.openingDone = true;
        return { ok: true };
      }

      // fal bills its first minute up front; later seconds are metered from tick().
      this.falRun = crypto.randomUUID();
      this.falTicks = 0;
      this.addCredits((await post<{ credits?: number }>("fal-meter", { sessionId: this.sessionId, run: this.falRun, tick: 0 })).credits);
      const fal = createFalClient({ proxyUrl: `${apiBase}/api/realtime-video/fal-proxy` });
      this.fal = fal;
      // First frame: an uploaded image (sent to fal storage), or the cover when publicly reachable,
      // else (looks pinned) the opening shot drawn from its scene plate with the portraits' faces.
      let anchor: string | null = null;
      if (uploaded) {
        const blob = await (await fetch(uploaded)).blob();
        anchor = await fal.storage.upload(blob);
      } else if (this.opts.firstFrame === "cover" && op.coverUrl && /^https:\/\//.test(op.coverUrl)) {
        anchor = op.coverUrl;
      } else if (lookPins()) {
        const first = saved?.shot ? { shot: saved.shot, scene: saved.currentScene ?? undefined } : op.beats[0];
        if (first?.shot) {
          this.addStep({ kind: "info", text: "按定场图画第一帧，定住角色形象…" });
          anchor = await this.falFrame(first.shot, first.scene ?? null);
          if ((this.state.status as VideoState["status"]) !== "starting") return { error: "stopped" };
        }
      }
      this.falSession = (fal.realtime.open(wma("minimax/h3-max/director"), {
        receive: ["video", "audio"],
        onMedia: (stream: MediaStream) => {
          this.video.removeAttribute("src");
          this.video.srcObject = stream;
          this.play();
          this.addStep({ kind: "info", text: "视频流已连上" });
        },
        onData: (raw: string) => this.onFalData(raw),
        onState: (s: string) => { if (s === "failed" || s === "closed") this.stop(false); },
        onError: (e: unknown) => this.addStep({ kind: "error", text: `连接错误：${(e as Error)?.message ?? e}` }),
      }) as unknown) as WmaRealtimeSession;
      this.falAnchor = anchor;
      this.begin();
      const beats = op.beats;
      this.openingBeats = beats;
      if (saved && !saved.opening) {
        // Left after the opening: the last shot again, then any reply written since.
        this.openingDone = true;
        this.lastAssistantId = saved.replyId;
        this.setProgress({ phase: "turn", shot: 1, total: 1, excerpt: saved.excerpt }, { currentScene: saved.currentScene });
        this.sendShot(saved.shot, "上次离开时的镜头", "shot");
        if (latest && latest.id !== saved.replyId) this.afterOnScreen(this.version, () => 4000, 20_000, () => this.handleReply());
        return { ok: true };
      }
      if (late) {
        // No film yet but the story is past the greeting: open on the latest reply.
        this.openingDone = true;
        this.lastAssistantId = null;
        this.handleReply();
        return { ok: true };
      }
      const from = saved?.opening ? Math.min(Math.max(0, saved.opening.at), beats.length - 1) : 0;
      const play0Only = (go: (i: number) => void, more: boolean) => {
        this.openingAt = from;
        this.setProgress({ phase: "opening", shot: from + 1, total: beats.length, excerpt: beats[from].text.slice(0, 1500) }, { held: true });
        this.sendShot(beats[from].shot, beats[from].text.replace(/\s+/g, " ").slice(0, 90), "opening", beats[from].scene);
        this.addStep({ kind: "info", text: "开场第一镜先拍着，等玩家进场再往下播" });
        // The player is in: this shot plays out from now, then the rest follows.
        this.onRelease = () => { if (more) this.afterOnScreen(this.version, () => 7000, 7000, () => go(from + 1)); else this.openingDone = true; };
        // Nobody came: stop paying for a film no one watches.
        this.holdTimer = setTimeout(() => { if (this.state.held) { this.addStep({ kind: "info", text: "玩家迟迟没进场，先停拍" }); this.stop(false); } }, 180_000);
      };
      const play = (i: number) => {
        if (!this.running) return;
        this.openingAt = i;
        this.setProgress({ phase: "opening", shot: i + 1, total: beats.length, excerpt: beats[i].text.slice(0, 1500) });
        this.sendShot(beats[i].shot, beats[i].text.replace(/\s+/g, " ").slice(0, 90), "opening", beats[i].scene);
        // A shot needs ~6-10 s to settle on screen; 12 s lets each beat read. Rushed (the player
        // already acted): 5 s, so the whole opening still plays before their turn.
        // The next beat goes out once this one is actually on screen and has played for a while
        // (fal needs 7-14 s to show a new shot). Rushed (the player already acted): a shorter stay.
        if (i + 1 < beats.length) {
          this.openingNext = () => play(i + 1);
          this.afterOnScreen(this.version, () => (this.openingRush ? 3000 : 7000), 30_000, () => {
            const go = this.openingNext;
            this.openingNext = null;
            go?.();
          });
        } else {
          this.openingNext = null;
          this.openingDone = true;
          this.saveResume();
          this.addStep({ kind: "info", text: "开场演完，之后每条回复都会接成下一个镜头" });
          if (this.pendingReply) {
            this.pendingReply = false;
            setTimeout(() => this.handleReply(), 5000);
          }
        }
      };
      if (this.opts.hold) {
        // Shoot the establishing shot now; the rest of the opening waits for the player.
        play0Only(play, beats.length > 1);
        return { ok: true };
      }
      play(from);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof FilmError ? e.code : (e as Error).message;
      this.addStep({ kind: "error", text: `启动失败：${(e as Error).message}` });
      this.stop(false);
      this.set({ status: "error", error: msg });
      return { error: (e as Error).message };
    }
  }

  private falRun = "";
  private falTicks = 0;
  private falMetering = false;
  private addCredits(n: number | undefined | null) {
    if (typeof n !== "number" || !(n > 0)) return;
    const credits = Math.round((this.state.credits + n) * 10) / 10;
    this.set({ credits, cost: credits / 1000 });
  }
  /** The film stops: the wallet is empty (or the player turned the feature off). */
  private failHard(code: string, text: string) {
    this.addStep({ kind: "error", text });
    this.stop(false);
    this.set({ status: "error", error: code });
  }
  /** fal streams browser-to-fal: after the prepaid minute, bill every 15 s it keeps running. */
  private meterFal(elapsed: number) {
    if (this.falMetering || !this.falRun) return;
    const due = Math.floor(Math.max(0, elapsed - FAL_MIN_BILLED_SEC) / 15);
    if (due <= this.falTicks) return;
    this.falMetering = true;
    const tick = this.falTicks + 1;
    post<{ credits?: number }>("fal-meter", { sessionId: this.sessionId, run: this.falRun, tick, seconds: 15 })
      .then((r) => { this.falTicks = tick; this.addCredits(r.credits); })
      .catch((e) => { if (e instanceof FilmError && FILM_STOP_CODES.has(e.code)) this.failHard(e.code, "蘑菇币不足，停止拍摄"); })
      .finally(() => { this.falMetering = false; });
  }
  private falAnchor: string | null = null;
  private fal: ReturnType<typeof createFalClient> | null = null;

  /** A frame that pins the characters' looks (server /keyframe: the scene's plate, this shot's
   *  moment edited from it with the portraits' faces), uploaded to fal. Null when it failed. */
  private async falFrame(shot: string, scene: string | null): Promise<string | null> {
    const fal = this.fal;
    if (!fal) return null;
    const sheet = scene ? this.state.scenes.find((x) => x.id === scene)?.sheet ?? null : null;
    const t0 = performance.now();
    try {
      const r = await Promise.race([
        post<{ url: string; credits?: number }>("keyframe", { sessionId: this.sessionId, shot, scene, sheet, style: this.opts.style, look: this.look || null }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 90_000)),
      ]);
      this.addCredits(r.credits);
      const blob = await (await fetch(`${apiBase}${r.url}`)).blob();
      const url = await fal.storage.upload(blob);
      this.addStep({ kind: "info", text: `角色形象帧已画好（${((performance.now() - t0) / 1000).toFixed(1)}s）` });
      return url;
    } catch (e) {
      if (e instanceof FilmError && FILM_STOP_CODES.has(e.code)) { this.failHard(e.code, "蘑菇币不足，停止拍摄"); return null; }
      this.addStep({ kind: "error", text: `角色形象帧失败：${(e as Error).message}` });
      return null;
    }
  }

  /** Steer the stream onto a pinned frame: the current shot again, ending exactly on `url`. A wait
   *  on the shot it replaces carries over to it. */
  private pinLook(url: string) {
    const session = this.falSession;
    if (!this.running || !session || !this.prevShot) return;
    const v = ++this.version;
    this.sentAt.set(v, performance.now());
    const waiter = this.onScreenWaiters.get(v - 1);
    if (waiter) { this.onScreenWaiters.delete(v - 1); this.onScreenWaiters.set(v, waiter); }
    session.send({ type: "prompt", prompt_version: v, prompt: this.prevShot, end_image_url: url });
    this.addStep({ kind: "info", text: "校正角色形象（画面会走到定好的这一帧）", shot: this.prevShot, version: v, status: "已发送" });
  }

  private begin() {
    this.startedAt = performance.now();
    this.lastShotAt = performance.now();
    this.running = true;
    this.set({ status: "live" });
    this.timer = setInterval(() => this.tick(), 500);
  }

  private tick() {
    const elapsed = this.now();
    this.set({ elapsed });
    if (this.state.engine === "fal") this.meterFal(elapsed);
    // The live stream must never sit paused on the page (the browser can pause it on its own).
    if (this.state.engine === "fal" && this.video.srcObject && this.video.paused && this.video.isConnected) this.play();
    // Short films cost nothing while they hold a frame: no time limit.
    if (this.state.engine === "shorts") return;
    if (this.state.engine !== "fal" && !this.state.held) {
      if (this.idle()) this.playNext();
      this.pump();
    }
    if (elapsed >= this.opts.limitSeconds) {
      this.addStep({ kind: "info", text: `到达时长上限 ${this.opts.limitSeconds}s，自动结束` });
      this.stop(false);
    } else if (this.state.engine === "fal" && this.openingDone && (performance.now() - this.lastShotAt) / 1000 > this.opts.idleSeconds) {
      this.addStep({ kind: "info", text: `${this.opts.idleSeconds} 秒没有新剧情，自动停流省钱` });
      this.stop(false);
    }
  }

  /** byPlayer: the player cut the film, so coming back does not pick it up again. */
  stop(byPlayer = true) {
    if (this.consentAnswer) void this.answerConsent(false);
    this.falRun = "";
    if (byPlayer) this.clearResume();
    // The player paused short films: coming back does not start them again. (Films being made
    // still finish on the server and land in their replies.)
    if (byPlayer && this.state.engine === "shorts") shortsOn(this.sessionId, false);
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.skipNow = null;
    if (this.ffTimer) clearTimeout(this.ffTimer);
    this.ffTimer = null;
    try { this.falSession?.close(); } catch { /* already closed */ }
    this.falSession = null;
    const wasRunning = this.running;
    this.running = false;
    this.queue = [];
    this.resetClips();
    this.resetShorts();
    if (this.timer) clearInterval(this.timer);
    if (this.openingTimer) clearTimeout(this.openingTimer);
    this.openingTimer = null;
    this.openingNext = null;
    this.openingRush = false;
    for (const t of this.waitTimers) clearTimeout(t);
    this.waitTimers.clear();
    this.onScreenWaiters.clear();
    this.pendingReply = false;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.onRelease = null;
    this.timer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (wasRunning || this.state.status === "starting") this.set({ status: "ended", waiting: false, skippable: false, held: false, fastForward: null, rewind: null, rewindable: false });
  }

  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The play page closed: stop paying after a short grace; coming back resumes (see ResumePoint). */
  leaveSoon() {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      if (!this.running && this.state.status !== "starting") return;
      this.addStep({ kind: "info", text: "玩家离开了页面：先停拍，回来接着拍" });
      this.stop(false);
    }, 8000);
  }

  dispose() {
    this.stop(false);
    this.listeners.clear();
  }

  private onRelease: (() => void) | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The player is here: play the rest of a held opening (see VideoStartOptions.hold). */
  release() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    const go = this.onRelease;
    this.onRelease = null;
    if (!this.state.held) return;
    this.set({ held: false });
    if (this.running) {
      go?.();
      if (this.state.engine !== "fal" && this.idle()) this.playNext();
    }
  }

  /** A card (or the player) can direct the camera itself. */
  direct(prompt: string, label = "手动发送的镜头") {
    if (!this.running || !prompt.trim()) return;
    this.sendShot(prompt.trim(), label, "shot");
  }

  /** Shoot the latest shot again (a new take). Shorts: film the newest reply again. */
  regenerate() {
    if (this.running && this.state.engine === "shorts") return this.shootShort(true);
    if (!this.running || !this.prevShot) return;
    this.sendShot(this.prevShot, "重新生成这一镜", "shot");
  }

  // ── shots ──
  /** Grab what is on screen now (works for the fal stream and for Comfy clips). */
  private grab(maxW: number): string | null {
    const v = this.video;
    if (!v.videoWidth) return null;
    const scale = Math.min(1, maxW / v.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    try {
      canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.82);
    } catch {
      return null;
    }
  }

  /** Remember how the current scene looks before the camera leaves it. */
  private leaveScene() {
    const cur = this.state.currentScene;
    if (!cur) return;
    const full = this.state.engine === "fal" ? null : this.lastFrame;
    if (full) this.sceneFrames.set(cur, full);
    const thumb = this.grab(240);
    if (thumb) this.set({ scenes: this.state.scenes.map((x) => (x.id === cur ? { ...x, thumb } : x)) });
  }

  private enterScene(scene: string | undefined, kind: "cut" | "return" | "continue", sheet?: string | null) {
    if (!scene) return;
    if (scene === this.state.currentScene) return;
    this.leaveScene();
    let scenes = this.state.scenes;
    if (!scenes.some((x) => x.id === scene)) scenes = [...scenes, { id: scene, sheet: sheet ?? "" }];
    // Comfy: a return resumes from the exact frame the scene was left on.
    if (this.state.engine !== "fal" && kind === "return" && this.sceneFrames.has(scene)) this.lastFrame = this.sceneFrames.get(scene)!;
    this.set({ scenes, currentScene: scene, cut: this.state.currentScene ? { at: Date.now(), kind: kind === "return" ? "return" : "cut", scene } : this.state.cut });
  }

  /** The player picks a scene from the list: cut back to it. */
  cutTo(sceneId: string) {
    const sc = this.state.scenes.find((x) => x.id === sceneId);
    if (!this.running || !sc || sceneId === this.state.currentScene) return;
    this.enterScene(sceneId, "return");
    this.sendShot(`Cut back to: ${sc.sheet} The scene continues where it was left.`, `玩家切到场景 ${sceneId}`, "shot", sceneId, "return");
  }

  private sendShot(shot: string, label: string, kind: VideoStepKind, scene?: string, transition: "cut" | "return" | "continue" = "cut", sheet?: string | null) {
    if (scene) this.enterScene(scene, transition, sheet);
    const v = ++this.version;
    const excerpt = this.nextExcerpt ?? undefined;
    this.nextExcerpt = null;
    if (!this.replaying && (kind === "opening" || kind === "shot")) {
      this.reel.push({ shot, excerpt, scene, kind });
      this.cursor = this.reel.length - 1;
    }
    if (this.state.rewindable !== this.cursor > 0) this.set({ rewindable: this.cursor > 0 });
    this.prevShot = shot;
    this.lastShotAt = performance.now();
    this.sentAt.set(v, performance.now());
    this.set({ currentShot: shot, currentStatus: this.state.engine === "fal" ? "已发送" : "排队中" });
    if (this.state.engine !== "fal") {
      const turn = kind === "shot";
      // Story to film: shots of an older turn and held-shot filler not yet rendering give way.
      for (const q of this.queue.filter((x) => x.hold || (turn && x.turn && x.turnNo < this.turnNo))) this.dropClip(q.v, q.hold ? "有新剧情，不再延长" : "被新回合替换");
      // A new place starts fresh, a place seen before resumes from its own last clip.
      const prev = this.queuedScene;
      let from: "prev" | "fresh" | "scene" = "prev";
      if (scene && prev && scene !== prev) from = this.seenScenes.has(scene) ? "scene" : "fresh";
      if (scene) this.seenScenes.add(scene);
      this.queuedScene = scene ?? prev;
      this.enqueueClip({ v, prompt: shot, turn, turnNo: this.turnNo, scene: this.queuedScene, from, hold: false, queuedAt: performance.now() });
      this.addStep({ kind, text: label, shot, version: v, status: "排队中", excerpt });
      this.pump();
      return;
    }
    const session = this.falSession;
    if (!session) return;
    session.send(
      v === 1
        ? { type: "configure", prompt_version: 1, prompt: shot, resolution: "768p", aspect_ratio: "16:9", memory: 12, ...(this.falAnchor ? { image_url: this.falAnchor } : {}) }
        : { type: "prompt", prompt_version: v, prompt: shot },
    );
    this.addStep({ kind, text: label, shot, version: v, status: "已发送", excerpt });
    this.saveResume();
  }

  private onFalData(raw: string) {
    let msg: { type?: string; prompt_version?: number };
    try { msg = JSON.parse(raw); } catch { return; }
    const v = msg.prompt_version;
    if (v == null || !this.sentAt.has(v)) {
      if (msg.type === "error" || msg.type === "stream_exhausted") this.addStep({ kind: "error", text: `${msg.type}: ${raw.slice(0, 200)}` });
      return;
    }
    const secs = ((performance.now() - this.sentAt.get(v)!) / 1000).toFixed(1);
    if (msg.type === "prompt_applied") this.patchShot(v, `已生效 ${secs}s`);
    else if (msg.type === "prompt_rejected") this.patchShot(v, `被拒绝 ${secs}s`);
    else if (msg.type === "chunk") {
      const step = this.state.steps.find((s) => s.version === v);
      if (step && !step.status?.startsWith("画面")) {
        this.patchShot(v, `画面已出 ${secs}s`);
        const w = this.onScreenWaiters.get(v);
        this.onScreenWaiters.delete(v);
        w?.();
      }
    }
  }

  // ── comfy clip chain ──
  // H3 renders slower than it plays (~43 s for 9 s), so up to COMFY_LANES clips render at once,
  // each continuing the latest finished clip of its scene, and they play in story order.
  // Between turns the last shot is held longer so the film never stops.
  private resetClips() {
    this.rendering.clear();
    for (const r of this.rendered.values()) URL.revokeObjectURL(r.url);
    this.rendered.clear();
    this.playOrder = [];
    this.renderStart.clear();
    this.droppedClips.clear();
    this.refVersion.clear();
    this.lastRefVersion = 0;
    this.chainDepth.clear();
    this.holds = 0;
    this.failStreak = 0;
    this.pauseUntil = 0;
  }

  private idle() {
    return !this.video.src || this.video.paused || this.video.ended;
  }

  private enqueueClip(item: ClipItem) {
    this.queue.push(item);
    this.playOrder.push(item.v);
  }

  private dropClip(v: number, why: string) {
    this.queue = this.queue.filter((x) => x.v !== v);
    this.playOrder = this.playOrder.filter((x) => x !== v);
    const r = this.rendered.get(v);
    if (r) URL.revokeObjectURL(r.url);
    this.rendered.delete(v);
    this.droppedClips.add(v);
    this.patchShot(v, why);
  }

  private playNext() {
    if (this.state.held) return;
    while (this.playOrder.length) {
      const v = this.playOrder[0];
      const r = this.rendered.get(v);
      if (r) {
        // Filler gives way to story that is ready to play.
        if (r.hold && this.playOrder.some((x) => x !== v && this.rendered.has(x) && !this.rendered.get(x)!.hold)) {
          this.dropClip(v, "剧情已到，跳过延长");
          continue;
        }
        this.playOrder.shift();
        this.rendered.delete(v);
        this.set({ waiting: false });
        this.video.srcObject = null;
        if (this.video.src.startsWith("blob:")) URL.revokeObjectURL(this.video.src);
        this.video.src = r.url;
        this.play();
        this.patchShot(v, `画面已出 · ${r.info}`);
        const w = this.onScreenWaiters.get(v);
        this.onScreenWaiters.delete(v);
        w?.();
        return;
      }
      // Stuck in Comfy Cloud's queue while a later clip is ready: cut past it.
      const since = this.renderStart.get(v);
      const stuck = since != null && performance.now() - since > COMFY_STUCK_MS;
      if (stuck && this.playOrder.some((x) => this.rendered.has(x))) {
        this.dropClip(v, "生成太慢，跳过");
        continue;
      }
      break;
    }
    if (!this.state.waiting) this.set({ waiting: true });
  }

  /** Seconds of film left: what is playing, what is rendered, what is rendering. */
  private bufferedSeconds() {
    const v = this.video;
    const left = v.src && !v.ended && Number.isFinite(v.duration) ? Math.max(0, v.duration - v.currentTime) : 0;
    let ahead = 0;
    for (const x of this.playOrder) if (this.rendered.has(x) || this.rendering.has(x)) ahead += COMFY_CLIP_SEC;
    return left + ahead;
  }

  /** Start every clip that can start; when the story has nothing to film, hold the last shot longer. */
  private pump() {
    if (!this.running || performance.now() < this.pauseUntil) return;
    const lanes = COMFY_MODEL[this.state.engine as Exclude<VideoEngine, "fal" | "shorts">] === "h3-turbo" ? COMFY_LANES : 1;
    while (this.rendering.size < lanes) {
      const item = this.queue.find((q) => this.canStart(q));
      if (!item) break;
      this.queue = this.queue.filter((q) => q !== item);
      void this.renderClip(item);
    }
    const story = this.queue.some((q) => !q.hold) || [...this.rendering.values()].some((q) => !q.hold);
    const quiet = (performance.now() - this.lastShotAt) / 1000 < this.opts.idleSeconds;
    if (lanes > 1 && this.openingDone && !this.state.held && !story && !this.queue.length && quiet && this.prevShot && this.rendering.size < lanes && this.bufferedSeconds() < COMFY_FILL_BELOW_SEC) {
      const v = ++this.version;
      const prompt = this.prevShot + HOLD_SHOTS[this.holds++ % HOLD_SHOTS.length];
      this.enqueueClip({ v, prompt, turn: false, turnNo: this.turnNo, scene: this.queuedScene, from: "prev", hold: true, queuedAt: performance.now() });
      this.addStep({ kind: "info", text: "等剧情时延长当前镜头，画面不停", shot: prompt, version: v, status: "排队中" });
      this.pump();
    }
  }

  /** A clip continues its scene's latest finished clip; it waits briefly while that scene's first clip renders. */
  private canStart(item: ClipItem) {
    if (COMFY_MODEL[this.state.engine as Exclude<VideoEngine, "fal" | "shorts">] !== "h3-turbo") return true;
    if (item.from === "fresh") return true;
    if (this.sourceFor(item) || (!this.lastRef && this.lastFrame)) return !this.firstClipRendering();
    const sceneRendering = [...this.rendering.values()].some((q) => q.scene === item.scene);
    return !sceneRendering || performance.now() - item.queuedAt > COMFY_SCENE_WAIT_MS;
  }

  /** The film's very first clip sets the look; nothing else starts until it is out (or too slow). */
  private firstClipRendering() {
    if (this.lastRef) return false;
    const first = [...this.rendering.values()][0];
    return !!first && performance.now() - first.queuedAt < COMFY_SCENE_WAIT_MS;
  }

  private sourceFor(item: ClipItem): string {
    if (item.from === "fresh") return "";
    const ref = (item.scene ? this.sceneRefs.get(item.scene) : "") || (item.from === "prev" ? this.lastRef : "") || "";
    return ref && (this.chainDepth.get(ref) ?? 0) < COMFY_MAX_CHAIN ? ref : "";
  }

  private clipRequest(item: ClipItem) {
    const model = COMFY_MODEL[this.state.engine as Exclude<VideoEngine, "fal" | "shorts">];
    if (model !== "h3-turbo") return { model, prompt: item.prompt, frame: this.lastFrame };
    const guide = this.sourceFor(item);
    // Only the very first clip can start on a still (the cover or an uploaded image).
    const frame = !guide && item.from === "prev" && !this.lastRef ? this.lastFrame : "";
    // Character portraits are drawn art: they help drawn styles and drag live-action toward anime.
    return { model, prompt: item.prompt, sessionId: this.sessionId, style: this.opts.style, look: this.look || undefined, refs: this.opts.style !== "live", ...(guide ? { guide } : {}), ...(frame ? { frame } : {}) };
  }

  private clipFailed(v: number, why: string) {
    this.dropClip(v, `失败：${why}`.slice(0, 80));
    this.failStreak++;
    this.pauseUntil = performance.now() + Math.min(30_000, 1000 * 2 ** this.failStreak);
    if (this.failStreak >= 5) {
      this.addStep({ kind: "error", text: "连续 5 段生成失败，先停拍" });
      this.set({ error: why });
      this.stop(false);
    }
  }

  private async renderClip(item: ClipItem) {
    this.rendering.set(item.v, item);
    this.renderStart.set(item.v, performance.now());
    this.patchShot(item.v, "生成中");
    const t0 = performance.now();
    const body = this.clipRequest(item);
    const how = [item.hold ? "延长" : "", item.from === "fresh" ? "新场景" : item.from === "scene" ? "接回场景" : "guide" in body ? "续写" : ""].filter(Boolean).join(" · ");
    try {
      const res = await fetch(`${apiBase}/api/realtime-video/clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!this.running) return;
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (err.code && FILM_STOP_CODES.has(err.code)) {
          this.dropClip(item.v, "蘑菇币不足");
          this.failHard(err.code, "蘑菇币不足，停止拍摄");
          return;
        }
        this.clipFailed(item.v, err.error ?? (res.statusText || String(res.status)));
        return;
      }
      this.addCredits(Number(res.headers.get("X-Film-Credits") || 0));
      const url = URL.createObjectURL(await res.blob());
      if (!this.running) { URL.revokeObjectURL(url); return; }
      this.failStreak = 0;
      this.set({ clips: this.state.clips + 1 });
      const exec = Number(res.headers.get("X-Clip-Exec-Ms") || 0) / 1000;
      const queued = Number(res.headers.get("X-Clip-Queue-Ms") || 0) / 1000;
      const refs = decodeURIComponent(res.headers.get("X-Clip-Refs") || "");
      // Later clips continue from the newest footage of their scene, even footage that was skipped.
      const ref = res.headers.get("X-Clip-Ref");
      if (ref) {
        this.chainDepth.set(ref, "guide" in body && body.guide ? (this.chainDepth.get(body.guide) ?? 0) + 1 : 0);
        if (item.v > this.lastRefVersion) { this.lastRef = ref; this.lastRefVersion = item.v; }
        if (item.scene && item.v > (this.refVersion.get(item.scene) ?? 0)) { this.sceneRefs.set(item.scene, ref); this.refVersion.set(item.scene, item.v); }
      }
      if (item.v >= this.lastRefVersion) this.lastFrame = await lastFrameOf(url).catch(() => this.lastFrame);
      if (this.droppedClips.has(item.v)) { URL.revokeObjectURL(url); return; }
      const info = `${((performance.now() - t0) / 1000).toFixed(1)}s 生成好（排队 ${queued.toFixed(0)}s · 生成 ${exec.toFixed(0)}s${how ? ` · ${how}` : ""}${refs ? ` · 参考 ${refs}` : ""}）`;
      this.rendered.set(item.v, { url, hold: item.hold, info });
      this.patchShot(item.v, `已生成，等待播放 · ${info}`);
    } catch (e) {
      if (this.running && !this.droppedClips.has(item.v)) this.clipFailed(item.v, (e as Error).message);
    } finally {
      this.rendering.delete(item.v);
      if (this.running) {
        if (this.idle()) this.playNext();
        this.pump();
      }
    }
  }

  // ── chat ──
  private subscribeChat() {
    this.unsubs.push(useChatStore.subscribe((state, prev) => {
      if (!this.running) return;
      if (state.messages.length > prev.messages.length) {
        const added = state.messages[state.messages.length - 1];
        if (added?.role === "user") {
          this.turnNo++;
          this.early = null;
          this.earlyWork = null;
          this.addStep({ kind: "user", text: added.content.slice(0, 120) });
          // The player moved on: stop replaying, the story continues from the latest shot.
          if (this.replay) this.endReplay();
          // The player acted before the opening finished: play the rest faster, then their turn.
          if (!this.openingDone && !this.openingRush) {
            this.openingRush = true;
            this.addStep({ kind: "info", text: "玩家行动了：开场加快拍完，再接这一回合" });
          }
          // Same for the shots of the last turn still waiting to play.
          if (this.turnBusy) this.turnRush = true;
        }
      }
      if (state.isStreaming) {
        this.maybeEarlyShot(state.streamingContent);
        return;
      }
      if (!prev.isStreaming) return;
      if (!this.openingDone) {
        this.pendingReply = true;
        this.addStep({ kind: "info", text: "回复写好了，等开场拍完马上接上" });
        return;
      }
      this.handleReply();
    }));
  }

  /** The story just before the latest reply, for the director. */
  private recentStory(): string {
    const msgs = useChatStore.getState().messages;
    const lastAi = msgs.map((m) => m.role).lastIndexOf("assistant");
    return msgs.slice(Math.max(0, lastAi - 4), lastAi)
      .map((m) => `${m.role === "user" ? "Player" : "Story"}: ${m.content.replace(SHOT_TAG, "").replace(/\s+/g, " ").trim()}`)
      .join("\n").slice(-2500);
  }

  private directorBody(aiText: string, userText: string | undefined, part?: "start" | "rest") {
    return {
      sessionId: this.sessionId, style: this.opts.style, look: this.look || undefined, cast: this.cast, userText, aiText, prevShot: this.prevShot,
      recent: this.recentStory(), model: this.opts.directorModel,
      scenes: this.state.scenes.map(({ id, sheet }) => ({ id, sheet })), currentScene: this.state.currentScene,
      ...(part ? { part } : {}),
    };
  }

  /** People the director met for the first time keep the look it gave them. */
  private learnCast(newCast: CastMember[] | undefined) {
    const fresh = (newCast ?? []).filter((p) => p?.name && p.look && !this.cast.some((k) => k.name === p.name));
    if (!fresh.length) return;
    this.cast = [...this.cast, ...fresh];
    this.addStep({ kind: "info", text: `新角色定妆：${fresh.map((p) => p.name).join("、")}` });
  }

  /** A turn's shots still playing one after another. */
  private turnBusy = false;
  private turnRush = false;

  /** Film a turn's shots in order: each next one once the previous has played on screen. */
  private playBeats(beats: DirectorBeat[], no: number, total: number, label: string, fallbackExcerpt: string): void {
    const [b, ...rest] = beats;
    if (!b || !this.running) return this.endTurn();
    this.turnBusy = true;
    const how = b.transition === "cut" ? `切到新场景 ${b.scene}` : b.transition === "return" ? `切回场景 ${b.scene}` : "同一场景";
    this.setProgress({ phase: "turn", shot: no, total, excerpt: (b.text || fallbackExcerpt).slice(0, 1500) });
    this.sendShot(b.shot, `${label} · 第 ${no}/${total} 镜 · ${how}`, "shot", b.scene ?? undefined, b.transition ?? "continue", b.sheet);
    // Comfy renders a turn's shots side by side and plays them in order.
    if (this.state.engine !== "fal") return rest.length ? this.playBeats(rest, no + 1, total, label, "") : this.endTurn();
    if (rest.length) this.afterOnScreen(this.version, () => (this.turnRush ? 3000 : 7000), 30_000, () => this.playBeats(rest, no + 1, total, label, ""));
    else this.endTurn();
  }
  private endTurn() {
    this.turnBusy = false;
    this.turnRush = false;
    if (this.pendingReply && this.openingDone) {
      this.pendingReply = false;
      if (this.state.engine !== "fal") return this.handleReply();
      // The latest shot gets a moment on screen before the next turn starts.
      this.afterOnScreen(this.version, () => 4000, 20_000, () => this.handleReply());
    }
  }

  /** Once enough of the reply has streamed, have the director film its first moment. */
  private maybeEarlyShot(streamed: string) {
    if (!this.running || !this.openingDone || this.turnBusy || this.early || this.earlyWork) return;
    const text = streamed.replace(SHOT_TAG, "").trim();
    if (text.length < 260 || extractShot(streamed)) return;
    const state = useChatStore.getState();
    const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
    const t0 = performance.now();
    this.earlyWork = post<DirectorAnswer>("shot", this.directorBody(text.slice(0, 1600), lastUser?.content, "start"))
      .then((d) => {
        this.addCredits(d.credits);
        if (!this.running) return;
        this.learnCast(d.newCast);
        const b = d.beats?.[0] ?? d;
        const how = b.transition === "cut" ? `切到新场景 ${b.scene}` : b.transition === "return" ? `切回场景 ${b.scene}` : "同一场景";
        this.setProgress({ phase: "turn", shot: 1, total: 2, excerpt: (b.text || text).slice(0, 1500) });
        this.sendShot(b.shot, `导演 ${((performance.now() - t0) / 1000).toFixed(1)}s 写好镜头（回复还在写，先拍开头）· ${how}`, "shot", b.scene ?? undefined, b.transition ?? "continue", b.sheet);
        this.early = { at: performance.now(), shot: b.shot, len: text.length, v: this.version };
      })
      .catch(() => { /* the full reply still gets its shots */ });
  }

  // ── shorts: a film per reply ──
  // The server films a reply in a few minutes (turn-video.ts): the shots render side by side and
  // land in the reply as video embeds, which the chat hides. They play here, film after film in
  // story order, and the front of a film plays while its later shots are still being made.
  // Between films the last frame holds. Rewind goes back a film and plays on from there.
  /** The film on screen (by its reply) and which of its playable shots. */
  private shortAt: { messageId: string; clip: number; reply: number } | null = null;
  /** The newest film, held until something shows the video. */
  private shortUnseen: string | null = null;
  /** Bumped on every shot change, so a slow fetch never puts back an older shot. */
  private shortToken = 0;
  /** When the shot on screen was asked for (a rewind right after one goes back another film). */
  private shortSince = 0;
  /** Shots fetched ahead, so the next one starts without a gap. */
  private shortCache = new Map<string, string>();
  private shortFetching = new Map<string, Promise<string | null>>();
  /** The passage each shot of a landed film films, by message (read once from the film's notes). */
  private shortNotes = new Map<string, string[]>();

  private startShorts(): { ok: true } | { error: string } {
    const latest = this.latestReply();
    if (!latest) {
      this.set({ status: "error", error: "no opening message yet" });
      return { error: "no opening message yet" };
    }
    this.begin();
    shortsOn(this.sessionId, true, this.opts.style);
    this.unsubs.push(useChatStore.subscribe((state, prev) => {
      if (!this.running) return;
      if (state.messages.length > prev.messages.length) {
        const added = state.messages[state.messages.length - 1];
        if (added?.role === "user") this.addStep({ kind: "user", text: added.content.slice(0, 120) });
      }
      if (state.messages !== prev.messages) this.syncShorts();
      // A reply (or a new swipe of one) is written: film it.
      if (prev.isStreaming && !state.isStreaming) this.shootShort();
    }));
    const films = this.shortFilms();
    const newest = films[films.length - 1];
    // Back in a filmed story: the newest film plays again, once something shows the video (a card
    // places its stage after the film starts). When the newest reply has none yet, the film before
    // it holds its last frame while the newest is made.
    if (newest && newest.messageId === latest.id && !this.holders.length) this.shortUnseen = newest.messageId;
    if (newest) this.playShort(newest.messageId, 0, newest.messageId !== latest.id || !this.holders.length);
    else this.set({ waiting: true });
    this.addStep({ kind: "info", text: `短片：这一局已有 ${films.length} 部` });
    this.shootShort();
    this.syncShorts();
    return { ok: true };
  }

  private latestReply() {
    return [...useChatStore.getState().messages].reverse().find((m) => m.role === "assistant");
  }

  /** Every reply's film so far, in story order: landed films, and the playable front of films
   *  still being made (their finished shots up to the first one not done yet). */
  private shortFilms(): ShortFilm[] {
    const films: ShortFilm[] = [];
    let reply = 0;
    let userSeen = false;
    for (const m of useChatStore.getState().messages) {
      if (m.role === "user") userSeen = true;
      if (m.role !== "assistant") continue;
      reply++;
      const base = { messageId: m.id, reply, opening: !userSeen };
      const landed = turnVideoClips(m.content);
      if (landed.length) {
        const notes = this.shortNotes.get(m.id);
        if (!notes) this.loadNotes(m.id, m.content);
        films.push({ ...base, clips: landed, texts: landed.map((_, i) => notes?.[i] ?? ""), cells: landed.map(() => "done"), cellOf: landed.map((_, i) => i), making: false });
        continue;
      }
      const tv = m.turnVideo;
      if (tv?.status !== "rendering" || !tv.cells || !tv.clips) continue;
      const clips: string[] = [], texts: string[] = [], cellOf: number[] = [];
      for (let i = 0; i < tv.cells.length; i++) {
        if (tv.cells[i] === "failed") continue;
        if (tv.cells[i] !== "done" || !tv.clips[i]) break;
        clips.push(tv.clips[i]!);
        texts.push(tv.texts?.[i] ?? "");
        cellOf.push(i);
      }
      if (clips.length) films.push({ ...base, clips, texts, cells: tv.cells, cellOf, making: true });
    }
    return films;
  }

  private loadNotes(messageId: string, content: string) {
    this.shortNotes.set(messageId, []);
    void turnFilmNotes(content).then((texts) => {
      if (!texts?.length || !this.running) return;
      this.shortNotes.set(messageId, texts);
      this.syncShorts();
    });
  }

  /** Film the newest reply, unless it has a film, is being filmed, or failed (`again`: film it anyway). */
  private shootShort(again = false) {
    const latest = this.latestReply();
    if (!latest || !latest.content.trim() || latest.turnVideo?.status === "rendering") return;
    if (latest.swipes?.[latest.activeSwipeIndex ?? 0]?.refusal) return;
    if (!again && (turnVideoClips(latest.content).length || latest.turnVideo?.status === "failed")) return;
    this.addStep({ kind: "reply", text: latest.content.replace(/\s+/g, " ").slice(0, 120) });
    void filmTurn(latest.id, this.opts.style || "source").then((credits) => {
      this.addCredits(credits);
      const now = useChatStore.getState().messages.find((m) => m.id === latest.id)?.turnVideo;
      if (now?.status === "failed" && now.reason === "credits" && this.running) this.failHard("INSUFFICIENT_CREDITS", "蘑菇币不足，停止拍摄");
    });
  }

  /** Follow the chat: what is on screen, films being made, and shots that just finished. */
  private syncShorts() {
    const films = this.shortFilms();
    const msgs = useChatStore.getState().messages;
    // Films being made (or that failed), oldest first, apart from the one on screen.
    const queue: NonNullable<VideoState["shortQueue"]> = [];
    let reply = 0;
    let userSeen = false;
    for (const m of msgs) {
      if (m.role === "user") userSeen = true;
      if (m.role !== "assistant") continue;
      reply++;
      const tv = m.turnVideo;
      if (!tv || m.id === this.shortAt?.messageId) continue;
      queue.push(tv.status === "failed"
        ? { messageId: m.id, reply, opening: !userSeen, status: "failed", cells: [], reason: tv.reason }
        : { messageId: m.id, reply, opening: !userSeen, status: tv.cells?.length ? "shooting" : "writing", cells: tv.cells ?? [] });
    }
    const tv = this.latestReply()?.turnVideo;
    const short: VideoState["short"] = !tv ? null
      : tv.status === "failed" ? { status: "failed", shots: 0, done: 0, reason: tv.reason }
      : { status: tv.shots ? "shooting" : "writing", shots: tv.shots ?? 0, done: tv.done ?? 0 };
    const film = this.shortAt ? films.find((f) => f.messageId === this.shortAt!.messageId) : undefined;
    const shortNow: VideoState["shortNow"] = film && this.shortAt ? {
      messageId: film.messageId, reply: film.reply, opening: film.opening, shot: this.shortAt.clip + 1, total: film.cells.filter((c) => c !== "failed").length,
      text: film.texts[this.shortAt.clip] ?? "", cells: film.cells, at: film.cellOf[this.shortAt.clip] ?? 0, making: film.making,
    } : null;
    const patch: Partial<VideoState> = {};
    if (JSON.stringify(short) !== JSON.stringify(this.state.short ?? null)) {
      patch.short = short;
      if (this.state.waiting) patch.currentStatus = !short ? "" : short.status === "failed" ? `没拍成：${short.reason}` : short.status === "writing" ? "导演在写分镜…" : `正在拍：已拍好 ${short.done}/${short.shots} 个镜头`;
    }
    if (JSON.stringify(queue) !== JSON.stringify(this.state.shortQueue ?? [])) patch.shortQueue = queue;
    if (JSON.stringify(shortNow) !== JSON.stringify(this.state.shortNow ?? null)) patch.shortNow = shortNow;
    if (Object.keys(patch).length) this.set(patch);
    // Nothing playing: the next shot of this film once it is done, else the next film (once
    // something shows the video, so a film never plays unseen).
    if (this.state.waiting && this.holders.length) {
      if (film && this.shortAt && this.shortAt.clip + 1 < film.clips.length) this.playShort(film.messageId, this.shortAt.clip + 1);
      else {
        // (The film on screen may be gone: a film being made that failed.)
        const next = films.find((f) => f.reply > (this.shortAt?.reply ?? 0));
        if (next) this.playShort(next.messageId, 0);
      }
    }
    this.markShorts();
  }

  private shortIndex(films: { messageId: string }[]) {
    return this.shortAt ? films.findIndex((f) => f.messageId === this.shortAt!.messageId) : -1;
  }

  /** Play shot `clip` of a reply's film (`hold`: show the last finished shot's last frame instead). */
  private playShort(messageId: string, clip: number, hold = false) {
    const films = this.shortFilms();
    const i = films.findIndex((f) => f.messageId === messageId);
    const film = films[i];
    if (!film) return;
    if (hold) clip = film.clips.length - 1;
    const url = film.clips[clip];
    if (!url) return;
    this.shortAt = { messageId, clip, reply: film.reply };
    this.shortSince = performance.now();
    const token = ++this.shortToken;
    // Played from a fetched copy: the next shot starts without a gap, and the sound reaches the
    // film's sound chain whichever host serves the file.
    void this.fetchShort(url).then((blob) => {
      if (token !== this.shortToken || !this.running) return;
      this.video.srcObject = null;
      this.video.src = blob ?? url;
      if (hold) {
        this.video.autoplay = false;
        this.video.addEventListener("loadedmetadata", () => {
          this.video.currentTime = Math.max(0, this.video.duration - 0.05);
          this.video.autoplay = true;
        }, { once: true });
      } else {
        this.play();
      }
      // Keep this shot and the next (of this film, or the first of the next), fetched now.
      const ahead = film.clips[clip + 1] ?? films[i + 1]?.clips[0];
      for (const [k, cached] of this.shortCache) {
        if (k !== url && k !== ahead) { URL.revokeObjectURL(cached); this.shortCache.delete(k); }
      }
      if (ahead) void this.fetchShort(ahead);
    });
    if (hold) {
      this.set({ waiting: true, progress: null });
    } else {
      this.version++;
      const total = film.cells.filter((c) => c !== "failed").length;
      this.set({ waiting: false, clips: this.state.clips + 1, progress: { phase: "turn", shot: clip + 1, total, excerpt: film.texts[clip] ?? "" }, currentStatus: `第 ${film.reply} 条回复 · 第 ${clip + 1}/${total} 镜` });
      this.addStep({ kind: "shot", text: `短片 ${i + 1}/${films.length} · 第 ${clip + 1}/${total} 镜`, excerpt: film.texts[clip] || undefined, version: this.version, status: "画面已出", shownAt: this.now() });
    }
    this.syncShorts();
  }

  private fetchShort(url: string): Promise<string | null> {
    const cached = this.shortCache.get(url);
    if (cached) return Promise.resolve(cached);
    let p = this.shortFetching.get(url);
    if (!p) {
      p = fetch(url)
        .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
        .then((blob) => {
          if (blob && this.running) this.shortCache.set(url, blob);
          else if (blob) URL.revokeObjectURL(blob);
          return blob;
        })
        .catch(() => null)
        .finally(() => this.shortFetching.delete(url));
      this.shortFetching.set(url, p);
    }
    return p;
  }

  /** A shot played out: the next shot, the next film, or hold the last frame (until the film's
   *  next shot is done, or the next film is here). */
  private shortEnded() {
    if (!this.running || !this.shortAt) return;
    const films = this.shortFilms();
    const i = this.shortIndex(films);
    const film = films[i];
    if (film && this.shortAt.clip + 1 < film.clips.length) return this.playShort(film.messageId, this.shortAt.clip + 1);
    if (!film?.making && films[i + 1]) return this.playShort(films[i + 1].messageId, 0);
    this.set({ waiting: true, progress: null });
    this.syncShorts();
  }

  /** Jump to shot `clip` of the film on screen (a finished one). */
  jumpShort(clip: number) {
    if (!this.running || this.state.engine !== "shorts" || !this.shortAt) return;
    this.playShort(this.shortAt.messageId, clip);
  }

  /** Back to the start of this film, or (already at its start) of the film before. */
  private rewindShort() {
    const films = this.shortFilms();
    if (!films.length) return;
    const i = this.shortIndex(films);
    // At a film's start (or just sent there): the film before.
    const atStart = !this.state.waiting && this.shortAt?.clip === 0 && (this.video.currentTime < 2 || performance.now() - this.shortSince < 2500);
    const to = films[i < 0 ? films.length - 1 : Math.max(0, atStart ? i - 1 : i)];
    this.addStep({ kind: "info", text: "玩家回退：从头放一部" });
    this.playShort(to.messageId, 0);
  }

  /** Forward to the next film; on the newest, to its last frame. */
  private skipShort() {
    const films = this.shortFilms();
    const i = this.shortIndex(films);
    if (films[i + 1]) return this.playShort(films[i + 1].messageId, 0);
    if (films[i] && !this.state.waiting) this.playShort(films[i].messageId, 0, true);
  }

  /** Rewind and forward are offered when there is somewhere to go. */
  private markShorts() {
    const films = this.shortFilms();
    const i = this.shortIndex(films);
    const rewindable = films.length > 0;
    const skippable = i >= 0 && (i + 1 < films.length || !this.state.waiting);
    if (rewindable !== this.state.rewindable || skippable !== this.state.skippable) this.set({ rewindable, skippable });
  }

  private resetShorts() {
    this.shortAt = null;
    this.shortUnseen = null;
    this.shortToken++;
    for (const blob of this.shortCache.values()) URL.revokeObjectURL(blob);
    this.shortCache.clear();
    this.shortFetching.clear();
  }

  /** Turn the latest finished reply into its shots. */
  private handleReply() {
    if (!this.running) return;
    if (this.turnBusy) {
      // The last turn's shots are still playing: this reply follows them.
      this.pendingReply = true;
      return;
    }
    if (this.earlyWork && !this.early) {
      // The early shot is still being written: film the rest once it is out.
      const w = this.earlyWork;
      this.earlyWork = null;
      void w.finally(() => this.handleReply());
      return;
    }
    const state = useChatStore.getState();
    const last = [...state.messages].reverse().find((m) => m.role === "assistant");
    if (!last || last.id === this.lastAssistantId) return;
    this.lastAssistantId = last.id;
    const clean = last.content.replace(SHOT_TAG, "").trim();
    this.addStep({ kind: "reply", text: clean.replace(/\s+/g, " ").slice(0, 120) + (clean.length > 120 ? "…" : "") });
    const own = extractShot(last.content);
    if (own) {
      this.setProgress({ phase: "turn", shot: 1, total: 1, excerpt: clean.slice(0, 1500) });
      this.sendShot(own, "卡的 AI 自带镜头（跳过导演）", "shot");
      return;
    }
    const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
    const early = this.early;
    this.early = null;
    this.earlyWork = null;
    // Shots of this reply are on their way: a reply that lands meanwhile waits for them.
    this.turnBusy = true;
    const t0 = performance.now();
    // The rest of the reply: the passage after what the early shot covered.
    const restText = early ? clean.slice(Math.min(clean.length - 1, early.len)).replace(/^[^\n.!?]*[.!?\n]\s*/, "") : clean;
    post<DirectorAnswer>("shot", this.directorBody(clean, lastUser?.content, early ? "rest" : undefined))
      .then((d) => {
        this.addCredits(d.credits);
        if (!this.running) return;
        this.learnCast(d.newCast);
        const beats = (d.beats?.length ? d.beats : [d]).filter((b) => b && b.shot);
        if (!beats.length) throw new Error("no shot");
        const label = `导演 ${((performance.now() - t0) / 1000).toFixed(1)}s 拆成 ${beats.length} 镜${early ? "（接着拍这条回复的后半段）" : ""}`;
        const go = () => this.playBeats(beats, early ? 2 : 1, beats.length + (early ? 1 : 0), label, restText);
        // fal drifts from the characters' looks over a story: each reply steers it back once.
        if (this.state.engine === "fal" && lookPins()) {
          const no = this.turnNo;
          const b = beats[0];
          void this.falFrame(b.shot, b.scene ?? null).then((url) => { if (url && this.turnNo === no) this.pinLook(url); });
        }
        // The early shot plays out first: 6 s after its picture is on screen.
        if (early && this.state.engine === "fal") this.afterOnScreen(early.v, () => 6000, 30_000, go);
        else go();
      })
      .catch((e) => {
        if (e instanceof FilmError && FILM_STOP_CODES.has(e.code)) return this.failHard(e.code, "蘑菇币不足，停止拍摄");
        this.addStep({ kind: "error", text: `导演失败：${e.message}` });
        this.endTurn();
      });
  }
}

/** A reply's film as the shorts engine plays it: its playable shots (and the passage each films),
 *  every shot's state, and which shot each playable one is. */
type ShortFilm = {
  messageId: string; reply: number; opening: boolean; clips: string[]; texts: string[];
  cells: TurnShotState[]; cellOf: number[]; making: boolean;
};

type ClipItem = {
  v: number; prompt: string; turn: boolean; turnNo: number; scene: string | null; from: "prev" | "fresh" | "scene";
  /** Filler that holds the last shot while the story is quiet. */
  hold: boolean;
  queuedAt: number;
};
type DirectorBeat = { text?: string; shot: string; transition?: "continue" | "cut" | "return"; scene?: string | null; sheet?: string | null };
type DirectorAnswer = DirectorBeat & { beats?: DirectorBeat[]; newCast?: CastMember[]; credits?: number };

const controllers = new Map<string, RealtimeVideoController>();

/** The controller for a play session (created on first use). */
export function getVideoController(sessionId: string): RealtimeVideoController {
  let c = controllers.get(sessionId);
  if (!c) {
    for (const [id, other] of controllers) {
      other.dispose();
      controllers.delete(id);
    }
    c = new RealtimeVideoController(sessionId);
    controllers.set(sessionId, c);
  }
  return c;
}
