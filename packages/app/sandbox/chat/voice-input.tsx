/**
 * Hold-to-talk voice input for the default chat composer.
 *
 * Hold the mic (or the hold-to-talk key) and speak; let go and the words come
 * back from the host (the sandbox has no microphone — see src/lib/voice-input).
 * Slide up before letting go to throw the clip away. What happens to the text
 * depends on `voiceInputState.mode`: "auto" sends it as spoken — the party-game
 * feel, no send tap — and "confirm" drops it in the composer for review.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { useYumina } from "../sandbox-context";
import { makeChatT } from "./i18n";

type Phase = "idle" | "recording" | "transcribing";

/** Drag this far up (px) before letting go to cancel. */
const CANCEL_DRAG_PX = 60;
const LEVEL_HISTORY = 48;

/** Space stays an ordinary key until the player has recorded once (so the
 *  mic permission is already granted): a stray Space must never pop a
 *  permission prompt or steal a card's own Space controls. */
const SPACE_ARMED_KEY = "yumina:voice-input:space-armed";
let spaceArmed = (() => {
  try { return localStorage.getItem(SPACE_ARMED_KEY) === "1"; } catch { return false; }
})();
function armSpaceShortcut() {
  if (spaceArmed) return;
  spaceArmed = true;
  try { localStorage.setItem(SPACE_ARMED_KEY, "1"); } catch { /* per-page only */ }
}

export function useVoiceInput(onTranscript: (text: string) => void) {
  const api = useYumina();
  const [phase, setPhase] = useState<Phase>("idle");
  const [cancelArmed, setCancelArmed] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [tapHint, setTapHint] = useState(false);
  const levelsRef = useRef<number[]>([]);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const cancelRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const start = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    cancelRef.current = false;
    setCancelArmed(false);
    setTapHint(false);
    levelsRef.current = [];
    setStartedAt(Date.now());
    setPhase("recording");
    phaseRef.current = "recording";
    void api.voice
      .record({
        onLevel: (level) => {
          const h = levelsRef.current;
          h.push(level);
          if (h.length > LEVEL_HISTORY) h.shift();
        },
      })
      .then((result) => {
        setPhase("idle");
        if (result.ok) armSpaceShortcut();
        if (result.ok && result.text) onTranscriptRef.current(result.text);
        else if (result.reason === "too-short") setTapHint(true);
      });
  }, [api.voice]);

  /** Let go: transcribe, or discard if the cancel gesture is armed. */
  const finish = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    if (cancelRef.current) {
      api.voice.cancel();
      return;
    }
    setPhase("transcribing");
    phaseRef.current = "transcribing";
    api.voice.stop();
  }, [api.voice]);

  const cancel = useCallback(() => {
    if (phaseRef.current === "recording") api.voice.cancel();
  }, [api.voice]);

  const armCancel = useCallback((armed: boolean) => {
    cancelRef.current = armed;
    setCancelArmed(armed);
  }, []);

  useEffect(() => {
    if (!tapHint) return;
    const id = window.setTimeout(() => setTapHint(false), 2200);
    return () => window.clearTimeout(id);
  }, [tapHint]);

  // Unmount mid-recording (leaving the chat): drop the clip.
  useEffect(() => () => {
    if (phaseRef.current === "recording") api.voice.cancel();
  }, [api.voice]);

  return { phase, cancelArmed, startedAt, tapHint, levelsRef, start, finish, cancel, armCancel };
}

export type VoiceInputControl = ReturnType<typeof useVoiceInput>;

/** Hold-to-talk keyboard shortcut. Space only counts when you're not typing
 *  somewhere; any other key the player picked works everywhere. */
