import type { ActivePersonaLike } from "./persona-metadata.js";

/** Stored outside game state so restoring a turn cannot change the player's identity. */
export interface SessionPersona {
  persona: (ActivePersonaLike & { id?: string }) | null;
}

export function captureSessionPersona(persona: (ActivePersonaLike & { id?: string }) | null): SessionPersona {
  if (!persona) return { persona: null };
  const { id, name, avatarUrl, appearance, personality, backstory } = persona;
  return { persona: { id, name, avatarUrl, appearance, personality, backstory } };
}

/** Legacy sessions keep their saved identity, including an explicit absence.
 * Never guess by name or consult the account's current persona here. */
export function legacySessionPersona(state: Record<string, unknown>): SessionPersona {
  const m = (state.metadata ?? {}) as Record<string, unknown>;
  if (m.personaActive !== true || typeof m.personaName !== "string") return { persona: null };
  const text = (key: string) => typeof m[key] === "string" ? m[key] as string : "";
  return captureSessionPersona({
    name: m.personaName,
    avatarUrl: text("personaImage"),
    appearance: text("personaAppearance"),
    personality: text("personaPersonality"),
    backstory: text("personaBackstory"),
  });
}
