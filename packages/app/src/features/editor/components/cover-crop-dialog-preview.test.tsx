import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, Fragment, type ComponentType, type ReactNode } from "react";
import { clientDom, loadClientModule } from "@/lib/feed-beacon.test-helpers";
import * as cropping from "@/lib/cover-crop";
import type { CoverCropSettings } from "@/lib/cover-crop";

const legacy: CoverCropSettings = { x: 0, y: -16, zoom: 0.75, fit: "cover" };
type Saved = { activeMode: string; coverCrop?: CoverCropSettings; landscapeCoverCrop?: CoverCropSettings };

async function mount(initialMode: "cover" | "gallery") {
  const env = clientDom();
  env.dom.window.scrollTo = () => {};
  const passthrough = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children);
  const { CoverCropDialog } = loadClientModule<{ CoverCropDialog: ComponentType<Record<string, unknown>> }>(new URL("./cover-crop-dialog-preview.tsx", import.meta.url), {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@radix-ui/react-dialog": { Root: passthrough, Portal: passthrough, Content: passthrough, Title: passthrough },
    "react-image-crop": { default: passthrough, __esModule: true },
    "react-image-crop/dist/ReactCrop.css": {},
    "@/lib/cover-crop": cropping,
    "@/lib/discover-world-artwork": { DISCOVER_COVER_ASPECTS: { cover: 2 / 3, gallery: 16 / 9 } },
    "@/lib/asset-url": { resolveImageUrl: (src: string) => src },
    "@/components/world-cover-previews": { WorldCoverPreviews: () => null },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const saves: Saved[] = [];
  await act(async () => root.render(createElement(CoverCropDialog, {
    src: "/portrait.jpg", landscapeSrc: "/portrait.jpg", initialMode,
    fallbackLandscapeCrop: legacy, onCancel() {}, onSave: (value: Saved) => saves.push(value),
  })));
  const image = env.dom.window.document.querySelector("img")!;
  Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 1800 } });
  await act(async () => image.dispatchEvent(new env.dom.window.Event("load")));
  return {
    saves,
    zoom: () => env.dom.window.document.querySelector<HTMLInputElement>("input[type=range]")!.value,
    click: async (key: string) => {
      const button = [...env.dom.window.document.querySelectorAll("button")].find(node => node.textContent === key)!;
      assert.ok(button); assert.equal(button.disabled, false);
      await act(async () => button.click());
    },
    cleanup: async () => { await act(async () => root.unmount()); env.restore(); },
  };
}

test("legacy wide framing opens unchanged and becomes confirmed when the wide crop is saved", async () => {
  const app = await mount("gallery");
  try {
    assert.equal(app.zoom(), "0.75");
    await app.click("extra.crop.save");
    assert.deepEqual(app.saves[0]?.landscapeCoverCrop, legacy);
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
    assert.deepEqual(app.saves[0]?.landscapeCoverCrop, { ...cropping.DEFAULT_COVER_CROP, fit: "cover" });
  } finally { await app.cleanup(); }
});
