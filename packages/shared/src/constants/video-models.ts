/**
 * The video lane of the AI generation page: one template ("video"), several
 * models, each declaring what it can take. The page draws its controls off
 * these specs (a control the model cannot use is shown disabled with the
 * model's name, never silently dropped), and the server validates a request
 * against the same spec before it charges anything.
 *
 * Prices are in mushies ($1 ≈ 1000). A spec carries the partner's own price
 * (OpenRouter and Comfy Router bill video per second or per clip, so the charge
 * is known before the job runs and is taken up front like every Comfy job); the
 * creator pays that times VIDEO_PARTNER_MARKUP.
 */

import { getPlatformStyle } from "./generation.js";
import { ROUTER_VIDEO_MODELS } from "./video-router-models/index.js";

export const VIDEO_TEMPLATE_ID = "video";

/** What a creator pays for a partner model (OpenRouter, Comfy Router) over its
 *  cost, which is what the specs' per-second and per-clip prices record. */
export const VIDEO_PARTNER_MARKUP = 1.2;

export const VIDEO_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];

export type VideoProvider = "openrouter" | "comfy" | "comfy-router";

/** Model families, the cards on the page: versions of one family are chips under it. */
export type VideoFamily =
  | "seedance" | "kling" | "veo" | "wan" | "hailuo" | "grok" | "luma" | "ltx"
  | "moonvalley" | "runway" | "flux" | "pruna" | "happyhorse" | "omni";

/** Brand names are not translated: a creator looks for "Kling", not a gloss of it.
 *  Ordered as the page lists them; the first four show before "more models". */
export const VIDEO_FAMILY_INFO: Record<VideoFamily, { name: string; maker: string }> = {
  seedance: { name: "Seedance", maker: "ByteDance" },
  kling: { name: "Kling", maker: "Kuaishou" },
  veo: { name: "Veo", maker: "Google" },
  omni: { name: "Gemini Omni", maker: "Google" },
  wan: { name: "Wan", maker: "Alibaba" },
  hailuo: { name: "Hailuo", maker: "MiniMax" },
  grok: { name: "Grok Imagine", maker: "xAI" },
  happyhorse: { name: "HappyHorse", maker: "Alibaba" },
  luma: { name: "Ray", maker: "Luma AI" },
  ltx: { name: "LTX", maker: "Lightricks" },
  runway: { name: "Runway", maker: "Runway" },
  moonvalley: { name: "Marey", maker: "Moonvalley" },
  flux: { name: "FLUX Video", maker: "Black Forest Labs" },
  pruna: { name: "P-Video", maker: "Pruna AI" },
};
export const VIDEO_FAMILIES = Object.keys(VIDEO_FAMILY_INFO) as VideoFamily[];
export const VIDEO_FEATURED_FAMILIES: readonly VideoFamily[] = ["seedance", "kling", "veo", "wan"];

