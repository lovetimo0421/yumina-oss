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
 *  "character"`, with a portrait (still, moving or live) set. */
export function portraitCharacters(entries: ReadonlyArray<WorldEntry> | undefined): WorldEntry[] {
  return (entries ?? []).filter(
    (e) =>
      e.role === "character" &&
      e.enabled !== false &&
      ((typeof e.portrait === "string" && e.portrait.length > 0) ||
        (typeof e.portraitVideo?.idle === "string" && e.portraitVideo.idle.length > 0) ||
        hasLivePortrait(e)),
  );
}

/** A live character ref (`@rig:<id>` or `@asset:<id>`) on a character entry. */
export function hasLivePortrait(e: Pick<WorldEntry, "portraitLive">): boolean {
  return typeof e.portraitLive === "string" && /^@(?:rig|asset):\S+$/.test(e.portraitLive.trim());
}

/** Enabled characters with a live character beside the chat. */
export function liveCharacters(entries: ReadonlyArray<WorldEntry> | undefined): WorldEntry[] {
  return (entries ?? []).filter((e) => e.role === "character" && e.enabled !== false && hasLivePortrait(e));
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
  /** The text with the leading tag(s) removed. */
  text: string;
  /** `[face: …]` the reply opened with (beside or instead of the speaker
   *  tag): the expression a live character shows. Absent when there was none. */
  face?: string;
}

/** `[face: happy]`: how a live character looks in this reply. Up to 40
 *  characters: the creator's own expressions have names of their own. */
const LEADING_FACE_TAG = /^\s*\[\s*face\s*:\s*([^\]\n]{1,40}?)\s*\]/i;
/** A face tag on a line of its own anywhere else in the reply (models put it
 *  at the end with the directives too). */
const FACE_LINE = /^[ \t]*\[\s*face\s*:\s*([^\]\n]{1,40}?)\s*\][ \t]*$/gim;
/** `[face: set "smile"]` is a write to a card's own `face` variable, not a face. */
const DIRECTIVE_OP = /^(?:set|add|subtract|multiply|toggle|append|merge|push|delete|update)(?=$|[\s"'{[\d+\-,])/i;

export function parseLeadingSpeakerTag(text: string): SpeakerTagParse {
  let rest = text;
  let speaker: string | null = null;
  let face: string | undefined;
  let tagged = false;
  // The speaker tag and the face tag, in either order, each once.
  for (let i = 0; i < 2; i++) {
    const m = tagged ? null : LEADING_SPEAKER_TAG.exec(rest);
    if (m) {
      const raw = m[1]!.trim();
      speaker = (raw.toLowerCase() === NARRATOR_SPEAKER ? NARRATOR_SPEAKER : raw) || null;
      tagged = true;
      rest = rest.slice(m[0].length).replace(/^[ \t]*\n/, "");
      continue;
    }
    const f = face === undefined ? LEADING_FACE_TAG.exec(rest) : null;
    if (f && !DIRECTIVE_OP.test(f[1]!.trim())) {
      face = f[1]!.trim();
      rest = rest.slice(f[0].length).replace(/^[ \t]*\n/, "");
      continue;
    }
    break;
  }
  return face === undefined ? { speaker, text: rest } : { speaker, text: rest, face };
}

/** Face tags on lines of their own, taken out; the last one is the face
 *  (a reply that put it at the end instead of the start). */
export function stripFaceLines(text: string): { text: string; face?: string } {
  let face: string | undefined;
  const out = text.replace(FACE_LINE, (line, value: string) => {
    if (DIRECTIVE_OP.test(value.trim())) return line;
    face = value.trim();
    return "";
  });
  return face === undefined ? { text } : { text: out, face };
}

/** True while a stream is still inside a partial leading tag (`[spea`,
 *  `[speaker: Mi`, `[speaker: Mia]\n[fa`), so the UI can hold the label
 *  instead of flashing it. */
export function isPartialLeadingSpeakerTag(text: string): boolean {
  const head = parseLeadingSpeakerTag(text).text.trimStart();
  if (!head.startsWith("[")) return false;
  if (head.includes("]")) return false;
  return /^\[\s*(s(p(e(a(k(e(r(\s*(:.*)?)?)?)?)?)?)?)?)?$/i.test(head) || /^\[\s*(f(a(c(e(\s*(:.*)?)?)?)?)?)?$/i.test(head);
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

/** The faces every live character can show (alive6.js plays one the creator
 *  switched off as a gentler one). `calm` lets the face rest. Arm moves stay
 *  out: on a character drawn without arms they do nothing. */
export const LIVE_FACES = [
  "calm", "happy", "laugh", "shy", "surprised", "angry", "sad", "doubt", "sigh",
  "sleepy", "lookdown", "wink", "heart", "nod", "shake", "tilt",
] as const;

/** The prompt block that asks for the face tag. Empty unless a character
 *  has a live character beside the chat; empty when a variable would collide
 *  with the tag's name. `own`: the creator's own expressions per live
 *  character ref, which the server reads off the character's settings. */
export function buildLiveFaceBlock(
  world: Pick<WorldDefinition, "entries" | "variables" | "worldbooks">,
  own?: Readonly<Record<string, readonly string[]>>,
): string {
  if ((world.variables ?? []).some((v) => v.id.toLowerCase() === "face")) return "";
  const live = liveCharacters(world.entries);
  if (live.length === 0) return "";
  const names = [...new Set(live.map((e) => displayCharacterName(e.name)))];
  const builtIn = new Set<string>(LIVE_FACES);
  const extra = [...new Set(live.flatMap((e) => own?.[e.portraitLive!.trim()] ?? []))]
    .map((n) => n.trim())
    .filter((n) => n && n.length <= 40 && !/[\]\n,]/.test(n) && !builtIn.has(n.toLowerCase()));
  return [
    "<face-format>",
    `${names.join(", ")} ${names.length > 1 ? "are live characters" : "is a live character"} on screen.`,
    speakerTagEnabled(world)
      ? "Right after the speaker tag, write the speaking character's face:"
      : "Begin EVERY reply with the face, before any prose:",
    "  [face: happy]",
    `Faces: ${[...LIVE_FACES, ...extra].join(", ")}. calm when nothing stands out. The tag never reaches the player.`,
    "</face-format>",
  ].join("\n");
}
