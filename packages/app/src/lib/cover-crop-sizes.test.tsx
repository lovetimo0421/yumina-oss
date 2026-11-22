import assert from "node:assert/strict";
import test from "node:test";
import { act, type ComponentType } from "react";
import { clientDom, loadClientModule } from "./feed-beacon.test-helpers";

// A cover wider than its 3:4 slot is drawn wider than the box, so `sizes`
// follows the image's aspect. Chrome reports the natural size scaled to
// `sizes` and rounded; that rounding must not re-derive `sizes` (a reload loop).
test("a rounding hair in the reported aspect does not change sizes", async () => {
  const env = clientDom({
    IntersectionObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => ({ ok: false }),
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  });
  env.dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 240, height: 320 }) as DOMRect;
  try {
    const assets = loadClientModule<Record<string, unknown>>(new URL("./asset-url.ts", import.meta.url));
    const { CroppedImage } = loadClientModule<{ CroppedImage: ComponentType<{ src: string; alt: string; width?: number }> }>(new URL("./cover-crop.tsx", import.meta.url), {
      "./asset-url": { ...assets, cardImageUrl: (_: string, w: number) => `https://cdn.example/w${w}.webp` },
      "./cropping": { defaultCropImageRenderer: { getImageStyle: ({ sourceAspect, targetAspect }: { sourceAspect: number | null; targetAspect: number | null }) =>
        ({ width: `${((sourceAspect ?? 0.75) / (targetAspect ?? 0.75)) * 100}%`, height: "100%" }) } },
      "./utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
    });
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(env.dom.window.document.getElementById("root")!);
    const source = "/cdn/key/" + Buffer.from("worlds/one/image/wide.webp").toString("base64url");
    await act(async () => root.render(<CroppedImage src={source} width={480} alt="Cover" />));
    const img = env.dom.window.document.querySelector("img")!;
    const load = async (w: number, h: number) => {
      Object.defineProperty(img, "naturalWidth", { configurable: true, value: w });
      Object.defineProperty(img, "naturalHeight", { configurable: true, value: h });
      await act(async () => img.dispatchEvent(new env.dom.window.Event("load")));
      return img.getAttribute("sizes");
    };
    const first = await load(480, 300);
    assert.equal(first, "512px");
    assert.equal(await load(512, 321), first);
    assert.equal(await load(511, 320), first);
    assert.notEqual(await load(480, 480), first, "a real aspect change still re-measures");
    await act(async () => root.unmount());
  } finally { env.restore(); }
});