export interface VideoModelSpec {
  id: string;
  name: string;
  provider: VideoProvider;
  family: VideoFamily;
  /** OpenRouter model slug (provider "openrouter"). */
  openrouterModel?: string;
  /** Comfy Router model id, `{partner}/{model}` (provider "comfy-router"). */
  routerModel?: string;
  /** Shapes it can draw (default: all of VIDEO_ASPECTS). */
  aspects?: readonly VideoAspect[];
  /** Short side of the output, as the provider names it. */
  resolutions: readonly string[];
  defaultResolution: string;
  /** Either any whole second in a range, or a fixed menu. */
  durations: { min: number; max: number } | readonly number[];
  defaultDuration: number;
  /** Frame images it accepts. `both` = first and last together in one request;
   *  `lastNeedsFirst` = a last frame is refused unless a first frame comes too. */
  frames: { first: boolean; last: boolean; both: boolean; lastNeedsFirst?: boolean };
  /** Character / style reference images (0 = not supported). */
  maxReferences: number;
  /** References are their own mode: they cannot be sent with a first/last frame. */
  referencesWithoutFrames?: boolean;
  /** With referencesWithoutFrames: a first frame may still bring up to this many
   *  references along (never a last frame). */
  referencesWithFirstFrame?: number;
  /** A frame sets the shape: the clip follows the first frame's aspect ratio. */
  aspectFromFrame?: boolean;
  /** The partner's own "camera fixed" switch (BytePlus Seedance 1.x `camera_fixed`): 固定 is sent as it, not as
   *  words. The other camera moves have no native field on any model here and go as words (videoCameraPrompt). */
  cameraFixed?: boolean;
  /** Can generate a soundtrack with the picture. */
  sound: boolean;
  /** The soundtrack cannot be turned off (sound is always on). */
  soundAlways?: boolean;
  /** Provider-side "AI generated" watermark switch. */
  watermark: boolean;
  /** Text only, no picture at all. */
  textToVideo: boolean;
  /** Steps / CFG / seed / negative prompt are exposed. */
  tuning: boolean;
  /** Library LoRAs can be stacked. */
  loras: boolean;
  /** Text-to-video can open on a frame drawn in one of the platform image
   *  styles (the clip then keeps that style). */
  styles: boolean;
  /** Runs on our own workers, so the provider's content filter does not apply. */
  selfHosted: boolean;
  /** Typical wait for the default recipe, seconds. */
  etaSeconds: number;
  /** OpenRouter / Router: mushies per output second, by resolution. */
  perSecond?: Record<string, number>;
  /** Router: per second when the soundtrack is on, if it costs more. */
  perSecondSound?: Record<string, number>;
  /** Router: a flat price per clip, by resolution then seconds (overrides perSecond). */
  perClip?: Record<string, Record<number, number>>;
  /** Router: perClip when the soundtrack is on, if it costs more. */
  perClipSound?: Record<string, Record<number, number>>;
  /** Router: added when any frame (first/last) is given, if image-to-video costs more. */
  perFrameRequest?: number;
  /** OpenRouter / Router: mushies per reference image. */
  perReference?: number;
  /** Router: follows a reference video for camera, layout and motion (a grey 3D
   *  blockout, a screen recording). It is cropped to the clip's shape and size,
   *  so it costs what the clip costs; `perSecond` is per output second and
   *  covers the reference too. Never with a first or last frame. */
  referenceVideo?: { resolutions: readonly string[]; perSecond: Record<string, number> };
  /** Comfy: price of the default recipe (5 s, base steps, base pixels). */
  basePrice?: number;
  baseSteps?: number;
  basePixels?: number;
  defaultSteps?: number;
  defaultCfg?: number;
  /** Comfy: a distilled few-step mode (Wan's Lightning LoRA). On by default;
   *  turning it off unlocks steps/CFG at the full price. */
  fast?: { steps: number; cfg: number; basePrice: number; etaSeconds: number };
}

