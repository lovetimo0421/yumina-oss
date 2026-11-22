import { isValidTtsVoice } from "@yumina/shared";
import { aiFrameIds, resolveSpeaker, type SpeakerEntry } from "@/../sandbox/chat/speaker";

/**
 * The voice a card asks for a reply to be read in.
 *
 * Voices used to be the player's alone: one voice, chosen in settings, read
 * every line of every card — the narrator and three characters in the same
 * throat. An author can now give a character a voice (`entry.voice`) and the
 * card a narrator (`settings.narratorVoice`), and the card's choice comes
 * first: a card that says who sounds like what is telling the player how it
 * is meant to be heard, the way it already tells them what it looks like.
 *
 * The speaker is found the way the bubble finds the face beside a line — the
 * `[speaker: Name]` tag the model opens with, else the prose heuristics — so
 * the voice and the portrait always agree about who is talking. A speaking
 * character without a voice of their own falls to the narrator's, and a card
 * that set neither returns nothing, which leaves the player's own choice in
 * force. Anything that is not a fish reference id is ignored rather than
 * sent.
 */
export interface CardVoiceWorld {
  entries?: ReadonlyArray<SpeakerEntry & { voice?: string | null }> | null;
  worldbooks?: ReadonlyArray<{ id: string; station?: unknown }> | null;
  settings?: { narratorVoice?: string | null } | null;
}

/**
 * `picks` are the voices the player chose for speakers in this chat (keyed by
 * name, "narrator" for the narrator). They come before the card's.
 */
export function resolveCardVoice(world: CardVoiceWorld | null | undefined, text: string, picks: Readonly<Record<string, string>> = {}): string | undefined {
  const picked = (name: string | undefined) => {
    const voice = name ? picks[name.trim()] : undefined;
    return voice && isValidTtsVoice(voice) ? voice : undefined;
  };
  if (!world) return picked("narrator");
  const speaker = resolveSpeaker(world.entries ?? [], text, aiFrameIds(world.worldbooks));
  const own = picked(speaker?.name);
  if (own) return own;
  if (speaker?.voice && isValidTtsVoice(speaker.voice)) return speaker.voice;
  const narrator = picked("narrator") ?? world.settings?.narratorVoice;
  return narrator && isValidTtsVoice(narrator) ? narrator : undefined;
}
