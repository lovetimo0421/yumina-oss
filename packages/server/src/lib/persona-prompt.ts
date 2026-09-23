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

/** Build a system message describing the player's active persona.
 *
 * The name line is deliberately explicit. A header like
 * "[The user is roleplaying as Alex]" can read as a role/card label, so models
 * may fail to use "Alex" when a character is asked to say the user's name. */
export function buildPersonaSystemMessage(persona: PromptPersona | null): string | null {
  if (!persona) return null;

  const parts: string[] = [
    "[User Persona]",
    `User's roleplay name: ${persona.name}`,
  ];
  if (persona.appearance) parts.push(`Appearance: ${persona.appearance}`);
  if (persona.personality) parts.push(`Personality: ${persona.personality}`);
  if (persona.backstory) parts.push(`Backstory: ${persona.backstory}`);
  const entries = formatPersonaEntries(persona.entries);
  if (entries) parts.push(entries);
  return parts.join("\n");
}

/** Append the platform-generated persona message to an assembled LLM prompt.
 * A null persona is a strict no-op so the outgoing prompt contains no trace of
 * the optional persona feature. All generation paths use this helper. */
export function appendPersonaSystemMessage(
  messages: PersonaPromptMessage[],
  persona: PromptPersona | null,
): void {
  const content = buildPersonaSystemMessage(persona);
  if (content) messages.push({ role: "system", content });
}
