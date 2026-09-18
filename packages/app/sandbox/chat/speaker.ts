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
  NARRATOR_SPEAKER,
  parseLeadingSpeakerTag,
  isPartialLeadingSpeakerTag,
} from "@yumina/engine";

export { displayCharacterName, isPartialLeadingSpeakerTag };

export interface SpeakerEntry {
  name: string;
  role?: string;
  enabled?: boolean;
  portrait?: string | null;
}

export interface Speaker {
  name: string;
  /** null when the tagged character exists but has no portrait — the name
   *  still beats a generic "Narrator" label. */
  portrait: string | null;
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
  };
}

function firstSentence(text: string): string {
  const t = text.trimStart();
  const m = /[.!?。！？\n]/.exec(t);
  return m ? t.slice(0, m.index) : t;
}

export function resolveSpeaker(
  entries: ReadonlyArray<SpeakerEntry> | null | undefined,
  rawContent: string,
): Speaker | null {
  if (!entries || entries.length === 0) return null;
  const characters = entries.filter(
    (e) => e.role === "character" && e.enabled !== false && displayCharacterName(e.name).length > 0,
  );
  if (characters.length === 0) return null;

  // 1. The tag.
  const tag = parseLeadingSpeakerTag(rawContent);
  if (tag.speaker === NARRATOR_SPEAKER) return null;
  if (tag.speaker) {
    const wanted = tag.speaker.toLowerCase();
    const hit =
      characters.find((c) => displayCharacterName(c.name).toLowerCase() === wanted) ??
      characters.find((c) => c.name.trim().toLowerCase() === wanted);
    if (hit) return toSpeaker(hit);
    // Unknown name: fall through and let the text decide.
  }

  // 2. Heuristics on the prose.
  const candidates = characters.filter((c) => typeof c.portrait === "string" && c.portrait.length > 0);
  if (candidates.length === 0) return null;
  if (characters.length === 1) return toSpeaker(characters[0]!);

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
