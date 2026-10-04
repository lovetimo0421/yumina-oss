/**
 * Voice readout orchestration (parent side).
 *
 * The sandbox can't fetch (`connect-src 'none'`), so speak requests arrive
 * here over the postMessage bridge (world-renderer `tts.speak` case) or from
 * the chat store's auto-readout hook. This module owns the network round-trip
 * (synth → CDN URL) and hands playback to the audio store, which owns the
 * element, ducking and the iOS unlock machinery.
 *
 * Flow: setVoicePlayback(loading) → POST synth → playVoice(url). A serial
 * guards the async gap so stop/replace during synthesis wins.
 */

import { toast } from "sonner";
import i18n from "@/lib/i18n";
import {
  DIALOGUE_SCAN_START,
  defaultTtsVoiceForLang,
  extractDialogueSpans,
  findStreamCut,
  isValidTtsVoice,
  scanDialogueState,
  type DialogueScanState,
  type TtsReadingMode,
  isTtsOptedIn,
  readTtsVoicePool,
  sanitizeTtsVoicePool,
  ttsPoolForLang,
} from "@yumina/shared";
import { consumeTtsUserStop, registerTtsHalt } from "@/lib/tts-stop-signal";
import { useAudioStore } from "@/stores/audio";
import { useUserProfileStore } from "@/stores/user-profile";
import { resolveCardVoice, type CardVoiceWorld } from "@/lib/tts-card-voice";
import { isPartialLeadingSpeakerTag } from "@yumina/engine";

const apiBase = import.meta.env.VITE_API_URL || "";

let _speakSerial = 0;
let _speakController: AbortController | null = null;

// The chat store is imported lazily everywhere in this module (it imports
// this one); once loaded, the read-along path needs it synchronously.
let _chatStore: typeof import("@/stores/chat").useChatStore | null = null;
async function chatStore() {
  if (!_chatStore) _chatStore = (await import("@/stores/chat")).useChatStore;
  return _chatStore;
}
/** The card's voice for a reply, if the card set one — see tts-card-voice. */
function cardVoiceFor(text: string): string | undefined {
  const session = _chatStore?.getState().session;
  const world = session?.world?.schema as CardVoiceWorld | undefined;
  return resolveCardVoice(world, text);
}
/** What was actually said, for the speaker resolver: the live stream is raw,
 *  a stored reply keeps its tag only in the active swipe's rawContent. */
function messageTextFor(messageId: string | undefined): string {
  if (!messageId || !_chatStore) return "";
  const m = _chatStore.getState().messages.find((x) => x.id === messageId);
  if (!m) return "";
  const swipe = m.swipes?.[m.activeSwipeIndex ?? 0];
  return swipe?.rawContent ?? m.content;
}

export interface TtsPrefs {
  enabled: boolean;
  autoPlay: boolean;
  /** The player's own voice: their first pool voice for the UI language,
   *  else the default for it. Narration falls back to it; the server casts
   *  characters from the pool itself (read from stored preferences). */
  voice: string;
  mode: TtsReadingMode;
}

/** Read the account's TTS preferences with the same absent-means-default
 *  conventions as the settings page. */
export function getTtsPrefs(): TtsPrefs {
  const prefs = useUserProfileStore.getState().profile?.preferences ?? {};
  const uiLang = (i18n.language ?? "en").toLowerCase().slice(0, 2);
  const own = ttsPoolForLang(readTtsVoicePool(prefs), uiLang)[0] ?? "";
  return {
    enabled: isTtsOptedIn(prefs),
    autoPlay: prefs.ttsAutoPlay === true,
    voice: own || defaultTtsVoiceForLang(i18n.language),
    mode: prefs.ttsMode === "dialogue" ? "dialogue" : "full",
  };
}

// ── Voice casting ───────────────────────────────────────────────────
// The server decides who says each line and which voice a new speaker gets
// (lib/tts/cast.ts). The voices it hands out are remembered per session so
// a character keeps their voice for the whole game: in memory, mirrored to
// localStorage so a reload doesn't recast everyone.

const _casts = new Map<string, Record<string, string>>();
const castStorageKey = (sessionId: string) => `yumina:tts-cast:${sessionId}`;

function castFor(sessionId: string): Record<string, string> {
  let cast = _casts.get(sessionId);
  if (!cast) {
    cast = {};
    try {
      const raw = localStorage.getItem(castStorageKey(sessionId));
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") cast[k] = v;
      }
    } catch { /* storage unavailable: memory only */ }
    _casts.set(sessionId, cast);
  }
  return cast;
}

function rememberCast(sessionId: string, cast: unknown): void {
  if (!cast || typeof cast !== "object") return;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(cast as Record<string, unknown>)) if (typeof v === "string") next[k] = v;
  _casts.set(sessionId, next);
  try { localStorage.setItem(castStorageKey(sessionId), JSON.stringify(next)); } catch { /* memory only */ }
}

