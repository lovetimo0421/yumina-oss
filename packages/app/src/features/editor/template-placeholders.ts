import { useTranslation } from "react-i18next";
import type { WorldEntry } from "@yumina/engine";

/* Template-seeded entries carry a `template-content:<key>` tag. When the
 * entry's content is still empty, the editor shows the i18n template text as
 * a placeholder — once the user types anything, the placeholder disappears.
 * This lets new worlds feel scaffolded without forcing creators to delete the
 * guidance text manually. */

export const TEMPLATE_CONTENT_TAG_PREFIX = "template-content:";

/** Maps the tag key (e.g. "chat-character") to the i18n path for the
 * placeholder body. Anything not in this map is left without a placeholder. */
const TEMPLATE_I18N: Record<string, string> = {
  "chat-character": "chat.entries.character.content",
  "chat-worldview": "chat.entries.worldview.content",
  "chat-dialogueAndStyle": "chat.entries.dialogueAndStyle.content",
  "world-overview": "world.entries.worldOverview.content",
  "world-systemAndPowers": "world.entries.systemAndPowers.content",
  "world-npcA": "world.entries.npcA.content",
  "world-npcB": "world.entries.npcB.content",
  "world-narrativeStyle": "world.entries.narrativeStyle.content",
};

export function getTemplateContentKey(entry: Pick<WorldEntry, "tags">): string | null {
  const tag = entry.tags?.find((t) => t.startsWith(TEMPLATE_CONTENT_TAG_PREFIX));
  if (!tag) return null;
  return tag.slice(TEMPLATE_CONTENT_TAG_PREFIX.length);
}

/** React hook: returns the i18n placeholder text for an entry, or "" if it
 * isn't a template entry. Only useful when entry.content is empty — the
 * textarea's `placeholder` attribute already hides itself once value fills in. */
export function useTemplateContentPlaceholder(entry: Pick<WorldEntry, "tags">): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("templates-content") as { t: (key: string) => string };
  const key = getTemplateContentKey(entry);
  if (!key) return "";
  const i18nPath = TEMPLATE_I18N[key];
  return i18nPath ? t(i18nPath) : "";
}
