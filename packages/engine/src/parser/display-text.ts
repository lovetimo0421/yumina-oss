/**
 * The story text a player sees, from text that may still hold state
 * bookkeeping: a reply streaming in, or a stored reply from before a parser
 * change. One implementation for the server and every client: it is the
 * response parser's own clean text, so what streams is what will be saved.
 *
 * The client carries variable ids and the card's visible reply-rule matches.
 * Without ids the bracket-line rule falls back to its generic
 * criteria (placeholder keys, operation words); the saved reply, cleaned on
 * the server with the full world, is authoritative.
 */
import { ResponseParser } from "./response-parser.js";
import type { ReplyRule } from "./reply-rules.js";
import { PARTIAL_BOOKKEEPING_TAIL_RE } from "./bookkeeping-blocks.js";
import { isPartialLeadingSpeakerTag, parseLeadingSpeakerTag } from "../prompts/speaker-tag.js";

export interface DisplayTextOptions {
  /** The world's variable ids (keys of the game state), when known. */
  variableIds?: Iterable<string>;
  /** Rules whose matched display blocks the author explicitly retains. */
  replyRules?: readonly ReplyRule[];
  /** The reply is still arriving: hold back what is not finished yet. */
  streaming?: boolean;
  /** Keep a leading `[speaker: Name]` (normalised onto its own line) for the
   *  bubble to pick the face; a partial one is returned as is. */
  keepSpeakerTag?: boolean;
}

const parser = new ResponseParser();

/** `[id: …` with no `]` yet, at the very end. */
const TRAILING_INCOMPLETE = /\[[\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+(?: [\w\p{L}\p{N}$·・-]+)*)*\s*:[^\]]*$/u;
/** A last line that opened a bracket and has not closed it (`[sta`). */
const TRAILING_OPEN_BRACKET_LINE = /(^|\n)[ \t]*\[[^\]\n]*$/;
/** `[image: handle]` — the server turns it into an embed after the reply. */
const BARE_IMAGE_HANDLE = /\[\s*image:\s*[\p{L}\p{N}_-]+\s*\]/giu;
/** `[bg: id]` — read by the background resolver, never body text. */
const BG_TAG = /\[\s*bg\s*:\s*[^\]\n]{1,80}\]/gi;

export function cleanDisplayText(text: string, opts: DisplayTextOptions = {}): string {
  if (opts.keepSpeakerTag) {
    if (isPartialLeadingSpeakerTag(text)) return text;
    const tag = parseLeadingSpeakerTag(text);
    if (tag.speaker) return `[speaker: ${tag.speaker}]\n${cleanDisplayText(tag.text, { ...opts, keepSpeakerTag: false })}`;
  }
  const visibleRules = opts.replyRules?.filter((rule) => !rule.hide);
  let out = parser.parse(text, undefined, { variableIds: opts.variableIds, replyRules: visibleRules }).cleanText
    .replace(BG_TAG, "")
    .replace(TRAILING_INCOMPLETE, "");
  if (opts.streaming) {
    out = out
      .replace(BARE_IMAGE_HANDLE, "")
      .replace(PARTIAL_BOOKKEEPING_TAIL_RE, "")
      .replace(TRAILING_OPEN_BRACKET_LINE, "$1");
  }
  return out.trimEnd();
}
