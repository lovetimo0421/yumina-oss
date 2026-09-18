import { create } from "zustand";
import type { AudioTrack, AudioEffect, BGMPlaylist, ConditionalBGM, Condition } from "@yumina/engine";
import { filterResumableAudioEffects } from "@yumina/engine";
// Relative (not "@/") so the store is importable under the Node test runner,
// which resolves modules without Vite's path-alias config.
import { resolveAssetUrl } from "../lib/asset-url";
import { setElVolume, getElVolume } from "../lib/media-volume";

/** Extended evaluation context for conditional BGM */
export interface BGMEvalContext {
  worldId: string;
  variables: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
  turnCount: number;
  metadata: Record<string, unknown>;
  playerMessage?: string;
  aiMessage?: string;
  isSessionStart?: boolean;
}

interface ActiveTrack {
  audio: HTMLAudioElement;
  volume: number;
  type: "bgm" | "sfx" | "ambient";
}

interface PlaylistState {
  currentIndex: number;
  isPlaying: boolean;
  gapTimer: ReturnType<typeof setTimeout> | null;
  shuffleOrder: string[];
}

interface AudioState {
  tracks: AudioTrack[];
  activeTracks: Map<string, ActiveTrack>;
  masterVolume: number;
  bgmVolume: number;
  sfxVolume: number;
  muted: boolean;

  // Playlist state
  playlist: BGMPlaylist | null;
  playlistState: PlaylistState;
  conditionalRules: ConditionalBGM[];
  activeConditionalId: string | null;

  // Actions
  setTracks: (tracks: AudioTrack[]) => void;
  processAudioEffects: (effects: AudioEffect[]) => void;
  playTrack: (id: string, opts?: { volume?: number; fadeDuration?: number; chainTo?: string; maxDuration?: number; duckBgm?: boolean; loop?: boolean }) => void;
  stopTrack: (id: string, fadeDuration?: number) => void;
  stopAll: () => void;
  /** Pause a track in place, keeping its position so resumeTrack can continue. */
  pauseTrack: (id: string) => void;
  /** Resume a track paused by pauseTrack (no-op if not paused / not active). */
  resumeTrack: (id: string) => void;
  setMasterVolume: (volume: number) => void;
  setBgmVolume: (volume: number) => void;
  setSfxVolume: (volume: number) => void;
  toggleMute: () => void;
  resumeFromState: (activeAudio: unknown) => void;
  cleanup: () => void;

  // Playlist actions
  setPlaylist: (playlist: BGMPlaylist | null) => void;
  setConditionalRules: (rules: ConditionalBGM[]) => void;
  startPlaylist: () => void;
  playNextInPlaylist: () => void;
  evaluateConditionalBGM: (context: BGMEvalContext) => void;
}

const FADE_INTERVAL = 50;

// Track active fade intervals so they can be cleared on cleanup/stopAll (#35)
const _activeFadeIntervals = new Set<ReturnType<typeof setInterval>>();

// Store event handler references per track so they can be removed (#36)
const _trackHandlers = new Map<string, { ended?: () => void; error?: () => void }>();

// Store maxDuration timers per track for cleanup
const _maxDurationTimers = new Map<string, ReturnType<typeof setTimeout>>();

// A stop can arrive while playTrack is awaiting an @asset URL. Track the
// latest intent per id so a cancelled or superseded play cannot start later.
let _playIntentSerial = 0;
const _latestPlayIntents = new Map<string, number>();

function beginPlayIntent(id: string): number {
  const intent = ++_playIntentSerial;
  _latestPlayIntents.set(id, intent);
  return intent;
}

function cancelPlayIntent(id: string): void {
  _latestPlayIntents.delete(id);
}

// Subscribers notified when a (non-looping) track finishes. The parent renderer
// forwards these into the sandbox (api.onAudioEnded) so creator music players
// can advance to the next track. Module-level so it survives store re-creation.
const _trackEndedListeners = new Set<(trackId: string) => void>();
/** Subscribe to track-ended notifications. Returns an unsubscribe function. */
export function onAudioTrackEnded(cb: (trackId: string) => void): () => void {
  _trackEndedListeners.add(cb);
  return () => { _trackEndedListeners.delete(cb); };
}
function emitTrackEnded(trackId: string): void {
  // Copy first: a listener may unsubscribe during iteration. Swallow listener
  // errors so one bad subscriber can't break audio playback.
  for (const cb of [..._trackEndedListeners]) {
    try { cb(trackId); } catch { /* ignore */ }
  }
}

