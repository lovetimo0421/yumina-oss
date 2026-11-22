/**
 * yumina.io/atelier: what the Atelier is, as pages anyone can read.
 *
 * The Atelier (AI pictures, video, sound, 3D models and LoRAs) lives in the
 * app at /app/generate, where a crawler gets an empty shell. These pages say
 * what it makes, with which models, and what a run costs:
 *
 *   /atelier                    the introduction
 *   /atelier/image/<family>     one page per image model family
 *   /atelier/video/<family>     one page per video model family
 *   /atelier/styles/<style>     one page per built-in art style
 *
 * Everything that can change is read from the lists the app itself draws its
 * page from (@yumina/shared): the image and video models, the art styles and
 * what each costs. A model added to the app gets its page here with no edit.
 * Prices are stated only where the code computes them in mushies (art
 * styles, video, 3D); the general image models are billed at the provider's
 * reported cost, so those pages say where the price is shown instead of
 * quoting one.
 *
 * Styles and models for adult content have no page.
 */
import {
  MODEL_3D_CHOICES,
  PLATFORM_STYLES,
  SMART_IMAGE_FAMILIES,
  SMART_IMAGE_FAMILY_INFO,
  SMART_IMAGE_MODELS,
  VIDEO_FAMILIES,
  VIDEO_FAMILY_INFO,
  VIDEO_MODELS,
  computeVideoModelPrice,
  mediaTool,
  mediaToolMushies,
  platformStyleFamilies,
  platformStylePrice,
  videoAspects,
  videoDurationOptions,
  type PlatformStyleInfo,
  type SmartImageFamily,
  type VideoFamily,
  type VideoModelSpec,
} from "@yumina/shared";
import { PUBLIC_ORIGIN } from "./env.js";
import { breadcrumbHtml, breadcrumbLd, esc, faqHtml, faqLd, type Faq } from "./public-page-parts.js";

export const ATELIER_PATH = "/atelier";
/** Where the tool itself lives in the app; `?view=` opens a studio. */
export const ATELIER_APP_PATH = "/app/generate";
export const ATELIER_TITLE = "Atelier: AI Image, Video and 3D Generator";
const studioHref = (view: "image" | "video" | "audio" | "3d" | "lora") => `${ATELIER_APP_PATH}?view=${view}`;
const count = (n: number) => n.toLocaleString("en-US");
const kebab = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// ── art styles ───────────────────────────────────────────────────────────────

/**
 * The names the app shows for the built-in styles (its English strings,
 * library.json generation.style.*). atelier-public.test.ts checks them
 * against that file, so a renamed style fails the test instead of drifting.
 */
export const STYLE_NAMES: Record<string, string> = {
  anime: "Anime",
  realistic: "Realistic",
  semireal: "2.5D",
  guofeng: "Ink Wash",
  western: "Western",
};
export const STYLE_VARIANT_NAMES: Record<string, string> = { anime: "Classic", "anime-new": "New" };

/** What each style draws, in one sentence. */
const STYLE_ABOUT: Record<string, string> = {
  anime: "Anime illustration: characters and scenes drawn the way anime and manga draw them.",
  realistic: "Pictures that look like photographs.",
  semireal: "Halfway between anime and realistic: anime faces with painted light and depth.",
  guofeng: "Anime characters in Chinese ink-wash painting, with Chinese clothing and brush texture.",
  western: "Western illustration, in the manner of comics and painted fantasy art.",
};

export interface AtelierStyle {
  slug: string;
  name: string;
  about: string;
  /** How its prompt is written. */
  dialect: "danbooru" | "prose";
  /** Mushies for one default picture. */
  price: number;
  /** Whether LoRAs can be added (the SDXL styles; the others have their own encoders). */
  loras: boolean;
  /** A sample picture shipped with the app. */
  image: string;
  /** Versions of the style a creator can switch between, when there is more than one. */
  variants: Array<{ name: string; price: number }>;
}

const isAdultStyle = (style: PlatformStyleInfo) => /nsfw/i.test(style.slug) || /nsfw/i.test(style.family ?? "");

