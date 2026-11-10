/**
 * Streaming text as the player should see it. One implementation: the
 * engine's `cleanDisplayText`, which is the response parser's own clean text,
 * so what streams is what the server will save. Pass the world's variable ids
 * (the game-state keys) when known; without them only the generic criteria
 * hide bracket lines (placeholder keys, operation words).
 */
import { cleanDisplayText, type ReplyRule } from "@yumina/engine";

export function stripDirectives(text: string, variableIds?: Iterable<string>, replyRules?: readonly ReplyRule[]): string {
  return cleanDisplayText(text, { variableIds, replyRules, streaming: true });
}

/**
 * The stripper for text pushed to the sandbox while streaming. The leading
 * `[speaker: Name]` tag is NOT a state directive — it tells the bubble whose
 * face to show, and it only has value while the reply is still arriving — so
 * it is kept (normalized to its own line) and everything after it is stripped
 * as usual. A partially streamed tag (`[spea`) is held verbatim: the sandbox
 * hides it, and stripping it here would leave the bubble unable to tell "no
 * tag" from "tag not finished yet".
 */
export function stripDirectivesForSandbox(text: string, variableIds?: Iterable<string>, replyRules?: readonly ReplyRule[]): string {
  return cleanDisplayText(text, { variableIds, replyRules, streaming: true, keepSpeakerTag: true });
}
