import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, Fragment, type ComponentType, type ReactNode } from "react";
import { clientDom, loadClientModule } from "@/lib/feed-beacon.test-helpers";
import * as cropping from "@/lib/cover-crop";
import type { CoverCropSettings } from "@/lib/cover-crop";
import { isMotionCoverRef } from "@/lib/asset-url";
import ReactCrop, { type PercentCrop } from "react-image-crop";

const legacy: CoverCropSettings = { x: 0, y: -16, zoom: 0.75, fit: "cover" };
type Saved = { activeMode: string; coverCrop?: CoverCropSettings; landscapeCoverCrop?: CoverCropSettings };

async function mount(initialMode: "cover" | "gallery", src = "/portrait.jpg", initialLandscapeCrop?: CoverCropSettings, file = "./cover-crop-dialog-preview.tsx") {
  const env = clientDom({ ResizeObserver: class { observe() {} disconnect() {} } });
  env.dom.window.scrollTo = () => {};
  let selection: { crop: PercentCrop; aspect: number; onChange: (pixels: unknown, percent: PercentCrop) => void };
  let preview: { landscapeCoverCrop?: CoverCropSettings };
  const passthrough = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children);
  const { CoverCropDialog } = loadClientModule<{ CoverCropDialog: ComponentType<Record<string, unknown>> }>(new URL(file, import.meta.url), {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key.replace("coverEditor:", "") }) },
    "@radix-ui/react-dialog": { Root: passthrough, Portal: passthrough, Content: passthrough, Title: passthrough },
    "react-image-crop": { default: (props: typeof selection & { children?: ReactNode }) => { selection = props; return passthrough(props); }, __esModule: true },
    "react-image-crop/dist/ReactCrop.css": {},
    "@/lib/cover-crop": cropping,
    "@/lib/discover-world-artwork": { DISCOVER_COVER_ASPECTS: { cover: 2 / 3, gallery: 16 / 9 } },
    "@/lib/asset-url": { resolveImageUrl: (src: string) => src, isMotionCoverRef },
    "@/components/world-cover-previews": { WorldCoverPreviews: (props: typeof preview) => { preview = props; return null; } },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const saves: Saved[] = [];
  await act(async () => root.render(createElement(CoverCropDialog, {
    src, landscapeSrc: "/portrait.jpg", initialMode, initialLandscapeCrop,
    fallbackLandscapeCrop: legacy, onCancel() {}, onSave: (value: Saved) => saves.push(value),
  })));
  const image = env.dom.window.document.querySelector("img")!;
  Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 1800 } });
  await act(async () => image.dispatchEvent(new env.dom.window.Event("load")));
  if (initialMode === "gallery") {
    const mobile = [...env.dom.window.document.querySelectorAll("button")].find(node => node.textContent === "extra.crop.galleryMobile")!;
    await act(async () => mobile.click());
  }
  return {
    saves,
    selection: () => selection,
    preview: () => preview,
    drag: async (crop: PercentCrop) => { await act(async () => selection.onChange({}, crop)); },
    video: () => env.dom.window.document.querySelector("video"),
    zoom: () => env.dom.window.document.querySelector<HTMLInputElement>("input[type=range]")!.value,
    click: async (key: string) => {
      const button = [...env.dom.window.document.querySelectorAll("button")].find(node => node.textContent === key)!;
      assert.ok(button); assert.equal(button.disabled, false);
      await act(async () => button.click());
    },
    cleanup: async () => { await act(async () => root.unmount()); env.restore(); },
  };
}

test("managed motion starts paused, plays on request, and stops on pause or source change", async () => {
  const src = `/cdn/key/${Buffer.from("worlds/one/thumbnail/cover.motion.anim.image").toString("base64url")}`;
  const app = await mount("cover", src);
  try {
    assert.equal(app.video(), null);
    await app.click("motion.play");
    assert.equal(new URL(app.video()!.src).pathname, `${src}/cover-preview.mp4`);
    assert.equal(app.video()!.muted, true);
    assert.equal(app.video()!.loop, true);
    await app.click("motion.pause");
    assert.equal(app.video(), null);
    await app.click("motion.play");
    await app.click("extra.crop.desktop");
    assert.equal(app.video(), null, "switching to a still source removes the clip");
  } finally { await app.cleanup(); }
});

test("legacy wide framing opens unchanged and becomes confirmed when the wide crop is saved", async () => {
  const app = await mount("gallery");
  try {
    assert.equal(app.zoom(), "0.75");
    await app.click("extra.crop.save");
    assert.deepEqual(app.saves[0]?.landscapeCoverCrop, { ...legacy, desktop: { ...legacy, aspect: 21 / 9 } });
    assert.equal(app.saves[0]?.coverCrop, undefined);
  } finally { await app.cleanup(); }
});

test("saving the portrait does not confirm an untouched legacy landscape fallback", async () => {
  const app = await mount("cover");
  try {
    await app.click("extra.crop.save");
    assert.ok(app.saves[0]?.coverCrop);
    assert.equal(app.saves[0]?.landscapeCoverCrop, undefined);
  } finally { await app.cleanup(); }
});

test("resetting legacy landscape framing deliberately replaces the fallback", async () => {
  const app = await mount("gallery");
  try {
    await app.click("extra.crop.reset");
    assert.equal(app.zoom(), "1");
    await app.click("extra.crop.save");
    assert.deepEqual(app.saves[0]?.landscapeCoverCrop, { ...cropping.DEFAULT_COVER_CROP, fit: "cover", desktop: { ...legacy, aspect: 21 / 9 } });
  } finally { await app.cleanup(); }
});