/** A cast readout comes back as several clips (one per voice). A slice keeps
 *  them in its single result slot, newline-joined (URLs never contain one). */
function readoutUrls(body: { url?: string; segments?: Array<{ url?: string }> }): string[] {
  const urls = Array.isArray(body.segments) ? body.segments.map((seg) => seg.url ?? "").filter(Boolean) : [];
  return urls.length > 0 ? urls : body.url ? [body.url] : [];
}

export interface SpeakOptions {
  messageId?: string;
  text?: string;
  /** Playback identity for button state — defaults to messageId. */
  key?: string;
  /** Per-call voice override (cards may voice their own characters). */
  voice?: string;
}

/** What to tell the player when a readout can't be paid for (HTTP 402):
 *  no mushies, a BYOK player with neither an OpenRouter key nor mushies, or
 *  their own OpenRouter key out of balance. */
export function ttsPaymentMessage(code: string): string {
  if (code === "TTS_NEEDS_KEY_OR_CREDITS") {
    return i18n.t("chat:tts.needsKeyOrCredits", "Voice readout needs an OpenRouter key or mushies.");
  }
  if (code === "BYOK_INSUFFICIENT_BALANCE") {
    return i18n.t("chat:tts.byokNoBalance", "Your API key has insufficient balance.");
  }
  return i18n.t("chat:tts.noCredits", "Not enough mushies for this readout.");
}

/** Toast for a failed synth. Payment/limit/empty cases are handled by the
 *  callers; this covers everything that would otherwise just be silence. */
function toastSynthFailure(status: number, code: string): void {
  if (code === "BYOK_KEY_INVALID") {
    toast.error(i18n.t("chat:tts.keyInvalid", "Your OpenRouter key was rejected. Check it in Settings."));
  } else if (code === "NO_API_KEY") {
    toast.error(i18n.t("chat:tts.noKey", "Voice readout needs an API key. Add one in Settings."));
  } else if (code === "VOICE_UNAVAILABLE") {
    toast.error(i18n.t("chat:tts.voiceUnavailable", "This voice is no longer available. Pick another one."));
  } else if (status === 429) {
    toast.error(i18n.t("chat:tts.rateLimited", "Too many voice requests — give it a moment."));
  } else {
    toast.error(i18n.t("chat:tts.failed", "Voice generation failed. Please try again."));
  }
}

export async function speakMessage(
  sessionId: string,
  opts: SpeakOptions,
): Promise<{ ok: boolean; reason?: string }> {
  const serial = ++_speakSerial;
  _speakController?.abort();
  const controller = new AbortController();
  _speakController = controller;
  try {
    return await speakMessageOwned(sessionId, opts, serial, controller);
  } finally {
    if (_speakController === controller) _speakController = null;
  }
}

