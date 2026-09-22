import { z } from "zod";
import { aiGenerationConfigSchema } from '../ai-generation.js';
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_REGEX,
  MAX_BIO_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_WEBSITE_LENGTH,
} from "../constants/limits.js";

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH).optional(),
  image: z.string().min(1).nullable().optional(),
  banner: z.string().min(1).nullable().optional(),
  bio: z.string().max(MAX_BIO_LENGTH).nullable().optional(),
  location: z.string().max(MAX_LOCATION_LENGTH).nullable().optional(),
  website: z
    .string()
    .max(MAX_WEBSITE_LENGTH)
    .refine((v) => v === "" || /^https?:\/\//.test(v), {
      message: "Website must start with http:// or https://",
    })
    .nullable()
    .optional(),
  username: z
    .string()
    .min(MIN_USERNAME_LENGTH)
    .max(MAX_USERNAME_LENGTH)
    .regex(USERNAME_REGEX, "Username must start with a letter and contain only letters, numbers, underscores, or hyphens")
    .optional(),
  birthYear: z.number().int().min(1900).max(new Date().getFullYear()).nullable().optional(),
  featuredWorldId: z.string().nullable().optional(),
  preferences: z.record(z.unknown()).optional(),
});

export type UpdateProfileSchema = z.infer<typeof updateProfileSchema>;

export const aiConfigSchema = z.object({
  ...aiGenerationConfigSchema.shape,
  // The account copy of the story-memory dial. The app keeps "never chosen"
  // as null and syncs it like any other key, so null has to be storable here:
  // rejecting it failed the whole PUT — including the first-sync seed of
  // every other setting — and nothing reached the account. Turns never read
  // this copy; they get the dial per request and treat non-numbers as unset.
  storyMemory: aiGenerationConfigSchema.shape.storyMemory.unwrap().nullable().optional(),
  selectedModel: z.string().min(1).max(200).optional(),
  modelFallback: z.object({
    mode: z.enum(["ask", "auto", "stop"]),
    officialModel: z.string().max(200),
    privateModel: z.string().max(200),
    privateKeyId: z.string().min(1).max(200).nullable(),
  }).strict().optional(),
  pinnedModels: z.array(z.string().min(1).max(200)).max(8).optional(),
  // Pins are scoped to the model universe they belong to. Official ids can
  // never render in a BYOK picker, so sharing one list meant the seeded
  // official defaults silently ate half of a BYOK user's slots.
  pinnedPrivateModels: z.array(z.string().min(1).max(200)).max(8).optional(),
  mixMode: z.boolean().optional(),
  modelPool: z.array(z.object({
    modelId: z.string().min(1).max(200),
    weight: z.number().int().min(0).max(100),
    locked: z.boolean().optional(),
  })).max(5).optional(),
}).strict();

export type AiConfigSchema = z.infer<typeof aiConfigSchema>;
