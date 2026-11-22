import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
import { playerRoleModelsSchema, resolvePlayerRoleModel, type PlayerRoleModels, type PlayerTextAiRole } from "@yumina/shared";

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
  /** The player's model per background AI; see @yumina/shared ai-roles. */
  roleModels?: PlayerRoleModels;
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
  const roles = playerRoleModelsSchema.safeParse(raw.roleModels);
  if (roles.success) out.roleModels = roles.data;
  return out;
}

/** The model the player picked for one background AI, or null for the platform default. */
export async function loadPlayerRoleModel(userId: string, role: PlayerTextAiRole): Promise<string | null> {
  const config = await loadPlayerAiConfig(userId);
  return resolvePlayerRoleModel(config.roleModels, role, config.selectedModel);
}
