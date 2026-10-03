/**
 * TTS input preparation — turn a persisted message's cleanText into something
 * a voice should actually say.
 *
 * The message content is already directive-free (ResponseParser strips
 * `[var: …]` etc. before persistence), but it still carries markdown, HTML,
 * macro remnants and roleplay markup that would be read out literally.
 *
 * NOTE on square brackets: latin `[whisper]`-style spans are deliberately KEPT
 * — Fish S2.x interprets them as inline emotion/style tags, so a card whose AI
 * writes them gets expressive readouts for free.
 */

import { TTS_MAX_TEXT_CHARS, extractDialogueTexts, type TtsReadingMode } from "@yumina/shared";

/** Strip presentation markup, keep the words. */
export function stripMarkupForTts(raw: string): string {
  let text = raw;

  // Fenced code blocks are never worth hearing.
  text = text.replace(/```[\s\S]*?```/g, " ");
  // HTML tags (custom cards sometimes echo markup into content).
  text = text.replace(/<[^>\n]{1,200}>/g, " ");
  // Unresolved template macros.
  text = text.replace(/\{\{[^}]*\}\}/g, " ");
  // Engine directives that reach RAW streamed text ([hp: -10], [mood: set x])
  // — bracketed spans WITH a colon, which may span lines ([game_state: set
  // "night: 1\nphase: …"]). Fish emotion tags ([whisper], [laughing
  // nervously]) carry no colon and survive.
  text = text.replace(/\[[^\][]*:[^\][]*\]/g, " ");
  // A streaming slice force-cut inside a directive leaves an unterminated
  // head (`…[game_state: set "night`) or an orphan tail (`phase: x]…`).
  // Colon-gated so prose with a stray bracket survives.
  text = text.replace(/\[[^\][]*:[^\][]*$/, " ");
  text = text.replace(/^[^\][]*:[^\][]*\]/, " ");
  // Markdown images/links: keep the label, drop the URL.
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Bare URLs read as garbage.
  text = text.replace(/https?:\/\/\S+/g, " ");
  // Markdown headers, blockquote markers, list bullets, table pipes.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\|.*\|[ \t]*$/gm, " ");
  // Emphasis / strike / inline code: drop the markers, keep the text.
  // (Roleplay `*action*` asterisks land here too — the narration survives.)
  text = text.replace(/[*_~`]+/g, "");
  // Horizontal rules.
  text = text.replace(/^[ \t]*(?:-{3,}|—{2,}|={3,})[ \t]*$/gm, " ");

  // Collapse whitespace, keep sentence-ish line breaks.
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{2,}/g, "\n");
  return text.trim();
}

/** Extract quoted dialogue, in original order of appearance.
 *  Shared scanner (see @yumina/shared tts-dialogue): outermost quotes only,
 *  CJK/curly/guillemet/straight pairs, Spanish raya lines, and salvage of
 *  unterminated quotes. Runs on stripped text, where paragraphs are single
 *  newlines. */
export function extractDialogue(text: string): string[] {
  return extractDialogueTexts(text, { paragraph: "single" });
}

/** Truncate at a sentence-ish boundary so the readout doesn't stop mid-word. */
export function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(
    slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"),
    slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"),
    slice.lastIndexOf("\n"),
  );
  // Only respect the boundary when it keeps most of the budget — otherwise a
  // single early period would throw away 90% of the readable text.
  return boundary > maxChars * 0.5 ? slice.slice(0, boundary + 1) : slice;
}

/**
 * Full pipeline: markup strip → optional dialogue-only extraction → length cap.
 * Returns "" when nothing speakable remains.
 */
export function prepareTtsText(raw: string, mode: TtsReadingMode): string {
  const stripped = stripMarkupForTts(raw ?? "");
  if (!stripped) return "";

  let text = stripped;
  if (mode === "dialogue") {
    const dialogue = extractDialogue(stripped);
    // No quotes → read everything. Silence would read as a broken button.
    if (dialogue.length > 0) text = dialogue.join("\n");
  }

  return truncateAtBoundary(text, TTS_MAX_TEXT_CHARS).trim();
}