/** The built-in art styles that have a page: one per style card, adult ones left out. */
export function atelierStyles(): AtelierStyle[] {
  return platformStyleFamilies(PLATFORM_STYLES.filter((s) => !isAdultStyle(s)))
    .filter((f) => STYLE_NAMES[f.family])
    .map((f) => {
      const base = f.styles.find((s) => s.slug === f.family) ?? f.styles[0]!;
      // A version that is offered only when the server lists it is not promised here.
      const offered = f.styles.filter((s) => !s.optIn);
      return {
        slug: f.family,
        name: STYLE_NAMES[f.family]!,
        about: STYLE_ABOUT[f.family] ?? "",
        dialect: base.dialect,
        price: platformStylePrice(base.slug, "portrait"),
        loras: !base.arch || base.arch === "sdxl",
        image: `/workbench/styles/${base.slug}.webp`,
        variants: offered.length > 1
          ? offered.map((s) => ({ name: STYLE_VARIANT_NAMES[s.slug] ?? s.slug, price: platformStylePrice(s.slug, "portrait") }))
          : [],
      };
    });
}

// ── model families ───────────────────────────────────────────────────────────

export interface ImageFamilyPage {
  kind: "image";
  slug: string;
  name: string;
  maker: string;
  models: Array<{ name: string; sizes: string[]; shapes: number; reference: boolean; seed: boolean }>;
}

export interface VideoFamilyPage {
  kind: "video";
  slug: string;
  name: string;
  maker: string;
  models: Array<{
    name: string;
    resolutions: string[];
    /** Seconds: shortest and longest clip. */
    shortest: number;
    longest: number;
    firstFrame: boolean;
    lastFrame: boolean;
    references: number;
    sound: boolean;
    textToVideo: boolean;
    /** Mushies for the model's default clip, and how long that clip is. */
    price: number;
    priceSeconds: number;
  }>;
}

export function atelierImageFamilies(): ImageFamilyPage[] {
  return SMART_IMAGE_FAMILIES.map((family: SmartImageFamily) => ({
    kind: "image" as const,
    slug: kebab(family),
    name: SMART_IMAGE_FAMILY_INFO[family].name,
    maker: SMART_IMAGE_FAMILY_INFO[family].maker,
    models: SMART_IMAGE_MODELS.filter((m) => m.family === family).map((m) => ({
      name: m.name,
      sizes: [...m.resolutions].map((r) => (r === "512" ? "0.5K" : r)),
      shapes: m.aspectRatios.length,
      reference: m.supportsReference,
      seed: m.supportsSeed,
    })),
  })).filter((f) => f.models.length > 0);
}

function defaultClipPrice(spec: VideoModelSpec): number {
  return computeVideoModelPrice(spec, {
    aspectRatio: videoAspects(spec).includes("16:9") ? "16:9" : videoAspects(spec)[0]!,
    resolution: spec.defaultResolution,
    durationSeconds: spec.defaultDuration,
  });
}

export function atelierVideoFamilies(): VideoFamilyPage[] {
  return VIDEO_FAMILIES.map((family: VideoFamily) => ({
    kind: "video" as const,
    slug: kebab(family),
    name: VIDEO_FAMILY_INFO[family].name,
    maker: VIDEO_FAMILY_INFO[family].maker,
    models: VIDEO_MODELS.filter((m) => m.family === family).map((m) => {
      const seconds = videoDurationOptions(m);
      return {
        name: m.name,
        resolutions: [...m.resolutions],
        shortest: Math.min(...seconds),
        longest: Math.max(...seconds),
        firstFrame: m.frames.first,
        lastFrame: m.frames.last,
        references: m.maxReferences,
        sound: m.sound,
        textToVideo: m.textToVideo,
        price: defaultClipPrice(m),
        priceSeconds: m.defaultDuration,
      };
    }),
  })).filter((f) => f.models.length > 0);
}

/** Mushies for one 3D model from the default generator. */
export function model3dPrice(): number {
  const tool = mediaTool("to-3d");
  return tool ? mediaToolMushies(tool, 1) : 0;
}

