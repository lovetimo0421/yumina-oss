/**
 * AI voice design — the charge / call / refund flow, with every side effect
 * injected so it can be tested without Fish, S3 or a wallet.
 *
 * Design: charge the author first (so two clicks can't both spend the same
 * mushies), call Fish, store the candidates, and give the mushies back if any
 * of that fails. Save: same shape, around registering the kept candidate.
 *
 * Candidates are stored under `tts/{sha256(design|userId|token)}.mp3` (WAV
 * bytes, served by the existing /cdn/tts/:hash route) with a JSON sidecar.
 * The client only ever holds the random token; the save endpoint re-derives
 * the hash from the CALLER's user id, so one author can't register another
 * author's candidate. Cloning from an uploaded recording is its own endpoint
 * (POST /api/voice-design/clone, lib/tts/voice-clone.ts).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  TTS_MARKUP,
  VOICE_DESIGN_CANDIDATES,
  VOICE_DESIGN_PRICE_USD,
  VOICE_DESIGN_PROMPT_MAX,
  VOICE_SAVE_PRICE_USD,
  TTS_CUSTOM_VOICE_NAME_MAX,
} from "@yumina/shared";
import { providerCostUsdToCredits } from "../provider-cost.js";
import {
  FishApiError,
  VOICE_DESIGN_SAMPLE_LINES,
  voiceDesignLanguage,
  type FishDesignCandidate,
} from "./fish-voice-design.js";

export const VOICE_DESIGN_CREDITS = providerCostUsdToCredits(VOICE_DESIGN_PRICE_USD, TTS_MARKUP);
export const VOICE_SAVE_CREDITS = providerCostUsdToCredits(VOICE_SAVE_PRICE_USD, TTS_MARKUP);

/** Largest candidate clip the save step will read back (a ~5 s WAV is ~450 KB). */
const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;

export interface VoiceDesignDeps {
  /** Throws an Error whose message is "INSUFFICIENT_CREDITS" when short. */
  charge(userId: string, credits: number, referenceId: string, description: string): Promise<void>;
  refund(userId: string, credits: number, referenceId: string, description: string): Promise<void>;
  logUsage(row: { userId: string; endpoint: string; model: string; costUsd: number; ms: number }): Promise<void>;
  design(params: { instruction: string; referenceText: string; language: string; n: number }): Promise<FishDesignCandidate[]>;
  register(params: { title: string; description: string; audio: Buffer; text: string; signature?: string }): Promise<string>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string, maxBytes: number): Promise<Buffer | null>;
  newToken(): string;
  reportError(event: string, err: unknown, extra?: Record<string, unknown>): void;
}

export type VoiceDesignFailure = {
  ok: false;
  status: 400 | 402 | 404 | 429 | 502 | 503 | 504;
  code: string;
  error: string;
};

export function candidateHash(userId: string, token: string): string {
  return createHash("sha256").update(`voice-design-v1|${userId}|${token}`).digest("hex");
}

const audioKey = (hash: string) => `tts/${hash}.mp3`;
const metaKey = (hash: string) => `voice-design/${hash}.json`;

/** A Fish failure → what the author is told. Fish's own 402 means the
 *  PLATFORM's Fish wallet is empty — not the author's problem to fix. */
export function fishFailure(err: unknown): VoiceDesignFailure {
  const status = err instanceof FishApiError ? err.status : 502;
  if (status === 429) return { ok: false, status: 429, code: "PROVIDER_BUSY", error: "Voice design is busy. Try again shortly." };
  if (status === 504) return { ok: false, status: 504, code: "TIMEOUT", error: "Voice design timed out" };
  if (status === 402 || status === 401 || status === 403) {
    return { ok: false, status: 503, code: "VOICE_DESIGN_UNAVAILABLE", error: "Voice design is temporarily unavailable" };
  }
  return { ok: false, status: 502, code: "PROVIDER_ERROR", error: "Voice design failed" };
}

/** An author's description → the trimmed prompt, or null when unusable. */
export function cleanDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length > VOICE_DESIGN_PROMPT_MAX) return null;
  return text;
}

/** The name a saved voice gets: the author's, else the description's start. */
export function voiceTitle(name: unknown, description: string): string {
  const own = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  const base = own || description;
  return base.length > TTS_CUSTOM_VOICE_NAME_MAX ? `${base.slice(0, TTS_CUSTOM_VOICE_NAME_MAX - 1)}…` : base;
}

function isInsufficient(err: unknown): boolean {
  return err instanceof Error && err.message === "INSUFFICIENT_CREDITS";
}

async function safeRefund(deps: VoiceDesignDeps, userId: string, credits: number, referenceId: string, what: string) {
  if (credits <= 0) return;
  try {
    await deps.refund(userId, credits, referenceId, `${what} — failed, refunded`);
  } catch (err) {
    // The charge stands with nothing delivered: loud, so it can be repaid by hand.
    deps.reportError("voice-design-refund-failed", err, { userId, credits, referenceId });
  }
}

export async function designVoices(
  input: { userId: string; description: unknown; lang: unknown },
  deps: VoiceDesignDeps,
): Promise<
  | { ok: true; candidates: Array<{ token: string; url: string; durationMs: number }>; credits: number }
  | VoiceDesignFailure
