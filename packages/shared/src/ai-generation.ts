import { z } from 'zod';

export const aiGenerationConfigSchema = z.object({
  maxTokens: z.number().int().min(256).max(32768).optional(),
  maxContext: z.number().int().min(4096).max(2_000_000).optional(),
  /**
   * How much of the conversation is kept word for word before older scenes
   * are folded into the running recap. The only memory dial a player is asked
   * to set, and the same on every plan: what a plan buys is how much of the
   * WORLD we carry (memoryCap), which is charged separately.
   */
  storyMemory: z.number().int().min(2048).max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  repetitionPenalty: z.number().min(0).max(2).optional(),
  topK: z.number().int().min(0).max(500).optional(),
  minP: z.number().min(0).max(1).optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  streaming: z.boolean().optional(),
});

export type AiGenerationConfig = z.infer<typeof aiGenerationConfigSchema>;

/**
 * storyMemory is deliberately ABSENT here. Every other key has a safe
 * default; this one does not, because "unset" has to keep meaning "the user
 * has never chosen" all the way down. Baking 16,000 in would make every
 * existing account look like it had asked for 16,000 and would cut its
 * prompts the moment this deploys. resolveStoryMemory decides what an absent
 * value means, using the account's age (packages/shared/src/story-memory.ts).
 */
export type AiGenerationDefaults = Readonly<Required<Omit<AiGenerationConfig, "storyMemory">>> & {
  storyMemory?: number;
};
export const AI_GENERATION_DEFAULTS: AiGenerationDefaults = {
  maxTokens: 12000, maxContext: 200000, temperature: 1.0, topP: 1.0,
  frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1.08,
  topK: 0, minP: 0, reasoningEffort: 'low', streaming: true,
};

/** Preferences may contain legacy or unrelated fields. Validate independently
 * so one old field cannot discard the user's other saved settings. */
export function resolveAiGenerationConfig(input: unknown): AiGenerationDefaults {
  const resolved = { ...AI_GENERATION_DEFAULTS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return resolved;
  for (const key of Object.keys(aiGenerationConfigSchema.shape) as (keyof AiGenerationConfig)[]) {
    const value = aiGenerationConfigSchema.shape[key].safeParse((input as Record<string, unknown>)[key]);
    if (value.success && value.data !== undefined) Object.assign(resolved, { [key]: value.data });
  }
  return resolved;
}