// Duck state: when an SFX ducks BGM, save original volumes to restore later
let _duckState: {
  originalVolumes: Map<string, number>;  // trackId → original volume
  restoreTimer?: ReturnType<typeof setTimeout>;
  activeCount: number;
} | null = null;

// Account-level "world audio" kill switch. When the user turns the setting
// off, every playTrack call — BGM, ambient, SFX, whether creator TSX,
// AI-directive, or playlist driven — is dropped, so worlds are fully silent.
// Turning it off mid-session also silences anything already playing.
let _worldAudioEnabled = true;

/** Sync the account preference into the store (called from AppShell). */
export function setWorldAudioEnabled(enabled: boolean): void {
  const wasEnabled = _worldAudioEnabled;
  _worldAudioEnabled = enabled;
  if (wasEnabled && !enabled) {
    useAudioStore.getState().stopAll();
  }
}

// iOS / mobile autoplay rescue: when `audio.play()` rejects (no user gesture
// bubbled through — classic for async navigation → loadSession → playTrack on
// iOS Chrome/Safari), stash the element here and retry on the first real user
// gesture. Explains the "audio silent until I switch tabs and come back" symptom:
// the retry was racing whatever gesture-like state iOS happened to restore on
// return; this makes it explicit instead of incidental.
const _pendingUnlockAudios = new Set<HTMLAudioElement>();
const _cancelledAudios = new WeakSet<HTMLAudioElement>();
let _unlockListenerAttached = false;

// Old Android WebView (Chrome ≤ 49) and some iOS versions return undefined
// from HTMLAudioElement.play() instead of a Promise. Guard every call site.
function safePlay(audio: HTMLAudioElement): void {
  if (_cancelledAudios.has(audio) || !audio.src) return;
  try {
    const p = audio.play();
    if (p && typeof p.then === "function") {
      void p.then(
        () => { _pendingUnlockAudios.delete(audio); },
        () => { registerPendingUnlock(audio); },
      );
    } else if (!audio.paused) {
      _pendingUnlockAudios.delete(audio);
    }
  } catch { registerPendingUnlock(audio); }
}

function retryPendingUnlocks() {
  for (const audio of Array.from(_pendingUnlockAudios)) {
    if (_cancelledAudios.has(audio) || !audio.src) {
      _pendingUnlockAudios.delete(audio);
      continue;
    }
    if (!audio.paused) {
      _pendingUnlockAudios.delete(audio);
      continue;
    }

    try {
      const p = audio.play();
      if (p && typeof p.then === "function") {
        void p.then(
          () => { _pendingUnlockAudios.delete(audio); },
          () => { registerPendingUnlock(audio); },
        );
      } else if (!audio.paused) {
        _pendingUnlockAudios.delete(audio);
      }
    } catch {
      // Keep the element queued. A later touchend/click may be the first
      // gesture the mobile browser actually accepts for audible playback.
      registerPendingUnlock(audio);
    }
  }
}

function registerPendingUnlock(audio: HTMLAudioElement): void {
  if (_cancelledAudios.has(audio) || !audio.src) return;
  _pendingUnlockAudios.add(audio);
  if (_unlockListenerAttached) return;
  _unlockListenerAttached = true;
  document.addEventListener("touchstart", retryPendingUnlocks, { passive: true, capture: true });
  document.addEventListener("touchend", retryPendingUnlocks, { passive: true, capture: true });
  document.addEventListener("click", retryPendingUnlocks, { capture: true });
  document.addEventListener("keydown", retryPendingUnlocks, { capture: true });
}

// Track URLs we've already asked the browser to preload, so setTracks can be
// called multiple times (session switch, world reload) without duplicating
// preload hints.
const _preloadedUrls = new Set<string>();

/**
 * Start downloading an audio asset into the HTTP cache immediately, without
 * blocking on .play(). Called from setTracks so by the time playTrack runs
 * the media is already buffered and audio onset is near-instant.
 *
 * On iPhone cellular this is the difference between 1-3 second silent
 * stall before BGM starts vs. it starting as the first frame paints.
 */
