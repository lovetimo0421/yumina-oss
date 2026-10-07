import { voiceStartContextError, isVoiceSceneReaction, isVoiceSceneReference, isVoiceToolAllowlist, type VoiceAPI, type VoiceEvent } from "./voice-types";

export const VOICE_EVENT = "yumina:voice-event";

/** Own transferred bitmaps until every synchronous consumer has copied the pixels. */
export function dispatchVoiceEvent(event: VoiceEvent, options: {
  available: boolean;
  target: Pick<EventTarget, "dispatchEvent">;
  post(method: string, args: unknown[]): void;
}): void {
  if (event.type !== "video-frame") {
    if (options.available) options.target.dispatchEvent(new CustomEvent(VOICE_EVENT, { detail: event }));
    return;
  }
  try {
    if (options.available) options.target.dispatchEvent(new CustomEvent(VOICE_EVENT, { detail: event }));
  } catch {
    // A broken card consumer must not retain a frame or stall the producer.
  } finally {
    try { event.frame.close(); } finally {
      if (Number.isSafeInteger(event.id) && event.id >= 0) options.post("realtimeVoice.ackVideoFrame", [event.id]);
    }
  }
}

/** Pure SDK adapter, using only the existing trusted parent bridge. */
export function createVoiceAPI(options: {
  available: boolean;
  call<T>(method: string, args: unknown[], timeout?: number): Promise<T>;
  post(method: string, args: unknown[]): void;
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}): VoiceAPI {
  return {
    async prepare(params = {}) {
      if (!options.available) throw new Error("Voice is unavailable in this view.");
      const response = await options.call<{ intent?: string; error?: string }>("realtimeVoice.prepare", [params], 10_000);
      if (!response?.intent) throw new Error(response?.error || "Click a voice control to start the microphone.");
      return { intent: response.intent };
    },
    async start(params) {
      if (!options.available) throw new Error("Voice is unavailable in this view.");
      const contextError = voiceStartContextError(params?.instructions, params?.context);
      if (contextError) throw new Error(contextError);
      if (params.avatar !== undefined && typeof params.avatar !== "boolean") throw new Error("Avatar opt-in must be a boolean.");
      if (params.tools !== undefined && !isVoiceToolAllowlist(params.tools)) throw new Error("Invalid voice tool allowlist.");
      if (params.interruptionMode !== undefined && params.interruptionMode !== "automatic" && params.interruptionMode !== "manual") throw new Error("Invalid voice interruption mode.");
      const response = await options.call<{ status?: string; error?: string }>("realtimeVoice.start", [params], 180_000);
      if (response?.status !== "connected") throw new Error(response?.error || "Voice could not connect.");
      return { status: "connected" };
    },
    stop: () => options.post("realtimeVoice.stop", []),
    interrupt: () => { if (options.available) options.post("realtimeVoice.interrupt", []); },
    setMuted: params => options.post("realtimeVoice.setMuted", [params]),
    updateContext: context => options.post("realtimeVoice.updateContext", [context]),
    updateInstructions(instructions) {
      if (typeof instructions !== "string" || !instructions.trim() || instructions.length > 12_000) throw new Error("Voice instructions must contain 1–12,000 characters.");
      if (options.available) options.post("realtimeVoice.updateInstructions", [instructions]);
    },
    cancelSceneReaction(id) {
      if (id !== undefined && (typeof id !== "string" || id.length > 160 || !/^[\w:-]+$/.test(id))) throw new Error("Invalid voice scene id.");
      if (options.available) options.post("realtimeVoice.cancelSceneReaction", id === undefined ? [] : [id]);
    },
    reactToScene(notice) {
      if (!isVoiceSceneReference(notice) && !isVoiceSceneReaction(notice)) throw new Error("Invalid voice scene notice.");
      if (options.available) options.post("realtimeVoice.reactToScene", [{ id: notice.id, kind: notice.kind }]);
    },
    resolveTool: (callId, result) => options.post("realtimeVoice.resolveTool", [callId, result]),
    setSpatial: pose => options.post("realtimeVoice.setSpatial", [pose]),
    onEvent(callback) {
      if (!options.available) return () => {};
      const handler = (event: Event) => callback((event as CustomEvent<VoiceEvent>).detail);
      options.target.addEventListener(VOICE_EVENT, handler);
      return () => options.target.removeEventListener(VOICE_EVENT, handler);
    },
  };
}