async function speakMessageOwned(
  sessionId: string,
  opts: SpeakOptions,
  serial: number,
  controller: AbortController,
): Promise<{ ok: boolean; reason?: string }> {
  const audio = useAudioStore.getState();
  const prefs = getTtsPrefs();
  // The master switch is the player's "never spend on voice" — card code
  // calling api.tts.speak doesn't get to override it.
  if (!prefs.enabled) return { ok: false, reason: "disabled" };
  const key = opts.key ?? opts.messageId ?? "custom";
  await chatStore();
  if (serial !== _speakSerial) return { ok: false, reason: "superseded" };
  // A card's explicit per-call voice, then the voice the card gave the
  // speaker (or its narrator), then the player's own choice.
  const cardVoice = cardVoiceFor(opts.text ?? messageTextFor(opts.messageId));
  const voice = opts.voice && isValidTtsVoice(opts.voice) ? opts.voice : cardVoice ?? prefs.voice;

  // Free replay: if this exact message was just auto-read with the same
  // voice and reading mode, replay the recorded slice sequence from the CDN
  // cache — zero synth calls. (A whole-message synth would hash to a
  // DIFFERENT cache key than the slices, i.e. a fresh billed synthesis.)
  if (opts.messageId && !opts.text) {
    const entry = _stitchCache.get(opts.messageId);
    // Same words too: regenerating keeps the message id (a new swipe), and an
    // edit or a swipe switch changes the text under it.
    if (
      entry &&
      entry.voice === voice &&
      entry.mode === prefs.mode &&
      entry.text === messageTextFor(opts.messageId) &&
      entry.urls.length > 0
    ) {
      playSequence(sessionId, entry.urls, key, entry.voice, entry.mode, opts.messageId, entry.text);
      return { ok: true };
    }
  }

  // A manual readout replaces an auto-read in progress — otherwise the queue
  // plays its next slice over (or after) this one.
  if (_stream) {
    cancelStreamRead();
    if (audio.voicePlayback?.key.startsWith("stream:")) audio.stopVoice();
  }
  audio.setVoicePlayback({ key, status: "loading" });

  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/sessions/${sessionId}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({
        messageId: opts.messageId,
        text: opts.text,
        voice,
        // A card's or custom voice can be deleted upstream; the server
        // retries once with the player's own.
        ...(voice !== prefs.voice ? { fallbackVoice: prefs.voice } : {}),
        mode: prefs.mode,
        // A card naming its own voice for this call keeps it; everything
        // else is cast line by line.
        ...(opts.voice ? {} : { casting: true, playerVoice: prefs.voice, cast: castFor(sessionId) }),
      }),
    });
  } catch {
    if (serial !== _speakSerial || controller.signal.aborted) return { ok: false, reason: "superseded" };
    if (serial === _speakSerial) audio.setVoicePlayback(null);
    toast.error(i18n.t("chat:tts.failed", "Voice generation failed. Please try again."));
    return { ok: false, reason: "network" };
  }

  // Cancellation prevents obsolete client work and playback. A provider
  // request already accepted by the server can still complete and be billed.
  if (serial !== _speakSerial) return { ok: false, reason: "superseded" };

  if (!res.ok) {
    useAudioStore.getState().setVoicePlayback(null);
    let code = "";
    let message = "";
    try {
      const body = (await res.json()) as { code?: string; error?: string };
      code = body.code ?? "";
      message = body.error ?? "";
    } catch { /* non-JSON error body */ }
    if (serial !== _speakSerial) return { ok: false, reason: "superseded" };

    if (code === "INSUFFICIENT_CREDITS" || res.status === 402) {
      toast.error(ttsPaymentMessage(code));
      return { ok: false, reason: "insufficient" };
    }
    if (res.status === 429) {
      toast.error(i18n.t("chat:tts.rateLimited", "Too many voice requests — give it a moment."));
      return { ok: false, reason: "rate-limited" };
    }
    if (code === "EMPTY_TEXT") {
      toast.info(i18n.t("chat:tts.nothingToRead", "Nothing readable in this message."));
      return { ok: false, reason: "empty" };
    }
    console.warn("[TTS] synth failed:", res.status, message);
    toastSynthFailure(res.status, code);
    return { ok: false, reason: "error" };
  }

  let urls: string[] = [];
  let credits = 0;
  try {
    const body = (await res.json()) as { url?: string; segments?: Array<{ url?: string }>; cast?: unknown; credits?: number };
    urls = readoutUrls(body);
    rememberCast(sessionId, body.cast);
    credits = typeof body.credits === "number" ? body.credits : 0;
  } catch { /* fall through to the empty guard */ }
  if (serial !== _speakSerial) return { ok: false, reason: "superseded" };
  if (urls.length === 0) {
    useAudioStore.getState().setVoicePlayback(null);
    return { ok: false, reason: "error" };
  }

  // A paid synth changed the wallet — refresh so the model pill's mushie
  // count reflects it instead of going stale until the next chat turn.
  if (credits > 0) {
    void import("@/edition/slots.state")
      .then((m) => m.useCreditStore.getState().fetchCredits())
      .catch(() => {});
  }

  if (serial !== _speakSerial) return { ok: false, reason: "superseded" };
  if (urls.length > 1) {
    // Several speakers → several clips, played back to back.
    playSequence(sessionId, urls, key, voice, prefs.mode, opts.messageId ?? null, "");
  } else {
    useAudioStore.getState().playVoice(key, `${apiBase}${urls[0]}`);
  }
  return { ok: true };
}

/** Play already-synthesized clips in order under one button key (a stitched
 *  auto-read replay, or a multi-voice readout). */
function playSequence(
  sessionId: string,
  urls: string[],
  key: string,
  voice: string,
  mode: TtsReadingMode,
  messageId: string | null,
  sourceText: string,
): void {
  cancelStreamRead();
  useAudioStore.getState().stopVoice();
  const results = new Map<number, string | null>();
  urls.forEach((u, i) => results.set(i, u));
  _stream = {
    serial: ++_streamSerial,
    sessionId,
    voice,
    fallbackVoice: voice,
    dialogueOnly: mode === "dialogue",
    offset: 0,
    totalChars: 0,
    results,
    sliceUrls: [...urls],
    sliceCount: urls.length,
    synthInFlight: 0,
    nextPlayIndex: 0,
    inputClosed: true,
    scanState: DIALOGUE_SCAN_START,
    anyAudible: true,
    incomplete: false,
    fallbackFull: false,
    messageId,
    sourceText,
    stitchRecorded: true,
    voiceResolved: true,
    playKey: key,
    failureNotified: false,
    pending: [],
  };
  pumpPlay(_stream);
}

export function stopSpeaking(): void {
  _speakSerial++;
  _speakController?.abort();
  _speakController = null;
  cancelStreamRead();
  useAudioStore.getState().stopVoice();
}
registerTtsHalt(stopSpeaking);

// ── In-chat voice panel: preference writes ──────────────────────────

let _prefsPatch: Record<string, unknown> = {};
let _prefsFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Apply a partial TTS preference update from the in-chat voice panel.
 * Optimistic: the profile store updates immediately (which re-pushes the
 * sandbox UI channel and, for volume, flows into the audio store through the
 * app-shell effect); the PATCH is debounced so slider drags don't spam the API.
 */
