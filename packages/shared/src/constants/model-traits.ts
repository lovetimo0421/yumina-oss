/**
 * What each partner model leans to and is good at, as tags on the generation
 * page's model cards. Measured, not claimed: every model drew the same prompts
 * (a neutral scene with no style words, an anime one, a photoreal one, and for
 * images a poster with text) and the outputs were compared side by side; the
 * makers' own claims were only a cross-check. Keyed by image model id or video
 * spec id. A model with no entry simply shows no trait tags.
 */

export type ModelStyle = "realistic" | "anime" | "2.5d" | "3d" | "versatile";
export type ModelStrength = "anime" | "photoreal" | "text" | "design" | "detail" | "fast" | "motion" | "camera" | "dialogue";

export interface ModelTraits {
  /** How it does anime, the style our creators ask for most; none when it does
   *  anime and realism both well enough that neither needs saying. */
  style?: ModelStyle;
  /** At most two, best first: only where it clearly beat its peers. */
  strengths: readonly ModelStrength[];
}

// Style: every model drew the neutral prompt as a photo, so that says nothing.
// It is read from the anime prompt instead: "versatile" = anime scored 5 of 5
// and realistic at least 4 (shown as strong anime); "3d" = asked for anime it
// drew 3D CG; "anime" = anime clearly better than its realism; "realistic" =
// anime scored 3 or less, so it is mostly for realism. A model whose anime
// scored 4 carries no style tag: it does both. Strengths say what it beat its
// peers at. Video "fast" is not a trait: the page measures waits itself.
// Runs of 2026-10-09: images one per prompt at each model's smallest size, video
// at the cheapest size and shortest length of 3 s or more.
const T = (style: ModelStyle | null, ...strengths: ModelStrength[]): ModelTraits => ({ ...(style ? { style } : {}), strengths });

export const MODEL_TRAITS: Readonly<Record<string, ModelTraits>> = {
  // ── Image ──
  "bytedance-seed/seedream-5-0-flash": T(null, "photoreal"),
  "bytedance-seed/seedream-5-0-lite": T("versatile"),
  "bytedance-seed/seedream-5-0-pro": T("versatile", "detail"),
  "bytedance-seed/seedream-5-5": T("versatile", "detail"),
  "minimax/minimax-h3-image": T(null, "fast"),
  "google/gemini-nano-banana-2.1": T("realistic", "photoreal", "text"),
  "google/gemini-3.1-flash-image": T("realistic", "text", "fast"),
  "google/gemini-3-pro-image": T("realistic", "photoreal", "text"),
  "openai/gpt-image-2.5-flare": T("versatile", "text"),
  "openai/gpt-image-2.5-sunburst": T("versatile", "detail"),
  "openai/gpt-image-2": T("versatile", "text"),
  "xai/grok-imagine-image": T("realistic", "fast"),
  "kling/kling-image-o1": T(null, "design"),
  "luma_2/uni-1": T("realistic", "design"),
  "luma_2/uni-1-max": T(null, "design", "photoreal"),
  "ideogram/ideogram-4-6": T("realistic", "fast"),
  "wan/wan2.5-t2i-preview": T("anime"),
  "black-forest-labs/flux.2-pro": T(null, "fast"),
  "black-forest-labs/flux.2-max": T(null),
  "black-forest-labs/flux-3-image": T("versatile"),
  "qwen/qwen-image-3": T("versatile", "text", "design"),
  "qwen/qwen-image-3-pro": T("versatile", "text"),
  "x-ai/grok-imagine-image-2.0": T("versatile"),
  "recraft/recraft-v4.1": T(null, "design", "fast"),
  "krea/krea-2-medium-turbo": T(null),
  "krea/krea-2-medium": T(null),
  "krea/krea-2-large": T(null, "photoreal"),
  "microsoft/mai-image-2.6": T("versatile", "text"),
  "tencent/hy-image-v3.5-preview": T("realistic"),
  // ── Video ──
  "seedance-2.5": T(null, "camera"),
  "seedance-2.0": T("versatile", "camera"),
  "seedance-2.0-fast": T("versatile", "camera"),
  "seedance-2.0-mini": T(null),
  "seedance-1.0-pro": T("realistic"),
  "seedance-1.0-pro-fast": T("realistic"),
  "kling-3-omni": T(null, "motion"),
  "kling-3": T("3d", "motion"),
  "kling-3-turbo": T(null, "motion"),
  "kling-o1": T("realistic"),
  "kling-2.6": T(null),
  "kling-2.5-turbo": T(null, "motion"),
  "veo-3.1-lite": T("realistic"),
  "veo-3.1-fast": T(null, "camera"),
  "veo-3.1": T("3d"),
  "grok-imagine-1.5-lite": T(null),
  "grok-imagine-1.5": T("versatile", "motion"),
  "wan-3.0": T("versatile", "motion"),
  "wan-3.0-prime": T("versatile"),
  "wan-2.7": T("versatile", "motion"),
  "wan-2.6": T(null),
  "wan-2.5": T("realistic"),
  "happyhorse-1.1": T(null),
  "happyhorse-1.0": T("realistic"),
  "ltx-2.5-fast": T("3d"),
  "ltx-2.5-pro": T("3d"),
  "marey": T("realistic"),
  "flux-3-video": T(null),
  "p-video-2": T("3d"),
  "h3-max-turbo": T("versatile"),
  "h3": T("versatile"),
  "h3-max": T("versatile"),
  // Its look comes from the first frame it is given; it beat every peer at speech and lip sync.
  "gemini-omni-1.1-flash": T(null, "dialogue"),
  // runway-gen4-turbo animates the creator's picture: its look is the picture's.
};

/**
 * 无限制: the models that draw what the partners' own filters turn down. Measured on prod, 60 days to 2026-11-17:
 * HunyuanImage 3.5 refused 0 of 1,777 (it is also the model a refused picture is retried on) and Wan 2.2 on our own
 * GPUs 0 of 731; every other model refused 7% to 90%. Our own image lane (画风模型: styles and LoRAs) is the same
 * and says so on its tab. A model belongs here only while that holds.
 */
export const UNRESTRICTED_MODELS: ReadonlySet<string> = new Set(["tencent/hy-image-v3.5-preview", "wan-2.2"]);

export function isUnrestrictedModel(id: string): boolean {
  return UNRESTRICTED_MODELS.has(id);
}

export function getModelTraits(id: string): ModelTraits | undefined {
  return MODEL_TRAITS[id];
}
