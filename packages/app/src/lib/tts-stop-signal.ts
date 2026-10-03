/**
 * Synchronous handshake between the chat store's stopGeneration and the
 * lazily-loaded TTS read-along watcher (lib/tts-playback).
 *
 * stopGeneration's setState fires store subscribers synchronously, so the
 * watcher sees the isStreaming falling edge BEFORE any dynamic import could
 * resolve — a plain module-scope flag is the only thing fast enough to tell
 * it "this end is a user stop: cancel the readout queue instead of flushing
 * (and billing) the unread tail". Kept dependency-free so chat.ts can import
 * it statically without pulling tts-playback into the main bundle.
 */

let _userStop = false;

/** Called by stopGeneration BEFORE it flips isStreaming off. */
export function signalTtsUserStop(): void {
  _userStop = true;
}

/** Read-and-clear, called by the read-along watcher on stream edges. */
export function consumeTtsUserStop(): boolean {
  const v = _userStop;
  _userStop = false;
  return v;
}

// ── Leaving the chat ────────────────────────────────────────────────
// Navigating away / switching sessions must silence the readout queue, and
// must do it BEFORE the audio store's cleanup clears voicePlayback — that
// idle transition is what chains the next slice. A dynamic import would
// resolve too late, so tts-playback registers its stop here on load; if it
// never loaded, nothing is speaking and there is nothing to stop.

let _halt: (() => void) | null = null;

/** Called once by tts-playback when the module loads. */
export function registerTtsHalt(fn: () => void): void {
  _halt = fn;
}

/** Stop every voice readout (queue, in-flight manual synth, playback). */
export function haltTts(): void {
  _halt?.();
}
