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

/** The scene plate drawn from the card's own pictures (owner, 2026-10-19): Qwen-Image-Edit 2511
 *  (8-step Lightning) with the cover as image 1 for the art style and the portraits of who is in
 *  the scene after it. A plate from text alone set the look of every shot after it, and on prod it
 *  drew an anime card's heroine as a short-haired, semi-realistic film actor (the model's own idea
 *  of the name), which every keyframe and shot of that scene then copied. */
export function plateRefGraph(refs: string[], prompt: string, seed: number): Graph {
  const g: Graph = {
    unet: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511_fp8mixed.safetensors", weight_dtype: "default" } },
    lora: { class_type: "LoraLoaderModelOnly", inputs: { model: ["unet", 0], lora_name: "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-fp32.safetensors", strength_model: 1 } },
    shift: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["lora", 0], shift: 3.1 } },
    norm: { class_type: "CFGNorm", inputs: { model: ["shift", 0], strength: 1 } },
    clip: QWEN_CLIP,
    vae: QWEN_VAE,
  };
  const images: Record<string, [string, number]> = {};
  refs.slice(0, 3).forEach((r, i) => {
    g[`img${i + 1}`] = { class_type: "LoadImage", inputs: { image: r } };
    images[`image${i + 1}`] = [`img${i + 1}`, 0];
  });
  Object.assign(g, {
    posraw: { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["clip", 0], vae: ["vae", 0], prompt, ...images } },
    negraw: { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["clip", 0], vae: ["vae", 0], prompt: "", ...images } },
    pos: { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["posraw", 0], reference_latents_method: "index_timestep_zero" } },
    neg: { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["negraw", 0], reference_latents_method: "index_timestep_zero" } },
    latent: { class_type: "EmptySD3LatentImage", inputs: { width: W, height: H, batch_size: 1 } },
    ks: { class_type: "KSampler", inputs: { model: ["norm", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["latent", 0], seed, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    dec: { class_type: "VAEDecode", inputs: { samples: ["ks", 0], vae: ["vae", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "rtv-plate" } },
  });
  return g;
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

/** Someone in the picture with no reference picture, and how they look (the cast's look). */
export type Described = { name: string; look: string };

/** Who has no reference picture: how each looks, and that nobody borrows a reference face. On prod
 *  the bathroom's ghost, named but never described, got the heroine's face and headband in a
 *  keyframe and was drawn as a second her in a plate (2026-10-19). */
function othersLine(others: Described[], faces: string[]): string {
  const looks = others.map((o) => ` ${o.name} looks like this: ${o.look.trim().replace(/\.?$/, ".")}`).join("");
  if (!faces.length) return looks;
  const many = faces.length > 1;
  return `${looks} Only ${faces.join(" and ")} ${many ? "have" : "has"} the face${many ? "s" : ""} of the reference picture${many ? "s" : ""}; everyone else has their own clearly different face, hair and clothing.`;
}

/** A scene state for a picture: what the player does and where they stand comes out ("You stand
 *  near the doorway with your bag": the plate drew a boy with a bag in the doorway, prod
 *  2026-10-19). The picture is seen through their eyes. */
export function withoutPlayer(state: string): string {
  return state.split(/(?<=[.!?])\s+/).filter((s) => !/^(?:you|your)\b/i.test(s.trim())).join(" ").trim();
}

/** The plate's prompt: the look, the scene state, an establishing wide shot. */
export function platePrompt(style: string, state: string, others: Described[] = []): string {
  return `${pictureStyle(style)} ${silentShot(withoutPlayer(state))}${othersLine(others, [])} Establishing wide shot of the whole place at eye level, everyone in it visible. Absolutely no text anywhere in the picture: no subtitles, captions, letters, writing or watermark.`;
}

/** The prompt for plateRefGraph. With portraits (images 1..n) each is a reference sheet of one
 *  person: their look, and the first one also the drawing style. Measured on the off-model film's
 *  own scene (2026-10-19): a cover as the style image brought its people along (the player was in 4
 *  of 4), and a scene that described her again beside her portrait drew her twice; portraits framed
 *  as reference sheets, with the scene naming her and not describing her, gave the card's style and
 *  her look every time and one of her in most. Without portraits the cover (`cover`) is a style
 *  sample only. The plate comes closer than a bare establishing shot: it is the scene's first frame,
 *  and faces too small to read lose what the portraits gave them. */
export function plateRefPrompt(style: string, state: string, cover: boolean, faces: string[], others: Described[] = []): string {
  const scene = ` The scene: ${silentShot(withoutPlayer(state))}${othersLine(others, faces)} Medium-wide shot at eye level that shows the place and the people in it, close enough that their faces read clearly. The camera is the player's own eyes: the player is not in the picture, at most their bare hands. Absolutely no text anywhere in the picture: no subtitles, captions, letters, writing or watermark.`;
  if (!faces.length) {
    return cover
      ? `Draw a completely new picture in exactly the art style of image 1: the same medium, line work, shading, colouring and proportions. Image 1 is only a style sample: none of its people, poses, place or composition appear.${scene}`
      : `${pictureStyle(style)}${scene}`;
  }
  const sheets = faces
    // Hairstyle, accessories and clothes follow the story where it changed them: given "her hair
    // disheveled without her headband" and a sheet with one, a plate drew her twice, once each way
    // (prod 2026-10-19).
    .map((name, i) => `Image ${i + 1} is a character reference sheet of ${name}: use it only for how ${name} looks (face, eye colour, hair colour and hair length; hairstyle, accessories and clothing as in the sheet unless the scene says otherwise, and then as the scene says)${i === 0 ? " and for the art style (the same medium, line work, cel shading, colouring and proportions)" : ""}.`)
    .join(" ");
  const named = [...faces, ...others.map((o) => o.name)];
  const once = named.length === 1 ? `${named[0]} appears exactly once` : `each of ${named.join(", ")} appears exactly once`;
  return `${sheets} Do not copy the reference sheets' poses, crossed arms, framing or backgrounds. Draw a new scene in which ${once}, in the pose the scene describes, and nobody else appears unless the scene names them.${scene}`;
}

/** A style sentence for a picture model: what it is, without the "Not …" sentences. With no
 *  negative prompt (the plate zeroes it) a "not a 3D model" in the prompt only adds 3D. */
export function pictureStyle(style: string): string {
  return style
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/^not\b/i.test(s.trim()))
    .join(" ")
    .trim();
}

/** A still has nothing to say: spoken lines and the voice instructions come out of the shot
 *  before it becomes a picture prompt, or the edit model letters them onto the frame as subtitles
 *  (on prod every shot of a film carried a burned-in Japanese caption, 2026-10-08). */
export function silentShot(shot: string): string {
  const unquoted = shot
    // A line that ends its sentence leaves a full stop: "…her tone hardening: 「…」 All dialogue is
    // spoken in Japanese…" became one sentence, dropped whole for "dialogue" below, and the shot
    // reached the picture model empty; it drew her twice (2 of 11 prod shots, 2026-10-19).
    .replace(/(?:「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*")(?=\s+[A-Z])/g, ". ")
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g, "")
    // "facing Harry (player's first-person perspective)": a picture model draws the named player
    // into the frame (every plate drawn from portraits did, 2026-10-19). The player is the camera.
    .replace(/\b[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?\s*\(\s*(?:the\s+)?(?:player|you)\b[^)]*\)/gu, "the camera")
    // "murmuring softly in Japanese: 「…」 as she…" with the line gone.
    .replace(/,?\s*\bin Japanese\b\s*[:：]?/gi, "");
  const quiet = unquoted
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b(dialogue|spoken|subtitles?|captions?|on-screen text)\b/i.test(sentence))
    .join(" ")
    // "says softly:" with its line gone.
    .replace(/\s*[:：]\s*(?=[.!?]|$)/g, "")
    .replace(/\s+([.!?,])/g, "$1")
    .replace(/([.!?])[.,]+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return softBlush(unreflected(quiet));
}

/** The player has no reflection. "She catches your direct reflection" put a stranger in the
 *  mirror (prod 2026-10-19): she sees you, the camera, instead. */
export function unreflected(text: string): string {
  return text.replace(/\byour\s+(?:[\p{L}-]+\s+){0,2}reflection\b/giu, "you");
}

const HEAT = String.raw`(?:(?:blazing|burning|fiery|furious|vivid|intense|bright|deep|dark|heavy|flaming|hot)\s+)*`;
const SKIN_RED = [
  new RegExp(String.raw`\b${HEAT}(?:crimson|scarlet|red)(?=\s+(?:blush|flush))`, "gi"),
  new RegExp(String.raw`\b((?:blush|flush|turn|burn|blaze|go|glow)(?:s|es|ed|ing)?)\s+(?:a\s+)?${HEAT}(?:crimson|scarlet|red)\b`, "gi"),
  new RegExp(String.raw`\b((?:ears?|earlobes?|cheeks?|face|neck)(?:\s+tips?)?)\s+(?:are\s+|is\s+)?${HEAT}(?:crimson|scarlet|red)\b`, "gi"),
] as const;
/** A blush is a faint pink one. "A blazing crimson blush" and "ears blazing red" became glowing red
 *  patches on her face and ears, in keyframes and in the video model alike (2026-10-19); her
 *  "red-rimmed eyes" became red irises (same day). */
export function softBlush(text: string): string {
  return text.replace(/\b(?:red|bloodshot)[- ]rimmed eyes\b|\bbloodshot eyes\b/gi, "teary eyes").replace(SKIN_RED[0], "faint pink").replace(SKIN_RED[1], "$1 faint pink").replace(SKIN_RED[2], "$1 faintly pink");
}

/** The keyframe's prompt: the plate's place and people, cut to this shot's angle and moment.
 *  Who is who in the plate is said in words (`people`, the cast's looks), not with portraits: the
 *  plate already has their faces, and a portrait beside it drew a person a second time in 3 of 3
 *  two-person shots (often from behind, in the foreground), while unnamed looks let the ghost take
 *  the heroine's face or the heroine the ghost's glasses. Measured on the prod bathroom scene
 *  (2026-10-19): portraits 0/3 clean, words 9/9 across a two-person shot, a wand shot and a mirror
 *  close-up, faces still on model. Only someone the plate lacks, who joins the scene, gets their
 *  portrait (`joining`, images 2..). The camera comes first, or the cut kept the plate's framing. */
export function keyframePrompt(shot: string, joining: string[] = [], people: Described[] = []): string {
  const joins = joining.map((name, i) => ` Image ${i + 2} is a character reference of ${name}, who is not in image 1 yet: draw ${name} with exactly this face, hair and clothing, once, but not this pose or background.`).join("");
  const who = people.length
    ? ` Who is who in image 1: ${people.map((p) => `${p.name} is the ${p.look.split(",")[0]!.trim().replace(/^(?:a|an|the)\s+/i, "").replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase())} who looks like this: ${p.look.trim().replace(/\.?$/, ".")}`).join(" ")} Each person keeps exactly their own face, hair, accessories and clothing from image 1; nobody takes on another person's glasses, hair, face or clothes.`
    : "";
  return `A new camera angle of the same scene as image 1, as a film cuts to a new shot: ${silentShot(shot)} Change the camera position and framing completely from image 1 (closer, from another side, or a different height), as this moment needs. Keep the same place, furniture, light and art style as image 1, and the same people.${joins}${who} Everyone appears exactly once and nobody ${joining.length ? "else" : "new"} is added. Seen through the player's own eyes (first-person view): the player's face and back are never shown, only their bare hands when they act, and nobody holds a camera. Mirrors, windows and water never show the player. Absolutely no text anywhere in the picture: no subtitles, captions, speech bubbles, letters or writing.`;
}
