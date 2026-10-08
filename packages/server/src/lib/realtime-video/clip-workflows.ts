/**
 * Image-to-video graphs for the realtime "clip chain" engine on Comfy Cloud.
 * Each call renders one ~5 s clip that starts on a given frame, so clips can
 * be chained from the previous clip's last frame.
 */
import { CAUSAL_GRAPH, H3_GRAPH, WAN_GRAPH } from "./templates.js";

export const CLIP_MODELS = ["causal-forcing", "h3-turbo", "wan14b-4step"] as const;
export type ClipModel = (typeof CLIP_MODELS)[number];

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

function clone(g: unknown): Graph {
  return JSON.parse(JSON.stringify(g)) as Graph;
}

function set(g: Graph, id: string, inputs: Record<string, unknown>) {
  if (!g[id]) throw new Error(`clip graph is missing node ${id}`);
  Object.assign(g[id].inputs, inputs);
}

/** Frames carried from the previous clip into the next one (H3 clips are 17k+5 frames at 24 fps). */
export const H3_OVERLAP = 22;
/** Every render is ~10 s: per job Comfy Cloud adds 3-4 s of queue and transfer, so longer clips
 *  keep up with playback better than 5 s ones (2026-10-06 speed lab). */
const H3_LENGTH = 243;
/** The base H3 model at 6 steps, no turbo LoRA (2026-10-07 quality lab, same cover/prompt/seed):
 *  every turbo LoRA (lightx2v 4-step v0.1, 8-step v1.0, the 768p v1.2 4-step and 8-step) pulled a
 *  painted cover toward generic flat anime, shifted its palette or added lens-flare/bokeh junk, and
 *  the 768p 8-step one broke at 6 steps; the base model at 6 steps kept the cover's look and was as
 *  fast as a LoRA at 6. Both sides must be multiples of 32 (1088x624 fails).
 *
 *  - stream: the floating film player, which needs clips back quickly: 1024x576 at 6 steps, ~90 s
 *    per clip on the film deployment, close to 1344x768 in sharpness; 832x480 played soft.
 *  - shot: one ~5 s shot of a message's film, where the picture matters most (owner,
 *    2026-10-07): the model's native 1344x768 at 10 steps. On real turns it kept details the shot
 *    asks for that 1024 or 6 steps dropped (a wrist screen lighting up, a pipe across someone's
 *    knees), and beat 1024 upscaled to 1080p by SeedVR2, which sharpens but keeps the smaller
 *    picture's composition and mistakes. Five seconds because render time grows faster than
 *    length (measured: 5 s in ~93 s, 10 s in ~320 s, 15 s in ~640 s), so a long film is many
 *    short shots, rendered side by side.
 *  - warm: a tiny clip that only wakes a deployment worker (loads the models). */
export const H3_PRESETS = {
  stream: { w: 1024, h: 576, steps: 6, length: H3_LENGTH },
  shot: { w: 1344, h: 768, steps: 10, length: 124 },
  warm: { w: 256, h: 160, steps: 1, length: 22 },
} as const;
export type H3Preset = keyof typeof H3_PRESETS;

/**
 * MiniMax H3 clip that continues the previous one the way Civitai long-video workflows do:
 * the last 22 frames + audio of the previous clip (still on Comfy Cloud, referenced by its
 * output path) are anchored at frame 0, and those 22 frames are cut from the result.
 * With reference images it switches to the REF2VA model; the prompt names them <Picture i>.
 */