export function applyTtsPrefs(partial: Record<string, unknown>): void {
  // Voice readout is opted into from Settings › Display only. Until then the
  // in-chat panel isn't shown and card calls change nothing; after, the panel
  // can tune it or switch it back off, but never on.
  if (!getTtsPrefs().enabled) return;
  const patch: Record<string, unknown> = {};
  if (partial.enabled === false) patch.ttsEnabled = false;
  if (typeof partial.autoPlay === "boolean") patch.ttsAutoPlay = partial.autoPlay;
  if (partial.mode === "full" || partial.mode === "dialogue") patch.ttsMode = partial.mode;
  if (typeof partial.voice === "string" && (partial.voice === "" || isValidTtsVoice(partial.voice))) {
    patch.ttsVoice = partial.voice;
    patch.ttsVoicePool = partial.voice ? [partial.voice] : [];
  }
  if (Array.isArray(partial.voicePool)) patch.ttsVoicePool = sanitizeTtsVoicePool(partial.voicePool);
  if (typeof partial.volume === "number" && Number.isFinite(partial.volume)) {
    patch.ttsVolume = Math.max(0, Math.min(100, Math.round(partial.volume)));
  }
  if (Object.keys(patch).length === 0) return;

  // Turning the master switch off silences everything, immediately. Turning
  // auto-read off cancels the live read-along queue (current slice included)
  // without touching an unrelated manual/preview playback.
  if (partial.enabled === false) {
    stopSpeaking();
  } else if (partial.autoPlay === false && _stream && !_stream.playKey) {
    cancelStreamRead();
    const playback = useAudioStore.getState().voicePlayback;
    if (playback?.key.startsWith("stream:")) useAudioStore.getState().stopVoice();
  }

  queuePreferencePatch(patch);
}

/** Voice-input prefs from the in-chat voice panel. `mode` "" = follow the card. */
export function applyVoiceInputPrefs(partial: Record<string, unknown>): void {
  const patch: Record<string, unknown> = {};
  if (typeof partial.enabled === "boolean") patch.voiceInputEnabled = partial.enabled;
  if (partial.mode === "" || partial.mode === "confirm" || partial.mode === "auto") patch.voiceInputMode = partial.mode;
  if (typeof partial.key === "string" && partial.key.length > 0 && partial.key.length <= 32) patch.voiceInputKey = partial.key;
  if (Object.keys(patch).length === 0) return;
  queuePreferencePatch(patch);
}

/** Optimistic profile update (the sandbox UI channel re-pushes at once) and
 *  a debounced PATCH, so slider drags don't spam the API. */
function queuePreferencePatch(patch: Record<string, unknown>): void {
  const store = useUserProfileStore.getState();
  if (store.profile) {
    useUserProfileStore.setState({
      profile: {
        ...store.profile,
        preferences: { ...store.profile.preferences, ...patch },
      },
    });
  }

  _prefsPatch = { ..._prefsPatch, ...patch };
  if (_prefsFlushTimer) clearTimeout(_prefsFlushTimer);
  _prefsFlushTimer = setTimeout(() => {
    const body = _prefsPatch;
    _prefsPatch = {};
    _prefsFlushTimer = null;
    void fetch(`${apiBase}/api/users/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ preferences: body }),
    })
      .then((res) => {
        if (!res.ok) {
          console.warn("[TTS] pref save failed:", res.status);
          void useUserProfileStore.getState().forceFetchProfile();
        }
      })
      .catch(() => {});
  }, 400);
}

/** Voice-picker preview (no session required). Players only hear one after
 *  opting in to voice readout; the Studio voice pickers pass
 *  `purpose: "editor"` — a creator auditioning a character's voice. */
export async function previewVoice(
  voiceId: string,
  lang: string,
  opts: { purpose?: "editor" } = {},
): Promise<{ ok: boolean; reason?: string }> {
  if (opts.purpose !== "editor" && !getTtsPrefs().enabled) return { ok: false, reason: "disabled" };
  const serial = ++_speakSerial;
  _speakController?.abort();
  const controller = new AbortController();
  _speakController = controller;
  cancelStreamRead();
  useAudioStore.getState().stopVoice();
  const key = `preview:${voiceId || "auto"}`;
  const voice = voiceId && isValidTtsVoice(voiceId) ? voiceId : defaultTtsVoiceForLang(lang);
  try {
    const res = await fetch(`${apiBase}/api/tts/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({ voice, lang, ...(opts.purpose ? { purpose: opts.purpose } : {}) }),
    });
    if (serial !== _speakSerial) return { ok: false, reason: "superseded" };
    if (!res.ok) {
      let code = "";
      try {
        code = ((await res.json()) as { code?: string }).code ?? "";
      } catch { /* non-JSON error body */ }
      if (serial !== _speakSerial) return { ok: false, reason: "superseded" };
      if (res.status === 402) {
        toast.error(ttsPaymentMessage(code));
        return { ok: false, reason: "insufficient" };
      }
      toastSynthFailure(res.status, code);
      return { ok: false, reason: "error" };
    }
    const body = (await res.json()) as { url?: string; credits?: number };
    if (serial !== _speakSerial) return { ok: false, reason: "superseded" };
    if (!body.url) {
      toastSynthFailure(res.status, "");
      return { ok: false, reason: "error" };
    }
    if ((body.credits ?? 0) > 0) {
      void import("@/edition/slots.state")
        .then((m) => m.useCreditStore.getState().fetchCredits())
        .catch(() => {});
    }
    useAudioStore.getState().playVoice(key, `${apiBase}${body.url}`);
    return { ok: true };
  } catch {
    if (serial !== _speakSerial || controller.signal.aborted) return { ok: false, reason: "superseded" };
    toastSynthFailure(0, "");
    return { ok: false, reason: "network" };
  } finally {
    if (_speakController === controller) _speakController = null;
  }
}

