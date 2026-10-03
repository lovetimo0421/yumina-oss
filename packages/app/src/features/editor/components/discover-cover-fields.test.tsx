import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { create } from "zustand";
import { clientDom, loadClientModule } from "@/lib/feed-beacon.test-helpers";

for (const shape of ["portrait", "landscape"] as const) {
  for (const method of ["upload", "asset"] as const) {
    for (const replacedInAnotherTab of [false, true]) {
    test(`${shape} ${method} synchronizes before crop save (newer upload: ${replacedInAnotherTab})`, async () => {
      const env = clientDom();
      const originalFetch = globalThis.fetch;
      let serverRevision = 1;
      let editorRevision = 1;
      let saved = false;
      const currentImage = replacedInAnotherTab ? "/newer.jpg" : "/new.jpg";
      const draft: Record<string, unknown> = { avatar: "/old.jpg", name: "Krew", description: "Keep local edits" };
      const store = create(() => ({
        worldDraft: draft, serverWorldId: "world",
        setField: (key: string, value: unknown) => store.setState({ worldDraft: { ...store.getState().worldDraft, [key]: value } }),
        refreshWorldSchema: async (_force: boolean, options: { source: string }) => {
          assert.equal(options.source, "cover-upload");
          editorRevision = serverRevision;
          store.getState().setField(shape === "portrait" ? "avatar" : "landscapeCover", currentImage);
        },
        saveDraft: async () => { saved = editorRevision === serverRevision; return saved; },
      }));
      const uploaded = () => { serverRevision++; return { thumbnailUrl: "/new.jpg" }; };
      globalThis.fetch = async () => Response.json({ data: uploaded() });
      const { DiscoverCoverFields } = loadClientModule<{ DiscoverCoverFields: ComponentType }>(new URL("./discover-cover-fields.tsx", import.meta.url), {
        "@/stores/editor": { useEditorStore: store },
        "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
        "@/lib/auth-client": { useSession: () => ({ data: { user: { name: "Lovetimo" } } }) },
        "@/lib/asset-upload": { uploadAssetWithPresignedUrl: async () => uploaded(), getAssetUploadErrorMessage: String },
        "@/components/world-cover-previews": { WorldCoverPreview: () => null },
        "../asset-picker": { AssetPicker: ({ onSelect }: { onSelect: (ref: string) => void }) => createElement("button", { onClick: () => onSelect("@asset:chosen") }, "Choose asset") },
        "./cover-crop-dialog-preview": { CoverCropDialog: ({ onSave, error }: { onSave: (value: unknown) => void; error?: string }) => createElement("div", {}, error, createElement("button", { onClick: () => onSave({ activeMode: shape === "portrait" ? "cover" : "gallery", [shape === "portrait" ? "coverCrop" : "landscapeCoverCrop"]: { x: 0, y: 0, zoom: 1, fit: "cover" } }) }, "Save crop")) },
      });
      const { createRoot } = await import("react-dom/client");
      const root = createRoot(env.dom.window.document.getElementById("root")!);
      const buttons = (text: string) => [...env.dom.window.document.querySelectorAll("button")].filter(button => button.textContent === text);
      try {
        await act(async () => root.render(createElement(DiscoverCoverFields)));
        const index = shape === "portrait" ? 0 : 1;
        await act(async () => buttons(method === "upload" ? "overview.uploadCover" : "overview.fromAssets")[index]!.click());
        if (method === "upload") {
          const input = env.dom.window.document.querySelector<HTMLInputElement>("input[type=file]")!;
          Object.defineProperty(input, "files", { value: [new env.dom.window.File(["image"], "cover.png", { type: "image/png" })] });
          await act(async () => input.dispatchEvent(new env.dom.window.Event("change", { bubbles: true })));
        } else {
          await act(async () => buttons("Choose asset")[0]!.click());
        }
        assert.equal(store.getState().worldDraft[shape === "portrait" ? "avatar" : "landscapeCover"], currentImage, "crop the authoritative image, never the stale upload response");
        await act(async () => buttons("Save crop")[0]!.click());
        assert.equal(saved, true, "the crop must not conflict with its own upload");
        assert.equal(buttons("Save crop").length, 0, "successful save closes the dialog");
        assert.equal(store.getState().worldDraft.description, "Keep local edits");
      } finally {
        await act(async () => root.unmount());
        globalThis.fetch = originalFetch;
        env.restore();
      }
    });
    }
  }
}
