import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type ComponentType, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule } from "../../../lib/feed-beacon.test-helpers";
import * as cropping from "../../../lib/cropping";
import * as artwork from "../../../lib/world-cover-crop";

test("crop tabs preserve loaded dimensions, require a loaded image, and confirm only visited artwork", async () => {
  const env = clientDom();
  env.dom.window.scrollTo = () => {};
  const panel = ({ children }: PropsWithChildren) => createElement("div", null, children);
  const { CoverCropDialog } = loadClientModule<{ CoverCropDialog: ComponentType<Record<string, unknown>> }>(new URL("./cover-crop-dialog.tsx", import.meta.url), {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@radix-ui/react-dialog": { Root: panel, Portal: panel, Content: panel, Title: panel },
    "react-image-crop": panel, "react-image-crop/dist/ReactCrop.css": {},
    "@/lib/cover-crop": cropping, "@/lib/world-cover-crop": artwork,
    "@/lib/asset-url": { resolveImageUrl: (src: string) => src },
    "@/components/world-cover-previews": { WorldCoverPreviews: () => null },
  });
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const saves: Array<{ activeMode: string; coverCrop?: cropping.CoverCropSettings; landscapeCoverCrop?: cropping.CoverCropSettings }> = [];
  const button = (key: string) => Array.from(env.dom.window.document.querySelectorAll("button")).find(node => node.textContent === key)!;
  const loadImage = async (width: number, height: number) => {
    const image = env.dom.window.document.querySelector("img")!;
    Object.defineProperties(image, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } });
    await act(async () => image.dispatchEvent(new env.dom.window.Event("load")));
  };
  try {
    await act(async () => root.render(createElement(CoverCropDialog, { src: "/portrait.jpg", landscapeSrc: "/wide.jpg", onCancel: () => {}, onSave: (value: (typeof saves)[number]) => saves.push(value) })));
    assert.equal(button("extra.crop.save").disabled, true, "loading cannot confirm a crop");
    await loadImage(1000, 1500);
    assert.equal(button("extra.crop.save").disabled, false);
    await act(async () => button("extra.crop.phone").click());
    assert.equal(button("extra.crop.save").disabled, false, "active tab must not wait for an image load that will never occur");
    await act(async () => button("extra.crop.save").click());
    assert.equal(saves[0]?.activeMode, "cover");
    assert.equal(saves[0]?.landscapeCoverCrop, undefined, "untouched wide crop remains unconfirmed");
    await act(async () => button("extra.crop.desktop").click());
    assert.equal(button("extra.crop.save").disabled, true);
    await loadImage(1600, 900);
    await act(async () => button("extra.crop.desktop").click());
    assert.equal(button("extra.crop.save").disabled, false);
    await act(async () => button("extra.crop.save").click());
    assert.equal(saves[1]?.activeMode, "gallery");
    assert.equal(saves[1]?.landscapeCoverCrop?.fit, "cover");
    await act(async () => env.dom.window.document.querySelector("img")!.dispatchEvent(new env.dom.window.Event("error")));
    assert.equal(button("extra.crop.save").disabled, true, "broken image cannot be confirmed");
  } finally { await act(async () => root.unmount()); env.restore(); }
});
