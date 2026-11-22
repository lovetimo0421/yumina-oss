/**
 * The workbench's tools: one model behind each (fal's queue API), one job each (generation_jobs kind "tool",
 * templateId = the tool's id), billed like every other generation: the provider's price × MEDIA_TOOL_MARKUP,
 * reserved up front from the inputs, refunded on failure.
 *
 * The app draws each tool's form from `inputs`; the server validates a request against the same list, so
 * adding a tool is one entry here plus (rarely) a line in the server's input mapping
 * (packages/server/src/lib/generation/media-tools.ts).
 */
export type MediaToolGroup = "image" | "video" | "audio" | "3d";
export type MediaToolOutput = "image" | "video" | "audio" | "model3d";

/** What the server checks on a picked file before anything is charged. Seconds and sides are measured from the
 *  file itself (ffprobe / sharp), never taken from its name or the library row. */
export interface MediaToolMediaLimits {
  minSeconds?: number;
  maxSeconds?: number;
  maxBytes?: number;
  /** the shorter side, px */
  minSide?: number;
  /** the longer side, px */
  maxSide?: number;
  /** A video outside minSide/maxSide is scaled into them, kept in proportion, instead of refused (our own 720p
   *  clips are 704 px on the short side; Kling lipsync wants 720). Only where the proportion allows both. */
  fitSides?: boolean;
  /** An audio file shorter than minSeconds is padded with silence up to it instead of refused (a short line). */
  padToMin?: boolean;
}

export type MediaToolInput =
  /** an @asset of that kind from the creator's library (or a job result) */
  | { key: string; kind: "image" | "video" | "audio"; required?: boolean; limits?: MediaToolMediaLimits }
  /** a painted mask over the `of` image: white = change it. An uploaded PNG asset; the server scales it to the image. */
  | { key: string; kind: "mask"; of: string; required?: boolean }
  | { key: string; kind: "text"; maxChars: number; required?: boolean; multiline?: boolean }
  /** song lyrics with [verse]/[chorus] tags */
  | { key: string; kind: "lyrics"; maxChars: number; required?: boolean }
  | { key: string; kind: "number"; min: number; max: number; step: number; default: number }
  | { key: string; kind: "select"; options: readonly string[]; default: string }
  | { key: string; kind: "boolean"; default: boolean }
  /** a voice from MEDIA_TOOL_VOICES (by id) */
  | { key: string; kind: "voice"; default: string };

/** How the provider prices one run. `per` is what `usd` buys; `roundUp` rounds the measured amount up to a
 *  multiple first (fal bills ElevenLabs music by whole minutes, Kling lipsync by 5 s blocks, FLUX Fill by whole
 *  megapixels). */
export interface MediaToolPrice {
  per: "call" | "second" | "minute" | "megapixel" | "kchar";
  usd: number;
  roundUp?: number;
  /** the least one run costs */
  minUsd?: number;
  /** an option that multiplies the price (an upscale factor, a quality tier) */
  times?: readonly { key: string; equals: string | number | boolean; factor: number }[];
  /** a select input whose choice sets the price outright: one tool, several models behind it, each at its own
   *  price (`usd` above is then the default choice's). */
  byOption?: { key: string; usd: Readonly<Record<string, number>> };
}

/** Where the priced amount comes from:
 *  - none: one call is one unit
 *  - number: a number input (seconds asked for)
 *  - chars: the length of a text input
 *  - seconds: the measured length of a video/audio input, capped at `max` when the tool only uses that much
 *  - megapixels: an image input's width × height / 1e6, × scale² when `scaleKey` names an upscale factor
 *  - videoMegapixels: a video's width × height × frames / 1e6, × scale² (what SeedVR bills: the output's pixels) */
export type MediaToolAmount =
  | { from: "none" }
  | { from: "number"; key: string }
  | { from: "chars"; key: string }
  | { from: "seconds"; key: string; max?: number }
  | { from: "megapixels"; key: string; scaleKey?: string }
  | { from: "videoMegapixels"; key: string; scaleKey?: string };

