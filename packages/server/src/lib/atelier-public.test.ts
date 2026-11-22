import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PLATFORM_STYLES,
  SMART_IMAGE_FAMILIES,
  SMART_IMAGE_FAMILY_INFO,
  SMART_IMAGE_MODELS,
  VIDEO_FAMILIES,
  VIDEO_MODELS,
  mediaTool,
  mediaToolMushies,
  platformStylePrice,
} from "@yumina/shared";
import { edition } from "../edition/index.js";
import {
  ATELIER_APP_PATH,
  ATELIER_TITLE,
  STYLE_NAMES,
  STYLE_VARIANT_NAMES,
  atelierFaq,
  atelierImageFamilies,
  atelierMeta,
  atelierPage,
  atelierPaths,
  atelierStyles,
  atelierVideoFamilies,
  model3dPrice,
  renderAtelier,
} from "./atelier-public.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { renderPublicContent } from "./prerender.js";
import { PRICING_PATH } from "./pricing-public.js";
import { generateSitemaps, getMetaForPath } from "./seo.js";

const NO_ATELIER = edition.info().features.imageGeneration ? false : "this edition has no Atelier";
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "../../../app");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

test("every image and video model family the app offers has a page listing all its models", () => {
  const images = atelierImageFamilies();
  assert.equal(images.length, SMART_IMAGE_FAMILIES.length);
  assert.deepEqual(images.flatMap((f) => f.models.map((m) => m.name)).sort(), SMART_IMAGE_MODELS.map((m) => m.name).sort());
  for (const family of images) {
    const page = atelierPage(`/atelier/image/${family.slug}`)!;
    assert.ok(page, family.slug);
    assert.match(page.html, new RegExp(`<h1 class="pre-h1">${escape(family.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} image models</h1>`));
    for (const model of family.models) assert.ok(page.html.includes(`<th scope="row">${escape(model.name)}</th>`), model.name);
    assert.ok(page.html.includes(`href="${ATELIER_APP_PATH}?view=image"`), "a link into the picture studio");
    assert.equal(page.meta.url, `${PUBLIC_ORIGIN}/atelier/image/${family.slug}`);
  }
  assert.equal(atelierImageFamilies().find((f) => f.name === SMART_IMAGE_FAMILY_INFO.nanoBanana.name)!.slug, "nano-banana");

  const videos = atelierVideoFamilies();
  assert.deepEqual(videos.flatMap((f) => f.models.map((m) => m.name)).sort(), VIDEO_MODELS.map((m) => m.name).sort());
  assert.ok(videos.length <= VIDEO_FAMILIES.length, "a family with no model has no page");
  for (const family of videos) {
    const page = atelierPage(`/atelier/video/${family.slug}`)!;
    for (const model of family.models) {
      assert.ok(page.html.includes(`<th scope="row">${escape(model.name)}</th>`), model.name);
      assert.ok(model.price > 0, `${model.name} has a price`);
    }
    assert.ok(page.html.includes(`href="${ATELIER_APP_PATH}?view=video"`));
  }
});

test("art styles: one page per built-in style, named as the app names it, priced as the app prices it, with its sample picture", () => {
  const styles = atelierStyles();
  assert.deepEqual(styles.map((s) => s.slug), ["anime", "realistic", "semireal", "guofeng", "western"]);
  for (const style of styles) {
    assert.equal(style.price, platformStylePrice(style.slug, "portrait"), style.slug);
    const page = atelierPage(`/atelier/styles/${style.slug}`)!;
    assert.match(page.html, new RegExp(`<h1 class="pre-h1">${style.name.replace(".", "\\.")} art style</h1><img class="pre-cover" src="/workbench/styles/${style.slug}\\.webp" alt="A sample picture in the ${style.name.replace(".", "\\.")} art style"`));
    assert.ok(page.html.includes(`One picture costs ${style.price} mushies`));
    assert.equal(page.meta.image, `${PUBLIC_ORIGIN}/workbench/styles/${style.slug}.webp`);
  }
  // LoRAs are promised only on the styles that take them.
  const realistic = styles.find((s) => s.slug === "realistic")!;
  assert.equal(realistic.loras, false);
  assert.doesNotMatch(atelierPage("/atelier/styles/realistic")!.html, /LoRA/);
  assert.match(atelierPage("/atelier/styles/anime")!.html, /up to three LoRAs/);
  // A version offered only when the server lists it is not promised.
  assert.deepEqual(styles.find((s) => s.slug === "anime")!.variants.map((v) => v.name), ["Classic", "New"]);
});