export const VIDEO_MODELS: readonly VideoModelSpec[] = [
  // Listed cheapest-good first: the page opens on the first model the server offers.
  {
    id: "wan-2.2", name: "Wan 2.2", provider: "comfy", family: "wan",
    resolutions: ["480p", "720p"], defaultResolution: "480p",
    durations: [3, 5, 8], defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 0,
    sound: false, watermark: false, textToVideo: true, tuning: true, loras: true, styles: true, selfHosted: true,
    // Priced ~1 mushie per GPU second (Comfy Cloud 2026-10-01: 20 steps ≈ 170 s on
    // the GPU). Waits measured on our warm deployment 2026-10-02 (5 s, 848×480):
    // Lightning 4 steps ≈ 30 s with Wan loaded, ≈ 110 s when it has to load first;
    // 720p Lightning ≈ 89 s; 20 steps ≈ 185 s.
    etaSeconds: 190, basePrice: 170, baseSteps: 20, basePixels: 848 * 480, defaultSteps: 20, defaultCfg: 3.5,
    fast: { steps: 4, cfg: 1, basePrice: 60, etaSeconds: 40 },
  },
  {
    id: "h3-max", name: "H3 Max", provider: "openrouter", family: "hailuo", openrouterModel: "minimax/hailuo-3-max",
    resolutions: ["480p", "768p"], defaultResolution: "768p",
    durations: { min: 5, max: 15 }, defaultDuration: 5,
    frames: { first: true, last: true, both: false }, maxReferences: 0,
    sound: false, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 20, perSecond: { "480p": 50, "768p": 80 },
  },
  {
    id: "h3", name: "H3", provider: "openrouter", family: "hailuo", openrouterModel: "minimax/hailuo-3",
    resolutions: ["2K"], defaultResolution: "2K",
    durations: { min: 5, max: 15 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 9,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 260, perSecond: { "2K": 130 }, perReference: 40,
  },
  // Google's video model with native speech: Artificial Analysis ranks Omni first for dialogue and lip
  // sync (2026-11-10). Sound is always on (OpenRouter only prices it with audio). 1.1 is listed, not
  // 1.2: on 2026-11-10 1.2 failed 8 of 9 requests on OpenRouter ("Video generation failed", text-only
  // and first-frame alike) while 1.1 drew both kinds first try, ~30 s for 3 s at 720p ($0.304).
  // Swap in "google/gemini-omni-1.2-flash" (720p $0.0695/s, 1080p $0.104, 4K $0.209, 3-15 s) once it holds.
  {
    id: "gemini-omni-1.1-flash", name: "Gemini Omni 1.1 Flash", provider: "openrouter", family: "omni",
    openrouterModel: "google/gemini-omni-1.1-flash",
    aspects: ["16:9", "9:16"], aspectFromFrame: true,
    resolutions: ["720p", "1080p", "4K"], defaultResolution: "720p",
    durations: { min: 3, max: 10 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 0,
    sound: true, soundAlways: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 35, perSecond: { "720p": 101, "1080p": 152, "4K": 304 },
  },
  // Seedance 2.5's cheaper tier (2026-11-15). Comfy Router has no Flash (its byteplus/* list stops at 2.5,
  // checked 2026-11-16), so it runs on OpenRouter. Billed like 2.5 by tokens (width × height × 24 fps ×
  // seconds / 1024) at $7 per 1M, sound or not: $0.0672 / $0.1512 a second at 480p / 720p for 16:9.
  // Rounded up for the extra frame (a 4 s clip is 97 frames) and 21:9, the widest tier (+4.5% pixels at
  // 480p, +0.5% at 720p). Measured 2026-11-16: 4 s 480p first frame 3:4 with sound $0.2787, reference 16:9
  // $0.2718, ~60 s each. A reference picture costs nothing extra; references are their own mode as on 2.5.
  // Following a reference video, editing and extending are on the model but not wired here.
  {
    id: "seedance-2.5-flash", name: "Seedance 2.5 Flash", provider: "openrouter", family: "seedance",
    openrouterModel: "bytedance/seedance-2.5-flash",
    resolutions: ["480p", "720p"], defaultResolution: "720p",
    durations: { min: 4, max: 30 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 9, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 75, perSecond: { "480p": 72, "720p": 154 },
  },
  // Comfy Router's partner models, one file per family (video-router-models/).
  ...ROUTER_VIDEO_MODELS,
];

export const VIDEO_MODEL_IDS = VIDEO_MODELS.map((m) => m.id);

export function getVideoModel(id: string): VideoModelSpec | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

export const VIDEO_TUNING_LIMITS = {
  stepsMin: 4,
  stepsMax: 40,
  cfgMin: 1,
  cfgMax: 8,
  maxNegativeLength: 1000,
  maxLoras: 4,
  loraWeightMin: 0,
  loraWeightMax: 1.5,
} as const;

/** `blockout`: grey boxes and mannequins, everything to be drawn from the
 *  prompt. `scene`: a rendered AI scene with mannequins in it, the place to be
 *  kept as it is and only the people drawn. */
export type ReferenceVideoLook = "blockout" | "scene";

/** What the page sends for a video job (besides the prompt). */
export interface VideoRequest {
  model: string;
  aspectRatio: VideoAspect;
  resolution: string;
  durationSeconds: number;
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  referenceAssetIds?: string[];
  /** A video the clip follows (spec.referenceVideo). */
  referenceVideoAssetId?: string;
  /** What the reference video looks like, so the model is told how far to
   *  trust it: grey shapes to be replaced, or a rendered place to be kept. */
  referenceVideoLook?: ReferenceVideoLook;
  sound?: boolean;
  watermark?: boolean;
  /** Comfy models with a `fast` mode: false = full sampling. Default true. */
  fast?: boolean;
  steps?: number;
  cfg?: number;
  seed?: number;
  negativePrompt?: string;
  loras?: { modelId: string; weight: number }[];
  /** Platform image style slug: text-to-video draws its first frame in it. */
  style?: string;
  /** A camera move (the video studio's chips): the model's own switch where it has one, else words. */
  camera?: VideoCameraMove;
  /** 延长: the clip this one continues (its last frame is this one's first). Recorded only: 接成一条 reads it. */
  extendOf?: string;
  /** 接成一条: the clips this one joins, in order (a joined result's record; never sent to a model). */
  joinOf?: string[];
}

/** The camera moves a clip can be asked for, the video studio's chips in order. */
export const VIDEO_CAMERA_MOVES = ["push", "pull", "orbit", "follow", "pan", "static"] as const;
export type VideoCameraMove = (typeof VIDEO_CAMERA_MOVES)[number];

/** What a move adds to the prompt on a model without a switch for it (every model here, for all but 固定): the
 *  shot's name and what the camera does, sent before the words (a 2026-11-08 run with the move after the words
 *  came back a push-in, not an orbit). */
export const VIDEO_CAMERA_PROMPTS: Record<VideoCameraMove, string> = {
  push: "Camera movement: slow dolly-in. The camera moves steadily toward the subject, ending in a close-up.",
  pull: "Camera movement: slow dolly-out. The camera moves steadily away from the subject, revealing the wider scene.",
  orbit: "Camera movement: orbit shot. The camera circles around the subject in a smooth wide arc, the background sweeping past behind it, the subject kept in the center.",
  follow: "Camera movement: tracking shot. The camera travels alongside the subject at its pace, keeping it in frame as it moves.",
  pan: "Camera movement: slow pan. The camera stays in place and turns horizontally across the scene from left to right.",
  static: "Camera movement: none. A locked-off static shot on a tripod; the camera does not move or zoom.",
};

/** Whether the model takes this move as its own switch (sent as a field, not as words). References are their
 *  own mode on Seedance and take no camera switch. */
export function videoCameraNative(spec: Pick<VideoModelSpec, "cameraFixed">, camera: VideoCameraMove | undefined, hasReferences = false): boolean {
  return camera === "static" && !!spec.cameraFixed && !hasReferences;
}

/** The prompt a model is sent for a camera move: as typed when the model switches it natively, else with the
 *  move's line before it. */
export function videoCameraPrompt(spec: Pick<VideoModelSpec, "cameraFixed">, prompt: string, camera: VideoCameraMove | undefined, hasReferences = false): string {
  if (!camera || videoCameraNative(spec, camera, hasReferences)) return prompt;
  return [VIDEO_CAMERA_PROMPTS[camera], prompt.trim()].join("\n\n");
}

/** A reference video shorter than this has no camera move to follow. */
export const REFERENCE_VIDEO_MIN_SECONDS = 2;
/** The largest reference video the server will read. */
export const REFERENCE_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

/** Drawing the style frame: one image at the image lane's base price. */
export const VIDEO_STYLE_FRAME_MUSHIES = 10;
/** The style frame's extra wait, seconds (one SDXL image plus its checkpoint). */
export const VIDEO_STYLE_FRAME_SECONDS = 10;

export function videoAspects(spec: VideoModelSpec): readonly VideoAspect[] {
  return spec.aspects ?? VIDEO_ASPECTS;
}

export function videoDurationOptions(spec: VideoModelSpec): number[] {
  if (Array.isArray(spec.durations)) return [...(spec.durations as readonly number[])];
  const { min, max } = spec.durations as { min: number; max: number };
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/** Output size in pixels for an aspect at a named short side ("480p", "2K"). */
export function videoDimensions(aspect: VideoAspect, resolution: string): { width: number; height: number } {
  const short = resolution === "2K" ? 1440 : parseInt(resolution, 10);
  const [a, b] = aspect.split(":").map(Number) as [number, number];
  // Comfy latents want multiples of 16 on both sides.
  const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);
  const long = (short * Math.max(a, b)) / Math.min(a, b);
  return a >= b ? { width: round16(long), height: round16(short) } : { width: round16(short), height: round16(long) };
}

/**
 * Why this request cannot run on this model, as an error code — or null.
 * The page disables the same things, so a code here means a stale or forged
 * request rather than something a person could click into.
 */
export function videoRequestProblem(spec: VideoModelSpec, req: VideoRequest): string | null {
  if (!videoAspects(spec).includes(req.aspectRatio)) return "VIDEO_BAD_ASPECT";
  if (!spec.resolutions.includes(req.resolution)) return "VIDEO_BAD_RESOLUTION";
  if (!videoDurationOptions(spec).includes(req.durationSeconds)) return "VIDEO_BAD_DURATION";
  if (req.firstFrameAssetId && !spec.frames.first) return "VIDEO_NO_FIRST_FRAME";
  if (req.lastFrameAssetId && !spec.frames.last) return "VIDEO_NO_LAST_FRAME";
  if (req.firstFrameAssetId && req.lastFrameAssetId && !spec.frames.both) return "VIDEO_ONE_FRAME_ONLY";
  if (req.lastFrameAssetId && !req.firstFrameAssetId && spec.frames.lastNeedsFirst) return "VIDEO_LAST_NEEDS_FIRST";
  if ((req.referenceAssetIds?.length ?? 0) > spec.maxReferences) return "VIDEO_TOO_MANY_REFERENCES";
  const refs = req.referenceAssetIds?.length ?? 0;
  if (spec.referencesWithoutFrames && refs && (req.lastFrameAssetId
    || (req.firstFrameAssetId && refs > (spec.referencesWithFirstFrame ?? 0)))) return "VIDEO_FRAMES_OR_REFERENCES";
  if (req.referenceVideoAssetId) {
    if (!spec.referenceVideo) return "VIDEO_NO_REFERENCE_VIDEO";
    if (req.firstFrameAssetId || req.lastFrameAssetId) return "VIDEO_FRAMES_OR_REFERENCES";
    if (!spec.referenceVideo.resolutions.includes(req.resolution)) return "VIDEO_REFERENCE_VIDEO_RESOLUTION";
  }
  if (!spec.textToVideo && !req.firstFrameAssetId && !req.lastFrameAssetId) return "VIDEO_NEEDS_FRAME";
  if (req.sound && !spec.sound) return "VIDEO_NO_SOUND";
  if (!spec.tuning && (req.steps != null || req.cfg != null || req.seed != null || req.negativePrompt)) return "VIDEO_NO_TUNING";
  if (req.fast === false && !spec.fast) return "VIDEO_NO_TUNING";
  if (spec.fast && req.fast !== false && (req.steps != null || req.cfg != null)) return "VIDEO_FAST_FIXED";
  if ((req.loras?.length ?? 0) > (spec.loras ? VIDEO_TUNING_LIMITS.maxLoras : 0)) return "VIDEO_NO_LORAS";
  if (req.style != null) {
    if (!spec.styles) return "VIDEO_NO_STYLE";
    if (!getPlatformStyle(req.style)) return "VIDEO_BAD_STYLE";
    // A frame the creator gave already sets the look.
    if (req.firstFrameAssetId || req.lastFrameAssetId) return "VIDEO_STYLE_WITH_FRAME";
  }
  return null;
}

export const VIDEO_LORA_PRICE_MUSHIES = 2;

/** The charge for a request, in mushies. Mirrors the page's preview exactly. */
/** Whether a Comfy request runs the few-step mode. */
export function videoUsesFast(spec: VideoModelSpec, req: Pick<VideoRequest, "fast">): boolean {
  return !!spec.fast && req.fast !== false;
}

/** What drawing the style frame adds to a request's charge. */
function styleFramePrice(spec: VideoModelSpec, req: Pick<VideoRequest, "style">): number {
  const style = spec.styles && req.style ? getPlatformStyle(req.style) : undefined;
  return style ? VIDEO_STYLE_FRAME_MUSHIES + style.surchargeMushies : 0;
}

export function computeVideoModelPrice(spec: VideoModelSpec, req: Pick<VideoRequest, "aspectRatio" | "resolution" | "durationSeconds" | "referenceAssetIds" | "steps" | "loras" | "fast" | "style" | "sound" | "firstFrameAssetId" | "lastFrameAssetId" | "referenceVideoAssetId">): number {
  if (spec.provider !== "comfy") {
    const sound = spec.sound && (spec.soundAlways || req.sound !== false);
    const followsVideo = !!(req.referenceVideoAssetId && spec.referenceVideo);
    const clips = followsVideo ? undefined : (sound ? spec.perClipSound : undefined) ?? spec.perClip;
    const perSecond = followsVideo ? spec.referenceVideo!.perSecond : (sound ? spec.perSecondSound : undefined) ?? spec.perSecond;
    const base = clips ? clips[req.resolution]?.[req.durationSeconds] ?? 0 : (perSecond?.[req.resolution] ?? 0) * req.durationSeconds;
    const framed = req.firstFrameAssetId || req.lastFrameAssetId ? spec.perFrameRequest ?? 0 : 0;
    return Math.ceil((base + framed + (spec.perReference ?? 0) * (req.referenceAssetIds?.length ?? 0)) * VIDEO_PARTNER_MARKUP);
  }
  const { width, height } = videoDimensions(req.aspectRatio, req.resolution);
  const area = (req.durationSeconds / 5) * ((width * height) / (spec.basePixels ?? width * height));
  const fast = videoUsesFast(spec, req);
  const steps = req.steps ?? spec.defaultSteps ?? spec.baseSteps ?? 1;
  const scale = fast ? area : area * (steps / (spec.baseSteps ?? steps));
  const basePrice = fast ? spec.fast!.basePrice : spec.basePrice ?? 0;
  const base = Math.max(Math.ceil(basePrice * Math.max(scale, 0.25)), 5);
  return base + VIDEO_LORA_PRICE_MUSHIES * (req.loras?.length ?? 0) + styleFramePrice(spec, req);
}

/** Expected wait for a request, seconds (Comfy scales with the work). */
export function estimateVideoSeconds(spec: VideoModelSpec, req: Pick<VideoRequest, "aspectRatio" | "resolution" | "durationSeconds" | "steps" | "fast" | "style">): number {
  if (spec.provider !== "comfy") return Math.round(spec.etaSeconds * (req.durationSeconds / 5));
  const { width, height } = videoDimensions(req.aspectRatio, req.resolution);
  const area = (req.durationSeconds / 5) * ((width * height) / (spec.basePixels ?? width * height));
  const frame = spec.styles && req.style ? VIDEO_STYLE_FRAME_SECONDS : 0;
  if (videoUsesFast(spec, req)) return Math.max(30, Math.round(spec.fast!.etaSeconds * area)) + frame;
  const steps = req.steps ?? spec.defaultSteps ?? 1;
  return Math.max(30, Math.round(spec.etaSeconds * area * (steps / (spec.baseSteps ?? steps)))) + frame;
}
