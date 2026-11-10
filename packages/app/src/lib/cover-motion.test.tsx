import assert from "node:assert/strict";
import test from "node:test";
import { act, type ComponentType } from "react";
import { clientDom, loadClientModule, settlePromises } from "./feed-beacon.test-helpers";

async function mount(kind: string, reduced = false, options: { normalized?: boolean; width?: number; motion?: boolean } = {}) {
  let visible: (entries: { isIntersecting: boolean }[]) => void = () => {};
  const env = clientDom({
    IntersectionObserver: class { constructor(callback: typeof visible) { visible = callback; } observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => ({ ok: true, json: async () => ({ kind }) }),
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  });
  env.dom.window.matchMedia = (() => ({ matches: reduced })) as unknown as typeof window.matchMedia;
  env.dom.window.HTMLMediaElement.prototype.play = async () => {};
  env.dom.window.HTMLMediaElement.prototype.pause = () => {};
  const assets = loadClientModule<Record<string, unknown>>(new URL("./asset-url.ts", import.meta.url));
  const { CroppedImage } = loadClientModule<{ CroppedImage: ComponentType<{ src: string; alt: string; width?: number; motion?: boolean }> }>(new URL("./cover-crop.tsx", import.meta.url), {
    "./asset-url": assets,
    "./cropping": { defaultCropImageRenderer: { getImageStyle: () => ({ width: "100%", height: "100%" }) } },
    "./utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const source = "/cdn/key/" + Buffer.from(options.normalized ? "worlds/one/thumbnail/cover.motion.anim.image" : "worlds/one/image/unmarked.webp").toString("base64url");
  await act(async () => root.render(<CroppedImage src={source} width={options.normalized ? options.width : 480} motion={options.motion} alt="Cover" />));
  return { document: env.dom.window.document, source, env,
    show: async (value: boolean) => { await act(async () => { visible([{ isIntersecting: value }]); await settlePromises(); }); },
    cleanup: async () => { await act(async () => root.unmount()); env.restore(); },
  };
}

test("normalized covers play without a resize width and retain their bounded poster on transform failure", async () => {
  const app = await mount("video", false, {normalized:true});
  try {
    await app.show(true);
    assert.ok(app.document.querySelector("video"));
    assert.equal(app.document.querySelectorAll("img").length,1);
  } finally { await app.cleanup(); }
  const resized = await mount("video", false, {normalized:true,width:480});
  try {
    await resized.show(true);
    const poster = resized.document.querySelector("img")!;
    await act(async () => poster.dispatchEvent(new resized.env.dom.window.Event("error")));
    assert.equal(new URL(poster.src).pathname,resized.source);
    assert.ok(resized.document.querySelector("video"));
  } finally { await resized.cleanup(); }
});

test("the crop dialog can keep motion paused without fetching the video", async () => {
  const app = await mount("video", false, {normalized:true,width:480,motion:false});
  try {
    await app.show(true);
    assert.equal(app.document.querySelector("video"),null);
  } finally { await app.cleanup(); }
});

test("unmarked animated covers start with a safe still, use video in view and release it offscreen", async () => {
  const app = await mount("video");
  try {
    const poster = app.document.querySelector("img")!;
    assert.match(poster.src, /anim=false/);
    assert.doesNotMatch(poster.src + poster.srcset, /onerror=redirect/);
    assert.equal(app.document.querySelector("video"), null);
    await app.show(true);
    const video = app.document.querySelector("video")!;
    assert.ok(video); assert.match(video.src, /cover-preview\.mp4$/);
    assert.equal(video.muted, true); assert.equal(video.loop, true);
    assert.equal(app.document.querySelectorAll("img").length, 1, "never append the giant animated original");
    await app.show(false);
    assert.equal(app.document.querySelector("video"), null);
  } finally { await app.cleanup(); }
});

test("an unavailable heavy animation or failed poster never falls back to the unchecked master", async () => {
  const app = await mount("still");
  try {
    await app.show(true);
    const poster = app.document.querySelector("img")!;
    await act(async () => poster.dispatchEvent(new app.env.dom.window.Event("error")));
    assert.match(poster.src, /anim=false/);
    assert.equal(app.document.querySelectorAll("img").length, 1);
    assert.equal(app.document.querySelector("video"), null);
  } finally { await app.cleanup(); }
});

test("proven static covers retain the existing original fallback when image resizing is unavailable", async () => {
  const app = await mount("static");
  try {
    await app.show(true);
    const poster = app.document.querySelector("img")!;
    await act(async () => poster.dispatchEvent(new app.env.dom.window.Event("error")));
    assert.equal(poster.getAttribute("src"), app.source);
    assert.equal(app.document.querySelector("video"), null);
  } finally { await app.cleanup(); }
});

test("reduced-motion preference leaves the poster visible without starting animation", async () => {
  const app = await mount("video", true);
  try {
    await app.show(true);
    assert.equal(app.document.querySelector("video"), null);
    assert.equal(app.document.querySelectorAll("img").length, 1);
  } finally { await app.cleanup(); }
});