const imagePath = (slug: string) => `${ATELIER_PATH}/image/${slug}`;
const videoPath = (slug: string) => `${ATELIER_PATH}/video/${slug}`;
const stylePath = (slug: string) => `${ATELIER_PATH}/styles/${slug}`;

/** Every Atelier page address, the introduction first. */
export function atelierPaths(): string[] {
  return [
    ATELIER_PATH,
    ...atelierImageFamilies().map((f) => imagePath(f.slug)),
    ...atelierVideoFamilies().map((f) => videoPath(f.slug)),
    ...atelierStyles().map((s) => stylePath(s.slug)),
  ];
}

// ── the introduction ─────────────────────────────────────────────────────────

function cheapestClip(): { price: number; seconds: number; name: string } | null {
  let best: { price: number; seconds: number; name: string } | null = null;
  for (const family of atelierVideoFamilies()) {
    for (const m of family.models) {
      if (m.price > 0 && (!best || m.price < best.price)) best = { price: m.price, seconds: m.priceSeconds, name: m.name };
    }
  }
  return best;
}

export function atelierFaq(): Faq[] {
  const images = atelierImageFamilies();
  const videos = atelierVideoFamilies();
  const styles = atelierStyles();
  const clip = cheapestClip();
  const stylePrice = Math.min(...styles.map((s) => s.price));
  const d3 = model3dPrice();
  const withReference = images.filter((f) => f.models.some((m) => m.reference)).length;
  return [
    {
      q: "What can I make in the Atelier?",
      a: "Pictures, short video clips, music, sound effects, voices and 3D models. You write a sentence, or start from a picture you already have, and the result is saved to your asset library.",
    },
    {
      q: "Which AI models does the Atelier use?",
      a: `For pictures: ${list(images.slice(0, 6).map((f) => f.name))}, ${images.length} model families in all. For video: ${list(videos.slice(0, 5).map((f) => f.name))}, ${videos.length} families in all. For 3D, ${MODEL_3D_CHOICES.length} generators, with Hunyuan 3D as the default.`,
    },
    {
      q: "How much does it cost?",
      a:
        `Runs are paid in mushies, and the button shows the price before you press it. A picture in a built-in art style starts at ${count(stylePrice)} mushies` +
        (clip ? `, a ${clip.seconds}-second clip on ${clip.name} is ${count(clip.price)}` : "") +
        (d3 ? `, and a 3D model from the default generator is ${count(d3)}` : "") +
        `. Free accounts get mushies every month.`,
    },
    {
      q: "Do I need an account?",
      a: "You can open the Atelier and look around without one: the studios, their settings and what other people have shared. Generating needs an account, because a run spends mushies and saves to your library.",
    },
    {
      q: "Can I start from a picture I already have?",
      a: `Yes. ${withReference} of the ${images.length} picture model families take a reference picture and change it the way you describe. A video can open on a picture, and a 3D model is made from one.`,
    },
    {
      q: "Can I keep a character looking the same in every picture?",
      a: "Yes, with a LoRA. Train one from a single portrait of the character, or bring your own, and add it to pictures made in the art styles. A LoRA can also be attached to a character in a world so its story illustrations keep the same face.",
    },
    {
      q: "Can I use what I make in a world?",
      a: "Yes. Everything lands in your asset library. Pictures become covers, portraits and scenes, a clip can be a character's moving portrait, and a 3D model can be placed in a 3D scene.",
    },
  ];
}