export function useHoldToTalkKey(code: string, active: boolean, voice: VoiceInputControl) {
  useEffect(() => {
    if (!active) return;
    const isTyping = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || node.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== code || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      // The card already handled this key itself.
      if (e.defaultPrevented) return;
      if (code === "Space" && (!spaceArmed || isTyping(e.target))) return;
      if ((e.target as HTMLElement | null)?.closest?.("button, [role=button], a") && code === "Space") return;
      e.preventDefault();
      voice.start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== code || voice.phase !== "recording") return;
      e.preventDefault();
      voice.finish();
    };
    const blur = () => voice.cancel();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [code, active, voice]);
}

/** The composer's round action button while the box is empty. */
export function MicButton({ voice, disabled }: { voice: VoiceInputControl; disabled?: boolean }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const originY = useRef(0);
  const holding = useRef(false);

  return (
    <div className="relative">
      {voice.tapHint && (
        <span className="pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md">
          {t("micTapHint")}
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        aria-label={t("micHold")}
        title={t("micHold")}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          holding.current = true;
          originY.current = e.clientY;
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
          voice.start();
        }}
        onPointerMove={(e) => {
          if (!holding.current) return;
          voice.armCancel(originY.current - e.clientY > CANCEL_DRAG_PX);
        }}
        onPointerUp={() => {
          if (!holding.current) return;
          holding.current = false;
          voice.finish();
        }}
        onPointerCancel={() => {
          if (!holding.current) return;
          holding.current = false;
          voice.cancel();
        }}
        onKeyDown={(e) => {
          // Keyboard users: Enter toggles recording.
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (voice.phase === "idle") voice.start();
          else voice.finish();
        }}
        style={{ touchAction: "none", WebkitUserSelect: "none", userSelect: "none", WebkitTouchCallout: "none" } as React.CSSProperties}
        className="play-composer-send flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:pointer-events-none disabled:opacity-20"
      >
        <Mic className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Covers the composer card while recording / transcribing. */
export function VoiceRecordingOverlay({ voice, autoSend }: { voice: VoiceInputControl; autoSend: boolean }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (voice.phase !== "recording") return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [voice.phase]);

  useEffect(() => {
    if (voice.phase !== "recording") return;
    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      if (cv) {
        const w = cv.clientWidth;
        const h = cv.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        if (cv.width !== Math.round(w * dpr)) {
          cv.width = Math.round(w * dpr);
          cv.height = Math.round(h * dpr);
        }
        const ctx = cv.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, h);
          const style = getComputedStyle(cv);
          ctx.fillStyle = voice.cancelArmed ? style.getPropertyValue("--mic-muted") || "#6f6b63" : style.color;
          const bars = Math.max(8, Math.floor(w / 5));
          const levels = voice.levelsRef.current;
          for (let i = 0; i < bars; i++) {
            const li = levels.length - bars + i;
            const level = li >= 0 ? levels[li]! : 0;
            const bh = Math.max(2, level * h);
            ctx.fillRect(i * 5, (h - bh) / 2, 3, bh);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [voice.phase, voice.cancelArmed, voice.levelsRef]);

  if (voice.phase === "idle") return null;

  if (voice.phase === "transcribing") {
    return (
      <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-2xl bg-popover text-[13px] text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        {t("micTranscribing")}
      </div>
    );
  }

  const secs = Math.max(0, Math.floor((now - voice.startedAt) / 1000));
  return (
    <div className="absolute inset-0 z-20 flex items-center gap-3 rounded-2xl bg-popover px-4" role="status">
      <span className="pointer-events-none absolute -top-7 left-0 right-0 text-center text-[11.5px]">
        <span className={voice.cancelArmed ? "text-destructive" : "text-muted-foreground"}>
          {voice.cancelArmed ? t("micReleaseCancel") : autoSend ? t("micReleaseSend") : t("micReleaseFill")}
        </span>
      </span>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${voice.cancelArmed ? "bg-muted-foreground" : "bg-destructive animate-pulse"}`}
      />
      <span className="w-9 shrink-0 tabular-nums text-[13px] text-foreground">
        {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
      </span>
      <canvas ref={canvasRef} className="h-7 min-w-0 flex-1 text-primary" aria-hidden="true" />
    </div>
  );
}

