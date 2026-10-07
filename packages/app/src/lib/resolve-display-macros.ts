/**
 * Client-side replacement of {{user}} and {{char}} macros in displayed message content.
 * This ensures the player always sees their current persona/display name,
 * even for messages stored before persona support was added.
 */

const MACRO_RE = /\{\{(user|char)\}\}/gi;

/** The names a preview shows for the macros before anyone plays: the player
 *  as 「你」 (the card is read from their side), the character as its own
 *  entry's name. In the editor's preview and the board's rows {{user}} used
 *  to stand as written — code where a newcomer expected a sentence. */
export function previewMacroNames(entries: ReadonlyArray<{ role: string; name: string; enabled?: boolean }>, you: string): { user: string; char: string } {
  const char = entries.find((e) => e.role === "character" && e.enabled !== false)?.name?.trim();
  return { user: you, char: char || you };
}

export function resolveDisplayMacros(
  text: string,
  userName: string,
  charName: string,
): string {
  return text.replace(MACRO_RE, (_match, key: string) => {
    const lower = key.toLowerCase();
    if (lower === "user") return userName;
    if (lower === "char") return charName;
    return _match;
  });
}
