import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { acquireConcurrency, checkRateLimit, releaseConcurrency } from "../middleware/rate-limit.js";
import type { VoiceRouteServices } from "../routes/voice.js";
import { getUserApiKey } from "./resolve-provider.js";
import { createOpenAiVoiceCall } from "./voice-realtime.js";

export const voiceServices: VoiceRouteServices = {
  async authenticate(c) {
    await authMiddleware(c, async () => {});
    return c.get("user") ?? null;
  },
  async ownsSession(sessionId, userId) {
    const [session] = await db.select({ id: playSessions.id }).from(playSessions)
      .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId))).limit(1);
    return Boolean(session);
  },
  // This only decrypts this user's OpenAI key. Never use the model resolver,
  // official key selection, wallet billing, or custom-endpoint metadata here.
  getOpenAiKey: (userId) => getUserApiKey(userId, "openai"),
  checkRateLimit: (userId) => checkRateLimit(`voice:${userId}`, 4),
  acquireConnection: (userId) => acquireConcurrency(`voice:${userId}`, 1, 45),
  releaseConnection: (userId) => releaseConcurrency(`voice:${userId}`),
  connect: createOpenAiVoiceCall,
};

/** True when the session plays the 1984 card ("Big Brother Is Listening"). Matched by its
 * root component and dossier variable, never its display name: the name is the creator's to change. */
export async function isUnpersonSession(sessionId: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT 1 FROM play_sessions s JOIN worlds w ON w.id = s.world_id
    WHERE s.id = ${sessionId} AND w.schema->'rootComponent'->>'id' = 'unperson-root'
      AND w.schema->'variables' @> '[{"id":"unperson-dossier"}]'::jsonb LIMIT 1`);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  return rows.length > 0;
}

/**
 * True when a session may place a credits-paid live call (lib/voice-live-credits.ts).
 *
 * It used to be the 1984 card alone. Owner, 2026-11-12: any card may, so an
 * author can build a character the player talks to out loud. The exception is
 * a card rated for adults: a live call sends the card's own direction to
 * OpenAI on Yumina's key, and that key is not to depend on what such a card
 * says. Those cards keep hold-to-talk and the character's reading voice, and a
 * player's own OpenAI key still works for them as before.
 */
export async function isLiveVoiceSession(sessionId: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT 1 FROM play_sessions s JOIN worlds w ON w.id = s.world_id
    WHERE s.id = ${sessionId} AND (
      (w.age_rating = 'all' AND w.is_nsfw IS NOT TRUE)
      OR (w.schema->'rootComponent'->>'id' = 'unperson-root' AND w.schema->'variables' @> '[{"id":"unperson-dossier"}]'::jsonb)
    ) LIMIT 1`);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  return rows.length > 0;
}
