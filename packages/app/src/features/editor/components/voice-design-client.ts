/**
 * Client side of AI voice design (server: routes/voice-design.ts).
 * Kept free of React so the request/merge rules are unit-testable.
 */
import { TTS_VOICE_POOL_MAX, sanitizeTtsCustomVoices, type TtsCustomVoice } from "@yumina/shared";

const apiBase = import.meta.env?.VITE_API_URL || "";

export interface VoiceDesignStatus {
  enabled: boolean;
  designCredits: number;
  saveCredits: number;
  maxDescription: number;
}

export interface VoiceDesignCandidate {
  token: string;
  url: string;
  durationMs: number;
}

const OFF: VoiceDesignStatus = { enabled: false, designCredits: 0, saveCredits: 0, maxDescription: 500 };

let statusPromise: Promise<VoiceDesignStatus> | null = null;

/** Whether the server has voice design on (FISH_API_KEY set). Asked once per
 *  page load; a failed ask reads as off and is retried next time. */
export function loadVoiceDesignStatus(fetchImpl: typeof fetch = fetch): Promise<VoiceDesignStatus> {
  if (!statusPromise) {
    statusPromise = fetchImpl(`${apiBase}/api/voice-design`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Partial<VoiceDesignStatus>;
        return {
          enabled: body.enabled === true,
          designCredits: typeof body.designCredits === "number" ? body.designCredits : 0,
          saveCredits: typeof body.saveCredits === "number" ? body.saveCredits : 0,
          maxDescription: typeof body.maxDescription === "number" ? body.maxDescription : 500,
        };
      })
      .catch(() => {
        statusPromise = null;
        return OFF;
      });
  }
  return statusPromise;
}

export function resetVoiceDesignStatusForTest(): void {
  statusPromise = null;
}

/** Server error code → the voiceField.design.* key the author sees. */
export function voiceDesignErrorKey(code: string, status: number): string {
  if (code === "INSUFFICIENT_CREDITS" || status === 402) return "noCredits";
  if (code === "CANDIDATE_NOT_FOUND" || code === "INVALID_CANDIDATE") return "expired";
  if (code === "VOICE_DESIGN_UNAVAILABLE" || code === "VOICE_DESIGN_OFF") return "unavailable";
  if (status === 429) return "busy";
  return "failed";
}

type Outcome<T> = ({ ok: true } & T) | { ok: false; errorKey: string };

async function post<T>(path: string, body: unknown, fetchImpl: typeof fetch): Promise<Outcome<T>> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, errorKey: "failed" };
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch { /* non-JSON body */ }
  if (!res.ok) return { ok: false, errorKey: voiceDesignErrorKey(typeof json.code === "string" ? json.code : "", res.status) };
  return { ok: true, ...(json as T) };
}

export function requestVoiceDesign(description: string, lang: string, fetchImpl: typeof fetch = fetch) {
  return post<{ candidates: VoiceDesignCandidate[]; credits: number }>("/api/voice-design", { description, lang }, fetchImpl);
}

export function saveDesignedVoice(token: string, name: string, fetchImpl: typeof fetch = fetch) {
  return post<{ id: string; name: string; credits: number }>("/api/voice-design/save", { token, name }, fetchImpl);
}

/** The author's custom-voice list with a newly saved voice added (or renamed
 *  in place), capped like the settings page caps it. */
export function withSavedVoice(list: readonly TtsCustomVoice[], voice: TtsCustomVoice): TtsCustomVoice[] {
  const rest = list.filter((v) => v.id !== voice.id);
  // A full list drops its oldest entry rather than the voice just paid for.
  return sanitizeTtsCustomVoices([...rest, voice].slice(-TTS_VOICE_POOL_MAX));
}