/** The #root fragment for /atelier. */
export function renderAtelier(): string {
  const images = atelierImageFamilies();
  const videos = atelierVideoFamilies();
  const styles = atelierStyles();
  const clip = cheapestClip();
  const d3 = model3dPrice();
  const familyList = (families: Array<{ slug: string; name: string; maker: string; models: Array<{ name: string }> }>, path: (slug: string) => string) =>
    `<ul class="pre-list">${families
      .map((f) => `<li><a href="${esc(path(f.slug))}">${esc(f.name)}</a> <span class="pre-card__by">${esc(f.maker)}</span><p>${esc(f.models.map((m) => m.name).join(", "))}</p></li>`)
      .join("")}</ul>`;
  const styleCards = styles
    .map((s) => `<a class="pre-card" href="${esc(stylePath(s.slug))}"><img class="pre-card__img" src="${esc(s.image)}" alt="${esc(`${s.name} art style sample`)}" loading="lazy" width="480" height="640" /><span class="pre-card__name">${esc(s.name)}</span><span class="pre-card__by">${count(s.price)} mushies</span></a>`)
    .join("");
  return (
    `<main class="pre pre-atelier"><h1 class="pre-h1">Atelier: AI image, video and 3D generator</h1>` +
    `<div class="pre-text"><p>The Atelier is where you make the pictures, video clips, sound and 3D models for an AI game or roleplay world on Yumina. Write a sentence, pick a model, and the result is saved to your asset library.</p></div>` +
    `<p class="pre-by"><a href="${ATELIER_APP_PATH}">Open the Atelier</a></p>` +
    `<section class="pre-more"><h2 class="pre-h2">What you can make</h2><ul class="pre-list">` +
    `<li><a href="${esc(studioHref("image"))}">Pictures</a><p>A sentence becomes a picture. Attach a reference picture to have it changed the way you describe, and choose the shape and size.</p></li>` +
    `<li><a href="${esc(studioHref("video"))}">Video</a><p>A sentence or a picture is enough for a short clip. A clip can go into a world as a character's moving portrait.</p></li>` +
    `<li><a href="${esc(studioHref("audio"))}">Sound</a><p>Music, sound effects and voices. Pick a voice to read a line, design one from a sentence, or clone one from a recording.</p></li>` +
    `<li><a href="${esc(studioHref("3d"))}">3D models</a><p>One picture becomes a textured 3D model, saved as a .glb. A full-body picture of a person becomes a rigged character that moves.</p></li>` +
    `<li><a href="${esc(studioHref("lora"))}">LoRAs</a><p>Train a LoRA from one portrait so a character keeps the same face, or use one that someone else has shared.</p></li>` +
    `</ul></section>` +
    `<section class="pre-more"><h2 class="pre-h2">Picture models</h2>${familyList(images, imagePath)}</section>` +
    `<section class="pre-more"><h2 class="pre-h2">Video models</h2>${familyList(videos, videoPath)}</section>` +
    `<section class="pre-more"><h2 class="pre-h2">Art styles</h2><div class="pre-text"><p>Art styles are picture models tuned for one look. They run on Yumina's own GPUs, and most of them take LoRAs.</p></div><div class="pre-grid">${styleCards}</div></section>` +
    `<section class="pre-more"><h2 class="pre-h2">How to make a picture</h2><ol class="pre-list">` +
    `<li>Open the Atelier and choose Pictures.</li>` +
    `<li>Write one sentence about what you want. Attach a picture if you want it changed instead of drawn from nothing.</li>` +
    `<li>Pick a model or an art style, then the shape and size. The button shows the price.</li>` +
    `<li>Press Generate. The picture is saved to your asset library, ready to use in a world.</li>` +
    `</ol></section>` +
    `<section class="pre-more"><h2 class="pre-h2">What it costs</h2><div class="pre-text">` +
    `<p>Each run costs mushies, the same balance that pays for story replies. The price is on the button before you press it.</p>` +
    `<ul class="pre-list">` +
    styles.map((s) => `<li>A picture in the ${esc(s.name)} style: ${count(s.price)} mushies.</li>`).join("") +
    (clip ? `<li>A ${clip.seconds}-second clip on ${esc(clip.name)}: ${count(clip.price)} mushies. Other video models cost more.</li>` : "") +
    (d3 ? `<li>A 3D model from the default generator: ${count(d3)} mushies.</li>` : "") +
    `<li>The general picture models are charged at what the provider bills for that run, so the button is the place to read their price.</li>` +
    `</ul><p>Free accounts get mushies every month. <a href="/pricing">Plans and packs</a> add more.</p></div></section>` +
    `<section class="pre-more"><h2 class="pre-h2">Questions</h2>${faqHtml(atelierFaq())}</section>` +
    `</main>`
  );
}

