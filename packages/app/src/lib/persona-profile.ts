/** Only role-play fields may cross into a world's sandbox. Private notes and
 * account identity stay in the host app. */
export interface PersonaProfile {
  name: string;
  appearance: string;
  personality: string;
  backstory: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Use the same saved session selection displayed by PersonaManagerDialog.
 * Never substitute global defaults: an explicit "No Persona" is meaningful.
 * Captured session IDs prevent a late sandbox request from reading another
 * session after navigation. Legacy hosts keep their saved metadata identity. */
export function readPersonaProfile(sessionId: string, session: unknown): PersonaProfile | null {
  const current = record(session);
  if (!sessionId || !current || current.id !== sessionId) return null;
  let persona: Record<string, unknown>;
  if (current.sessionPersona !== undefined && current.sessionPersona !== null) {
    const binding = record(current.sessionPersona);
    if (!binding || !("persona" in binding)) throw new Error("Invalid session Persona");
    if (binding.persona === null) return null;
    const selected = record(binding.persona);
    if (!selected || typeof selected.name !== "string") throw new Error("Invalid session Persona");
    persona = selected;
  } else {
    const metadata = record(record(current.state)?.metadata);
    if (metadata?.personaActive !== true || typeof metadata.personaName !== "string") return null;
    persona = { name: metadata.personaName, appearance: metadata.personaAppearance,
      personality: metadata.personaPersonality, backstory: metadata.personaBackstory };
  }
  const field = (key: string) => typeof persona[key] === "string" ? persona[key] as string : "";
  return { name: field("name"), appearance: field("appearance"), personality: field("personality"), backstory: field("backstory") };
}
