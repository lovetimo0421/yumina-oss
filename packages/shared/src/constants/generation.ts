// ── AI media generation (ComfyUI workers) ────────────────────────────
// Shared between server (pricing enforcement, template validation) and app
// (generation panel). Prices are in mushies ($1 ≈ 1000 mushies) and are the
// single source of truth — the server must never trust a client-sent price.

export type GenerationKind = "image" | "video";

export interface GenerationTemplateInfo {
  id: string;
  kind: GenerationKind;
  /** Price in mushies, deducted on submit and refunded on failure. */
  priceMushies: number;
  /** Video templates animate a reference image (image-to-video). */
  requiresReferenceImage: boolean;
  /** Approximate output length for video templates. */
  durationSeconds?: number;
  /** Rough wall-clock expectation surfaced in the UI. */
  etaMinutes: number;
}

export const GENERATION_TEMPLATES: GenerationTemplateInfo[] = [
  {
    id: "image-smart", kind: "image", priceMushies: 60,
    requiresReferenceImage: false, etaMinutes: 1,
  },
  {
    id: "image-anime",
    kind: "image",
    priceMushies: 10,
    requiresReferenceImage: false,
    etaMinutes: 1,
  },
  {
    id: "video-text",
    kind: "video",
    priceMushies: 40,
    requiresReferenceImage: false,
    durationSeconds: 4,
    etaMinutes: 2,
  },
  {
    id: "video-fast",
    kind: "video",
    priceMushies: 40,
    requiresReferenceImage: true,
    durationSeconds: 5,
    etaMinutes: 2,
  },
  {
    id: "video-hq",
    kind: "video",
    priceMushies: 170,
    requiresReferenceImage: true,
    durationSeconds: 5,
    etaMinutes: 8,
  },
];

export function getGenerationTemplate(id: string): GenerationTemplateInfo | undefined {
  return GENERATION_TEMPLATES.find((t) => t.id === id);
}

/** Public submission allowlist. Historical video jobs remain readable. */
export const ENABLED_GENERATION_TEMPLATES = GENERATION_TEMPLATES.filter((t) => t.kind === "image");
export function getEnabledGenerationTemplate(id: string): GenerationTemplateInfo | undefined {
  return ENABLED_GENERATION_TEMPLATES.find((t) => t.id === id);
}

/** Jobs in "queued"/"running" per user — the real concurrency throttle. */
export const MAX_ACTIVE_GENERATION_JOBS = 2;

export const MAX_GENERATION_PROMPT_LENGTH = 2000;

export const SMART_IMAGE_MODEL = "bytedance-seed/seedream-5-0-lite";
export const SMART_IMAGE_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"] as const;
/** Provider cost estimates for balance checks, never a retail charge.
 * Capabilities checked against OpenRouter's dedicated Image API on 2026-09-07.
 * Keep the default for historical jobs, recipes and drafts without a model.
 */
export const SMART_IMAGE_MODELS = [
  { id: SMART_IMAGE_MODEL, key: "seedreamLite", name: "Seedream 5.0 Lite", estimatedCostUsd: 0.035, resolution: "2K", quality: undefined, supportsSeed: true },
  { id: "bytedance-seed/seedream-5-0-pro", key: "seedreamPro", name: "Seedream 5.0 Pro", estimatedCostUsd: 0.093, resolution: "2K", quality: undefined, supportsSeed: true },
  { id: "google/gemini-3.1-flash-image", key: "nanoBanana2", name: "Nano Banana 2", estimatedCostUsd: 0.14, resolution: "2K", quality: undefined, supportsSeed: false },
  { id: "google/gemini-3-pro-image", key: "nanoBananaPro", name: "Nano Banana Pro", estimatedCostUsd: 0.24, resolution: "2K", quality: undefined, supportsSeed: false },
  { id: "openai/gpt-image-2", key: "gptImage2", name: "GPT Image 2", estimatedCostUsd: 0.45, resolution: undefined, quality: "high", supportsSeed: false },
] as const;
export type SmartImageModelId = typeof SMART_IMAGE_MODELS[number]["id"];
export const SMART_IMAGE_MODEL_IDS = SMART_IMAGE_MODELS.map(model => model.id) as [SmartImageModelId, ...SmartImageModelId[]];
export function getSmartImageModel(id: string = SMART_IMAGE_MODEL) {
  return SMART_IMAGE_MODELS.find(model => model.id === id);
}
export type SmartImageParams = { billing?: "actual-v1"; model?: SmartImageModelId; aspectRatio: typeof SMART_IMAGE_ASPECTS[number]; batchSize: number; seed?: number };

export type GenerationJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

// ── Advanced mode (image template) ──────────────────────────────────

export const IMAGE_SAMPLERS = [
  "euler_ancestral",
  "euler",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_sde",
] as const;
export type ImageSampler = (typeof IMAGE_SAMPLERS)[number];

/** SDXL-native resolutions — arbitrary sizes degrade quality and cost. */
export const IMAGE_ASPECTS = [
  { id: "portrait", width: 832, height: 1216 },
  { id: "landscape", width: 1216, height: 832 },
  { id: "square", width: 1024, height: 1024 },
  { id: "wide", width: 1344, height: 768 },
  { id: "tall", width: 768, height: 1344 },
] as const;