// ── Streaming read-along ────────────────────────────────────────────
//
// "The reply starts SPEAKING while it is still being written." With auto-read
// on, the manager watches the chat store's streaming text, slices completed
// sentences off as they arrive, synthesizes them (up to two in flight, ahead
// of playback) and plays them strictly in order. The first line is usually
// audible within a couple of seconds of generation starting.
//
// Slicing is quote-aware (shared scanner in @yumina/shared): a cut never
// lands inside an open quote, so dialogue-only mode can't lose a line to a
// slice boundary; a runaway quote is force-cut with its open-quote state
// carried into the next slice, and both halves still extract as dialogue.
//
// Billing note: each slice is a normal /tts call — cached and billed per
// slice, with a per-call 0.1-mushie round-up. Later slices wait for more
// text (STREAM_RELAXED_SLICE_CHARS) while playback has lookahead, keeping
// the call count low. When every slice of a message succeeds, the ordered
// slice URLs are recorded so replaying that message from its speaker button
// re-plays the sequence from the CDN cache for free — a whole-message synth
// would hash to a different cache key and bill the full text again.

/** Total characters read per message under auto-read (cost ceiling ≈135🍄 zh). */
const STREAM_CHAR_BUDGET = 4000;
/** Minimum slice length for the FIRST audible slice (and whenever playback
 *  is about to starve) — small, so the voice starts fast. */
const STREAM_MIN_SLICE_CHARS = 15;
/** Preferred slice length once playback has lookahead — fewer synth calls,
 *  less per-call rounding overhead, better prosody. */
const STREAM_RELAXED_SLICE_CHARS = 80;
const STREAM_MAX_SYNTH_IN_FLIGHT = 2;
/** Force a cut (even mid-quote, carrying scan state) past this many unsliced
 *  chars, so a never-closing quote can't stall the readout. */
const STREAM_MAX_HOLD_CHARS = 600;
/** Rate-limited slices retry after the server's Retry-After instead of being
 *  silently skipped (a skipped slice is an unread sentence). */
const STREAM_SYNTH_RETRIES = 2;

interface StreamReadSession {
  serial: number;
  sessionId: string;
  voice: string;
  /** The player's own voice, for when a card voice is gone upstream. */
  fallbackVoice: string;
  dialogueOnly: boolean;
  /** Chars of streamingContent already sliced off. */
  offset: number;
  /** Total chars enqueued (budget guard). */
  totalChars: number;
  /** Slice results by index; synths resolve out of order. */
  results: Map<number, string | null>; // url, or null = skipped/failed
  /** Slice URLs by index, kept for stitched replay: url, "" skipped, null failed. */
  sliceUrls: Array<string | null>;
  sliceCount: number;
  synthInFlight: number;
  nextPlayIndex: number;
  /** No more slices will be added (stream finished). */
  inputClosed: boolean;
  /** Quote-scan state at `offset`, carried across slices so a quote split by
   *  a forced cut still extracts as dialogue in both halves. */
  scanState: DialogueScanState;
  /** Dialogue mode: some slice produced speakable dialogue. */
  anyAudible: boolean;
  /** Budget-clipped or a slice failed — a stitched replay would have holes. */
  incomplete: boolean;
  /** Dialogue mode found no dialogue in the whole reply → full-text fallback
   *  (mirrors the server's "no quotes → read everything"). */
  fallbackFull: boolean;
  /** Persisted message this readout corresponds to (rawContent match). */
  messageId: string | null;
  /** The raw reply text the readout was cut from (stitch-cache validity). */
  sourceText: string;
  stitchRecorded: boolean;
  /** The card's voice for this reply is decided once the speaker tag has
   *  fully arrived; until then no slice is cut. */
  voiceResolved: boolean;
  /** Stitched replays: fixed playback key (the message id) for button state. */
  playKey: string | null;
  /** A failure was already toasted — one per readout, not one per slice. */
  failureNotified: boolean;
  /** The rest of the current slice's clips (a slice read in several voices). */
  pending: string[];
}

