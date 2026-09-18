import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions } from "../db/schema.js";
import type { SocialState } from "@yumina/engine";
/** Actions and generation claims share the same lock; no last-writer-wins snapshots. */
export async function mutateSocialSession(sessionId: string, userId: string, initial: SocialState, fn: (state: SocialState) => SocialState) {
    return db.transaction(async (tx) => {
        const result = await tx.execute(sql `SELECT state FROM play_sessions WHERE id=${sessionId} AND user_id=${userId} FOR UPDATE`);
        const row = result.rows[0] as {
            state: Record<string, unknown>;
        } | undefined;
        if (!row)
            throw new Error("Session not found");
        const metadata = (row.state.metadata ?? {}) as Record<string, unknown>;
        const stored = metadata.social as SocialState | undefined;
        const initialized = !stored?.epoch;
        const previous = initialized ? { ...(stored ?? initial), epoch: crypto.randomUUID() } : stored;
        const next = fn(previous);
        if (initialized || next !== previous) {
            if (JSON.stringify(next).length > 4000000)
                throw new Error("This session is full. Start a new session to continue.");
            await tx.update(playSessions).set({ state: { ...row.state, metadata: { ...metadata, social: next } }, updatedAt: new Date() }).where(eq(playSessions.id, sessionId));
        }
        return next;
    });
}