test("the style names are the app's own English strings and the sample pictures are shipped files", { skip: fs.existsSync(path.join(appDir, "src/locales/en/library.json")) ? false : "no app locale files here" }, () => {
  const locale = JSON.parse(fs.readFileSync(path.join(appDir, "src/locales/en/library.json"), "utf8"));
  const find = (node: unknown): Record<string, any> | null => {
    if (!node || typeof node !== "object") return null;
    const obj = node as Record<string, any>;
    if (obj.anime?.name && obj.guofeng?.name) return obj;
    for (const value of Object.values(obj)) {
      const hit = find(value);
      if (hit) return hit;
    }
    return null;
  };
  const names = find(locale)!;
  assert.ok(names, "the style strings were found");
  for (const [slug, name] of Object.entries(STYLE_NAMES)) assert.equal(name, names[slug].name, slug);
  for (const [slug, name] of Object.entries(STYLE_VARIANT_NAMES)) assert.equal(name, names[slug].variant, slug);
  for (const style of atelierStyles()) assert.ok(fs.existsSync(path.join(appDir, "public", style.image)), style.image);
});

test("nothing for adult content has a page or is named on one", () => {
  const adult = PLATFORM_STYLES.filter((s) => /nsfw/i.test(s.slug));
  assert.ok(adult.length > 0, "the app does have such styles");
  for (const style of adult) assert.equal(atelierPage(`/atelier/styles/${style.slug}`), null, style.slug);
  for (const p of atelierPaths()) assert.doesNotMatch(atelierPage(p)!.html + JSON.stringify(atelierPage(p)!.meta), /nsfw|limitless|explicit/i, p);
});

test("the introduction says what you can make, the models, the steps, the prices, and links into the tool", () => {
  const html = renderAtelier();
  assert.match(html, /^<main class="pre pre-atelier"><h1 class="pre-h1">Atelier: AI image, video and 3D generator<\/h1>/);
  assert.ok(html.includes(`<a href="${ATELIER_APP_PATH}">Open the Atelier</a>`));
  for (const view of ["image", "video", "audio", "3d", "lora"]) assert.ok(html.includes(`href="${ATELIER_APP_PATH}?view=${view}"`), view);
  for (const family of atelierImageFamilies()) assert.ok(html.includes(`<a href="/atelier/image/${family.slug}">${escape(family.name)}</a>`), family.name);
  for (const family of atelierVideoFamilies()) assert.ok(html.includes(`<a href="/atelier/video/${family.slug}">${escape(family.name)}</a>`), family.name);
  for (const style of atelierStyles()) assert.ok(html.includes(`<a class="pre-card" href="/atelier/styles/${style.slug}">`), style.name);
  const steps = /<h2 class="pre-h2">How to make a picture<\/h2><ol class="pre-list">(.*?)<\/ol>/.exec(html)![1]!;
  assert.equal(steps.split("<li>").length - 1, 4);
  // Prices are the ones the code computes.
  assert.equal(model3dPrice(), mediaToolMushies(mediaTool("to-3d")!, 1));
  assert.ok(html.includes(`A 3D model from the default generator: ${model3dPrice()} mushies.`));
  assert.ok(html.includes(`A picture in the Anime style: ${platformStylePrice("anime", "portrait")} mushies.`));
  assert.ok(html.includes(`<a href="/pricing">Plans and packs</a>`));
  assert.doesNotMatch(html, /—/, "no em dashes");
});

