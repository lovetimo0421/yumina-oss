import { getTemplateContentKey, templateContentI18nPath } from "@/features/editor/template-placeholders";
import { isPhoneScreen } from "@/lib/editor-surface";
import { LEARNING_PHONE_OPEN_EVENT } from "../learn/learning-catalog";

/**
 * The blanks a template card still has before it plays as anything.
 *
 * A card started from 角色聊天 / 世界模拟 arrives with its character (or its
 * world) and its opening as empty rows wearing guidance text. The simple
 * editor marks those cards 必填 and says "fill them and you can play"; on the
 * canvas nothing said it, and most newcomers from a template left the card
 * exactly as it arrived (11/05: 545 of 801 first canvas cards still carried
 * the template's name, 11% of them ever edited).
 *
 * Only the template's own blanks count. A card that never had them (blank,
 * imported, written by the assistant) has nothing to show here, so this is
 * not a readiness meter for every card — that one was taken off the frame
 * header on 9/28 for being a number nobody acted on. This one names a row and
 * the chip that shows it opens that row.
 */

/** The template rows a card cannot play without: who the AI is (or the world
 *  it runs), and the first thing the player reads. Style, sample dialogue
 *  and NPCs are better filled, but a card plays without them. */
const REQUIRED_KEYS = ["chat-character", "world-overview", "chat-greeting", "world-greeting"] as const;

export interface TemplateBlank {
  entryId: string;
  /** The canvas node id: `greeting:<id>` for an opening, `entry:<id>` else. */
  objectId: string;
  /** templates-content i18n key for the row's name (「角色」「开场白」). */
  labelKey: string;
}

/** Guidance a template wrote is the only thing in it: empty, or one bracketed
 *  block (older drafts stored the guidance as content). */
function isBlank(text: string | undefined | null): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return true;
  return /^[[【]/.test(trimmed) && /[\]】]$/.test(trimmed);
}

export function templateBlanks(
  entries: ReadonlyArray<{ id: string; role: string; content?: string; tags?: string[] }>,
): TemplateBlank[] {
  const blanks: TemplateBlank[] = [];
  for (const key of REQUIRED_KEYS) {
    const entry = entries.find((e) => getTemplateContentKey(e) === key);
    if (!entry || !isBlank(entry.content)) continue;
    const contentPath = templateContentI18nPath(key);
    if (!contentPath) continue;
    blanks.push({
      entryId: entry.id,
      objectId: `${entry.role === "greeting" ? "greeting" : "entry"}:${entry.id}`,
      labelKey: contentPath.replace(/\.content$/, ".name"),
    });
  }
  // Who the AI is before what it opens with: the opening is written in their voice.
  return blanks.sort((a, b) => Number(a.objectId.startsWith("greeting:")) - Number(b.objectId.startsWith("greeting:")));
}

/** Open a row on the board, the way a click on it would: the desktop canvas
 *  brings its block over and opens it in place (the jump the player
 *  interface's 「打开」 uses); the phone board opens its page, as a lesson
 *  does. */
export function openRowOnBoard(objectId: string): void {
  if (isPhoneScreen()) {
    window.dispatchEvent(new CustomEvent(LEARNING_PHONE_OPEN_EVENT, { detail: { objectId } }));
    return;
  }
  window.dispatchEvent(new CustomEvent("yumina:studio-canvas-focus", { detail: { objId: objectId, open: true } }));
}