export const ADVANCED_LIMITS = {
  stepsMin: 10,
  stepsMax: 40,
  cfgMin: 1,
  cfgMax: 12,
  maxLoras: 3,
  loraWeightMin: 0,
  loraWeightMax: 1.5,
  maxNegativeLength: 1000,
  /** Images per submit — one worker run, one model load, N samples. */
  batchMin: 1,
  batchMax: 4,
} as const;

/** Video length options, in seconds (the model samples a frame count). */
export const VIDEO_DURATIONS = [3, 5, 8] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

export const VIDEO_ADVANCED_LIMITS = {
  stepsMin: 15,
  stepsMax: 40,
  cfgMin: 1,
  cfgMax: 8,
  maxNegativeLength: 1000,
} as const;

/**
 * Video price scales with duration and steps off each template's baseline
 * (the listed price covers the default 5s recipe).
 */
export function computeVideoPrice(opts: {
  basePrice: number;
  durationSeconds: number;
  steps: number;
  baseSteps: number;
}): number {
  const scale =
    (opts.durationSeconds / 5) * (opts.steps / Math.max(opts.baseSteps, 1));
  return Math.max(Math.ceil(opts.basePrice * Math.max(scale, 0.5)), 5);
}

export const LORA_PRICE_MUSHIES = 2;
/**
 * A custom base model has to be read off the network volume and swapped into
 * VRAM before sampling begins — minutes of billed GPU time the pixels×steps
 * term knows nothing about, and each distinct checkpoint evicts the previous
 * one from the worker's cache. Priced for that load, not for the sampling.
 */
export const CUSTOM_CHECKPOINT_PRICE_MUSHIES = 60;
/** Library files this large can register as checkpoints; smaller = LoRA. */
export const MAX_MODEL_FILE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Dynamic image price: the base 10-mushie price covers the default recipe
 * (832×1216 @ 28 steps); cost scales with pixels × steps, plus flat add-ons
 * for LoRAs (small load overhead) and custom checkpoints (large load
 * overhead). The SERVER is the source of truth — the client only previews.
 */
export function computeImagePrice(opts: {
  width: number;
  height: number;
  steps: number;
  loraCount: number;
  customCheckpoint: boolean;
  batchSize?: number;
}): number {
  const referencePixelSteps = 832 * 1216 * 28;
  const scale = (opts.width * opts.height * opts.steps) / referencePixelSteps;
  const base = Math.min(Math.max(Math.ceil(10 * Math.max(scale, 0.6)), 6), 60);
  // Extra images in a batch reuse the loaded model, so they cost less than a
  // fresh run — the sampling is the only part that repeats.
  const batch = Math.max(1, Math.min(opts.batchSize ?? 1, ADVANCED_LIMITS.batchMax));
  const sampling = base * (1 + (batch - 1) * 0.8);
  return (
    Math.ceil(sampling) +
    opts.loraCount * LORA_PRICE_MUSHIES +
    (opts.customCheckpoint ? CUSTOM_CHECKPOINT_PRICE_MUSHIES : 0)
  );
}

// ── Platform styles (multi-checkpoint image generation) ─────────────
// Each style maps to a checkpoint on the worker volumes. "anime" is the
// baked-in default (no generation_models row, zero surcharge); the rest are
// platform models (generation_models.userId = null) seeded from Civitai and
// distributed by model-sync. Filenames here MUST match the seeded rows.
export interface PlatformStyleInfo {
  slug: string;
  /** Worker-side checkpoint filename (models/checkpoints/<filename>). */
  checkpointFilename: string;
  /** Prompt dialect the enhance layer should emit. */
  dialect: "danbooru" | "prose";
  /** Added to the image price — covers the checkpoint swap's GPU load time. */
  surchargeMushies: number;
  defaultNegative: string;
  recommended: { steps: number; cfg: number; sampler: ImageSampler };
  /** Civitai model id the seed script imports (absent for baked-in styles). */
  civitaiModelId?: number;
}