test("the introduction's questions are visible and mirrored in FAQPage; it carries SoftwareApplication and BreadcrumbList", () => {
  const faq = atelierFaq();
  assert.ok(faq.length >= 5 && faq.length <= 8, String(faq.length));
  const html = renderAtelier();
  const meta = atelierMeta();
  assert.equal(meta.title, ATELIER_TITLE);
  assert.equal(meta.url, `${PUBLIC_ORIGIN}/atelier`);
  const graph = (meta.jsonLd as { "@graph": Array<Record<string, any>> })["@graph"];
  const page = graph.find((n) => n["@type"] === "FAQPage")!;
  for (const [i, item] of faq.entries()) {
    assert.equal(page.mainEntity[i].name, item.q);
    assert.equal(page.mainEntity[i].acceptedAnswer.text, item.a);
    assert.ok(html.includes(`<dt>${escape(item.q)}</dt><dd>${escape(item.a)}</dd>`), item.q);
  }
  const app = graph.find((n) => n["@type"] === "SoftwareApplication")!;
  assert.equal(app.url, `${PUBLIC_ORIGIN}/atelier`);
  assert.equal(app.operatingSystem, "Web browser");
  const crumbs = graph.find((n) => n["@type"] === "BreadcrumbList")!;
  assert.deepEqual(crumbs.itemListElement.map((i: any) => [i.name, i.item]), [["Yumina", PUBLIC_ORIGIN], ["Atelier", `${PUBLIC_ORIGIN}/atelier`]]);
  // Every sub-page has its breadcrumb too.
  for (const p of atelierPaths().slice(1)) {
    const sub = (atelierPage(p)!.meta.jsonLd as { "@graph": Array<Record<string, any>> })["@graph"];
    assert.equal(sub.find((n) => n["@type"] === "BreadcrumbList")!.itemListElement.length, 3, p);
  }
});

test("/atelier and its pages are indexable; the tool's own address points at /atelier; unknown ones are 404", { skip: NO_ATELIER }, async () => {
  for (const p of atelierPaths()) {
    const meta = await getMetaForPath(p);
    assert.equal(meta.status, undefined, p);
    assert.equal(meta.noindex, undefined, p);
    assert.equal(meta.url, `${PUBLIC_ORIGIN}${p}`, p);
  }
  assert.equal(await renderPublicContent("/atelier"), renderAtelier());
  assert.equal((await getMetaForPath("/Atelier/Image/Seedream")).url, `${PUBLIC_ORIGIN}/atelier/image/seedream`, "any casing is the one address");
  const tool = await getMetaForPath(ATELIER_APP_PATH);
  assert.equal(tool.title, "Atelier");
  assert.equal(tool.url, `${PUBLIC_ORIGIN}/atelier`);
  for (const missing of ["/atelier/image/no-such-model", "/atelier/video/no-such-model", "/atelier/styles/nsfw-anime", "/atelier/styles", "/atelier/audio/x", "/atelier/image/seedream/extra"]) {
    assert.equal((await getMetaForPath(missing)).status, 404, missing);
    assert.equal(await renderPublicContent(missing), null, missing);
  }
});

test("the pages sitemap lists /pricing, /atelier and every model and style page", { skip: NO_ATELIER }, async () => {
  const pages = (await generateSitemaps()).children.get("sitemap-pages.xml")!;
  for (const p of [PRICING_PATH, ...atelierPaths()]) assert.ok(pages.includes(`<loc>${PUBLIC_ORIGIN}${p}</loc>`), p);
  assert.ok(!pages.includes(`${PUBLIC_ORIGIN}/app/plans`) && !pages.includes(`${PUBLIC_ORIGIN}/app/generate`), "the signed-in and tool addresses are not listed");
});
