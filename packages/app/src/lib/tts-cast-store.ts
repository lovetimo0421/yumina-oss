// ── Voice casting memory ────────────────────────────────────────────
// The server decides who says each line and which voice a new speaker gets
// (lib/tts/cast.ts). The voices it hands out are remembered per session so
// a character keeps their voice for the whole game: in memory, mirrored to
// localStorage so a reload doesn't recast everyone.
//
// The player can also give a speaker a voice of their own for one chat. That
// choice beats the card author's voice and the cast (owner 2026-10-25: every
// AI the player hears is theirs to choose). The narrator's key is "narrator".
//
// Kept apart from tts-playback.ts so the chat screen can read and change it
// without loading the playback module.

export const NARRATOR_SPEAKER = "narrator";

const casts = new Map<string, Record<string, string>>();
const picks = new Map<string, Record<string, string>>();
const listeners = new Set<() => void>();
let version = 0;

const castKey = (sessionId: string) => `yumina:tts-cast:${sessionId}`;
const picksKey = (sessionId: string) => `yumina:tts-voice-picks:${sessionId}`;

function load(cache: Map<string, Record<string, string>>, key: string, sessionId: string): Record<string, string> {
  let record = cache.get(sessionId);
  if (!record) {
    record = {};
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") record[k] = v;
      }
    } catch { /* storage unavailable: memory only */ }
    cache.set(sessionId, record);
  }
  return record;
}

function save(cache: Map<string, Record<string, string>>, key: string, sessionId: string, record: Record<string, string>): void {
  cache.set(sessionId, record);
  try { localStorage.setItem(key, JSON.stringify(record)); } catch { /* memory only */ }
  version += 1;
  for (const listener of listeners) listener();
}

/** Voices this session's casting has handed out (name → voice id). */
export function castFor(sessionId: string): Record<string, string> {
  return load(casts, castKey(sessionId), sessionId);
}

export function rememberCast(sessionId: string, cast: unknown): void {
  if (!cast || typeof cast !== "object") return;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(cast as Record<string, unknown>)) if (typeof v === "string") next[k] = v;
  save(casts, castKey(sessionId), sessionId, next);
}

/** Voices the player picked for speakers in this chat (name → voice id). */
export function voicePicksFor(sessionId: string): Record<string, string> {
  return load(picks, picksKey(sessionId), sessionId);
}

/** Give a speaker the player's own voice for this chat; null hands it back to the card. */
export function setVoicePick(sessionId: string, speaker: string, voice: string | null): void {
  const name = speaker.trim();
  if (!name) return;
  const next = { ...voicePicksFor(sessionId) };
  if (voice) next[name] = voice;
  else delete next[name];
  save(picks, picksKey(sessionId), sessionId, next);
}

export function subscribeVoiceCast(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function voiceCastVersion(): number {
  return version;
}