export function buildH3Graph(o: { prompt: string; seed: number; frame?: string; guide?: string; refs?: string[]; preset?: H3Preset }): Graph {
  const refs = (o.refs ?? []).slice(0, 4);
  const useRef = refs.length > 0;
  const { w: H3_W, h: H3_H, steps: H3_STEPS, length } = H3_PRESETS[o.preset ?? "stream"];
  const H3_NEW = length - H3_OVERLAP;
  const g: Graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: useRef ? "minimax_h3_ref2va_pruned_int8_convrot.safetensors" : "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
  };
  if (useRef) {
    const cond: Record<string, unknown> = { clip: ["3", 0], prompt: o.prompt, width: H3_W, height: H3_H, length, ref_image_size: "match", vae: ["4", 0], audio_vae: ["5", 0] };
    refs.forEach((image, i) => {
      g[`r${i + 1}`] = { class_type: "LoadImage", inputs: { image } };
      cond[`ref_images.ref_image_${i + 1}`] = [`r${i + 1}`, 0];
    });
    g["10"] = { class_type: "MiniMaxH3ReferenceToVideo", inputs: cond };
  } else {
    const cond: Record<string, unknown> = { clip: ["3", 0], vae: ["4", 0], prompt: o.prompt, width: H3_W, height: H3_H, length };
    if (o.frame && !o.guide) {
      g.f = { class_type: "LoadImage", inputs: { image: o.frame } };
      cond.first_frame = ["f", 0];
    }
    g["10"] = { class_type: "MiniMaxH3ImageToVideo", inputs: cond };
  }
  let positive: unknown = ["10", 0];
  if (o.guide) {
    const sec = H3_OVERLAP / 24;
    g["30"] = { class_type: "LoadVideo", inputs: { file: `${o.guide} [output]` } };
    g["31"] = { class_type: "GetVideoComponents", inputs: { video: ["30", 0] } };
    g["32"] = { class_type: "ImageFromBatch", inputs: { image: ["31", 0], batch_index: -H3_OVERLAP, length: H3_OVERLAP } };
    g["33"] = { class_type: "TrimAudioDuration", inputs: { audio: ["31", 1], start_index: -sec, duration: sec } };
    g["34"] = { class_type: "MiniMaxH3AddGuide", inputs: { positive, latent: ["10", 1], frame_idx: 0, vae: ["4", 0], audio_vae: ["5", 0], image: ["32", 0], audio: ["33", 0] } };
    positive = ["34", 0];
  }
  Object.assign(g, {
    "40": { class_type: "RandomNoise", inputs: { noise_seed: o.seed } },
    "41": { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: positive } },
    "42": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "43": { class_type: "BasicScheduler", inputs: { scheduler: "simple", steps: H3_STEPS, denoise: 1, model: ["1", 0] } },
    "44": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["40", 0], guider: ["41", 0], sampler: ["42", 0], sigmas: ["43", 0], latent_image: ["10", 1] } },
    "45": { class_type: "VAEDecode", inputs: { samples: ["44", 0], vae: ["4", 0] } },
    "46": { class_type: "VAEDecodeAudio", inputs: { samples: ["44", 0], vae: ["5", 0] } },
  });
  let images: unknown = ["45", 0];
  let audio: unknown = ["46", 0];
  if (o.guide) {
    // The first 22 frames repeat the anchor; only the new part is played.
    g["47"] = { class_type: "ImageFromBatch", inputs: { image: images, batch_index: H3_OVERLAP, length: H3_NEW } };
    g["48"] = { class_type: "TrimAudioDuration", inputs: { audio, start_index: H3_OVERLAP / 24, duration: H3_NEW / 24 } };
    images = ["47", 0];
    audio = ["48", 0];
  }
  g["50"] = { class_type: "CreateVideo", inputs: { fps: 24, bit_depth: 8, images, audio } };
  g["51"] = { class_type: "SaveVideo", inputs: { video: ["50", 0], filename_prefix: "yumina-rtv/h3", format: "mp4", codec: "h264" } };
  return g;
}

export function buildClipGraph(model: ClipModel, o: { image: string; prompt: string; seconds: number; seed: number }): Graph {
  let g: Graph;
  if (model === "causal-forcing") {
    g = clone(CAUSAL_GRAPH);
    set(g, "18", { image: o.image });
    set(g, "29:4", { text: o.prompt });
    set(g, "29:28", { value: o.seconds });
    set(g, "29:11", { noise_seed: o.seed });
  } else if (model === "h3-turbo") {
    g = clone(H3_GRAPH);
    set(g, "114", { image: o.image });
    set(g, "105:104", { prompt: o.prompt });
    set(g, "105:111", { value: o.seconds });
    set(g, "105:126", { value: true });
    set(g, "115", { aspect_ratio: "16:9 (Widescreen)" });
    set(g, "105:15", { noise_seed: o.seed });
  } else {
    g = clone(WAN_GRAPH);
    set(g, "97", { image: o.image });
    set(g, "129:93", { text: o.prompt });
    set(g, "129:131", { value: true });
    set(g, "129:98", { width: 832, height: 480 });
    set(g, "129:161", { value: o.seconds });
    set(g, "129:86", { noise_seed: o.seed });
  }
  for (const node of Object.values(g)) {
    if (node.class_type === "SaveVideo") Object.assign(node.inputs, { filename_prefix: `yumina-rtv/${model}`, format: "mp4", codec: "h264" });
  }
  return g;
}