let _stream: StreamReadSession | null = null;
let _streamSerial = 0;
let _watcherInstalled = false;

/** Ordered slice URLs of fully-successful auto-readouts, so the message's
 *  speaker button replays them free instead of re-billing a full synth. */
const _stitchCache = new Map<
  string,
  { voice: string; mode: TtsReadingMode; text: string; urls: string[] }
>();
const STITCH_CACHE_MAX = 30;

function cancelStreamRead(): void {
  if (_stream) {
    _streamSerial++;
    _stream = null;
  }
}

function streamSliceKey(s: StreamReadSession, index: number): string {
  return s.playKey ?? `stream:${s.serial}:${index}`;
}

function openStreamSession(sessionId: string, prefs: TtsPrefs): void {
  useAudioStore.getState().stopVoice();
  _stream = {
    serial: ++_streamSerial,
    sessionId,
    voice: prefs.voice,
    fallbackVoice: prefs.voice,
    dialogueOnly: prefs.mode === "dialogue",
    offset: 0,
    totalChars: 0,
    results: new Map(),
    sliceUrls: [],
    sliceCount: 0,
    synthInFlight: 0,
    nextPlayIndex: 0,
    inputClosed: false,
    scanState: DIALOGUE_SCAN_START,
    anyAudible: false,
    incomplete: false,
    fallbackFull: false,
    messageId: null,
    sourceText: "",
    stitchRecorded: false,
    voiceResolved: false,
    playKey: null,
    failureNotified: false,
    pending: [],
  };
}

/** The persisted row whose active swipe's raw content equals what we just
 *  streamed — self-validating (a wrong-message binding is impossible), and
 *  degrades to "no stitch entry" when the server normalized the text. */
function findMessageIdByRawContent(
  messages: Array<{
    id: string;
    role: string;
    activeSwipeIndex?: number;
    swipes?: Array<{ rawContent?: string }>;
  }>,
  raw: string,
): string | null {
  if (!raw) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    if (m.swipes?.[m.activeSwipeIndex ?? 0]?.rawContent === raw) return m.id;
  }
  return null;
}

/** Record the slice sequence for free replay once every synth has resolved
 *  successfully and the readout covered the whole message. */
function maybeRecordStitch(s: StreamReadSession): void {
  if (s.stitchRecorded || s.playKey) return;
  if (!s.inputClosed || s.synthInFlight > 0) return;
  if (!s.messageId || s.incomplete) return;
  const urls: string[] = [];
  for (let i = 0; i < s.sliceCount; i++) {
    const u = s.sliceUrls[i];
    if (typeof u !== "string") return; // failed or still unresolved
    if (u) urls.push(...u.split("\n"));
  }
  if (urls.length === 0) return;
  s.stitchRecorded = true;
  _stitchCache.delete(s.messageId);
  _stitchCache.set(s.messageId, {
    voice: s.voice,
    mode: s.dialogueOnly ? "dialogue" : "full",
    text: s.sourceText,
    urls,
  });
  while (_stitchCache.size > STITCH_CACHE_MAX) {
    const oldest = _stitchCache.keys().next().value;
    if (oldest === undefined) break;
    _stitchCache.delete(oldest);
  }
}

/** Synthesize one slice. Dialogue mode extracts quoted speech client-side
 *  (with cross-slice quote state) so narration slices skip the billed call. */