interface Meta {
  title: string;
  description: string;
  url: string;
  image?: string;
  imageAlt?: string;
  jsonLd?: Record<string, unknown>;
}

const HOME = { name: "Yumina", path: "/" };
const ATELIER = { name: "Atelier", path: ATELIER_PATH };

export function atelierMeta(): Meta {
  const url = `${PUBLIC_ORIGIN}${ATELIER_PATH}`;
  const description = "Make pictures, video clips, music, voices and 3D models for your AI game or roleplay world. Seedream, Nano Banana, GPT Image, FLUX, Kling, Veo and more, with the price shown before each run.";
  return {
    title: ATELIER_TITLE,
    description,
    url,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "SoftwareApplication",
          "@id": `${url}#app`,
          name: "Yumina Atelier",
          url,
          description,
          applicationCategory: "MultimediaApplication",
          operatingSystem: "Web browser",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free to open. Runs are paid in mushies; free accounts get mushies every month." },
          featureList: ["AI image generation", "AI video generation", "AI music, sound effects and voices", "Picture to 3D model", "LoRA training"],
          publisher: { "@type": "Organization", name: "Yumina", url: PUBLIC_ORIGIN },
        },
        breadcrumbLd([HOME, ATELIER]),
        faqLd(atelierFaq()),
      ],
    },
  };
}

// ── a model family ───────────────────────────────────────────────────────────

const yesNo = (value: boolean) => (value ? "Yes" : "No");

function otherFamilies(current: string, families: Array<{ slug: string; name: string }>, path: (slug: string) => string): string {
  const rest = families.filter((f) => f.slug !== current);
  return rest.length
    ? `<section class="pre-more"><h2 class="pre-h2">Other models</h2><ul class="pre-tags">${rest.map((f) => `<li><a href="${esc(path(f.slug))}">${esc(f.name)}</a></li>`).join("")}</ul></section>`
    : "";
}

/** What an image family is good for, read off what its models can do. */
export function imageFamilyNotes(family: ImageFamilyPage): string[] {
  const notes: string[] = [];
  const all = family.models;
  if (all.every((m) => m.reference)) notes.push("Every model takes a reference picture, so it can restyle a picture, edit part of it or extend it.");
  else if (all.some((m) => m.reference)) notes.push(`${list(all.filter((m) => m.reference).map((m) => m.name))} can take a reference picture and change it.`);
  else notes.push("It draws from words only and does not take a reference picture.");
  const k4 = all.filter((m) => m.sizes.includes("4K"));
  if (k4.length) notes.push(`${list(k4.map((m) => m.name))} can draw at 4K.`);
  const small = all.filter((m) => m.sizes.includes("0.5K"));
  if (small.length) notes.push(`${list(small.map((m) => m.name))} ${small.length > 1 ? "have" : "has"} a 0.5K size for icons and avatars.`);
  if (all.some((m) => m.seed)) notes.push("With a seed you can draw the same picture again and change one thing.");
  return notes;
}

export function renderImageFamily(family: ImageFamilyPage): string {
  const rows = family.models
    .map((m) => `<tr><th scope="row">${esc(m.name)}</th><td>${esc(m.sizes.length ? m.sizes.join(", ") : "One size")}</td><td>${m.shapes}</td><td>${yesNo(m.reference)}</td><td>${yesNo(m.seed)}</td></tr>`)
    .join("");
  return (
    `<main class="pre pre-atelier-model">${breadcrumbHtml([ATELIER])}` +
    `<h1 class="pre-h1">${esc(family.name)} image models</h1>` +
    `<div class="pre-text"><p>${esc(family.name)} is a family of AI image models from ${esc(family.maker)}. In the Atelier you can pick ${esc(list(family.models.map((m) => m.name)))} to draw pictures for a world: covers, portraits, scenes and items.</p>` +
    imageFamilyNotes(family).map((n) => `<p>${esc(n)}</p>`).join("") +
    `</div>` +
    `<table class="pre-table"><thead><tr><th scope="col">Model</th><th scope="col">Sizes</th><th scope="col">Shapes</th><th scope="col">Reference picture</th><th scope="col">Seed</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="pre-text"><p>These models are charged in mushies at what the provider bills for the run. The Generate button shows the price before you press it.</p></div>` +
    `<p class="pre-by"><a href="${esc(studioHref("image"))}">Open the picture studio</a></p>` +
    otherFamilies(family.slug, atelierImageFamilies(), imagePath) +
    `</main>`
  );
}

