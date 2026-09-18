/**
 * Strips state-change directives from streaming text so they are never visible to the user.
 * Uses the same patterns as the engine's ResponseParser.
 */

// [variableId: operation value]
const STANDARD = /\[([\w\p{L}\p{N}.$-]+):\s*(set|add|subtract|multiply|toggle|append|\+|-|\*)?\s*("(?:[^"\\]|\\.)*"|[\w\p{L}\p{N}.$-]+)?\]/gu;
// [audio: trackId action ...]
const AUDIO = /\[audio:\s*([\w\p{L}\p{N}-]+)\s+(play|stop|crossfade|volume)(?:\s+([\d.]+))?(?:\s+chain:([\w\p{L}\p{N}-]+))?\]/gu;
// [variableId: op {json}] or [variableId: op [json]]
const JSON_DIR = /\[([\w\p{L}\p{N}.$-]+):\s*(set|merge|push|delete)\s+(\{[\s\S]*?\}|\[[\s\S]*?\])\]/gu;
// <UpdateVariable>...<JSONPatch>...</JSONPatch>...</UpdateVariable>
const UPDATE_VAR = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi;
// Standalone structural XML tags
const STRUCTURAL_XML = /^\s*<\/?(maintext|option|sum|Analysis|UpdateVariable|JSONPatch|status_current_variable)\s*>\s*$/gim;
// Trailing incomplete directive at end of streaming text: [word: ...
const TRAILING_INCOMPLETE = /\[[\w\p{L}\p{N}.$-]+:[^\]]*$/u;

export function stripDirectives(text: string): string {
  return text
    .replace(UPDATE_VAR, "")
    .replace(AUDIO, "")
    .replace(JSON_DIR, "")
    .replace(STANDARD, "")
    .replace(STRUCTURAL_XML, "")
    .replace(TRAILING_INCOMPLETE, "");
}
