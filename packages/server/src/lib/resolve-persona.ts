import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, userPersonas } from "../db/schema.js";

import { captureSessionPersona, type SessionPersona } from "./session-persona.js";

export type ResolvedPersona = typeof userPersonas.$inferSelect;

/** Resolve the account selection used by new and unlocked sessions. Read the
 * primary so a just-saved choice is visible to the next load or generation.
 * Legacy world pins remain historical data and never override this choice. */
export async function resolvePersonaForWorld(
  userId: string,
  _worldId: string | null | undefined
): Promise<ResolvedPersona | null> {
  const [active] = await db
    .select()
    .from(userPersonas)
    .where(and(eq(userPersonas.userId, userId), eq(userPersonas.isActive, true)))
    .limit(1);
  return active ?? null;
}

/** A locked session keeps its selected persona while an unlocked session follows
 * the account selection. Resolve a locked persona by ID so profile edits still
 * apply; the public snapshot is the fallback if that persona was later deleted. */
export async function resolvePersonaForSession(session: Pick<typeof playSessions.$inferSelect, "id" | "userId" | "state" | "sessionPersona" | "personaLocked">) {
  if (!session.personaLocked) return resolvePersonaForWorld(session.userId, null);
  const snapshot = session.sessionPersona?.persona ?? null;
  if (!snapshot?.id) return snapshot;
  const [current] = await db
    .select()
    .from(userPersonas)
    .where(and(eq(userPersonas.id, snapshot.id), eq(userPersonas.userId, session.userId)))
    .limit(1);
  return current ?? snapshot;
}

/** Shared by profile and in-chat selection. Lock in a stable order so concurrent
 * choices cannot leave multiple personas active. Never copy private notes. */
export async function setAccountPersona(userId: string, personaId: string | null) {
  return db.transaction(async (tx) => {
    const personas = await tx.select().from(userPersonas)
      .where(eq(userPersonas.userId, userId)).orderBy(userPersonas.id).for("update");
    const persona = personas.find((p) => p.id === personaId);
    if (personaId !== null && !persona) return { error: "Persona not found" } as const;
    await tx.update(userPersonas).set({
      isActive: personaId === null ? false : sql`${userPersonas.id} = ${personaId}`,
      updatedAt: new Date(),
    }).where(eq(userPersonas.userId, userId));
    return { data: captureSessionPersona(persona ?? null) } as const;
  });
}

/** Session and persona must both belong to the authenticated user. */
export async function setSessionPersona(userId: string, sessionId: string, personaId: string | null): Promise<
  { data: SessionPersona; error?: never } | { error: "Session not found" | "Persona not found"; data?: never }
> {
  const [owned] = await db.select({ id: playSessions.id }).from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
  if (!owned) return { error: "Session not found" } as const;
  const result = await setAccountPersona(userId, personaId);
  if ("error" in result) return result;
  // Backward-compatible behavior for older clients: choosing from the chat
  // picker changes the global persona and puts this session back in follow mode.
  await db.update(playSessions).set({
    personaLocked: false,
    sessionPersona: result.data,
    updatedAt: new Date(),
  }).where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
  return result;
}

/** Lock one session to a persona (including explicit no-persona), or release it
 * so it immediately follows the account selection again. */
export async function setSessionPersonaLock(
  userId: string,
  sessionId: string,
  locked: boolean,
  personaId?: string | null,
): Promise<
  { data: { personaLocked: boolean; sessionPersona: SessionPersona }; error?: never }
  | { error: "Session not found" | "Persona not found"; data?: never }
> {
  const [owned] = await db.select({ id: playSessions.id }).from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
  if (!owned) return { error: "Session not found" } as const;

  if (!locked) {
    const binding = captureSessionPersona(await resolvePersonaForWorld(userId, null));
    await db.update(playSessions).set({ personaLocked: false, sessionPersona: binding, updatedAt: new Date() })
      .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
    return { data: { personaLocked: false, sessionPersona: binding } } as const;
  }

  if (personaId === undefined) return { error: "Persona not found" } as const;
  const [persona] = personaId === null ? [] : await db.select().from(userPersonas)
    .where(and(eq(userPersonas.id, personaId), eq(userPersonas.userId, userId)));
  if (personaId !== null && !persona) return { error: "Persona not found" } as const;
  const binding = captureSessionPersona(persona ?? null);
  await db.update(playSessions).set({ personaLocked: true, sessionPersona: binding, updatedAt: new Date() })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
  return { data: { personaLocked: true, sessionPersona: binding } } as const;
}