export interface MediaTool {
  id: string;
  group: MediaToolGroup;
  /** fal endpoint id, e.g. "fal-ai/birefnet/v2" */
  endpoint: string;
  /** A tool that offers several models: the select input that picks one, and each choice's endpoint
   *  (`endpoint` above is the default choice's). The creator picks, as with picture and video models. */
  endpoints?: { key: string; by: Readonly<Record<string, string>> };
  output: MediaToolOutput;
  inputs: readonly MediaToolInput[];
  price: MediaToolPrice;
  amount: MediaToolAmount;
  /** rough wall time, for the "about N s" hint */
  seconds: number;
  /** true: the output is a new version of the input (the canvas swaps that block's asset); false: a new thing (added). */
  replacesInput: boolean;
}

/** Languages the dubbing tool translates into (VEED's codes). */
export const DUBBING_LANGUAGES = ["en", "zh", "ja", "ko", "es", "fr", "de", "pt", "ru", "it", "ar", "id", "th", "vi", "hi", "tr"] as const;

/** The 3D models a creator may pick for "picture to 3D model", in the order shown. */
export const MODEL_3D_CHOICES = ["hunyuan", "rodin", "tripo", "trellis", "meshy"] as const;
export type Model3dChoice = (typeof MODEL_3D_CHOICES)[number];
export const MODEL_3D_ENDPOINTS: Readonly<Record<Model3dChoice, string>> = {
  hunyuan: "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d",
  rodin: "fal-ai/hyper3d/rodin/v2.5",
  tripo: "tripo3d/h3.1/image-to-3d",
  trellis: "fal-ai/trellis-2",
  meshy: "meshy/v7.1/image-to-3d",
};
export const MODEL_3D_USD: Readonly<Record<Model3dChoice, number>> = { hunyuan: 0.525, rodin: 0.4, tripo: 0.3, trellis: 0.3, meshy: 1.2 };
/** How much of the generated model is kept: "high" for something looked at up close, "standard" for one of many in a scene. */
export const MODEL_3D_DETAILS = ["high", "standard"] as const;
export type Model3dDetail = (typeof MODEL_3D_DETAILS)[number];
export const MODEL_3D_BUDGET: Readonly<Record<Model3dDetail, { triangles: number; textureSide: number }>> = {
  high: { triangles: 200_000, textureSide: 2048 },
  standard: { triangles: 50_000, textureSide: 1024 },
};

export const MEDIA_TOOL_MARKUP = 1.2;
/** 1 mushie = $0.001 (the same rate every generation is billed at). */
export const MEDIA_TOOL_USD_PER_MUSHIE = 0.001;

/** Tool jobs a creator may have running at once. Separate from MAX_ACTIVE_GENERATION_JOBS (pictures, videos,
 *  live characters): a quick picture fix never waits behind a long video. At most MAX_ACTIVE_LONG_TOOL_JOBS of
 *  them may be long tools (`seconds` ≥ LONG_TOOL_SECONDS), so two slots always stay free for the quick ones. */
export const MAX_ACTIVE_TOOL_JOBS = 4;
export const MAX_ACTIVE_LONG_TOOL_JOBS = 2;
export const LONG_TOOL_SECONDS = 60;

/** ElevenLabs premade voices both voice tools take (ElevenLabs' public /v1/voices list, 2026-11-06; the legacy
 *  Rachel/Aria fal still names as its default are no longer premade voices). fal is sent `elevenLabsId`; `previewUrl`
 *  is ElevenLabs' own public sample. `label` is the short English line the picker shows. */
