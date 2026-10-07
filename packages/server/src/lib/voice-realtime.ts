import { createHash } from "node:crypto";

export const VOICE_MAX_SDP_BYTES = 65_536;
export const VOICE_MAX_INSTRUCTIONS = 12_000;
export type VoiceToolName = "request_inspection_focus";
/** Bounded names only, never caller-supplied function schemas. */
export function isVoiceToolAllowlist(value: unknown): value is VoiceToolName[] {
  return Array.isArray(value) && value.length <= 1
    && (value.length === 0 || value[0] === "request_inspection_focus");
}
const VOICE_CONNECT_TIMEOUT_MS = 20_000;

const failures = {
  VOICE_CONNECTION_PENDING: { status: 429, message: "A live voice call is already active. Stop it before starting another." },
  VOICE_DAILY_LIMIT: { status: 429, message: "The sponsored testing voice daily limit has been reached. Try again tomorrow or add your own OpenAI key in Settings." },
  OPENAI_KEY_REQUIRED: { status: 412, message: "Add an OpenAI API key in Settings to use live voice. OpenAI bills your account directly." },
  OPENAI_KEY_REJECTED: { status: 502, message: "OpenAI rejected your stored key or its voice access. Check your OpenAI connection in Settings." },
  VOICE_PROVIDER_RATE_LIMITED: { status: 429, message: "OpenAI could not accept another voice connection. Check your OpenAI limits and try again." },
  VOICE_PROVIDER_ERROR: { status: 502, message: "OpenAI could not establish the voice connection. Please try again." },
  VOICE_TIMEOUT: { status: 504, message: "The voice connection timed out. Please try again." },
  VOICE_CANCELLED: { status: 408, message: "The voice connection was cancelled." },
  INVALID_VOICE_REQUEST: { status: 400, message: "Invalid voice connection request." },
  VOICE_REQUEST_TOO_LARGE: { status: 413, message: "Voice connection request is too large." },
} as const;

export class VoiceConnectionError extends Error {
  readonly status: (typeof failures)[keyof typeof failures]["status"];

  constructor(readonly code: keyof typeof failures) {
    super(failures[code].message);
    this.name = "VoiceConnectionError";
    this.status = failures[code].status;
  }
}

export interface VoiceConnectRequest {
  apiKey: string;
  userId: string;
  sdp: string;
  instructions: string;
  signal?: AbortSignal;
  voice?: "marin" | "cedar";
  /** Empty disables all tools; omitted preserves the legacy inspection tool. */
  tools?: VoiceToolName[];
  /** Opt in to client-owned response creation and interruption. */
  turnControl?: "client-v1" | "live-v1";
  onCallId?: (callId: string) => Promise<void>;
}

export function isVoiceSdp(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= VOICE_MAX_SDP_BYTES
    && /^v=0\r?\n/.test(value)
    && /^m=audio /m.test(value)
    && !value.includes("\0");
}

/**
 * GA unified WebRTC interface. The caller supplies a user's decrypted BYOK;
 * this module intentionally has no environment or platform-key dependency.
 * https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime
 */
