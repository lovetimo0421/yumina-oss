/**
 * Client-side replacement of {{user}} and {{char}} macros in displayed message content.
 * This ensures the player always sees their current persona/display name,
 * even for messages stored before persona support was added.
 */

const MACRO_RE = /\{\{(user|char)\}\}/gi;

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