export function renderVideoFamily(family: VideoFamilyPage): string {
  const rows = family.models
    .map((m) => {
      const frames = m.firstFrame && m.lastFrame ? "First and last" : m.firstFrame ? "First" : m.lastFrame ? "Last" : "None";
      const length = m.shortest === m.longest ? `${m.shortest} s` : `${m.shortest} to ${m.longest} s`;
      return `<tr><th scope="row">${esc(m.name)}</th><td>${esc(m.resolutions.join(", "))}</td><td>${esc(length)}</td><td>${frames}</td><td>${m.references || "None"}</td><td>${yesNo(m.sound)}</td><td>${count(m.price)} for ${m.priceSeconds} s</td></tr>`;
    })
    .join("");
  const notes: string[] = [];
  const withSound = family.models.filter((m) => m.sound);
  if (withSound.length) notes.push(`${list(withSound.map((m) => m.name))} can make the soundtrack with the picture.`);
  const framed = family.models.filter((m) => m.firstFrame);
  if (framed.length) notes.push(`${list(framed.map((m) => m.name))} can open on a picture you provide, which is how a portrait becomes a moving portrait.`);
  const refs = family.models.filter((m) => m.references > 0);
  if (refs.length) notes.push(`${list(refs.map((m) => m.name))} can take reference pictures of a character so it looks the same in the clip.`);
  return (
    `<main class="pre pre-atelier-model">${breadcrumbHtml([ATELIER])}` +
    `<h1 class="pre-h1">${esc(family.name)} video models</h1>` +
    `<div class="pre-text"><p>${esc(family.name)} is a family of AI video models from ${esc(family.maker)}. In the Atelier you can pick ${esc(list(family.models.map((m) => m.name)))} to make short clips from a sentence or a picture.</p>` +
    notes.map((n) => `<p>${esc(n)}</p>`).join("") +
    `</div>` +
    `<table class="pre-table"><thead><tr><th scope="col">Model</th><th scope="col">Resolution</th><th scope="col">Length</th><th scope="col">Start from a frame</th><th scope="col">Reference pictures</th><th scope="col">Sound</th><th scope="col">Mushies</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="pre-text"><p>The price is for the model's default clip. Longer clips and higher resolutions cost more, and the Generate button shows the exact price.</p></div>` +
    `<p class="pre-by"><a href="${esc(studioHref("video"))}">Open the video studio</a></p>` +
    otherFamilies(family.slug, atelierVideoFamilies(), videoPath) +
    `</main>`
  );
}

function familyMeta(family: ImageFamilyPage | VideoFamilyPage): Meta {
  const path = family.kind === "image" ? imagePath(family.slug) : videoPath(family.slug);
  const url = `${PUBLIC_ORIGIN}${path}`;
  const what = family.kind === "image" ? "image" : "video";
  const title = `${family.name} AI ${what === "image" ? "Image" : "Video"} Models on Yumina`;
  const description = `Use ${list(family.models.map((m) => m.name))} from ${family.maker} in the Yumina Atelier to make ${what === "image" ? "pictures" : "video clips"} for an AI game or roleplay world. Sizes, inputs and prices for each model.`;
  return {
    title,
    description,
    url,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", "@id": url, url, name: title, description, isPartOf: { "@type": "WebSite", name: "Yumina", url: PUBLIC_ORIGIN }, about: { "@type": "Thing", name: `${family.name} (${family.maker})` } },
        breadcrumbLd([HOME, ATELIER, { name: `${family.name} ${what} models`, path }]),
      ],
    },
  };
}