export async function createOpenAiVoiceCall(
  request: VoiceConnectRequest,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  if (request.turnControl !== undefined && request.turnControl !== "client-v1" && request.turnControl !== "live-v1") {
    throw new VoiceConnectionError("INVALID_VOICE_REQUEST");
  }
  const apiKey = request.apiKey.trim();
  if (!apiKey || /[\r\n\0]/.test(apiKey) || /^(null|undefined)$/i.test(apiKey)) {
    throw new VoiceConnectionError("OPENAI_KEY_REQUIRED");
  }
  if (!isVoiceSdp(request.sdp) || !request.instructions.trim()
    || request.instructions.length > VOICE_MAX_INSTRUCTIONS
    || (request.tools !== undefined && !isVoiceToolAllowlist(request.tools))
    || (request.turnControl === "live-v1" && request.tools?.length !== 0)) {
    throw new VoiceConnectionError("INVALID_VOICE_REQUEST");
  }
  if (request.signal?.aborted) throw new VoiceConnectionError("VOICE_CANCELLED");

  const controller = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? VOICE_CONNECT_TIMEOUT_MS);
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new VoiceConnectionError(timedOut ? "VOICE_TIMEOUT" : "VOICE_CANCELLED"));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const exchange = async () => {
      if (request.turnControl === "live-v1") {
        // Live owns continuous speech; the existing room director owns physical
        // actions. Realtime turn/VAD/tool settings are invalid for this API.
        const response = await (options.fetch ?? fetch)("https://api.openai.com/v1/live/sessions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": createHash("sha256").update(`yumina:voice:${request.userId}`).digest("hex") },
          body: JSON.stringify({ session: { model: "gpt-live-1", instructions: request.instructions,
            delegation: { type: "client" }, audio: { output: { voice: request.voice ?? "marin" } }, store: false },
            transport: { type: "webrtc", sdp: request.sdp } }),
          signal, redirect: "error",
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 401 || response.status === 403) throw new VoiceConnectionError("OPENAI_KEY_REJECTED");
          if (response.status === 429) throw new VoiceConnectionError("VOICE_PROVIDER_RATE_LIMITED");
          throw new VoiceConnectionError("VOICE_PROVIDER_ERROR");
        }
        const result = JSON.parse(await readBoundedAnswer(response, signal));
        const id: unknown = result?.session?.id;
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new VoiceConnectionError("VOICE_PROVIDER_ERROR");
        // Register ownership before validating SDP so a malformed answer still
        // reaches sponsored cleanup instead of leaving a paid session behind.
        await request.onCallId?.(id);
        const sdp: unknown = result?.transport?.sdp;
        if (typeof sdp !== "string" || !isVoiceSdp(sdp)) throw new VoiceConnectionError("VOICE_PROVIDER_ERROR");
        return sdp;
      }
      const providerManaged = request.turnControl !== "client-v1";
      const form = new FormData();
      form.set("sdp", request.sdp);
      form.set("session", JSON.stringify({
        type: "realtime",
        model: "gpt-realtime-2.1",
        instructions: request.instructions,
        output_modalities: ["audio"],
        max_output_tokens: 512,
        audio: {
          input: {
            transcription: { model: "gpt-4o-transcribe" },
            turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: providerManaged, interrupt_response: providerManaged },
          },
          output: { voice: request.voice ?? "marin" },
        },
        tools: request.tools?.length === 0 ? [] : [{
          type: "function",
          name: "request_inspection_focus",
          description: "Request inspection of a witnessed location. The world may reject the request. This cannot reveal evidence or change game state directly.",
          parameters: {
            type: "object",
            properties: {
              focus: { type: "string", enum: ["desk", "door", "bed"] },
              reason: { type: "string", minLength: 1, maxLength: 240 },
            },
            required: ["focus", "reason"],
            additionalProperties: false,
          },
        }],
        tool_choice: "auto",
      }));
      const response = await (options.fetch ?? fetch)("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Safety-Identifier": createHash("sha256").update(`yumina:voice:${request.userId}`).digest("hex"),
        },
        body: form,
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        // Do not read, log, or forward upstream failure bodies or headers.
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) throw new VoiceConnectionError("OPENAI_KEY_REJECTED");
        if (response.status === 429) throw new VoiceConnectionError("VOICE_PROVIDER_RATE_LIMITED");
        throw new VoiceConnectionError("VOICE_PROVIDER_ERROR");
      }
      if (request.onCallId) {
        const location = response.headers.get("Location");
        const match = location?.match(/^(?:https:\/\/api\.openai\.com)?\/v1\/realtime\/calls\/([A-Za-z0-9_-]{1,200})$/);
        if (!match) { void response.body?.cancel().catch(() => {}); throw new VoiceConnectionError("VOICE_PROVIDER_ERROR"); }
        await request.onCallId(match[1]!);
      }
      return readSdpAnswer(response, signal);
    };
    // The deadline covers both headers and the SDP body, even if a transport
    // fails to settle its promise after aborting.
    return await Promise.race([exchange(), aborted]);
  } catch (error) {
    if (signal.aborted) throw new VoiceConnectionError(timedOut ? "VOICE_TIMEOUT" : "VOICE_CANCELLED");
    if (error instanceof VoiceConnectionError) throw error;
    throw new VoiceConnectionError("VOICE_PROVIDER_ERROR");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort!);
    controller.abort();
  }
}

async function readSdpAnswer(response: Response, signal: AbortSignal): Promise<string> {
  const sdp = await readBoundedAnswer(response, signal);
  if (!isVoiceSdp(sdp)) throw new VoiceConnectionError("VOICE_PROVIDER_ERROR");
  return sdp;
}

async function readBoundedAnswer(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new VoiceConnectionError("VOICE_PROVIDER_ERROR");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > VOICE_MAX_SDP_BYTES) {
        cancel();
        throw new VoiceConnectionError("VOICE_PROVIDER_ERROR");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
