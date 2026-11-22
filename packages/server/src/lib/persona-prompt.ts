import { formatPersonaEntries, type PersonaEntry } from "@yumina/shared";

export interface PromptPersona {
  name: string;
  appearance?: string | null;
  personality?: string | null;
  backstory?: string | null;
  entries?: PersonaEntry[];
}

export interface PersonaPromptMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** True when a persona field's text is already in the card's own system prompt,
 * i.e. the card wrote {{persona}} / {{persona_backstory}} etc. Short texts only
 * count with their label so a one-word field can't match by coincidence. */
function alreadyInPrompt(systemText: string, label: string, text: string): boolean {
  if (systemText.includes(`${label}: ${text}`)) return true;
  return text.length >= 40 && systemText.includes(text);
}

/** Build a system message describing the player's active persona.
 *
 * The name line is deliberately explicit. A header like
 * "[The user is roleplaying as Alex]" can read as a role/card label, so models
 * may fail to use "Alex" when a character is asked to say the user's name.
 *
 * `existingSystemText` is the card's assembled system prompt. Fields the card
 * already placed there through persona macros are left out, so the persona is
 * not sent twice per turn; the name line always stays. */
export function buildPersonaSystemMessage(
  persona: PromptPersona | null,
  existingSystemText = "",
): string | null {
  if (!persona) return null;

  const parts: string[] = [
    "[User Persona]",
    `User's roleplay name: ${persona.name}`,
  ];
  const field = (label: string, text?: string | null) => {
    if (text && !alreadyInPrompt(existingSystemText, label, text)) parts.push(`${label}: ${text}`);
  };
  field("Appearance", persona.appearance);
  field("Personality", persona.personality);
  field("Backstory", persona.backstory);
  const entries = (persona.entries ?? []).filter(
    (e) => !alreadyInPrompt(existingSystemText, e.title, e.content),
  );
  const formatted = formatPersonaEntries(entries);
  if (formatted) parts.push(formatted);
  return parts.join("\n");
}

/** Append the platform-generated persona message to an assembled LLM prompt.
 * A null persona is a strict no-op so the outgoing prompt contains no trace of
 * the optional persona feature. All generation paths use this helper. */
export function appendPersonaSystemMessage<M extends { role: string; content?: unknown }>(
  messages: M[],
  persona: PromptPersona | null,
): void {
  if (!persona) return;
  const systemText = messages
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n");
  const content = buildPersonaSystemMessage(persona, systemText);
  if (content) messages.push({ role: "system", content } as unknown as M);
}
