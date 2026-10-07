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
 *  "character"`, with a portrait (still or moving) set. */
export function portraitCharacters(entries: ReadonlyArray<WorldEntry> | undefined): WorldEntry[] {
  return (entries ?? []).filter(
    (e) =>
      e.role === "character" &&
      e.enabled !== false &&
      ((typeof e.portrait === "string" && e.portrait.length > 0) ||
        (typeof e.portraitVideo?.idle === "string" && e.portraitVideo.idle.length > 0)),
  );
}

/** Entry names often carry an author-side label ("人物：Balder", "NPC: Mia").
 *  The player-facing name is what follows the colon. */
export function displayCharacterName(raw: string): string {
  const trimmed = raw.trim();
  const m = /^[^:：]{1,12}[:：]\s*(.+)$/s.exec(trimmed);
  return m && m[1]!.trim() ? m[1]!.trim() : trimmed;
}

/** The names the stock templates give their character entries, in every UI
 *  language (app `templates-content.json`; a test there keeps this in step).
 *  A character still called this has not been named by its author yet, so it
 *  is no name to put over a line. */
const PLACEHOLDER_CHARACTER_NAMES = new Set([
  "角色", "人物一", "人物二",
  "Character", "Character one", "Character two",
  "キャラクター", "人物その一", "人物その二",
  "Personaje", "Personaje uno", "Personaje dos",
]);

export function isPlaceholderCharacterName(raw: string | undefined): boolean {
  const name = displayCharacterName(raw ?? "");
  return !name || PLACEHOLDER_CHARACTER_NAMES.has(name);
}

/** Characters that live in a frame with an AI of its own: one named
 *  character per narrating station. Each speaks when its AI does, and only
 *  the reply can say whether she is the one talking or the AI is narrating
 *  someone else. */
export function aiVoiceCharacters(world: Pick<WorldDefinition, "entries" | "worldbooks">): WorldEntry[] {
  const out: WorldEntry[] = [];
  for (const book of world.worldbooks ?? []) {
    if (book.enabled === false || book.station?.kind !== "narrator") continue;
    const own = (world.entries ?? []).filter((e) => e.worldbookId === book.id && e.role === "character" && e.enabled !== false);
    if (own.length === 1 && !isPlaceholderCharacterName(own[0]!.name)) out.push(own[0]!);
  }
  return out;
}

/** The characters the model may name in the tag. Two or more with portraits
 *  (with one, every line is theirs); or, on a card with an AI of its own,
 *  every named character, so a reply says whether that AI's character is
 *  talking or someone else is. Nobody when a variable would collide with
 *  the tag's name. */
export function speakerRoster(world: Pick<WorldDefinition, "entries" | "variables" | "worldbooks">): WorldEntry[] {
  if ((world.variables ?? []).some((v) => v.id.toLowerCase() === "speaker")) return [];
  if (aiVoiceCharacters(world).length > 0) {
    return (world.entries ?? []).filter((e) => e.role === "character" && e.enabled !== false && !isPlaceholderCharacterName(e.name));
  }
  const faces = portraitCharacters(world.entries);
  return faces.length >= 2 ? faces : [];
}

/** Whether this world should be asked for a speaker tag. */
export function speakerTagEnabled(world: Pick<WorldDefinition, "entries" | "variables" | "worldbooks">): boolean {
  return speakerRoster(world).length > 0;
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
export function buildSpeakerFormatBlock(world: Pick<WorldDefinition, "entries" | "variables" | "worldbooks">): string {
  const roster = speakerRoster(world);
  if (roster.length === 0) return "";
  const names = [...new Set(roster.map((e) => displayCharacterName(e.name)))];
  return [
    "<speaker-format>",
    aiVoiceCharacters(world).length > 0 ? `Characters: ${names.join(", ")}.` : `Characters with portraits: ${names.join(", ")}.`,
    "Begin EVERY reply with a speaker tag as the very first thing, before any prose:",
    "  [speaker: Name]",
    "Name is exactly one of the names above — the character whose voice the reply is mainly in.",
    `For pure narration, or when no listed character is speaking, write [speaker: ${NARRATOR_SPEAKER}].`,
    "The tag is stripped before the player sees the reply; never mention it in the text.",
    "</speaker-format>",
  ].join("\n");
}
