// Keyframes for a short film (owner, 2026-10-08): before its shots render, each scene gets one
// establishing picture (the plate) and each new shot's first frame is edited from it, so every
// shot of a scene shows the same room, the same people and the same clothes. Measured on the
// shared pool: plate ~14 s, a keyframe ~15-20 s (side by side), against shots filmed straight from
// text that moved the furniture and changed faces and dresses between shots.

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

const QWEN_CLIP = { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image" } };
const QWEN_VAE = { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } };
/** The film's frame size (the H3 "shot" preset). */
const W = 1344;
const H = 768;

/** The scene plate: Qwen-Image 2512 with its 4-step Lightning LoRA. */
export function plateGraph(prompt: string, seed: number): Graph {
  return {
    unet: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2512_fp8_e4m3fn.safetensors", weight_dtype: "default" } },
    lora: { class_type: "LoraLoaderModelOnly", inputs: { model: ["unet", 0], lora_name: "Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors", strength_model: 1 } },
    shift: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["lora", 0], shift: 3.1 } },
    clip: QWEN_CLIP,
    vae: QWEN_VAE,
    pos: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: prompt } },
    neg: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["pos", 0] } },
    latent: { class_type: "EmptySD3LatentImage", inputs: { width: W, height: H, batch_size: 1 } },
    ks: { class_type: "KSampler", inputs: { model: ["shift", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["latent", 0], seed, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    dec: { class_type: "VAEDecode", inputs: { samples: ["ks", 0], vae: ["vae", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "rtv-plate" } },
  };
}

/** A shot's first frame: Qwen-Image-Edit 2511 (8-step Lightning) re-framing the plate (image 1),
 *  with the multiple-angles LoRA so the camera really moves (without it most shots kept the plate's
 *  wide angle), and up to two portraits after it for faces. */
export function keyframeGraph(plate: string, portraits: string[], prompt: string, seed: number): Graph {
  const g: Graph = {
    unet: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511_fp8mixed.safetensors", weight_dtype: "default" } },
    lora: { class_type: "LoraLoaderModelOnly", inputs: { model: ["unet", 0], lora_name: "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-fp32.safetensors", strength_model: 1 } },
    angles: { class_type: "LoraLoaderModelOnly", inputs: { model: ["lora", 0], lora_name: "qwen-image-edit-2511-multiple-angles-lora.safetensors", strength_model: 1 } },
    shift: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["angles", 0], shift: 3.1 } },
    norm: { class_type: "CFGNorm", inputs: { model: ["shift", 0], strength: 1 } },
    clip: QWEN_CLIP,
    vae: QWEN_VAE,
    img1: { class_type: "LoadImage", inputs: { image: plate } },
  };
  const images: Record<string, [string, number]> = { image1: ["img1", 0] };
  portraits.slice(0, 2).forEach((p, i) => {
    g[`img${i + 2}`] = { class_type: "LoadImage", inputs: { image: p } };
    images[`image${i + 2}`] = [`img${i + 2}`, 0];
  });
  Object.assign(g, {
    posraw: { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["clip", 0], vae: ["vae", 0], prompt, ...images } },
    negraw: { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["clip", 0], vae: ["vae", 0], prompt: "", ...images } },
    pos: { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["posraw", 0], reference_latents_method: "index_timestep_zero" } },
    neg: { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["negraw", 0], reference_latents_method: "index_timestep_zero" } },
    latent: { class_type: "EmptySD3LatentImage", inputs: { width: W, height: H, batch_size: 1 } },
    ks: { class_type: "KSampler", inputs: { model: ["norm", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["latent", 0], seed, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    dec: { class_type: "VAEDecode", inputs: { samples: ["ks", 0], vae: ["vae", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "rtv-key" } },
  });
  return g;
}

/** The plate's prompt: the look, the scene state, an establishing wide shot. */
export function platePrompt(style: string, state: string): string {
  return `${style} ${silentShot(state)} Establishing wide shot of the whole place at eye level, everyone in it visible. Absolutely no text anywhere in the picture: no subtitles, captions, letters, writing or watermark.`;
}

/** A still has nothing to say: spoken lines and the voice instructions come out of the shot
 *  before it becomes a picture prompt, or the edit model letters them onto the frame as subtitles
 *  (on prod every shot of a film carried a burned-in Japanese caption, 2026-10-08). */
export function silentShot(shot: string): string {
  const unquoted = shot.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g, "");
  return unquoted
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b(dialogue|spoken|subtitles?|captions?|on-screen text)\b/i.test(sentence))
    .join(" ")
    // "says softly:" with its line gone.
    .replace(/\s*[:：]\s*(?=[.!?]|$)/g, "")
    .replace(/\s+([.!?,])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The keyframe's prompt: keep the plate's place and people, cut to this shot's angle and moment. */
export function keyframePrompt(shot: string, faces: string[]): string {
  const who = faces.map((name, i) => ` Image ${i + 2} is ${name}'s face and hair.`).join("");
  return `Keep exactly the same place, furniture, light, art style and the same people (faces, hair and clothing) as in image 1.${who} Change the camera angle and framing completely, as a film cut to a new angle would, to show this moment: ${silentShot(shot)} Seen through the player's own eyes (first-person view): the player's face and back are never shown, only their bare hands when they act, and nobody holds a camera. Absolutely no text anywhere in the picture: no subtitles, captions, speech bubbles, letters or writing.`;
}