// ── an art style ─────────────────────────────────────────────────────────────

export function renderStyle(style: AtelierStyle): string {
  const prompt = style.dialect === "prose"
    ? "Write the prompt as a plain sentence."
    : "Write the prompt as short tags separated by commas, for example: 1girl, school uniform, rain, night.";
  const variants = style.variants.length
    ? `<p>It comes in ${style.variants.length} versions: ${esc(list(style.variants.map((v) => `${v.name} (${count(v.price)} mushies)`)))}.</p>`
    : "";
  return (
    `<main class="pre pre-atelier-style">${breadcrumbHtml([ATELIER])}` +
    `<h1 class="pre-h1">${esc(style.name)} art style</h1>` +
    `<img class="pre-cover" src="${esc(style.image)}" alt="${esc(`A sample picture in the ${style.name} art style`)}" width="360" height="480" />` +
    `<div class="pre-text"><p>${esc(style.about)}</p><p>${esc(style.name)} is one of the built-in art styles in the Atelier. ${esc(prompt)}</p>` +
    `<p>One picture costs ${count(style.price)} mushies at the default size. A larger size${style.loras ? ", more steps or a LoRA" : " or more steps"} changes the price, and the Generate button shows it.</p>${variants}` +
    `<p>Art styles run on Yumina's own GPUs.${style.loras ? " You can add up to three LoRAs, for a character's face or a look of your own." : ""}</p></div>` +
    `<p class="pre-by"><a href="${esc(studioHref("image"))}">Open the picture studio</a></p>` +
    `<section class="pre-more"><h2 class="pre-h2">Other art styles</h2><ul class="pre-tags">${atelierStyles().filter((s) => s.slug !== style.slug).map((s) => `<li><a href="${esc(stylePath(s.slug))}">${esc(s.name)}</a></li>`).join("")}</ul></section>` +
    `</main>`
  );
}

function styleMeta(style: AtelierStyle): Meta {
  const path = stylePath(style.slug);
  const url = `${PUBLIC_ORIGIN}${path}`;
  const title = `${style.name} AI Art Style on Yumina`;
  const description = `${style.about} A built-in art style in the Yumina Atelier, ${count(style.price)} mushies a picture.`;
  const image = `${PUBLIC_ORIGIN}${style.image}`;
  return {
    title,
    description,
    url,
    image,
    imageAlt: `A sample picture in the ${style.name} art style`,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", "@id": url, url, name: title, description, primaryImageOfPage: { "@type": "ImageObject", url: image }, isPartOf: { "@type": "WebSite", name: "Yumina", url: PUBLIC_ORIGIN } },
        breadcrumbLd([HOME, ATELIER, { name: `${style.name} art style`, path }]),
      ],
    },
  };
}

// ── by path ──────────────────────────────────────────────────────────────────

export interface AtelierPage {
  meta: Meta;
  html: string;
}

/** The page at an /atelier address, or null when there is none. */
export function atelierPage(rawPath: string): AtelierPage | null {
  const path = rawPath.toLowerCase();
  if (path === ATELIER_PATH) return { meta: atelierMeta(), html: renderAtelier() };
  const match = /^\/atelier\/(image|video|styles)\/([a-z0-9-]+)$/.exec(path);
  if (!match) return null;
  if (match[1] === "image") {
    const family = atelierImageFamilies().find((f) => f.slug === match[2]);
    return family ? { meta: familyMeta(family), html: renderImageFamily(family) } : null;
  }
  if (match[1] === "video") {
    const family = atelierVideoFamilies().find((f) => f.slug === match[2]);
    return family ? { meta: familyMeta(family), html: renderVideoFamily(family) } : null;
  }
  const style = atelierStyles().find((s) => s.slug === match[2]);
  return style ? { meta: styleMeta(style), html: renderStyle(style) } : null;
}
