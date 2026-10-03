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

export type VoiceRecordResult =
  | { ok: true; text: string }
  | { ok: false; reason: "cancelled" | "too-short" | "denied" | "unsupported" | "busy" | "empty" | "rate-limited" | "error" };

interface Recording {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  cancelled: boolean;
  audioCtx: AudioContext | null;
  levelTimer: ReturnType<typeof setInterval> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
}

let _current: Recording | null = null;
/** A start that is still waiting on the permission prompt. */
let _pendingStart = false;
let _cancelPending = false;

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

function release(rec: Recording): void {
  if (rec.levelTimer) clearInterval(rec.levelTimer);
  if (rec.maxTimer) clearTimeout(rec.maxTimer);
  rec.stream.getTracks().forEach((t) => t.stop());
  void rec.audioCtx?.close().catch(() => {});
}

/**
 * Record until `stopVoiceRecording()` (→ transcript) or
 * `cancelVoiceRecording()`. `onLevel` gets 0–1 input loudness ~15×/s.
 */
export async function recordVoice(onLevel: (level: number) => void): Promise<VoiceRecordResult> {
  if (_current || _pendingStart) return { ok: false, reason: "busy" };
  if (!isVoiceInputSupported()) {
    toast.error(i18n.t("chat:voiceInput.unsupported", "This browser can't record audio."));
    return { ok: false, reason: "unsupported" };
  }

  // Don't record the AI's own voice back in.
  haltTts();

  _pendingStart = true;
  _cancelPending = false;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    _pendingStart = false;
    const name = (err as Error)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      toast.error(i18n.t("chat:voiceInput.denied", "The browser blocked the microphone. Allow it from the icon at the left of the address bar."));
      return { ok: false, reason: "denied" };
    }
    toast.error(i18n.t("chat:voiceInput.noMic", "No microphone found."));
    return { ok: false, reason: "unsupported" };
  }
  _pendingStart = false;
  // Released before the permission prompt was answered — a tap, not a hold.
  if (_cancelPending) {
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, reason: "too-short" };
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
  const rec: Recording = {
    stream, recorder, chunks: [], startedAt: Date.now(), cancelled: false,
    audioCtx: null, levelTimer: null, maxTimer: null,
  };
  _current = rec;

  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      rec.audioCtx = new Ctx();
      const analyser = rec.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      rec.audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      rec.levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        // RMS of normal speech sits around 0.02–0.2; stretch it to 0–1.
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      }, LEVEL_INTERVAL_MS);
    }
  } catch { /* the waveform is decoration; recording still works */ }

  const done = new Promise<void>((resolve) => {
    recorder.ondataavailable = (e) => { if (e.data.size > 0) rec.chunks.push(e.data); };
    recorder.onstop = () => resolve();
  });
  recorder.start();
  rec.maxTimer = setTimeout(() => stopVoiceRecording(), MAX_RECORD_MS);

  await done;
  release(rec);
  if (_current === rec) _current = null;

  if (rec.cancelled) return { ok: false, reason: "cancelled" };
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
  if (_pendingStart) { _cancelPending = true; return; }
  const rec = _current;
  if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
}

/** Throw the clip away (slide-up, leaving the chat). */
export function cancelVoiceRecording(): void {
  if (_pendingStart) { _cancelPending = true; return; }
  const rec = _current;
  if (!rec) return;
  rec.cancelled = true;
  if (rec.recorder.state !== "inactive") rec.recorder.stop();
}
