import { z } from "zod";

/**
 * The AIs a player can pick a model for, besides the story AI (selectedModel).
 * The decision AI is not here on purpose: it answers with option
 * probabilities, which only the server's dedicated judge model can give.
 *
 * - world:   the AIs inside a card's situations (narrators, workers, called AIs)
 * - memory:  the session memory updater
 * - summary: story compaction and the layered summaries
 * - guard:   the state check that repairs missed variable updates
 */
export const PLAYER_TEXT_AI_ROLES = ["world", "memory", "summary", "guard"] as const;
export type PlayerTextAiRole = (typeof PLAYER_TEXT_AI_ROLES)[number];

/** What background AIs run on when nobody picked a model: cheap, fast, CJK-aware. */
export const DEFAULT_BACKGROUND_MODEL = "google/gemini-3.1-flash-lite";

/** Stored instead of a model id: use whatever the story AI uses. */
export const FOLLOW_STORY_MODEL = "@story";

const roleModel = z.string().min(1).max(200);

/** Absent role = the platform default for that AI. `video` is the model for
 *  the short films in chat (see film-video-models.ts). `write` is 帮我写, the
 *  composer's write-for-me: absent (or FOLLOW_STORY_MODEL) = the story model. */
export const playerRoleModelsSchema = z.object({
  world: roleModel.optional(),
  memory: roleModel.optional(),
  summary: roleModel.optional(),
  guard: roleModel.optional(),
  video: roleModel.optional(),
  write: roleModel.optional(),
}).strict();

/** The model 帮我写 runs on: the player's pick, else the story model. */
export function composeAssistModel(roleModels: PlayerRoleModels | undefined, storyModel: string): string {
  const picked = roleModels?.write;
  return picked && picked !== FOLLOW_STORY_MODEL ? picked : storyModel;
}

export type PlayerRoleModels = z.infer<typeof playerRoleModelsSchema>;

/** The model a player's choice for one role stands for, or null for the platform default. */
export function resolvePlayerRoleModel(
  roleModels: PlayerRoleModels | undefined,
  role: PlayerTextAiRole,
  storyModel: string | undefined,
): string | null {
  const picked = roleModels?.[role];
  if (!picked) return null;
  if (picked === FOLLOW_STORY_MODEL) return storyModel || null;
  return picked;
}

/**
 * A model id saved on a session counts as the player's choice only when it
 * differs from the platform default. Background jobs used to write the model
 * they ran on back into the session, so the default sitting in a column says
 * nothing about what the player wanted.
 */
export function sessionModelChoice(saved: string | null | undefined, platformDefault: string): string | null {
  const value = saved?.trim();
  return value && value !== platformDefault ? value : null;
}
