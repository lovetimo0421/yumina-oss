import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceEvent } from "../../../sandbox/voice-types";
import { VoiceController, dispatchVoiceCall } from "./voice-controller";
import { createVoiceAudio } from "./voice-audio";
import { createAvatarVoiceAudio } from "./avatar-voice-audio";
import type { VoiceConsentRequest } from "./voice-consent";

export function useWorldVoice(options: { sessionId: string; enabled: boolean; onEvent: (event: VoiceEvent) => void }) {
  const latest = useRef(options); latest.current = options;
  const [consent, setConsent] = useState<{ sessionId: string; request: VoiceConsentRequest } | null>(null);
  const [status, setStatus] = useState<{ sessionId: string; value: "connecting" | "connected" | "stopped" | "error" }>({ sessionId: options.sessionId, value: "stopped" });
  const controller = useMemo(() => new VoiceController(event => {
    // Render updates latest before passive cleanup stops the previous peer. Fence
    // that interval too: old speech/cleanup must never enter a replacement card.
    if (latest.current.sessionId !== options.sessionId) { if (event.type === "video-frame") event.frame.close(); return; }
    const terminal = event.type === "status" && (event.status === "stopped" || event.status === "error");
    const silence = (event.type === "level" || event.type === "input-level") && event.value === 0;
    if (!latest.current.enabled && !terminal && !silence) { if (event.type === "video-frame") event.frame.close(); return; }
    if (event.type === "status") setStatus({ sessionId: options.sessionId, value: event.status });
    latest.current.onEvent(event);
  }, {
    sessionId: options.sessionId,
    canUse: () => latest.current.enabled && latest.current.sessionId === options.sessionId && document.visibilityState !== "hidden",
    hasUserActivation: () => navigator.userActivation?.isActive === true,
    requestConsent: (signal, prepareAudio, config) => new Promise((resolve, reject) => {
      if (signal.aborted) { resolve(false); return; }
      document.exitPointerLock?.();
      let done = false;
      const finish = (accepted: boolean) => {
        if (done) return;
        done = true; signal.removeEventListener("abort", abort);
        setConsent(current => current?.sessionId === options.sessionId ? null : current);
        if (accepted && !signal.aborted) {
          try { prepareAudio(); } catch (error) { reject(error); return; }
        }
        resolve(accepted);
      };
      const abort = () => finish(false);
      signal.addEventListener("abort", abort, { once: true });
      setConsent({ sessionId: options.sessionId, request: { config, accept: () => finish(true), decline: () => finish(false) } });
    }),
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
    createPeer: () => new RTCPeerConnection(),
    createAudio: (output, input) => createVoiceAudio(output, undefined, input),
    createAvatarAudio: createAvatarVoiceAudio,
    fetch: (...args) => fetch(...args),
    apiBase: import.meta.env?.VITE_API_URL || "",
  }), [options.sessionId]);

  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") controller.stop(); };
    const leaving = () => controller.stop();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    return () => {
      controller.stop();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
    };
  }, [controller]);
  useEffect(() => { if (!options.enabled) controller.stop(); }, [controller, options.enabled]);

  const call = useCallback((method: string, args: unknown[]) => dispatchVoiceCall(controller, method, args), [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  return {
    consent: options.enabled && consent?.sessionId === options.sessionId ? consent.request : null,
    status: status.sessionId === options.sessionId ? status.value : "stopped",
    call, stop,
  };
}
