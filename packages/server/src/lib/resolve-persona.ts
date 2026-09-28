import { and, eq, sql } from "drizzle-orm";
import { db, type DrizzleDB } from "../db/index.js";
import { playSessions, userPersonas } from "../db/schema.js";

import { captureSessionPersona, type SessionPersona } from "./session-persona.js";

export type ResolvedPersona = typeof userPersonas.$inferSelect;

/** Resolve the account selection used by new and unlocked sessions. Read the
 * primary so a just-saved choice is visible to the next load or generation.
 * Legacy world pins remain historical data and never override this choice. */
export async function resolvePersonaForWorld(
  userId: string,
  _worldId: string | null | undefined,
  database: DrizzleDB = db,
): Promise<ResolvedPersona | null> {
  const [active] = await database
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

/** Account/profile selection only. Lock in a stable order so concurrent
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
export async function setSessionPersona(userId: string, sessionId: string, personaId: string | null, expectedVersion?: string): Promise<
  { data: SessionPersona; error?: never } | { error: "Session not found" | "Persona not found" | "Persona selection changed"; data?: never }
> {
  const result = await setSessionPersonaLock(userId, sessionId, true, personaId, expectedVersion);
  if (result.error) return { error: result.error };
  // Preserve the legacy response shape, but never write the account default.
  return { data: result.data.sessionPersona };
}

/** Lock one session to a persona (including explicit no-persona), or release it
 * so it immediately follows the account selection again. */
export async function setSessionPersonaLock(
  userId: string,
  sessionId: string,
  locked: boolean,
  personaId?: string | null,
  expectedVersion?: string,
): Promise<
  { data: { personaLocked: boolean; sessionPersona: SessionPersona }; error?: never }
  | { error: "Session not found" | "Persona not found" | "Persona selection changed"; data?: never }
> {
  const [owned] = await db.select({ id: playSessions.id, sessionPersona: playSessions.sessionPersona }).from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
  if (!owned) return { error: "Session not found" } as const;
  const previousVersion = expectedVersion ?? owned.sessionPersona?.selectionVersion ?? "";
  let persona;
  if (!locked) persona = await resolvePersonaForWorld(userId, null);
  else {
    if (personaId === undefined) return { error: "Persona not found" } as const;
    [persona] = personaId === null ? [] : await db.select().from(userPersonas)
      .where(and(eq(userPersonas.id, personaId), eq(userPersonas.userId, userId)));
    if (personaId !== null && !persona) return { error: "Persona not found" } as const;
  }
  const binding = { ...captureSessionPersona(persona ?? null), selectionVersion: crypto.randomUUID() };
  // Compare-and-swap makes a delayed request unable to overwrite a newer save,
  // including when a client timed out and retried before the old request finished.
  // Return only the ID: a full RETURNING row would detoast large game states.
  const updated = await db.execute(sql`UPDATE ${playSessions}
    SET persona_locked = ${locked}, session_persona = ${JSON.stringify(binding)}::jsonb, updated_at = now()
    WHERE ${playSessions.id} = ${sessionId} AND ${playSessions.userId} = ${userId}
      AND coalesce(${playSessions.sessionPersona}->>'selectionVersion', '') = ${previousVersion}
    RETURNING ${playSessions.id}`);
  if (!updated.rows.length) return { error: "Persona selection changed" } as const;
  return { data: { personaLocked: locked, sessionPersona: binding } } as const;
}