async function preloadAudioAsset(url: string): Promise<void> {
  if (!url) return;
  try {
    const resolved = url.startsWith("@asset:") ? await resolveAssetUrl(url) : url;
    if (_preloadedUrls.has(resolved)) return;
    _preloadedUrls.add(resolved);
    // <link rel="preload" as="audio"> is the standard hint to the browser
    // to fetch the asset with high priority and make it available to the
    // media element when .play() eventually runs — same HTTP cache entry.
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "audio";
    link.href = resolved;
    // crossorigin ensures CDN-served audio can be reused by <audio>/new Audio.
    // Anonymous is correct for our public `/cdn/:id` endpoint (no credentials).
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  } catch { /* best-effort; playTrack will still fetch on demand */ }
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

function evaluateCondition(cond: Condition, state: { variables: Record<string, number | string | boolean | Record<string, unknown> | unknown[]> }): boolean {
  const value = state.variables[cond.variableId];
  if (value === undefined) return false;
  switch (cond.operator) {
    case "eq": return value === cond.value;
    case "neq": return value !== cond.value;
    case "gt": return typeof value === "number" && typeof cond.value === "number" && value > cond.value;
    case "gte": return typeof value === "number" && typeof cond.value === "number" && value >= cond.value;
    case "lt": return typeof value === "number" && typeof cond.value === "number" && value < cond.value;
    case "lte": return typeof value === "number" && typeof cond.value === "number" && value <= cond.value;
    case "contains": return typeof value === "string" && typeof cond.value === "string" && value.includes(cond.value);
    default: return false;
  }
}

function evaluateConditions(conditions: Condition[], logic: "all" | "any", variables: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>): boolean {
  if (conditions.length === 0) return false;
  const fakeState = { worldId: "", variables, turnCount: 0, metadata: {} };
  if (logic === "all") return conditions.every((c) => evaluateCondition(c, fakeState));
  return conditions.some((c) => evaluateCondition(c, fakeState));
}

function matchesKeywords(text: string | undefined, keywords: string[] | undefined, wholeWords?: boolean): boolean {
  if (!text || !keywords || keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => {
    if (wholeWords) {
      const pattern = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      return pattern.test(text);
    }
    return lower.includes(kw.toLowerCase());
  });
}

function getCategoryVolume(type: "bgm" | "sfx" | "ambient", state: { bgmVolume: number; sfxVolume: number }): number {
  return type === "sfx" ? state.sfxVolume : state.bgmVolume;
}

function computeVolume(trackVol: number, type: "bgm" | "sfx" | "ambient", state: { bgmVolume: number; sfxVolume: number; masterVolume: number; muted: boolean }): number {
  return trackVol * getCategoryVolume(type, state) * state.masterVolume * (state.muted ? 0 : 1);
}

export const useAudioStore = create<AudioState>((set, get) => ({
  tracks: [],
  activeTracks: new Map(),
  masterVolume: 0.7,
  bgmVolume: 0.7,
  sfxVolume: 0.8,
  muted: false,
  playlist: null,
  playlistState: { currentIndex: 0, isPlaying: false, gapTimer: null, shuffleOrder: [] },
  conditionalRules: [],
  activeConditionalId: null,

  setTracks: (tracks) => {
    set({ tracks });
    // Fire-and-forget: start downloading every track asset NOW so it's
    // buffered by the time playTrack runs. On iPhone cellular this is
    // the difference between a 1-3 second silent stall at play-time
    // vs. audio onset on the next paint.
    for (const track of tracks) {
      if (track.preload !== false) void preloadAudioAsset(track.url);
    }
  },

  processAudioEffects: (effects) => {
    const state = get();
    for (const effect of effects) {
      switch (effect.action) {
        case "play":
          state.playTrack(effect.trackId, { volume: effect.volume, fadeDuration: effect.fadeDuration, chainTo: effect.chainTo, maxDuration: effect.maxDuration });
          break;
        case "stop":
          state.stopTrack(effect.trackId, effect.fadeDuration);
          break;
        case "volume": {
          const active = state.activeTracks.get(effect.trackId);
          if (active && effect.volume !== undefined) {
            active.volume = effect.volume;
            setElVolume(active.audio, computeVolume(effect.volume, active.type, state));
            set({ activeTracks: new Map(state.activeTracks) });
          }
          break;
        }
        case "crossfade":
          for (const [id, track] of state.activeTracks) {
            if (track.type === "bgm") state.stopTrack(id, effect.fadeDuration ?? 1);
          }
          state.playTrack(effect.trackId, { volume: effect.volume, fadeDuration: effect.fadeDuration ?? 1 });
          break;
      }
    }
  },

  playTrack: async (id, opts) => {
    const state = get();
    const track = state.tracks.find((t) => t.id === id);
    if (!track) return;
    const playIntent = beginPlayIntent(id);

    if (!_worldAudioEnabled) return;

    // Remove old event handlers and stop existing audio for this track (#36)
    const existing = state.activeTracks.get(id);
    if (existing) {
      const oldHandlers = _trackHandlers.get(id);
      if (oldHandlers) {
        if (oldHandlers.ended) existing.audio.removeEventListener("ended", oldHandlers.ended);
        if (oldHandlers.error) existing.audio.removeEventListener("error", oldHandlers.error);
        _trackHandlers.delete(id);
      }
      _cancelledAudios.add(existing.audio);
      _pendingUnlockAudios.delete(existing.audio);
      existing.audio.pause();
      existing.audio.src = "";
    }

    let url = track.url;
    if (url.startsWith("@asset:")) {
      // Static import (above) — no dynamic chunk fetch on this hot path.
      // Measurably faster on iPhone cellular where the lazy chunk fetch
      // was adding 300-800ms RTT between play intent and first audio chunk.
      url = await resolveAssetUrl(url);
    }

    // stopTrack/stopAll or a newer same-id play may have happened while the
    // asset URL was resolving. Do not resurrect a stale play request.
    if (_latestPlayIntents.get(id) !== playIntent) return;

    const audio = new Audio(url);
    // Tell the browser to download the full media asset immediately rather
    // than waiting for .play(). Default on iOS Safari is "none"/"metadata"
    // which holds the download until a user gesture + play() — by which
    // point the user is already sitting in silence watching a frozen UI.
    // "auto" gives a hint; actual behavior still respects data-saver etc.
    audio.preload = track.preload === false ? "metadata" : "auto";
    const targetVolume = opts?.volume ?? track.volume ?? 1;
    const fadeDuration = opts?.fadeDuration ?? track.fadeIn ?? 0;
    // Per-call `loop` (from playAudio opts) wins over the track default, so a
    // creator's music player can switch between single-loop and play-once modes
    // on the same track. Falls back to track.loop, then the type-based default.
    const shouldLoop = opts?.loop ?? track.loop ?? (track.type === "bgm" || track.type === "ambient");

    audio.loop = shouldLoop;

    // Named handlers stored for later removal (#36)
    const handlers: { ended?: () => void; error?: () => void } = {};

    // Non-looping tracks fire "ended" (looping ones never do). On end: retire
    // the finished element, notify creator code (api.onAudioEnded), then run the
    // built-in chain / playlist-advance behavior.
    if (!shouldLoop) {
      const chainTargetId = opts?.chainTo;
      handlers.ended = () => {
        const s = get();
        // Clean up the finished track — but only if this element still owns the
        // slot, so a concurrent re-play of the same id isn't evicted.
        const cur = s.activeTracks.get(id);
        if (!cur || cur.audio === audio) {
          const newMap = new Map(s.activeTracks);
          newMap.delete(id);
          set({ activeTracks: newMap });
        }
        // Notify subscribers (forwarded to the sandbox as api.onAudioEnded).
        emitTrackEnded(id);
        if (chainTargetId) {
          // Chain: auto-play the chained track (e.g. SFX → BGM)
          s.playTrack(chainTargetId);
        } else if (track.type === "bgm" && s.playlistState.isPlaying && !s.activeConditionalId) {
          // Default playlist BGM: advance to the next track
          const gap = s.playlist?.gapSeconds ?? 0;
          if (gap > 0) {
            const timer = setTimeout(() => s.playNextInPlaylist(), gap * 1000);
            set({ playlistState: { ...get().playlistState, gapTimer: timer } });
          } else {
            s.playNextInPlaylist();
          }
        }
      };
      audio.addEventListener("ended", handlers.ended);
    }

    handlers.error = () => {
      // Only retract the slot if this element still owns it — a newer playTrack
      // for the same id may have replaced us while the media was loading.
      const cur = get().activeTracks.get(id);
      if (cur && cur.audio !== audio) return;
      const newMap = new Map(get().activeTracks);
      newMap.delete(id);
      set({ activeTracks: newMap });
    };
    audio.addEventListener("error", handlers.error);
    _trackHandlers.set(id, handlers);

    if (fadeDuration > 0) {
      setElVolume(audio, 0);
      safePlay(audio);
      const steps = Math.ceil((fadeDuration * 1000) / FADE_INTERVAL);
      const volumeStep = targetVolume / steps;
      let currentStep = 0;
      const fadeTimer = setInterval(() => {
        currentStep++;
        const vol = Math.min(targetVolume, volumeStep * currentStep);
        const s = get();
        setElVolume(audio, computeVolume(vol, track.type, s));
        if (currentStep >= steps) {
          clearInterval(fadeTimer);
          _activeFadeIntervals.delete(fadeTimer);
        }
      }, FADE_INTERVAL);
      _activeFadeIntervals.add(fadeTimer);
    } else {
      setElVolume(audio, computeVolume(targetVolume, track.type, state));
      safePlay(audio);
    }

    // Read the LATEST map, not the pre-await `state` snapshot — otherwise a
    // concurrent playTrack for a different id (resolved during our await) is
    // silently clobbered when we write our stale copy back.
    const latest = get().activeTracks;
    // If the slot is still occupied by a *different* element — the pre-await
    // `existing` we paused, OR one a concurrent same-id playTrack installed
    // during our await — retire it now. Without this, that element keeps
    // playing (looping) as an orphan reachable by nothing but a page refresh.
    const occupant = latest.get(id);
    if (occupant && occupant.audio !== audio) {
      _cancelledAudios.add(occupant.audio);
      _pendingUnlockAudios.delete(occupant.audio);
      occupant.audio.pause();
      occupant.audio.src = "";
    }
    const newMap = new Map(latest);
    newMap.set(id, { audio, volume: targetVolume, type: track.type });
    set({ activeTracks: newMap });

    // maxDuration: auto-stop after N seconds (from opts or track definition)
    const effectiveMaxDuration = opts?.maxDuration ?? track.maxDuration;
    if (effectiveMaxDuration && effectiveMaxDuration > 0) {
      // Clear any existing timer for this track
      const existingTimer = _maxDurationTimers.get(id);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        _maxDurationTimers.delete(id);
        get().stopTrack(id, 0.5);
      }, effectiveMaxDuration * 1000);
      _maxDurationTimers.set(id, timer);
    }

    // duckBgm: lower all active BGM tracks while this SFX plays
    if (opts?.duckBgm) {
      const currentState = get();
      const originals = new Map<string, number>();
      for (const [tid, at] of currentState.activeTracks) {
        if ((at.type === "bgm" || at.type === "ambient") && tid !== id) {
          originals.set(tid, at.volume);
          // Fade to 15% of original volume
          const duckedVol = at.volume * 0.15;
          at.volume = duckedVol;
          setElVolume(at.audio, computeVolume(duckedVol, at.type, currentState));
        }
      }
      if (originals.size > 0) {
        // Cancel any previous restore
        if (_duckState?.restoreTimer) clearTimeout(_duckState.restoreTimer);
        _duckState = { originalVolumes: originals, activeCount: (_duckState?.activeCount ?? 0) + 1 };

        // Restore function — called when SFX ends or maxDuration fires
        const restoreBgm = () => {
          if (!_duckState) return;
          _duckState.activeCount--;
          if (_duckState.activeCount > 0) return; // other ducking SFX still active
          const s = get();
          for (const [tid, origVol] of _duckState.originalVolumes) {
            const at = s.activeTracks.get(tid);
            if (at) {
              at.volume = origVol;
              // Fade back over 1s
              const startVol = getElVolume(at.audio);
              const targetVol = computeVolume(origVol, at.type, s);
              const steps = Math.ceil(1000 / FADE_INTERVAL);
              const step = (targetVol - startVol) / steps;
              let cur = 0;
              const fadeTimer = setInterval(() => {
                cur++;
                setElVolume(at.audio, Math.min(targetVol, startVol + step * cur));
                if (cur >= steps) {
                  clearInterval(fadeTimer);
                  _activeFadeIntervals.delete(fadeTimer);
                }
              }, FADE_INTERVAL);
              _activeFadeIntervals.add(fadeTimer);
            }
          }
          _duckState = null;
        };

        // Hook into the ended event for this track
        const origEnded = handlers.ended;
        const duckEndedHandler = () => {
          origEnded?.();
          restoreBgm();
        };
        if (origEnded) audio.removeEventListener("ended", origEnded);
        audio.addEventListener("ended", duckEndedHandler);
        handlers.ended = duckEndedHandler;

        // Also restore when maxDuration fires (stopTrack removes ended listener)
        if (opts?.maxDuration && opts.maxDuration > 0) {
          const existingTimer = _maxDurationTimers.get(id);
          if (existingTimer) clearTimeout(existingTimer);
          const timer = setTimeout(() => {
            _maxDurationTimers.delete(id);
            get().stopTrack(id, 0.5);
            restoreBgm();
          }, opts.maxDuration * 1000);
          _maxDurationTimers.set(id, timer);
        }
      }
    }
  },

  stopTrack: (id, fadeDuration) => {
    // This must happen before the active-slot lookup: playTrack may still be
    // awaiting resolveAssetUrl and therefore have no active slot yet.
    cancelPlayIntent(id);
    const state = get();
    const active = state.activeTracks.get(id);
    if (!active) return;
    _cancelledAudios.add(active.audio);
    _pendingUnlockAudios.delete(active.audio);

    // Clear maxDuration timer if any
    const mdTimer = _maxDurationTimers.get(id);
    if (mdTimer) { clearTimeout(mdTimer); _maxDurationTimers.delete(id); }

    // Remove event handlers (#36)
    const handlers = _trackHandlers.get(id);
    if (handlers) {
      if (handlers.ended) active.audio.removeEventListener("ended", handlers.ended);
      if (handlers.error) active.audio.removeEventListener("error", handlers.error);
      _trackHandlers.delete(id);
    }

    const track = state.tracks.find((t) => t.id === id);
    const fade = fadeDuration ?? track?.fadeOut ?? 0;

    if (fade > 0) {
      const startVolume = getElVolume(active.audio);
      const steps = Math.ceil((fade * 1000) / FADE_INTERVAL);
      const volumeStep = startVolume / steps;
      let currentStep = 0;
      const fadeTimer = setInterval(() => {
        currentStep++;
        const vol = Math.max(0, startVolume - volumeStep * currentStep);
        setElVolume(active.audio, vol);
        if (currentStep >= steps) {
          clearInterval(fadeTimer);
          _activeFadeIntervals.delete(fadeTimer);
          active.audio.pause();
          active.audio.src = "";
          // Only retract the slot if it still points at the element we faded —
          // a new playTrack for this id may have taken it over mid-fade.
          // Deleting blindly here orphaned the new (looping) element, which
          // then played until a full browser refresh.
          const cur = get().activeTracks.get(id);
          if (!cur || cur.audio === active.audio) {
            const newMap = new Map(get().activeTracks);
            newMap.delete(id);
            set({ activeTracks: newMap });
          }
        }
      }, FADE_INTERVAL);
      _activeFadeIntervals.add(fadeTimer);
    } else {
      active.audio.pause();
      active.audio.src = "";
      // Same identity guard as the fade path: don't evict an element a
      // concurrent playTrack may have just installed under this id.
      const cur = get().activeTracks.get(id);
      if (!cur || cur.audio === active.audio) {
        const newMap = new Map(get().activeTracks);
        newMap.delete(id);
        set({ activeTracks: newMap });
      }
    }
  },

  stopAll: () => {
    const state = get();
    // Invalidate every in-flight playTrack, including requests that have not
    // created an Audio element or active slot yet.
    _latestPlayIntents.clear();
    if (state.playlistState.gapTimer) clearTimeout(state.playlistState.gapTimer);
    // Clear all fade intervals (#35)
    for (const interval of _activeFadeIntervals) clearInterval(interval);
    _activeFadeIntervals.clear();
    // Clear maxDuration timers
    for (const timer of _maxDurationTimers.values()) clearTimeout(timer);
    _maxDurationTimers.clear();
    // Clear duck state
    if (_duckState?.restoreTimer) clearTimeout(_duckState.restoreTimer);
    _duckState = null;
    // Remove all event handlers (#36)
    for (const [id, active] of state.activeTracks) {
      const handlers = _trackHandlers.get(id);
      if (handlers) {
        if (handlers.ended) active.audio.removeEventListener("ended", handlers.ended);
        if (handlers.error) active.audio.removeEventListener("error", handlers.error);
      }
      _cancelledAudios.add(active.audio);
      _pendingUnlockAudios.delete(active.audio);
      active.audio.pause();
      active.audio.src = "";
    }
    _pendingUnlockAudios.clear();
    _trackHandlers.clear();
    set({
      activeTracks: new Map(),
      playlistState: { ...state.playlistState, isPlaying: false, gapTimer: null },
      activeConditionalId: null,
    });
  },

  pauseTrack: (id) => {
    const active = get().activeTracks.get(id);
    if (!active) return;
    // Pause in place — keep the element AND its activeTracks entry so
    // resumeTrack can continue from the same position. (stopTrack, by
    // contrast, destroys the element via src="" and drops the entry.)
    active.audio.pause();
  },

  resumeTrack: (id) => {
    const active = get().activeTracks.get(id);
    if (!active || !active.audio.paused) return;
    safePlay(active.audio);
  },

  setMasterVolume: (volume) => {
    set({ masterVolume: volume });
    const state = get();
    for (const [, active] of state.activeTracks) {
      setElVolume(active.audio, computeVolume(active.volume, active.type, state));
    }
  },

  setBgmVolume: (volume) => {
    set({ bgmVolume: volume });
    const state = get();
    for (const [, active] of state.activeTracks) {
      if (active.type === "bgm" || active.type === "ambient") {
        setElVolume(active.audio, computeVolume(active.volume, active.type, state));
      }
    }
  },

  setSfxVolume: (volume) => {
    set({ sfxVolume: volume });
    const state = get();
    for (const [, active] of state.activeTracks) {
      if (active.type === "sfx") {
        setElVolume(active.audio, computeVolume(active.volume, active.type, state));
      }
    }
  },

  toggleMute: () => {
    const state = get();
    const newMuted = !state.muted;
    set({ muted: newMuted });
    const s = get();
    for (const [, active] of s.activeTracks) {
      setElVolume(active.audio, computeVolume(active.volume, active.type, s));
    }
  },

  resumeFromState: (activeAudio) => {
    if (!activeAudio || !Array.isArray(activeAudio)) return;
    const state = get();
    // Resume only what would still be sounding: looping BGM/ambient. Sessions
    // saved before the server-side filter landed still carry one-shot SFX in
    // metadata.activeAudio, and this runs on every loadSession — opening the
    // chat, switching persona, coming back from the library — which is what
    // made last turn's sound effect fire again with no trigger word in sight.
    // Guarding here (not only at the write site) heals those existing rows.
    const resumable = filterResumableAudioEffects(state.tracks, activeAudio as AudioEffect[]);
    for (const effect of resumable) {
      if (effect.action === "play") {
        state.playTrack(effect.trackId, { volume: effect.volume, maxDuration: effect.maxDuration });
      }
    }
  },

  cleanup: () => {
    const state = get();
    if (state.playlistState.gapTimer) clearTimeout(state.playlistState.gapTimer);
    get().stopAll();
    set({
      tracks: [],
      activeTracks: new Map(),
      playlist: null,
      playlistState: { currentIndex: 0, isPlaying: false, gapTimer: null, shuffleOrder: [] },
      conditionalRules: [],
      activeConditionalId: null,
    });
  },

  // ── Playlist ──

  setPlaylist: (playlist) => set({ playlist }),

  setConditionalRules: (rules) => set({ conditionalRules: rules }),

  startPlaylist: () => {
    const state = get();
    const pl = state.playlist;
    if (!pl || pl.tracks.length === 0) return;

    const shuffleOrder = pl.playMode === "shuffle"
      ? shuffleArray(pl.tracks)
      : [...pl.tracks];

    set({
      playlistState: { currentIndex: 0, isPlaying: true, gapTimer: null, shuffleOrder },
    });

    // waitForFirstMessage playlists still need to become logically active so
    // a conditional rule can later fall back to them. They must not start an
    // audible default track while conditional BGM owns the music channel.
    if (get().activeConditionalId) return;

    const firstTrackId = shuffleOrder[0];
    if (firstTrackId) state.playTrack(firstTrackId);
  },

  playNextInPlaylist: () => {
    const state = get();
    const pl = state.playlist;
    const ps = state.playlistState;
    if (!pl || !ps.isPlaying || pl.tracks.length === 0 || state.activeConditionalId) return;

    const order = ps.shuffleOrder.length > 0 ? ps.shuffleOrder : pl.tracks;
    let nextIndex = ps.currentIndex + 1;

    if (nextIndex >= order.length) {
      if (pl.playMode === "shuffle") {
        // Re-shuffle and restart
        const newOrder = shuffleArray(pl.tracks);
        set({ playlistState: { ...ps, currentIndex: 0, shuffleOrder: newOrder } });
        const nextId = newOrder[0];
        if (nextId) state.playTrack(nextId);
        return;
      } else {
        // Loop or sequential — wrap to start
        nextIndex = 0;
      }
    }

    set({ playlistState: { ...ps, currentIndex: nextIndex } });
    const nextId = order[nextIndex];
    if (nextId) state.playTrack(nextId);
  },

  evaluateConditionalBGM: (context) => {
    const state = get();
    const rules = state.conditionalRules;
    if (rules.length === 0) return;

    // Find highest-priority matching rule
    let matchingRule: ConditionalBGM | null = null;
    for (const rule of [...rules].sort((a, b) => b.priority - a.priority)) {
      const triggerType = rule.triggerType ?? "variable";
      let matched = false;

      switch (triggerType) {
        case "variable":
          matched = evaluateConditions(rule.conditions, rule.conditionLogic, context.variables);
          break;
        case "ai-keyword":
          matched = matchesKeywords(context.aiMessage, rule.keywords, rule.matchWholeWords);
          break;
        case "keyword":
          matched = matchesKeywords(context.playerMessage, rule.keywords, rule.matchWholeWords);
          break;
        case "turn-count": {
          const tc = context.turnCount;
          if (rule.atTurn != null && tc === rule.atTurn) matched = true;
          if (rule.everyNTurns != null && rule.everyNTurns > 0 && tc > 0 && tc % rule.everyNTurns === 0) matched = true;
          break;
        }
        case "session-start":
          matched = !!context.isSessionStart;
          break;
      }

      if (matched) {
        matchingRule = rule;
        break;
      }
    }

    const currentConditionalId = state.activeConditionalId;

    if (matchingRule) {
      // A rule matched
      if (currentConditionalId !== matchingRule.id) {
        // Different rule than current — transition
        if (currentConditionalId) {
          // Stop current conditional track
          const currentRule = rules.find((r) => r.id === currentConditionalId);
          if (currentRule) {
            state.stopTrack(currentRule.targetTrackId, currentRule.fadeOutDuration);
          }
        } else if (matchingRule.stopPreviousBGM) {
          // Stop default playlist BGM
          for (const [id, track] of state.activeTracks) {
            if (track.type === "bgm") state.stopTrack(id, matchingRule.fadeInDuration);
          }
        }

        // Play the conditional track
        set({ activeConditionalId: matchingRule.id });
        state.playTrack(matchingRule.targetTrackId, { fadeDuration: matchingRule.fadeInDuration });
      }
      // Same rule still active — do nothing
    } else {
      // No rules match — return to default if we were in conditional mode
      if (currentConditionalId) {
        const prevRule = rules.find((r) => r.id === currentConditionalId);
        if (prevRule) {
          state.stopTrack(prevRule.targetTrackId, prevRule.fadeOutDuration);
        }

        set({ activeConditionalId: null });

        // Fallback behavior
        if (prevRule?.fallback === "default") {
          // Resume playlist
          const ps = state.playlistState;
          if (ps.isPlaying) {
            const order = ps.shuffleOrder.length > 0 ? ps.shuffleOrder : (state.playlist?.tracks ?? []);
            const trackId = order[ps.currentIndex];
            if (trackId) state.playTrack(trackId);
          }
        } else if (prevRule?.fallback && prevRule.fallback !== "previous") {
          // Play specific track
          state.playTrack(prevRule.fallback);
        }
        // "previous" = do nothing, let whatever was playing continue
      }
    }
  },
}));
