import { and, eq } from "drizzle-orm";
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