> {
  const instruction = cleanDescription(input.description);
  if (!instruction) return { ok: false, status: 400, code: "INVALID_DESCRIPTION", error: "Describe the voice (up to 500 characters)" };
  const language = voiceDesignLanguage(typeof input.lang === "string" ? input.lang : undefined);
  const referenceText = VOICE_DESIGN_SAMPLE_LINES[language];

  const referenceId = `voice-design:${deps.newToken()}`;
  const credits = VOICE_DESIGN_CREDITS;
  if (credits > 0) {
    try {
      await deps.charge(input.userId, credits, referenceId, "AI voice design");
    } catch (err) {
      if (isInsufficient(err)) return { ok: false, status: 402, code: "INSUFFICIENT_CREDITS", error: "Not enough mushies" };
      throw err;
    }
  }

  const started = Date.now();
  let generated: FishDesignCandidate[];
  try {
    generated = await deps.design({ instruction, referenceText, language, n: VOICE_DESIGN_CANDIDATES });
  } catch (err) {
    await safeRefund(deps, input.userId, credits, referenceId, "AI voice design");
    deps.reportError("voice-design-failed", err, { userId: input.userId });
    return fishFailure(err);
  }

  // Fish billed the platform from here on, whatever happens next.
  await deps.logUsage({
    userId: input.userId,
    endpoint: "voice-design",
    model: "fish-audio/voice-design-1",
    costUsd: VOICE_DESIGN_PRICE_USD,
    ms: Date.now() - started,
  }).catch(() => {});

  try {
    const candidates = [];
    for (const c of generated) {
      const token = deps.newToken();
      const hash = candidateHash(input.userId, token);
      await deps.put(audioKey(hash), c.audio, "audio/wav");
      await deps.put(
        metaKey(hash),
        Buffer.from(JSON.stringify({ text: referenceText, instruction, ...(c.signature ? { signature: c.signature } : {}) })),
        "application/json",
      );
      candidates.push({ token, url: `/cdn/tts/${hash}`, durationMs: c.durationMs });
    }
    return { ok: true, candidates, credits };
  } catch (err) {
    await safeRefund(deps, input.userId, credits, referenceId, "AI voice design");
    deps.reportError("voice-design-store-failed", err, { userId: input.userId });
    return { ok: false, status: 502, code: "STORAGE_ERROR", error: "Failed to store the voices" };
  }
}

type SaveResult = { ok: true; id: string; name: string; credits: number; description: string } | VoiceDesignFailure;

/** Saves of one candidate already running on this instance: a double click registers once. */
const savesInFlight = new Map<string, Promise<SaveResult>>();

/**
 * Registers a kept candidate as a Fish voice. A candidate is registered at most once: the
 * voice id is written back into its sidecar, and saving it again returns that id instead of
 * creating another voice on the platform's Fish account.
 */
export async function saveDesignedVoice(
  input: { userId: string; token: unknown; name: unknown },
  deps: VoiceDesignDeps,
): Promise<SaveResult> {
  if (typeof input.token !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(input.token)) {
    return { ok: false, status: 400, code: "INVALID_CANDIDATE", error: "Unknown voice" };
  }
  const hash = candidateHash(input.userId, input.token);
  const running = savesInFlight.get(hash);
  if (running) return running;
  const save = saveCandidate(input, hash, deps).finally(() => savesInFlight.delete(hash));
  savesInFlight.set(hash, save);
  return save;
}

async function saveCandidate(
  input: { userId: string; name: unknown },
  hash: string,
  deps: VoiceDesignDeps,
): Promise<SaveResult> {
  const [audio, metaRaw] = await Promise.all([
    deps.get(audioKey(hash), MAX_CANDIDATE_BYTES),
    deps.get(metaKey(hash), 64 * 1024),
  ]);
  if (!audio || !metaRaw) return { ok: false, status: 404, code: "CANDIDATE_NOT_FOUND", error: "This voice is no longer available. Generate again." };
  let meta: { text?: unknown; instruction?: unknown; signature?: unknown; savedId?: unknown; savedName?: unknown };
  try {
    meta = JSON.parse(metaRaw.toString("utf8")) as typeof meta;
  } catch {
    return { ok: false, status: 404, code: "CANDIDATE_NOT_FOUND", error: "This voice is no longer available. Generate again." };
  }
  const text = typeof meta.text === "string" ? meta.text : "";
  const instruction = typeof meta.instruction === "string" ? meta.instruction : "";
  const name = voiceTitle(input.name, instruction);
  if (typeof meta.savedId === "string" && meta.savedId) {
    return { ok: true, id: meta.savedId, name: typeof meta.savedName === "string" ? meta.savedName : name, credits: 0, description: instruction };
  }

  const referenceId = `voice-design-save:${deps.newToken()}`;
  const credits = VOICE_SAVE_CREDITS;
  if (credits > 0) {
    try {
      await deps.charge(input.userId, credits, referenceId, "AI voice — save");
    } catch (err) {
      if (isInsufficient(err)) return { ok: false, status: 402, code: "INSUFFICIENT_CREDITS", error: "Not enough mushies" };
      throw err;
    }
  }

  const started = Date.now();
  let id: string;
  try {
    id = await deps.register({
      title: name || "Yumina voice",
      description: instruction,
      audio,
      text,
      ...(typeof meta.signature === "string" ? { signature: meta.signature } : {}),
    });
  } catch (err) {
    await safeRefund(deps, input.userId, credits, referenceId, "AI voice — save");
    deps.reportError("voice-design-save-failed", err, { userId: input.userId });
    return fishFailure(err);
  }
  try {
    await deps.put(metaKey(hash), Buffer.from(JSON.stringify({ ...meta, savedId: id, savedName: name })), "application/json");
  } catch (err) {
    // The voice exists and is returned; only a repeat save of this candidate would register again.
    deps.reportError("voice-design-save-mark-failed", err, { userId: input.userId });
  }
  await deps.logUsage({
    userId: input.userId,
    endpoint: "voice-design-save",
    model: "fish-audio/model",
    costUsd: VOICE_SAVE_PRICE_USD,
    ms: Date.now() - started,
  }).catch(() => {});
  return { ok: true, id, name, credits, description: instruction };
}

export { randomUUID as newVoiceDesignToken };
