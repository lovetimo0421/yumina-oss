import type { WorldDefinition, WorldEntry } from "../types/index.js";

/**
 * Speaker tag — the AI names who is talking BEFORE it writes the line.
 *
 * In a world where several characters carry portraits, the prompt asks the
 * model to open every reply with `[speaker: Name]`. The tag is the first few
 * tokens of the stream, so the chat knows whose face to show before any prose
 * arrives, instead of guessing from names in the text afterwards.
 *
 * The tag is only ever recognized at the very START of a reply. Variable
 * directives live at the end, so a world that happens to own a variable
 * called `speaker` keeps working — and such a world never gets the prompt
 * block in the first place (see `speakerTagEnabled`).
 */

export const NARRATOR_SPEAKER = "narrator";

/** `[speaker: Name]` at the start of a reply, tolerating padding and a
 *  stray blank line before it. Case-insensitive on the key. */
const LEADING_SPEAKER_TAG = /^\s*\[\s*speaker\s*:\s*([^\]\n]*?)\s*\]/i;

/** Character entries that can put a face on a line: enabled, `role:
 *  "character"`, with a portrait set. */
export function portraitCharacters(entries: ReadonlyArray<WorldEntry> | undefined): WorldEntry[] {
  return (entries ?? []).filter(
    (e) =>
      e.role === "character" &&
      e.enabled !== false &&
      typeof e.portrait === "string" &&
      e.portrait.length > 0,
  );
}

/** Entry names often carry an author-side label ("人物：Balder", "NPC: Mia").
 *  The player-facing name is what follows the colon. */
export function displayCharacterName(raw: string): string {
  const trimmed = raw.trim();
  const m = /^[^:：]{1,12}[:：]\s*(.+)$/s.exec(trimmed);
  return m && m[1]!.trim() ? m[1]!.trim() : trimmed;
}

/** Whether this world should be asked for a speaker tag: two or more
 *  characters with portraits (with one, every line is theirs), and no
 *  variable that would collide with the tag's name. */
export function speakerTagEnabled(world: Pick<WorldDefinition, "entries" | "variables">): boolean {
  if (portraitCharacters(world.entries).length < 2) return false;
  if ((world.variables ?? []).some((v) => v.id.toLowerCase() === "speaker")) return false;
  return true;
}

export interface SpeakerTagParse {
  /** The tagged name, or null when the reply carried no tag. `"narrator"`
   *  is returned as-is (lower-cased) so callers can treat it explicitly. */
  speaker: string | null;
  /** The text with the leading tag removed. */
  text: string;
}

export function parseLeadingSpeakerTag(text: string): SpeakerTagParse {
  const m = LEADING_SPEAKER_TAG.exec(text);
  if (!m) return { speaker: null, text };
  const raw = m[1]!.trim();
  const speaker = raw.toLowerCase() === NARRATOR_SPEAKER ? NARRATOR_SPEAKER : raw;
  return { speaker: speaker || null, text: text.slice(m[0].length).replace(/^[ \t]*\n/, "") };
}

/** True while a stream is still inside a partial leading tag (`[spea`,
 *  `[speaker: Mi`), so the UI can hold the label instead of flashing it. */
export function isPartialLeadingSpeakerTag(text: string): boolean {
  const head = text.trimStart();
  if (!head.startsWith("[")) return false;
  if (head.includes("]")) return false;
  return /^\[\s*(s(p(e(a(k(e(r(\s*(:.*)?)?)?)?)?)?)?)?)?$/i.test(head);
}

/** The prompt block that teaches the tag. Empty when the world doesn't
 *  qualify. */
export function buildSpeakerFormatBlock(world: Pick<WorldDefinition, "entries" | "variables">): string {
  if (!speakerTagEnabled(world)) return "";
  const names = portraitCharacters(world.entries).map((e) => displayCharacterName(e.name));
  return [
    "<speaker-format>",
    `Characters with portraits: ${names.join(", ")}.`,
    "Begin EVERY reply with a speaker tag as the very first thing, before any prose:",
    "  [speaker: Name]",
    "Name is exactly one of the names above — the character whose voice the reply is mainly in.",
    `For pure narration, or when no listed character is speaking, write [speaker: ${NARRATOR_SPEAKER}].`,
    "The tag is stripped before the player sees the reply; never mention it in the text.",
    "</speaker-format>",
  ].join("\n");
}