export const MEDIA_TOOL_VOICES = [
  { id: "Sarah", elevenLabsId: "EXAVITQu4vr4xnSDxMaL", label: "Sarah: mature, reassuring", gender: "female", accent: "American",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3" },
  { id: "Laura", elevenLabsId: "FGY2WhTYpPnrIDTdsKH5", label: "Laura: quirky, upbeat", gender: "female", accent: "American",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/FGY2WhTYpPnrIDTdsKH5/67341759-ad08-41a5-be6e-de12fe448618.mp3" },
  { id: "Jessica", elevenLabsId: "cgSgspJ2msm6clMCkdW9", label: "Jessica: bright, playful", gender: "female", accent: "American",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/cgSgspJ2msm6clMCkdW9/56a97bf8-b69b-448f-846c-c3a11683d45a.mp3" },
  { id: "Matilda", elevenLabsId: "XrExE9yKIg1WjnnlVkGX", label: "Matilda: warm, professional", gender: "female", accent: "American",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3" },
  { id: "Lily", elevenLabsId: "pFZP5JQG7iQjIQuC4Bku", label: "Lily: velvety actress", gender: "female", accent: "British",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/89b68b35-b3dd-4348-a84a-a3c13a3c2b30.mp3" },
  { id: "Alice", elevenLabsId: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice: clear, engaging", gender: "female", accent: "British",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3" },
  { id: "George", elevenLabsId: "JBFqnCBsd6RMkjVDRZzb", label: "George: warm storyteller", gender: "male", accent: "British",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/JBFqnCBsd6RMkjVDRZzb/e6206d1a-0721-4787-aafb-06a6e705cac5.mp3" },
  { id: "Brian", elevenLabsId: "nPczCjzI2devNBz1zQrb", label: "Brian: deep, resonant", gender: "male", accent: "American",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/nPczCjzI2devNBz1zQrb/2dd3e72c-4fd3-42f1-93ea-abc5d4e5aa1d.mp3" },
  { id: "Liam", elevenLabsId: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam: young, energetic", gender: "male", accent: "American",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3" },
  { id: "Callum", elevenLabsId: "N2lVS1w4EtoT3dr4eOWO", label: "Callum: husky trickster", gender: "male", accent: "American",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/N2lVS1w4EtoT3dr4eOWO/ac833bd8-ffda-4938-9ebc-b0f99ca25481.mp3" },
  { id: "Charlie", elevenLabsId: "IKne3meq5aSn9XLyUdCD", label: "Charlie: deep, energetic", gender: "male", accent: "Australian",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/IKne3meq5aSn9XLyUdCD/102de6f2-22ed-43e0-a1f1-111fa75c5481.mp3" },
  { id: "River", elevenLabsId: "SAz9YHcvj6GT2YYXdXww", label: "River: relaxed, neutral", gender: "neutral", accent: "American",
    previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/SAz9YHcvj6GT2YYXdXww/e6c95f0b-2227-491a-b3d7-2249240decb7.mp3" },
] as const satisfies readonly { id: string; elevenLabsId: string; label: string; gender: "female" | "male" | "neutral"; accent: string; previewUrl: string }[];
export type MediaToolVoiceId = (typeof MEDIA_TOOL_VOICES)[number]["id"];

const MB = 1024 * 1024;

// Inputs and limits checked against each endpoint's OpenAPI (fal.ai/api/openapi/queue/openapi.json?endpoint_id=…)
// and prices against fal.ai/models/<endpoint>, both read 2026-11-06.
export const MEDIA_TOOLS = [
  // image
  // fal lists BiRefNet as compute-billed with no per-image price; $0.01 a run is our ceiling for it.
  { id: "remove-bg", replacesInput: true, group: "image", endpoint: "fal-ai/birefnet/v2", output: "image", seconds: 8,
    inputs: [{ key: "image", kind: "image", required: true }], price: { per: "call", usd: 0.01 }, amount: { from: "none" } },
  // $0.001 per output megapixel.
  { id: "upscale", replacesInput: true, group: "image", endpoint: "fal-ai/seedvr/upscale/image", output: "image", seconds: 25,
    inputs: [{ key: "image", kind: "image", required: true }, { key: "factor", kind: "select", options: ["2", "4"], default: "2" }],
    price: { per: "megapixel", usd: 0.001, minUsd: 0.005 }, amount: { from: "megapixels", key: "image", scaleKey: "factor" } },
  // $0.05 per megapixel, rounded up to the next whole megapixel. The picture is sent at most 2048 px a side.
  { id: "inpaint", replacesInput: true, group: "image", endpoint: "fal-ai/flux-pro/v1/fill", output: "image", seconds: 20,
    inputs: [{ key: "image", kind: "image", required: true }, { key: "mask", kind: "mask", of: "image", required: true },
      { key: "prompt", kind: "text", maxChars: 1000, required: true }],
    price: { per: "megapixel", usd: 0.05, roundUp: 1 }, amount: { from: "megapixels", key: "image" } },
  // $0.018 without a prompt, $0.03 with one: reserved at $0.03.
  { id: "expand", replacesInput: true, group: "image", endpoint: "fal-ai/bria/expand", output: "image", seconds: 20,
    inputs: [{ key: "image", kind: "image", required: true }, { key: "aspect", kind: "select", options: ["16:9", "9:16", "4:3", "3:4", "1:1"], default: "16:9" },
      { key: "prompt", kind: "text", maxChars: 500 }], price: { per: "call", usd: 0.03 }, amount: { from: "none" } },
  // Option values are fal's own `lighting_style` values.
  { id: "relight", replacesInput: true, group: "image", endpoint: "fal-ai/image-apps-v2/relighting", output: "image", seconds: 20,
    inputs: [{ key: "image", kind: "image", required: true }, { key: "light", kind: "select",
      options: ["sunset", "golden_hour", "blue_hour", "moonlight", "natural", "studio", "neon", "candlelight", "dramatic", "soft", "backlight", "rim_light"], default: "sunset" }],
    price: { per: "call", usd: 0.04 }, amount: { from: "none" } },
  // video
  // $0.014 per input-video second, rounded up to 5 s blocks. Kling takes a 2–10 s 720p/1080p clip and 2–60 s of audio under 5 MB;
  // fal quotes ~12 minutes a run.
  { id: "lipsync", replacesInput: true, group: "video", endpoint: "fal-ai/kling-video/lipsync/audio-to-video", output: "video", seconds: 720,
    inputs: [{ key: "video", kind: "video", required: true, limits: { minSeconds: 2, maxSeconds: 10, maxBytes: 100 * MB, minSide: 720, maxSide: 1920, fitSides: true } },
      { key: "audio", kind: "audio", required: true, limits: { minSeconds: 2, maxSeconds: 60, maxBytes: 5 * MB, padToMin: true } }],
    price: { per: "second", usd: 0.014, roundUp: 5 }, amount: { from: "seconds", key: "video" } },
  // A still picture speaks the audio (Kling AI Avatar v2 Standard): $0.0562 per second, the clip as long as the
  // audio. Held to 30 s of audio here (about $1.69).
  { id: "talk", replacesInput: false, group: "video", endpoint: "fal-ai/kling-video/ai-avatar/v2/standard", output: "video", seconds: 240,
    inputs: [{ key: "image", kind: "image", required: true },
      { key: "audio", kind: "audio", required: true, limits: { minSeconds: 2, maxSeconds: 30, maxBytes: 10 * MB, padToMin: true } },
      { key: "prompt", kind: "text", maxChars: 300 }],
    price: { per: "second", usd: 0.0562 }, amount: { from: "seconds", key: "audio", max: 30 } },
  // $0.001 per megapixel of output video (width × height × frames).
  { id: "video-upscale", replacesInput: true, group: "video", endpoint: "fal-ai/seedvr/upscale/video", output: "video", seconds: 180,
    inputs: [{ key: "video", kind: "video", required: true, limits: { maxSeconds: 20, maxBytes: 200 * MB, maxSide: 1920, fitSides: true } },
      { key: "factor", kind: "select", options: ["2"], default: "2" }],
    price: { per: "megapixel", usd: 0.001, minUsd: 0.05 }, amount: { from: "videoMegapixels", key: "video", scaleKey: "factor" } },
  // $0.001 per second of audio; MMAudio makes at most 30 s.
  { id: "video-sound", replacesInput: true, group: "video", endpoint: "fal-ai/mmaudio-v2", output: "video", seconds: 40,
    inputs: [{ key: "video", kind: "video", required: true, limits: { minSeconds: 1, maxSeconds: 30, maxBytes: 200 * MB } },
      { key: "prompt", kind: "text", maxChars: 500 }],
    price: { per: "second", usd: 0.001, minUsd: 0.005 }, amount: { from: "seconds", key: "video", max: 30 } },
  // VEED dubbing: the speech translated into another language in the speaker's own voice, lips synced. $0.11 per
  // second of input video; VEED takes 8 s to 10 min, held to 2 min here.
  { id: "dubbing", replacesInput: false, group: "video", endpoint: "veed/dubbing", output: "video", seconds: 300,
    inputs: [{ key: "video", kind: "video", required: true, limits: { minSeconds: 8, maxSeconds: 120, maxBytes: 300 * MB } },
      { key: "lang", kind: "select", options: DUBBING_LANGUAGES, default: "en" }],
    price: { per: "second", usd: 0.11 }, amount: { from: "seconds", key: "video" } },
  // MiniMax H3 Max reframe: a clip in a new shape, the missing area drawn (the source and its sound kept). $0.08 per
  // generated second at 768p; fal also bills the overlap between its windows, so priced at $0.10. Held to 30 s.
  { id: "reframe", replacesInput: false, group: "video", endpoint: "minimax/h3-max/reframe-video", output: "video", seconds: 180,
    inputs: [{ key: "video", kind: "video", required: true, limits: { maxSeconds: 30, maxBytes: 300 * MB } },
      { key: "aspect", kind: "select", options: ["9:16", "16:9", "1:1", "3:4", "4:3", "21:9"], default: "9:16" },
      { key: "prompt", kind: "text", maxChars: 500 }],
    price: { per: "second", usd: 0.1, minUsd: 0.1 }, amount: { from: "seconds", key: "video", max: 30 } },
  // Kling 3.0 Standard motion control: a character picture moves the way the person in a reference video moves.
  // $0.126 per second of output (as long as the reference, held to 30 s).
  { id: "motion", replacesInput: false, group: "video", endpoint: "fal-ai/kling-video/v3/standard/motion-control", output: "video", seconds: 300,
    inputs: [{ key: "image", kind: "image", required: true },
      { key: "video", kind: "video", required: true, limits: { minSeconds: 3, maxSeconds: 30, maxBytes: 100 * MB } },
      { key: "prompt", kind: "text", maxChars: 500 }],
    price: { per: "second", usd: 0.126 }, amount: { from: "seconds", key: "video", max: 30 } },
  // audio
  // Mureka V9.5 (Artificial Analysis music arena #3 with vocals, 11/2026; Suno has no public API): $0.15 a song
  // from lyrics, so lyrics are required (the studio writes them first when left empty; a prompt-only song is $0.50).
  { id: "song-mureka", replacesInput: false, group: "audio", endpoint: "mureka/v9.5/generate/song", output: "audio", seconds: 90,
    inputs: [{ key: "lyrics", kind: "lyrics", maxChars: 3000, required: true }, { key: "prompt", kind: "text", maxChars: 1000, multiline: true },
      { key: "gender", kind: "select", options: ["auto", "female", "male"], default: "auto" }],
    price: { per: "call", usd: 0.15 }, amount: { from: "none" } },
  // Mureka V9.5 instrumental: $0.15 a track, its own length.
  { id: "bgm-mureka", replacesInput: false, group: "audio", endpoint: "mureka/v9.5/generate/instrumental", output: "audio", seconds: 90,
    inputs: [{ key: "prompt", kind: "text", maxChars: 1000, required: true, multiline: true }],
    price: { per: "call", usd: 0.15 }, amount: { from: "none" } },
  // ElevenLabs Music v2.5: $0.60 per output minute, rounded up to whole minutes. Lyrics become a composition plan
  // (one section per tag).
  { id: "song", replacesInput: false, group: "audio", endpoint: "elevenlabs/music/v2.5", output: "audio", seconds: 60,
    inputs: [{ key: "prompt", kind: "text", maxChars: 1000, required: true, multiline: true }, { key: "lyrics", kind: "lyrics", maxChars: 3000 },
      { key: "seconds", kind: "number", min: 10, max: 240, step: 10, default: 60 }, { key: "instrumental", kind: "boolean", default: false }],
    price: { per: "minute", usd: 0.6, roundUp: 1 }, amount: { from: "number", key: "seconds" } },
  // $0.0002 per second of audio. `prompt` is ACE-Step's genre tags (comma-separated).
  { id: "song-open", replacesInput: false, group: "audio", endpoint: "fal-ai/ace-step", output: "audio", seconds: 40,
    inputs: [{ key: "prompt", kind: "text", maxChars: 500, required: true }, { key: "lyrics", kind: "lyrics", maxChars: 3000 },
      { key: "seconds", kind: "number", min: 10, max: 240, step: 10, default: 60 }],
    price: { per: "second", usd: 0.0002, minUsd: 0.002 }, amount: { from: "number", key: "seconds" } },
  // $0.002 per second.
  { id: "sfx", replacesInput: false, group: "audio", endpoint: "elevenlabs/sound-effects/v3", output: "audio", seconds: 10,
    inputs: [{ key: "prompt", kind: "text", maxChars: 450, required: true }, { key: "seconds", kind: "number", min: 1, max: 30, step: 1, default: 5 },
      { key: "loop", kind: "boolean", default: false }], price: { per: "second", usd: 0.002 }, amount: { from: "number", key: "seconds" } },
  // ElevenLabs v3 through OpenRouter, not fal (whose own content checker refused ordinary roleplay lines):
  // $0.08 per 1,000 characters (OpenRouter's listing, 2026-11-16). Run by the server's media-tools readVoiceAloud.
  { id: "voice", replacesInput: false, group: "audio", endpoint: "elevenlabs/eleven-v3", output: "audio", seconds: 10,
    inputs: [{ key: "text", kind: "text", maxChars: 3000, required: true, multiline: true }, { key: "voice", kind: "voice", default: "Sarah" }],
    price: { per: "kchar", usd: 0.08 }, amount: { from: "chars", key: "text" } },
  // $0.30 per minute of input audio.
  { id: "voice-change", replacesInput: true, group: "audio", endpoint: "fal-ai/elevenlabs/voice-changer", output: "audio", seconds: 15,
    inputs: [{ key: "audio", kind: "audio", required: true, limits: { minSeconds: 0.5, maxSeconds: 300, maxBytes: 50 * MB } },
      { key: "voice", kind: "voice", default: "Sarah" }],
    price: { per: "minute", usd: 0.3, minUsd: 0.01 }, amount: { from: "seconds", key: "audio" } },
  // 3d
  // One picture in, one textured .glb out, from the model the creator picks (fal's per-call prices, 2026-11-13).
  // The result is brought to a card's budget before it lands (lib/generation/model3d-optimize.ts).
  { id: "to-3d", replacesInput: false, group: "3d", endpoint: MODEL_3D_ENDPOINTS.hunyuan, output: "model3d", seconds: 270,
    endpoints: { key: "model", by: MODEL_3D_ENDPOINTS },
    inputs: [{ key: "image", kind: "image", required: true },
      { key: "model", kind: "select", options: MODEL_3D_CHOICES, default: "hunyuan" },
      { key: "detail", kind: "select", options: MODEL_3D_DETAILS, default: "high" },
      // How tall the thing is in the world, metres; 0 leaves the model at the size it came in.
      { key: "heightM", kind: "number", min: 0, max: 5, step: 0.05, default: 0 }],
    price: { per: "call", usd: MODEL_3D_USD.hunyuan, byOption: { key: "model", usd: MODEL_3D_USD } }, amount: { from: "none" } },
  // One picture of a person in, a rigged .glb that moves out: Rodin 2.5 in a T/A pose ($0.40), then Hyper3D's
  // auto-rigger with up to ten motions baked in ($0.40), as one job (server lib/generation/model3d-rig.ts).
  { id: "to-3d-character", replacesInput: false, group: "3d", endpoint: MODEL_3D_ENDPOINTS.rodin, output: "model3d", seconds: 300,
    inputs: [{ key: "image", kind: "image", required: true },
      // Names from the motion library, comma separated (idle is always included); empty: a standard set.
      { key: "motions", kind: "text", maxChars: 400 },
      { key: "heightM", kind: "number", min: 0, max: 5, step: 0.05, default: 1.65 }],
    price: { per: "call", usd: 0.8 }, amount: { from: "none" } },
] as const satisfies readonly MediaTool[];

export type MediaToolId = (typeof MEDIA_TOOLS)[number]["id"];
export const MEDIA_TOOL_IDS = MEDIA_TOOLS.map((t) => t.id) as [MediaToolId, ...MediaToolId[]];

export function mediaTool(id: string): MediaTool | undefined {
  return (MEDIA_TOOLS as readonly MediaTool[]).find((t) => t.id === id);
}

/** A file's measured shape, as the amount needs it. */
export interface MediaToolMeasure { seconds?: number; width?: number; height?: number; frames?: number }

/** The priced amount for a run, from its inputs (options filled) and the measured media. NaN when a measurement
 *  it needs is missing. */
export function mediaToolAmount(tool: MediaTool, inputs: Record<string, unknown>, measured: Record<string, MediaToolMeasure> = {}): number {
  const a = tool.amount;
  const scale = (key?: string) => (key ? Number(inputs[key] ?? defaultOf(tool, key) ?? 1) || 1 : 1);
  switch (a.from) {
    case "none": return 1;
    case "number": return Number(inputs[a.key] ?? defaultOf(tool, a.key));
    case "chars": return typeof inputs[a.key] === "string" ? [...(inputs[a.key] as string)].length : 0;
    case "seconds": {
      const s = measured[a.key]?.seconds;
      return s === undefined ? NaN : a.max ? Math.min(s, a.max) : s;
    }
    case "megapixels": {
      const m = measured[a.key];
      return m?.width && m.height ? (m.width * m.height * scale(a.scaleKey) ** 2) / 1e6 : NaN;
    }
    case "videoMegapixels": {
      const m = measured[a.key];
      return m?.width && m.height && m.frames ? (m.width * m.height * m.frames * scale(a.scaleKey) ** 2) / 1e6 : NaN;
    }
  }
}

/**
 * The size a video is sent at when its tool fits sides (limits.fitSides): scaled so the shorter side reaches
 * minSide and the longer stays within maxSide, both even. Unchanged when it already fits, when fitting is off,
 * or when its proportion cannot meet both (the limits then refuse it as before).
 */
export function fitVideoSides(width: number, height: number, limits: MediaToolMediaLimits | undefined): { width: number; height: number } {
  if (!limits?.fitSides || !width || !height) return { width, height };
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  let scale = 1;
  if (limits.minSide && short < limits.minSide) scale = limits.minSide / short;
  if (limits.maxSide && long * scale > limits.maxSide) scale = limits.maxSide / long;
  if (scale === 1) return { width, height };
  const even = (n: number, up: boolean) => Math.max(2, (up ? Math.ceil(n / 2) : Math.floor(n / 2)) * 2);
  // The short side rounds up (it must reach minSide), the long one down (it must stay under maxSide).
  const w = even(width * scale, width <= height), h = even(height * scale, height < width);
  const fitted = { width: w, height: h };
  if ((limits.minSide && Math.min(w, h) < limits.minSide) || (limits.maxSide && Math.max(w, h) > limits.maxSide)) return { width, height };
  return fitted;
}

/** About how long a line takes to say, seconds: a CJK character a quarter second, another word 0.4 s, a pause at
 *  each sentence mark. What "让她说一段话" prices the talking clip on before the voice exists. */
export function estimateSpeechSeconds(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const words = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const pauses = (text.match(/[.!?,;:\u3002\uff01\uff1f\uff0c\u3001\uff1b\u2026]/g) ?? []).length;
  return Math.round((cjk * 0.25 + words * 0.4 + pauses * 0.3 + 0.5) * 10) / 10;
}

/** "让她说一段话": the voice line, then her picture speaking it, priced before either runs (the clip on the
 *  estimated length, at least the 2 s the clip takes). */
export function sayPrice(text: string): { voice: number; talk: number; total: number; seconds: number } {
  const voice = mediaTool("voice")!;
  const talk = mediaTool("talk")!;
  const seconds = Math.min(30, Math.max(2, estimateSpeechSeconds(text)));
  const v = mediaToolMushies(voice, [...text].length);
  const k = mediaToolMushies(talk, seconds);
  return { voice: v, talk: k, total: v + k, seconds };
}

/** The fal endpoint a run goes to: the tool's own, or the one its model choice names. */
export function mediaToolEndpoint(tool: MediaTool, inputs?: Record<string, unknown>): string {
  if (!tool.endpoints) return tool.endpoint;
  const choice = inputs?.[tool.endpoints.key] ?? defaultOf(tool, tool.endpoints.key);
  return (typeof choice === "string" && tool.endpoints.by[choice]) || tool.endpoint;
}

/** The provider's price for one run, USD, from what is known before it runs (seconds asked for, characters,
 *  output megapixels). `inputs` applies option multipliers (`price.times`); left out, the defaults apply. */
export function mediaToolPriceUsd(tool: MediaTool, amount: number, inputs?: Record<string, unknown>): number {
  const p = tool.price;
  let units = p.per === "call" ? 1 : p.per === "kchar" ? amount / 1000 : p.per === "minute" ? amount / 60 : amount;
  if (p.roundUp) units = Math.ceil(roundTiny(units / p.roundUp)) * p.roundUp;
  const choice = p.byOption ? inputs?.[p.byOption.key] ?? defaultOf(tool, p.byOption.key) : undefined;
  const unitUsd = (typeof choice === "string" && p.byOption?.usd[choice]) || p.usd;
  let usd = Math.max(p.minUsd ?? 0, units * unitUsd);
  for (const t of p.times ?? []) {
    const value = inputs?.[t.key] ?? defaultOf(tool, t.key);
    if (value === t.equals) usd *= t.factor;
  }
  return usd;
}

/** What a run reserves, in mushies: provider price × markup at $0.001 a mushie, rounded up to a whole mushie. */
export function mediaToolMushies(tool: MediaTool, amount: number, inputs?: Record<string, unknown>): number {
  return Math.ceil(roundTiny(mediaToolPriceUsd(tool, amount, inputs) * MEDIA_TOOL_MARKUP / MEDIA_TOOL_USD_PER_MUSHIE));
}

/** 0.01 × 1.2 / 0.001 is 12.000000000000002 in floating point; a price never rounds up on that dust. */
function roundTiny(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function defaultOf(tool: MediaTool, key: string): unknown {
  const input = tool.inputs.find((i) => i.key === key);
  return input && "default" in input ? input.default : undefined;
}
