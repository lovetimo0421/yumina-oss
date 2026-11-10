/**
 * Voice input (hold-to-talk) — parent side.
 *
 * The sandbox iframe has no microphone permission (and an opaque origin that
 * makes granting one messy), so recording lives here, like voice readout's
 * synthesis does. The sandbox asks over the bridge: `voice.record` is a
 * streaming call whose deltas are the live input level (for the waveform)
 * and whose result is the transcript; `voice.stop` / `voice.cancel` end it.
 *
 * Free to the player; the server runs it on the platform key.
 */

import i18n from "@/lib/i18n";
import { toast } from "sonner";
import { haltTts } from "@/lib/tts-stop-signal";

const apiBase = import.meta.env.VITE_API_URL || "";

/** Auto-finish a clip that runs this long (server caps the upload too). */
const MAX_RECORD_MS = 60_000;
/** Shorter than this is a tap, not speech — discard without a request. */
const MIN_RECORD_MS = 350;
const LEVEL_INTERVAL_MS = 66;
const LEVEL_READY_TIMEOUT_MS = 10_000;

type VoiceInputFailure = { ok: false; reason: "cancelled" | "too-short" | "denied" | "unsupported" | "busy" | "empty" | "rate-limited" | "error" | "levels-unavailable" };
export type VoiceRecordResult =
  | { ok: true; text: string }
  | VoiceInputFailure;

export type VoicePrepareResult = { ok: true } | VoiceInputFailure;
interface InputMeter { sample: () => number; close: () => void }
interface InputCapture { stream: MediaStream; meter: InputMeter | null }

interface Recording {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  cancelled: boolean;
  input: InputCapture;
  levelTimer: ReturnType<typeof setInterval> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
}

let _current: Recording | null = null;
/** Permission/analyser preparation owns the lane until it finishes or cancels.
 *  Each attempt has its own signal so a late grant cannot affect its successor. */
let _pendingInput: AbortController | null = null;

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

export function isVoiceInputSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

function releaseInput(input: InputCapture): void {
  input.meter?.close();
  input.stream.getTracks().forEach((t) => t.stop());
}

function release(rec: Recording): void {
  if (rec.levelTimer) clearInterval(rec.levelTimer);
  if (rec.maxTimer) clearTimeout(rec.maxTimer);
  releaseInput(rec.input);
}

async function openMeter(stream: MediaStream, signal: AbortSignal, requireLevels: boolean): Promise<InputMeter | null> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  const close = () => {
    source?.disconnect(); source = null;
    analyser?.disconnect(); analyser = null;
    void context?.close().catch(() => {}); context = null;
  };
  try {
    context = new Ctx();
    const ctx = context;
    // Browsers can leave resume() pending until another user activation.
    // Never leave automatic VAD waiting on zeroes forever.
    if (requireLevels) {
      const running = await new Promise<boolean>((resolve) => {
        const done = (ok: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(ok); };
        const abort = () => done(false);
        const timer = setTimeout(() => done(false), LEVEL_READY_TIMEOUT_MS);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { done(false); return; }
        void ctx.resume().then(() => done(ctx.state === "running"), () => done(false));
      });
      if (!running || signal.aborted) { close(); return null; }
    } else {
      // The hold-to-talk waveform is optional: never delay recording while
      // waiting for another gesture to unlock it.
      void ctx.resume().catch(close);
    }
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const sample = () => {
      if (ctx.state !== "running" || !analyser) throw new Error("Microphone analyser is unavailable");
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const value of buf) sum += ((value - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    };
    if (requireLevels) sample(); // Silence is valid; verify access, not speech.
    return { sample, close };
  } catch { close(); return null; }
}

async function acquireInput(requireLevels: boolean): Promise<{ ok: true; input: InputCapture } | VoiceInputFailure> {
  if (_current || _pendingInput) return { ok: false, reason: "busy" };
  if (!isVoiceInputSupported()) {
    toast.error(i18n.t("chat:voiceInput.unsupported", "This browser can't record audio."));
    return { ok: false, reason: "unsupported" };
  }

  // Don't record the AI's own voice back in.
  haltTts();

  const controller = new AbortController();
  _pendingInput = controller;
  const { signal } = controller;
  try {
    const permission = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // getUserMedia itself cannot be aborted. Settle our caller immediately,
    // then release any stream granted later instead of reopening the mic.
    const stream = await new Promise<MediaStream>((resolve, reject) => {
      const abort = () => reject(new DOMException("Microphone preparation cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      void permission.then((value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) value.getTracks().forEach((track) => track.stop());
        else resolve(value);
      }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort();
    });
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      return { ok: false, reason: "cancelled" };
    }
    const meter = await openMeter(stream, signal, requireLevels);
    const input = { stream, meter };
    if (signal.aborted || (requireLevels && !meter)) {
      releaseInput(input);
      return { ok: false, reason: signal.aborted ? "cancelled" : "levels-unavailable" };
    }
    return { ok: true, input };
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: "cancelled" };
    const name = (err as Error)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      toast.error(i18n.t("chat:voiceInput.denied", "The browser blocked the microphone. Allow it from the icon at the left of the address bar."));
      return { ok: false, reason: "denied" };
    }
    toast.error(i18n.t("chat:voiceInput.noMic", "No microphone found."));
    return { ok: false, reason: "unsupported" };
  } finally {
    if (_pendingInput === controller) _pendingInput = null;
  }
}

