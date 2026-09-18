import { z } from 'zod';

export const aiGenerationConfigSchema = z.object({
  maxTokens: z.number().int().min(256).max(32768).optional(),
  maxContext: z.number().int().min(4096).max(2_000_000).optional(),
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
export const AI_GENERATION_DEFAULTS: Readonly<Required<AiGenerationConfig>> = {
  maxTokens: 12000, maxContext: 200000, temperature: 1.0, topP: 1.0,
  frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1.08,
  topK: 0, minP: 0, reasoningEffort: 'low', streaming: true,
};

/** Preferences may contain legacy or unrelated fields. Validate independently
 * so one old field cannot discard the user's other saved settings. */
export function resolveAiGenerationConfig(input: unknown): Required<AiGenerationConfig> {
  const resolved = { ...AI_GENERATION_DEFAULTS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return resolved;
  for (const key of Object.keys(aiGenerationConfigSchema.shape) as (keyof AiGenerationConfig)[]) {
    const value = aiGenerationConfigSchema.shape[key].safeParse((input as Record<string, unknown>)[key]);
    if (value.success && value.data !== undefined) Object.assign(resolved, { [key]: value.data });
  }
  return resolved;
}