test("dragging a gallery selection saves the same region shown in the crop box and preview", async () => {
  const app = await mount("gallery");
  try {
    const selected: PercentCrop = { unit: "%", x: 32, y: 9, width: 60, height: 22.5 };
    await app.drag(selected);
    assert.equal(app.selection().aspect, 16 / 9);
    for (const key of ["x", "y", "width", "height"] as const) {
      assert.ok(Math.abs(app.selection().crop[key] - selected[key]) < 1e-8);
    }
    await app.click("extra.crop.save");
    const saved = JSON.parse(JSON.stringify(app.saves[0]!.landscapeCoverCrop!));
    assert.deepEqual(app.preview().landscapeCoverCrop, saved);
    const rect = cropping.getCoverCropRect(saved, 1200 / 1800, 16 / 9);
    for (const [actual, expected] of [[rect.left, selected.x], [rect.top, selected.y], [rect.width, selected.width], [rect.height, selected.height]]) {
      assert.ok(Math.abs(actual - expected) < 1e-8);
    }
  } finally { await app.cleanup(); }
});

for (const file of ["./cover-crop-dialog-preview.tsx", "./cover-crop-dialog.tsx"]) {
  test(`${file}: desktop and mobile can be edited independently, saved together, and reopened`, async () => {
    const app = await mount("gallery", "/portrait.jpg", legacy, file);
    let saved: CoverCropSettings;
    try {
      await app.drag({ unit: "%", x: 32, y: 9, width: 60, height: 22.5 });
      await app.click("extra.crop.galleryDesktop");
      assert.equal(app.selection().aspect, 21 / 9);
      const desktopSelection: PercentCrop = { unit: "%", x: 10, y: 55, width: 70, height: 70 * (2 / 3) / (21 / 9) };
      await app.drag(desktopSelection);
      await app.click("extra.crop.save");
      saved = JSON.parse(JSON.stringify(app.saves[0]!.landscapeCoverCrop!));
      assert.equal(saved.desktop!.aspect, 21 / 9, "the banner crop is saved with the shape it was framed in");
      const rect = cropping.getCoverCropRect(saved.desktop!, 2 / 3, 21 / 9);
      assert.ok(Math.abs(rect.left - 10) < 1e-8);
      assert.ok(Math.abs(rect.top - 55) < 1e-8);
      assert.deepEqual(app.preview().landscapeCoverCrop, saved);
      await app.click("extra.crop.galleryMobile");
      assert.ok(Math.abs(app.selection().crop.x - 32) < 1e-8);
      assert.ok(Math.abs(app.selection().crop.y - 9) < 1e-8);
      await app.click("extra.crop.reset");
      await app.click("extra.crop.save");
      assert.deepEqual(app.saves[1]!.landscapeCoverCrop!.desktop, saved.desktop);
    } finally { await app.cleanup(); }
    const reopened = await mount("gallery", "/portrait.jpg", saved!, file);
    try {
      assert.ok(Math.abs(reopened.selection().crop.x - 32) < 1e-8);
      await reopened.click("extra.crop.galleryDesktop");
      assert.ok(Math.abs(reopened.selection().crop.x - 10) < 1e-8);
      assert.ok(Math.abs(reopened.selection().crop.y - 55) < 1e-8);
    } finally { await reopened.cleanup(); }
  });
}


for (const file of ["./cover-crop-dialog-preview.tsx", "./cover-crop-dialog.tsx"]) {
  test(`${file}: dragging past top or bottom stays inside the image in both gallery frames`, async () => {
    const app = await mount("gallery", "/portrait.jpg", legacy, file);
    try {
      for (const device of ["Mobile", "Desktop"]) {
        await app.click(`extra.crop.gallery${device}`);
        for (const y of [-100, 200]) {
          await app.drag({ unit: "%", x: 20, y, width: 60, height: 60 * (2 / 3) / app.selection().aspect });
          const rect = app.selection().crop;
          assert.ok(rect.y >= 0);
          assert.ok(rect.y + rect.height <= 100 + 1e-8);
          assert.ok(Math.abs(y < 0 ? rect.y : rect.y + rect.height - 100) < 1e-8);
          await app.click("extra.crop.save");
          const saved = app.saves.at(-1)!.landscapeCoverCrop!;
          const rendered = cropping.getCoverCropRect(device === "Desktop" ? saved.desktop! : saved, 2 / 3, app.selection().aspect);
          assert.ok(Math.abs(rendered.top - rect.y) < 1e-8);
          assert.ok(Math.abs(rendered.height - rect.height) < 1e-8);
        }
      }
    } finally { await app.cleanup(); }
  });
}


test("the real cropper measures the image directly for both still and motion covers", async () => {
  const env = clientDom();
  const { CoverCropMedia } = loadClientModule<{ CoverCropMedia: ComponentType<Record<string, unknown>> }>(new URL("./cover-crop-media.tsx", import.meta.url), {
    "@/lib/asset-url": { coverPreviewUrl: () => "/cover-preview" },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  try {
    for (const playing of [false, true]) {
      await act(async () => root.render(createElement(ReactCrop, {
        crop: { unit: "%", x: 0, y: 0, width: 100, height: 25 }, onChange() {},
      }, createElement(CoverCropMedia, { src: "/cover.jpg", playing, className: "block h-auto w-full select-none touch-none" }))));
      const wrapper = env.dom.window.document.querySelector(".ReactCrop__child-wrapper")!;
      assert.equal(wrapper.firstElementChild?.tagName, "IMG", "cropper sizing and touch rules must target the image, not a separate layout box");
      const video = wrapper.querySelector("video");
      assert.equal(!!video, playing);
      if (video) assert.ok(video.classList.contains("absolute"), "motion must not add a second flow box");
    }
  } finally { await act(async () => root.unmount()); env.restore(); }
});