export const PLATFORM_STYLES: PlatformStyleInfo[] = [
  {
    slug: "anime",
    checkpointFilename: "animagine-xl-4.0.safetensors",
    dialect: "danbooru",
    surchargeMushies: 0,
    defaultNegative: "",
    recommended: { steps: 28, cfg: 5.5, sampler: "euler_ancestral" },
  },
  {
    slug: "nsfw-anime",
    checkpointFilename: "plat_nsfw_anime.safetensors",
    dialect: "danbooru",
    surchargeMushies: 10,
    defaultNegative: "worst quality, bad quality, sketch, jpeg artifacts, signature",
    recommended: { steps: 28, cfg: 6, sampler: "euler_ancestral" },
    civitaiModelId: 827184, // WAI-NSFW-illustrious-SDXL
  },
  {
    slug: "realistic",
    checkpointFilename: "plat_realistic.safetensors",
    dialect: "prose",
    surchargeMushies: 10,
    defaultNegative: "cartoon, anime, illustration, painting, cgi, deformed iris, bad hands",
    recommended: { steps: 30, cfg: 4.5, sampler: "dpmpp_2m" },
    civitaiModelId: 133005, // Juggernaut XL
  },
  {
    slug: "semireal",
    checkpointFilename: "plat_semireal.safetensors",
    dialect: "danbooru",
    surchargeMushies: 10,
    defaultNegative: "worst quality, low quality, watermark",
    recommended: { steps: 28, cfg: 5, sampler: "dpmpp_2m" },
    civitaiModelId: 112902, // DreamShaper XL (seed script skips turbo/lightning versions)
  },
  {
    slug: "guofeng",
    checkpointFilename: "plat_guofeng.safetensors",
    // The seed script's search resolves to a photo-realistic guofeng model
    // (GuoFeng Photo Realistic XL) — prose prompts, not tags.
    dialect: "prose",
    surchargeMushies: 10,
    defaultNegative: "worst quality, low quality, watermark",
    recommended: { steps: 30, cfg: 5, sampler: "dpmpp_2m" },
    civitaiModelId: 844395, // GuoFeng Photo Realistic XL
  },
  {
    slug: "western",
    checkpointFilename: "plat_western.safetensors",
    dialect: "prose",
    surchargeMushies: 10,
    defaultNegative: "photo, photorealistic, worst quality, watermark",
    recommended: { steps: 30, cfg: 5, sampler: "dpmpp_2m" },
    civitaiModelId: 119229, // ZavyChromaXL
  },
];

export function getPlatformStyle(slug: string): PlatformStyleInfo | undefined {
  return PLATFORM_STYLES.find((s) => s.slug === slug);
}

// ── Job failure codes ────────────────────────────────────────────────
//
// Stable machine-readable reasons written to generation_jobs.error_code and
// returned to the client, which localizes them (library ns,
// generation.errors.<CODE>). error_message stays the raw English/provider
// diagnostic for logs and admin — never the primary user-facing string.

export const GENERATION_ERROR_CODES = [
  /** Hard 30-min ceiling hit (cold start + queue + render). */
  "TIMED_OUT",
  /** Row inserted but the provider submit never happened (crash window). */
  "NEVER_STARTED",
  /** Worker finished without producing any output files. */
  "NO_OUTPUT",
  /** Outputs existed but persisting them to storage failed. */
  "STORE_FAILED",
  "PROVIDER_BUSY",
  "PROVIDER_CREDITS",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REQUEST",
  "CONTENT_FILTERED",
  "BILLING_UNAVAILABLE",
  "INSUFFICIENT_CREDITS",
  "PRICING_UPDATED",
  "GENERATION_BUSY",
  "GENERATION_BUDGET",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_FORMAT",
  "REFERENCE_TOO_LARGE",
  "REFERENCE_DIMENSIONS",
  "REFERENCE_UNAVAILABLE",
  /** The output would exceed the user's asset storage allowance. */
  "STORAGE_LIMIT",
  /** Job succeeded but its outputs could no longer be retrieved. */
  "OUTPUT_LOST",
  /** Worker/ComfyUI raised an execution error. */
  "WORKER_ERROR",
  /** Worker ran out of GPU memory. */
  "WORKER_OOM",
  /** A model file the workflow needs is missing on the worker volume. */
  "MODEL_MISSING",
  /** Submit failed on the provider side (no endpoint accepted the job). */
  "SUBMIT_FAILED",
  /** Cancelled by the user. */
  "CANCELLED",
  /** Anything else. */
  "INTERNAL",
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

/** Classify a raw worker/provider error string into a stable code. */
export function classifyWorkerError(raw: string | undefined | null): GenerationErrorCode {
  if (!raw) return "WORKER_ERROR";
  const text = raw.toLowerCase();
  if (/out of memory|cuda oom|allocation on device|oom/.test(text)) return "WORKER_OOM";
  if (
    /(checkpoint|lora|model|safetensors|unet|vae|clip|text encoder)[^.]{0,60}(not found|does not exist|missing|no such file)/.test(text) ||
    /value not in list.*ckpt_name|invalid.*ckpt_name/.test(text)
  )
    return "MODEL_MISSING";
  if (/timed? ?out/.test(text)) return "TIMED_OUT";
  return "WORKER_ERROR";
}

// ── img2img ──────────────────────────────────────────────────────────

/** Denoise strength: low = keep the reference, high = loose reinterpretation. */
export const DENOISE_MIN = 0.3;
export const DENOISE_MAX = 0.95;
export const DENOISE_DEFAULT = 0.7;

/** Snap a source image's aspect to the closest SDXL-native resolution. */
export function closestAspect(width: number, height: number) {
  const ratio = width / Math.max(height, 1);
  return IMAGE_ASPECTS.reduce((best, a) =>
    Math.abs(a.width / a.height - ratio) < Math.abs(best.width / best.height - ratio) ? a : best,
  );
}

/** Saved prompt recipes per user. */
export const MAX_GENERATION_PRESETS = 50;
