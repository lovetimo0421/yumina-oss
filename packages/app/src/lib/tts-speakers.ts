import { isValidTtsVoice } from "@yumina/shared";
import { NARRATOR_SPEAKER } from "@/lib/tts-cast-store";

export interface SpeakerVoiceWorld {
  entries?: ReadonlyArray<{ name?: string; role?: string; enabled?: boolean; voice?: string | null }> | null;
  settings?: { narratorVoice?: string | null } | null;
}

export interface SpeakerVoice {
  /** "narrator" for narration. */
  name: string;
  /** The voice this speaker is read in now, null when casting picks one later. */
  voice: string | null;
  /** player: picked in this chat · card: the author's · auto: given by casting. */
  source: "player" | "card" | "auto";
}

const MAX_SPEAKERS = 24;
const valid = (voice: string | null | undefined) => (voice && isValidTtsVoice(voice) ? voice : null);

/** Who can speak in this chat and in whose voice: the narrator, the card's
 *  characters, then anyone casting has already given a voice. */
export function listSpeakerVoices(
  world: SpeakerVoiceWorld | null | undefined,
  cast: Readonly<Record<string, string>>,
  picks: Readonly<Record<string, string>>,
): SpeakerVoice[] {
  const voiceOf = (name: string, cardVoice: string | null): SpeakerVoice => {
    const picked = valid(picks[name]);
    if (picked) return { name, voice: picked, source: "player" };
    if (cardVoice) return { name, voice: cardVoice, source: "card" };
    return { name, voice: valid(cast[name]), source: "auto" };
  };
  const out = [voiceOf(NARRATOR_SPEAKER, valid(world?.settings?.narratorVoice))];
  const seen = new Set([NARRATOR_SPEAKER]);
  for (const entry of world?.entries ?? []) {
    const name = entry.name?.trim();
    if (entry.role !== "character" || entry.enabled === false || !name || seen.has(name)) continue;
    seen.add(name);
    out.push(voiceOf(name, valid(entry.voice)));
  }
  for (const name of [...Object.keys(cast), ...Object.keys(picks)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(voiceOf(name, null));
  }
  return out.slice(0, MAX_SPEAKERS);
}