/** Check microphone permission and analyser readiness before starting a paid
 *  conversation. Releases the device immediately; never records or transcribes. */
export async function prepareVoiceInput(opts: { requireLevels?: boolean } = {}): Promise<VoicePrepareResult> {
  const result = await acquireInput(opts.requireLevels === true);
  if (!result.ok) return result;
  releaseInput(result.input);
  return { ok: true };
}

/** Record until stop (transcribe) or cancel; measured levels arrive ~15×/s.
 *  Automatic VAD callers requireLevels so analyser failures are terminal. */
export async function recordVoice(onLevel: (level: number) => void, opts: { requireLevels?: boolean } = {}): Promise<VoiceRecordResult> {
  const acquired = await acquireInput(opts.requireLevels === true);
  if (!acquired.ok) return acquired;
  const input = acquired.input;
  const { stream, meter } = input;

  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined); }
  catch { releaseInput(input); return { ok: false, reason: "unsupported" }; }
  const rec: Recording = {
    recorder, chunks: [], startedAt: Date.now(), cancelled: false,
    input, levelTimer: null, maxTimer: null,
  };
  _current = rec;
  let failure: VoiceInputFailure["reason"] | null = null;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
    recorder.ondataavailable = (e) => { if (e.data.size > 0) rec.chunks.push(e.data); };
    recorder.onstop = () => resolve();
    recorder.onerror = () => { failure = "error"; resolve(); };
  });
  try {
    recorder.start();
    if (meter) rec.levelTimer = setInterval(() => {
      try { onLevel(meter.sample()); }
      catch {
        if (opts.requireLevels) { failure = "levels-unavailable"; finish(); }
      }
    }, LEVEL_INTERVAL_MS);
    rec.maxTimer = setTimeout(() => stopVoiceRecording(), MAX_RECORD_MS);
  } catch { failure = "error"; finish(); }

  await done;
  recorder.onstop = null; recorder.onerror = null; recorder.ondataavailable = null;
  if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* release below */ } }
  release(rec);
  if (_current === rec) _current = null;

  if (rec.cancelled) return { ok: false, reason: "cancelled" };
  if (failure) return { ok: false, reason: failure };
  if (Date.now() - rec.startedAt < MIN_RECORD_MS) return { ok: false, reason: "too-short" };
  const blob = new Blob(rec.chunks, { type: (recorder.mimeType || mimeType || "audio/webm").split(";")[0] });
  if (blob.size === 0) return { ok: false, reason: "empty" };
  return transcribe(blob);
}

async function transcribe(blob: Blob): Promise<VoiceRecordResult> {
  const form = new FormData();
  const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
  form.append("file", blob, `clip.${ext}`);
  form.append("lang", (i18n.language || "").slice(0, 2));
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/voice-input`, { method: "POST", credentials: "include", body: form });
  } catch {
    toast.error(i18n.t("chat:voiceInput.failed", "Couldn't turn that into text. Try again."));
    return { ok: false, reason: "error" };
  }
  if (res.status === 429) {
    toast.error(i18n.t("chat:voiceInput.rateLimited", "Too many voice messages at once. Give it a moment."));
    return { ok: false, reason: "rate-limited" };
  }
  if (!res.ok) {
    toast.error(i18n.t("chat:voiceInput.failed", "Couldn't turn that into text. Try again."));
    return { ok: false, reason: "error" };
  }
  const text = ((await res.json().catch(() => ({}))) as { text?: string }).text?.trim() ?? "";
  if (!text) {
    toast.info(i18n.t("chat:voiceInput.heardNothing", "Didn't catch anything. Hold the mic and speak."));
    return { ok: false, reason: "empty" };
  }
  return { ok: true, text };
}

/** Finish the clip and transcribe it. */
export function stopVoiceRecording(): void {
  if (_pendingInput) {
    const pending = _pendingInput;
    _pendingInput = null;
    pending.abort();
    return;
  }
  const rec = _current;
  if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
}

/** Throw the clip away (slide-up, leaving the chat). */
export function cancelVoiceRecording(): void {
  if (_pendingInput) { stopVoiceRecording(); return; }
  const rec = _current;
  if (!rec) return;
  rec.cancelled = true;
  if (rec.recorder.state !== "inactive") rec.recorder.stop();
}
