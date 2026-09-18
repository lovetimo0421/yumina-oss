/**
 * Proactive iOS audio unlock.
 *
 * iOS (Safari, Chrome — all WebKit) rejects `HTMLAudioElement.play()` unless a
 * real user gesture is the *synchronous* ancestor of the call. Yumina almost
 * never satisfies this: the user clicks to enter a world, we navigate, fetch,
 * mount, run effects, load session, set tracks, THEN call `new Audio(url).play()`
 * — by then the original gesture is long out of scope and iOS rejects.
 *
 * The fix is to "unlock" iOS's media pipeline during the very first gesture
 * anywhere in the app. After one gesture-scoped `.play()` on a silent buffer,
 * iOS marks the document as media-engaged for the session and subsequent
 * programmatic `.play()` calls succeed. Desktop browsers are unaffected —
 * they already allow these plays without ceremony, so the silent buffer is a
 * no-op cost there.
 *
 * Pairs with the reactive `registerPendingUnlock` in `stores/audio.ts`: this
 * file handles the common case (unlock before any real audio plays);
 * `registerPendingUnlock` handles the edge case (audio was attempted before
 * the user ever gestured — queues for retry).
 */

const SILENT_WAV =
  "data:audio/wav;base64,UklGRhwAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

let _unlocked = false;

/**
 * Install a one-shot gesture listener that plays a silent audio + primes a
 * Web Audio context. Must be called once, as early in app startup as possible
 * (ideally from `main.tsx` as a side-effect import).
 */
export function installAudioUnlock(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (_unlocked) return;

  const unlock = () => {
    if (_unlocked) return;
    _unlocked = true;

    // 1) Silent HTMLAudioElement.play() in gesture scope — unlocks the
    //    element-based audio path used by `new Audio(url).play()` in audio.ts.
    try {
      const a = new Audio(SILENT_WAV);
      a.volume = 0;
      void a.play().catch(() => {});
    } catch { /* noop */ }

    // 2) Web Audio API resume — some creators (and 3rd-party libs) use
    //    AudioContext directly. Create and resume one so it's unlocked too.
    try {
      const Ctor =
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext ??
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        const ctx = new Ctor();
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        void ctx.resume().catch(() => {});
      }
    } catch { /* noop */ }

    document.removeEventListener("touchstart", unlock, true);
    document.removeEventListener("touchend", unlock, true);
    document.removeEventListener("click", unlock, true);
    document.removeEventListener("keydown", unlock, true);
  };

  document.addEventListener("touchstart", unlock, { passive: true, capture: true });
  document.addEventListener("touchend", unlock, { passive: true, capture: true });
  document.addEventListener("click", unlock, { capture: true });
  document.addEventListener("keydown", unlock, { capture: true });
}

/** For diagnostics / conditional UI (e.g., "tap to start" overlay on iOS). */
export function isAudioUnlocked(): boolean {
  return _unlocked;
}
