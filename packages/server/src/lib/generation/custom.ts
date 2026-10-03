import { z } from "zod";
import {
  ADVANCED_LIMITS, DENOISE_MAX, DENOISE_MIN, IMAGE_ASPECTS, IMAGE_SAMPLERS,
  MAX_GENERATION_PROMPT_LENGTH, VIDEO_ADVANCED_LIMITS, VIDEO_DURATIONS,
  type PlatformStyleInfo,
} from "@yumina/shared";

// Preserve the shared Studio proposal validation contract while keeping
// hosted generation and billing unavailable in the open-source edition.
export const advancedSchema = z.object({
  width: z.number().int(),
  height: z.number().int(),
  steps: z.number().int().min(ADVANCED_LIMITS.stepsMin).max(ADVANCED_LIMITS.stepsMax),
  cfg: z.number().min(ADVANCED_LIMITS.cfgMin).max(ADVANCED_LIMITS.cfgMax),
  sampler: z.enum(IMAGE_SAMPLERS),
  batchSize: z.number().int().min(ADVANCED_LIMITS.batchMin).max(ADVANCED_LIMITS.batchMax).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  negativePrompt: z.string().max(ADVANCED_LIMITS.maxNegativeLength).optional(),
  loras: z
    .array(
      z.object({
        modelId: z.string().uuid(),
        weight: z
          .number()
          .min(ADVANCED_LIMITS.loraWeightMin)
          .max(ADVANCED_LIMITS.loraWeightMax),
      }),
    )
    .max(ADVANCED_LIMITS.maxLoras)
    .optional(),
  checkpointModelId: z.string().uuid().optional(),
});

export const videoAdvancedSchema = z.object({
  durationSeconds: z.number().int().refine((v) => (VIDEO_DURATIONS as readonly number[]).includes(v)),
  steps: z.number().int().min(VIDEO_ADVANCED_LIMITS.stepsMin).max(VIDEO_ADVANCED_LIMITS.stepsMax),
  cfg: z.number().min(VIDEO_ADVANCED_LIMITS.cfgMin).max(VIDEO_ADVANCED_LIMITS.cfgMax),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  negativePrompt: z.string().max(VIDEO_ADVANCED_LIMITS.maxNegativeLength).optional(),
});

/** The custom-mode fields of a submission. POST /generation/jobs extends this
 *  with the smart-only `cloud` block; the Studio assistant parses through it
 *  as-is, so both callers hit identical limits. */
export const customSubmissionSchema = z.object({
  requestId: z.string().uuid().optional(),
  templateId: z.string().min(1),
  prompt: z.string().min(1).max(MAX_GENERATION_PROMPT_LENGTH),
  referenceAssetId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  advanced: advancedSchema.optional(),
  videoAdvanced: videoAdvancedSchema.optional(),
  /** img2img strength (image templates with a reference image). */
  denoise: z.number().min(DENOISE_MIN).max(DENOISE_MAX).optional(),
  /** Simple-mode resolution pick (e.g. snapped to a reference image). */
  aspectId: z
    .enum(IMAGE_ASPECTS.map((a) => a.id) as [string, ...string[]])
    .optional(),
  /** Platform style slug (image templates) — picks the base checkpoint. */
  style: z.string().max(40).optional(),
  /** Legacy flag from clients that rewrote on submit. Accepted for
   *  compatibility; the prompt is always sent verbatim. */
  enhance: z.boolean().optional(),
});
export type CustomSubmission = z.infer<typeof customSubmissionSchema>;

type ErrorStatus = 400 | 402 | 404 | 409 | 429 | 502 | 503;
/** A refusal carrying exactly the HTTP body the generation route has always
 *  returned for it — the route relays it untouched. */
export class CustomSubmissionError extends Error {
  constructor(public status: ErrorStatus, public body: { error: string; code?: string }) {
    super(body.code ?? body.error);
  }
  get code(): string { return this.body.code ?? "INVALID_REQUEST"; }
}
export const isCustomGenerationEnabled = (): boolean => false;
export async function readyPlatformStyles(): Promise<PlatformStyleInfo[]> { return []; }
export async function submitCustomGeneration(
  _userId: string, _input: CustomSubmission,
): Promise<{ job: { id: string }; newBalance: number }> {
  throw new CustomSubmissionError(503, {
    error: "Image generation is not available in this edition",
    code: "GENERATION_UNAVAILABLE",
  });
}
