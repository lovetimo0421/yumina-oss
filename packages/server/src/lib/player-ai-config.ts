import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";

/** The player's synced Yumina AI settings (user.preferences.aiConfig), for
 *  server-started calls that have no request overrides to read. */
export interface PlayerAiConfig {
  selectedModel?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export async function loadPlayerAiConfig(userId: string): Promise<PlayerAiConfig> {
  const [row] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  const raw = (row?.preferences as { aiConfig?: Record<string, unknown> } | null)?.aiConfig ?? {};
  const out: PlayerAiConfig = {};
  if (typeof raw.selectedModel === "string" && raw.selectedModel) out.selectedModel = raw.selectedModel;
  for (const key of ["temperature", "topP", "topK", "minP", "frequencyPenalty", "presencePenalty"] as const) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}
