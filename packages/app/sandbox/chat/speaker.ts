/**
 * Which character is "speaking" an assistant message — drives the portrait +
 * name shown above the bubble in the default chat.
 *
 * Order of trust:
 *   1. The speaker tag the AI was asked to open the reply with
 *      (`[speaker: Name]`, see engine `speaker-tag.ts`). Known before any
 *      prose streams in. `narrator` means: no face.
 *   2. No tag (older history, a model that ignored the instruction, a
 *      greeting): a world with exactly one character is that character's
 *      voice, so every line gets their face. With several characters, a
 *      line-start marker like `Mia:` / `【Mia】` / `**Mia**:` names the
 *      speaker; failing that, a name inside the FIRST sentence; failing
 *      that, it is narration and keeps the plain label.
 */
import {
  displayCharacterName,
  isPlaceholderCharacterName,
  NARRATOR_SPEAKER,
  parseLeadingSpeakerTag,
  isPartialLeadingSpeakerTag,
} from "@yumina/engine";

export { displayCharacterName, isPartialLeadingSpeakerTag };

export interface SpeakerEntry {
  name: string;
  role?: string;
  enabled?: boolean;
  worldbookId?: string | null;
  portrait?: string | null;
  portraitVideo?: { idle: string | null; speaking: string | null } | null;
  /** The voice the author gave this character (fish.audio reference id). */
  voice?: string | null;
}

export interface Speaker {
  name: string;
  /** null when the tagged character exists but has no portrait — the name
   *  still beats a generic "Narrator" label. */
  portrait: string | null;
  /** Moving portrait clips, when the author made them. */
  video: { idle: string | null; speaking: string | null } | null;
  /** The character's own voice, or null: the readout falls to the narrator's. */
  voice: string | null;
}

/** The text a bubble should render: the leading tag never reaches the player. */
export function stripLeadingSpeakerTag(text: string): string {
  return parseLeadingSpeakerTag(text).text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toSpeaker(e: SpeakerEntry): Speaker {
  return {
    name: displayCharacterName(e.name),
    portrait: typeof e.portrait === "string" && e.portrait.length > 0 ? e.portrait : null,
    video: e.portraitVideo && (e.portraitVideo.idle || e.portraitVideo.speaking) ? e.portraitVideo : null,
    voice: typeof e.voice === "string" && e.voice.length > 0 ? e.voice : null,
  };
}

/** Frames with an AI of their own. Their characters belong to that AI: on
 *  such a card the model names who is talking (engine `speakerRoster`), and
 *  no untagged line is ever theirs by default. */
export function aiFrameIds(worldbooks: ReadonlyArray<{ id: string; station?: unknown }> | null | undefined): ReadonlySet<string> {
  return new Set((worldbooks ?? []).filter((b) => !!b.station).map((b) => b.id));
}

function firstSentence(text: string): string {
  const t = text.trimStart();
  const m = /[.!?。！？\n]/.exec(t);
  return m ? t.slice(0, m.index) : t;
}

/** An AI of a group chat, as the bubble needs it: one that lives on the card
 *  or in a situation answers under its own name. */
export interface SpeakerVoice {
  id: string;
  name: string;
  host?: string;
  station?: unknown;
}

export function resolveSpeaker(
  entries: ReadonlyArray<SpeakerEntry> | null | undefined,
  rawContent: string,
  aiFrames?: ReadonlySet<string>,
  voices?: ReadonlyArray<SpeakerVoice>,
): Speaker | null {
  const characters = (entries ?? []).filter(
    (e) => e.role === "character" && e.enabled !== false && displayCharacterName(e.name).length > 0,
  );
  const tag = parseLeadingSpeakerTag(rawContent);
  // 0. One of the room's AIs: its own name, and the face of a character that
  // lives in it when it has one.
  if (tag.speaker && tag.speaker !== NARRATOR_SPEAKER) {
    const wanted = tag.speaker.trim().toLowerCase();
    const ai = voices?.find((v) => v.host !== undefined && !!v.station && v.name.trim().toLowerCase() === wanted);
    if (ai) {
      const face = characters.find((c) => c.worldbookId === ai.id);
      return face ? toSpeaker(face) : { name: ai.name.trim(), portrait: null, video: null, voice: null };
    }
  }
  if (characters.length === 0) return null;

  // 1. The tag.
  if (tag.speaker === NARRATOR_SPEAKER) return null;
  if (tag.speaker) {
    const wanted = tag.speaker.toLowerCase();
    const hit =
      characters.find((c) => displayCharacterName(c.name).toLowerCase() === wanted) ??
      characters.find((c) => c.name.trim().toLowerCase() === wanted);
    if (hit) return toSpeaker(hit);
    // Unknown name: fall through and let the text decide.
  }

  // 2. Heuristics on the prose, over the card's own characters: one that
  // lives in an AI's frame speaks only through its tag, so adding an AI to a
  // one-character card leaves that character the voice of every other line.
  const own = aiFrames?.size
    ? characters.filter((c) => !c.worldbookId || !aiFrames.has(c.worldbookId))
    : characters;
  if (own.length === 0) return null;
  // One character is the voice of every line, face or no face — once the
  // author has named them: a card whose only character had no portrait
  // labelled all of its replies 「旁白」, and the template's own 「角色」 is no
  // name to show either.
  if (own.length === 1) {
    return isPlaceholderCharacterName(own[0]!.name) ? null : toSpeaker(own[0]!);
  }
  const candidates = own.filter((c) => (typeof c.portrait === "string" && c.portrait.length > 0) || !!c.portraitVideo?.idle);
  if (candidates.length === 0) return null;

  const text = tag.text;
  const firstLine = (text.trimStart().split("\n")[0] ?? "").trim();
  let best: SpeakerEntry | null = null;
  let bestName = "";
  for (const c of candidates) {
    const name = displayCharacterName(c.name);
    const marker = new RegExp(
      `^\\s*(?:\\*\\*|【|\\[|「|\\()?\\s*${escapeRegExp(name)}\\s*(?:\\*\\*|】|\\]|」|\\))?\\s*[:：]`,
      "i",
    );
    if (marker.test(firstLine) && name.length > bestName.length) {
      best = c;
      bestName = name;
    }
  }
  if (best) return toSpeaker(best);

  const sentence = firstSentence(text).toLowerCase();
  let bestIdx = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const name = displayCharacterName(c.name);
    const idx = sentence.indexOf(name.toLowerCase());
    if (idx === -1) continue;
    if (idx < bestIdx || (idx === bestIdx && name.length > bestName.length)) {
      best = c;
      bestName = name;
      bestIdx = idx;
    }
  }
  return best ? toSpeaker(best) : null;
}
