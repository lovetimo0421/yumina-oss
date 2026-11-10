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

/**
 * The range a player may actually generate with. The schema above stays wide
 * (-2..2) on purpose: accounts already store values out there, and rejecting
 * them would 400 every send instead of just tightening it. Instead the story
 * call clamps to these at request time, and the settings sliders stop here.
 *
 * Why these numbers: high presence/frequency penalties make the model avoid
 * every token it has already used, so a few hundred tokens into a reply it
 * runs out of plausible words and switches languages mid-sentence — the
 * "multilingual word salad" reports (temp 1.45 + presence 1.71). Above ~1 the
 * penalty only buys that failure, and below 0 it rewards repetition, which is
 * the opposite of what roleplay ever needs (Kimi's loop fix is the separate
 * repetitionPenalty, untouched here). Temperature stops at 1.5, the slider's
 * existing ceiling and the card-author cap; models with a lower documented
 * ceiling (Claude, LongCat 2.0: 1.0) are narrowed further at the provider.
 */
export const PLAYER_SAMPLING_BOUNDS = {
  temperature: { min: 0, max: 1.5 },
  frequencyPenalty: { min: 0, max: 1 },
  presencePenalty: { min: 0, max: 1 },
} as const;

type BoundedKey = keyof typeof PLAYER_SAMPLING_BOUNDS;

/** Clamp the bounded keys into PLAYER_SAMPLING_BOUNDS; every other key, and any
 * non-numeric or missing value, passes through untouched. Returns a copy. */
export function clampPlayerSampling<T extends Partial<Record<BoundedKey, number | undefined>> | undefined>(values: T): T {
  if (!values) return values;
  const out: Partial<Record<BoundedKey, number | undefined>> = { ...values };
  for (const key of Object.keys(PLAYER_SAMPLING_BOUNDS) as BoundedKey[]) {
    const v = out[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const { min, max } = PLAYER_SAMPLING_BOUNDS[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  return out as T;
}

/** Preferences may contain legacy or unrelated fields. Validate independently
 * so one old field cannot discard the user's other saved settings. */
export function resolveAiGenerationConfig(input: unknown): AiGenerationDefaults {
  const resolved = { ...AI_GENERATION_DEFAULTS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return resolved;
  for (const key of Object.keys(aiGenerationConfigSchema.shape) as (keyof AiGenerationConfig)[]) {
    const value = aiGenerationConfigSchema.shape[key].safeParse((input as Record<string, unknown>)[key]);
    if (value.success && value.data !== undefined) Object.assign(resolved, { [key]: value.data });
  }
  return clampPlayerSampling(resolved);
}