function pumpSynth(s: StreamReadSession, text: string, initialState: DialogueScanState): void {
  const index = s.sliceCount++;
  let body = text;
  if (s.dialogueOnly && !s.fallbackFull) {
    body = extractDialogueSpans(text, { initialState, paragraph: "double" })
      .spans.map((sp) => sp.text)
      .join("\n");
  }
  if (!body.trim()) {
    s.results.set(index, null); // narration-only slice in dialogue mode
    s.sliceUrls[index] = "";
    return;
  }
  if (s.dialogueOnly) s.anyAudible = true;
  s.synthInFlight++;

  const fail = (status?: number, code = "") => {
    s.synthInFlight--;
    s.results.set(index, null);
    s.sliceUrls[index] = null;
    s.incomplete = true;
    if (status !== undefined) console.warn("[TTS] stream slice synth failed:", status, code);
    // Say so once — a silently skipped sentence reads as "voice is broken".
    if (!s.failureNotified && !s.playKey) {
      s.failureNotified = true;
      toastSynthFailure(status ?? 0, code);
    }
    maybeRecordStitch(s);
    pumpPlay(s);
  };

  const attempt = (retriesLeft: number) => {
    void fetch(`${apiBase}/api/sessions/${s.sessionId}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        text: body,
        voice: s.voice,
        ...(s.voice !== s.fallbackVoice ? { fallbackVoice: s.fallbackVoice } : {}),
        // Dialogue-only slices lose the narration that says HOW a line is
        // said; send it along for the emotion judge.
        ...(body !== text ? { context: text } : {}),
        casting: true,
        playerVoice: s.fallbackVoice,
        cast: castFor(s.sessionId),
        dialogueOnly: s.dialogueOnly && !s.fallbackFull,
      }),
    })
      .then(async (res) => {
        if (_stream !== s) return;
        if (res.status === 429 && retriesLeft > 0) {
          // Rate-limited (shared side-call window) — a skipped slice is an
          // unread sentence, so wait out Retry-After and try again.
          let retryAfter = 5;
          try {
            const b = (await res.json()) as { retryAfter?: number };
            if (typeof b.retryAfter === "number") retryAfter = b.retryAfter;
          } catch { /* default delay */ }
          const delayMs = Math.min(Math.max(retryAfter, 1), 15) * 1000;
          setTimeout(() => {
            if (_stream === s) attempt(retriesLeft - 1);
          }, delayMs);
          return;
        }
        if (!res.ok) {
          let code = "";
          try {
            code = ((await res.json()) as { code?: string }).code ?? "";
          } catch { /* non-JSON error body */ }
          if (_stream !== s) return;
          if (res.status === 402) {
            s.synthInFlight--;
            s.results.set(index, null);
            s.sliceUrls[index] = null;
            s.incomplete = true;
            toast.error(ttsPaymentMessage(code));
            cancelStreamRead();
            return;
          }
          fail(res.status, code);
          return;
        }
        let payload: { url?: string; segments?: Array<{ url?: string }>; cast?: unknown; credits?: number } = {};
        try {
          payload = (await res.json()) as typeof payload;
        } catch { /* fall through to the !url guard */ }
        rememberCast(s.sessionId, payload.cast);
        if (_stream !== s) return;
        const clips = readoutUrls(payload);
        const url = clips.length > 0 ? clips.join("\n") : null;
        if (!url) {
          fail();
          return;
        }
        s.synthInFlight--;
        s.results.set(index, url);
        s.sliceUrls[index] = url;
        if ((payload.credits ?? 0) > 0) {
          void import("@/edition/slots.state")
            .then((m) => m.useCreditStore.getState().fetchCredits())
            .catch(() => {});
        }
        maybeRecordStitch(s);
        pumpPlay(s);
      })
      .catch(() => {
        if (_stream !== s) return;
        fail();
      });
  };
  attempt(STREAM_SYNTH_RETRIES);
}

/** Play the next ready slice if the voice lane is idle. */
function pumpPlay(s: StreamReadSession): void {
  if (_stream !== s) return;
  const audio = useAudioStore.getState();
  // Something (ours or not) is already sounding or loading — wait for idle.
  if (audio.voicePlayback) return;
  if (s.pending.length > 0) {
    const next = s.pending.shift()!;
    audio.playVoice(`${streamSliceKey(s, s.nextPlayIndex - 1)}:${s.pending.length}`, `${apiBase}${next}`);
    return;
  }
  while (s.results.has(s.nextPlayIndex)) {
    const joined = s.results.get(s.nextPlayIndex)!;
    s.results.delete(s.nextPlayIndex);
    const index = s.nextPlayIndex++;
    if (joined) {
      const [first, ...rest] = joined.split("\n");
      s.pending = rest;
      audio.playVoice(streamSliceKey(s, index), `${apiBase}${first}`);
      return;
    }
    // skipped slice — fall through to the next one
  }
  // Nothing left and input closed → session complete.
  if (s.inputClosed && s.synthInFlight === 0 && s.nextPlayIndex >= s.sliceCount) {
    maybeRecordStitch(s);
    if (_stream === s) _stream = null;
  }
}

/** Slice completed sentences off the unspoken stream text (quote-aware). */
function harvestSlices(s: StreamReadSession, streamedText: string, flushAll: boolean): void {
  if (!s.voiceResolved) {
    // The tag that names the speaker is the first thing the model writes.
    // Wait for it to finish arriving rather than reading the first sentence
    // in the wrong voice — unless the stream is over, in which case what we
    // have is all there is.
    if (!flushAll && isPartialLeadingSpeakerTag(streamedText)) return;
    s.voice = cardVoiceFor(streamedText) ?? s.voice;
    s.voiceResolved = true;
  }
  const unspoken = streamedText.slice(s.offset);
  if (!unspoken) return;
  if (s.totalChars >= STREAM_CHAR_BUDGET) {
    if (flushAll && unspoken.trim()) s.incomplete = true; // tail never read
    return;
  }

  let sliceEnd = -1;
  let stateAtCut: DialogueScanState | null = null;
  if (flushAll) {
    sliceEnd = unspoken.length;
  } else {
    // First slice (or playback about to starve): cut small so the voice
    // starts fast. Otherwise wait for a meatier slice — fewer synth calls,
    // less rounding overhead, better prosody.
    const queuedAhead = s.sliceCount - s.nextPlayIndex;
    const minChars =
      s.sliceCount === 0 || queuedAhead <= 0
        ? STREAM_MIN_SLICE_CHARS
        : STREAM_RELAXED_SLICE_CHARS;
    const cut = findStreamCut(unspoken, {
      minChars,
      initialState: s.scanState,
      paragraph: "double",
    });
    if (cut.clean) {
      sliceEnd = cut.clean.end;
      stateAtCut = cut.clean.state;
    } else if (unspoken.length > STREAM_MAX_HOLD_CHARS && cut.raw) {
      // Runaway open quote — force a cut and carry the open-quote state so
      // the next slice still extracts the second half as dialogue.
      sliceEnd = cut.raw.end;
      stateAtCut = cut.raw.state;
    }
  }
  if (sliceEnd <= 0) return;

  let slice = unspoken.slice(0, sliceEnd);
  if (s.totalChars + slice.length > STREAM_CHAR_BUDGET) {
    slice = slice.slice(0, STREAM_CHAR_BUDGET - s.totalChars);
    stateAtCut = null; // recomputed below for the clipped prefix
    s.incomplete = true; // dropped tail — stitched replay would have holes
  }
  // Lookahead saturated mid-stream → postpone; the next streaming tick
  // re-harvests. The final flush NEVER postpones (there is no next tick).
  if (!flushAll && slice.trim() && s.synthInFlight >= STREAM_MAX_SYNTH_IN_FLIGHT) {
    return;
  }
  const initialState = s.scanState;
  s.offset += sliceEnd;
  s.totalChars += slice.length;
  s.scanState = stateAtCut ?? scanDialogueState(slice, initialState, "double");
  if (slice.trim()) pumpSynth(s, slice, initialState);
}

/**
 * Install the read-along watcher (idempotent). Called once from the chat
 * renderer; watches the chat store for streaming turns and the audio store
 * for playback-idle transitions to chain slices.
 */
export function ensureStreamReadAlong(): void {
  if (_watcherInstalled) return;
  _watcherInstalled = true;

  void import("@/stores/chat").then(({ useChatStore }) => {
    _chatStore = useChatStore;
    useChatStore.subscribe((state, prev) => {
      // Turn started streaming → open a read-along session if auto-read is on.
      if (state.isStreaming && !prev.isStreaming) {
        consumeTtsUserStop(); // stale-flag hygiene
        cancelStreamRead();
        const prefs = getTtsPrefs();
        const sessionId = state.session?.id;
        if (!prefs.enabled || !prefs.autoPlay || !sessionId) return;
        openStreamSession(sessionId, prefs);
        return;
      }

      const s = _stream;
      if (!s || s.inputClosed) return;

      // Mid-stream: harvest completed sentences as they accumulate.
      if (state.isStreaming && state.streamingContent !== prev.streamingContent) {
        harvestSlices(s, state.streamingContent, false);
        return;
      }

      // Stream ended: flush the tail (from the PREVIOUS state — the store
      // clears streamingContent in the same update), then let playback drain.
      if (!state.isStreaming && prev.isStreaming) {
        if (consumeTtsUserStop()) {
          // The user hit "stop generating" — stop means stop: cancel the
          // queue (no billed synth of the unread tail) and cut the audio.
          cancelStreamRead();
          const playback = useAudioStore.getState().voicePlayback;
          if (playback?.key.startsWith("stream:")) useAudioStore.getState().stopVoice();
          return;
        }
        if (state.error == null) {
          const rawText = prev.streamingContent;
          harvestSlices(s, rawText, true);
          // Dialogue mode found no dialogue anywhere in the reply → read the
          // full text instead of staying silent (mirrors the server-side
          // fallback the manual speaker button gets).
          if (s.dialogueOnly && !s.anyAudible && rawText.trim()) {
            s.fallbackFull = true;
            s.offset = 0;
            s.totalChars = 0;
            s.incomplete = false;
            harvestSlices(s, rawText, true);
          }
          // Bind the readout to the persisted message for free replay.
          s.messageId = findMessageIdByRawContent(state.messages, rawText);
          s.sourceText = rawText;
        }
        s.inputClosed = true;
        maybeRecordStitch(s);
        pumpPlay(s);
      }
    });

    // Late install: a turn may already be streaming (world page mounted and
    // the user sent immediately) — the rising edge is gone, so open the
    // session now and catch up on what has streamed so far.
    const now = useChatStore.getState();
    if (now.isStreaming && !_stream) {
      const prefs = getTtsPrefs();
      const sessionId = now.session?.id;
      if (prefs.enabled && prefs.autoPlay && sessionId) {
        openStreamSession(sessionId, prefs);
        if (now.streamingContent) harvestSlices(_stream!, now.streamingContent, false);
      }
    }
  });

  // Chain playback: whenever the voice lane goes idle, play the next slice.
  useAudioStore.subscribe((state, prev) => {
    const s = _stream;
    if (!s) return;
    if (prev.voicePlayback && !state.voicePlayback) {
      pumpPlay(s);
    }
  });
}
