import { and, eq } from "drizzle-orm";
import { LIVE_CANON_EXTENSION_KEY } from "@yumina/shared";
import { db } from "../../db/index.js";
import { playSessions, worlds } from "../../db/schema.js";
import { registerExtensionHooks } from "../../lib/extension-hooks.js";
import { resolveLiveCanonWorldForTurn } from "./service.js";

export function registerLiveCanonExtension(): void {
  registerExtensionHooks(LIVE_CANON_EXTENSION_KEY, {
    resolveCapabilities: async ({ sessionId, ownerUserId }) => {
      try {
        const [row] = await db
          .select({ allowLiveCanon: worlds.allowLiveCanon })
          .from(playSessions)
          .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
          .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, ownerUserId)))
          .limit(1);
        return row?.allowLiveCanon ? ["session-lore"] : [];
      } catch (error) {
        console.warn("[LiveCanon] capability check failed closed:", error instanceof Error ? error.message : error);
        return [];
      }
    },
    transformWorldDefinition: async ({ sessionId, ownerUserId, capabilities, worldDef }) => {
      if (!capabilities.has("session-lore")) return worldDef;
      try {
        return await resolveLiveCanonWorldForTurn(worldDef, sessionId, ownerUserId);
      } catch (error) {
        console.warn("[LiveCanon] overlay resolution failed closed:", error instanceof Error ? error.message : error);
        return worldDef;
      }
    },
  });
}
