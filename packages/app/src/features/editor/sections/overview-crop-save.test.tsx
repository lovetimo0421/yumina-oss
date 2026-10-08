import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { create } from "zustand";
import { clientDom, loadClientModule } from "@/lib/feed-beacon.test-helpers";

for (const outcome of ["false", "throw"] as const) {
  test(`legacy crop save keeps the dialog and selection after ${outcome}, then closes on retry`, async () => {
    const env = clientDom();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: { galleryImages: [] } });
    const nextCrop = { x: 5, y: -10, zoom: 0.65, fit: "cover" };
    let succeed = false, batches = 0, commits = 0;
    let finishSave: (() => void) | undefined;
    const store = create(() => ({
      worldDraft: { name: "Crop fixture", avatar: "/portrait.webp", landscapeCover: "/wide.webp", settings: {} } as Record<string, unknown>,
      serverWorldId: "world", galleryImages: [], worldStatus: "draft", language: "en",
      setField: (key: string, value: unknown) => store.setState({ worldDraft: { ...store.getState().worldDraft, [key]: value } }),
      beginBatch: () => { batches++; }, commitBatch: () => { commits++; },
      setGalleryImages: () => {},
      saveDraft: async () => {
        await new Promise<void>(resolve => { finishSave = resolve; });
        if (!succeed && outcome === "throw") throw new Error("Network failed");
        return succeed;
      },
    }));
    let dialogProps: { saving?: boolean; error?: string; onSave: (value: unknown) => void } | undefined;
    const empty = () => null;
    const { OverviewSection } = loadClientModule<{ OverviewSection: ComponentType }>(new URL("./overview.tsx", import.meta.url), {
      "@/hooks/use-discover-access": { useDiscoverAccess: () => ({ enabled: false }) },
      "../components/discover-cover-fields": { DiscoverCoverFields: empty },
      "@/lib/world-templates": { isPlaceholderCardName: () => false },
      "@/components/world-cover-previews": { WorldCoverPreview: empty },
      "@/lib/auth-client": { useSession: () => ({ data: { user: { name: "Creator" } } }) },
      "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
      "@/features/library/world-update-history": { WorldUpdateHistory: empty },
      "@/lib/import-world": { parseImportedFile: empty },
      "@/lib/asset-upload": { uploadAssetWithPresignedUrl: empty, getAssetUploadErrorMessage: String },
      "@/stores/editor": { useEditorStore: store, adoptOwnWriteToken: empty },
      "../asset-picker": { AssetPicker: empty },
      "../components/voice-field": { VoiceField: empty },
      "../components/debounced-field": { DebouncedInput: empty, DebouncedTextarea: empty },
      "@/lib/import-summary": { worldImportCounts: empty },
      "@/components/ui/global-confirm-dialog": { confirmAction: empty },
      "@/components/ui/two-tap-delete-button": { TwoTapDeleteButton: empty },
      "../components/cover-crop-dialog": { CoverCropDialog: (props: NonNullable<typeof dialogProps>) => {
        dialogProps = props;
        return createElement("div", { "data-crop-dialog": true }, props.error,
          createElement("button", { disabled: props.saving, onClick: () => props.onSave({ coverCrop: nextCrop }) }, "Save crop"));
      } },
    });
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(env.dom.window.document.getElementById("root")!);
    const dialog = () => env.dom.window.document.querySelector("[data-crop-dialog]");
    try {
      await act(async () => root.render(createElement(OverviewSection)));
      await act(async () => env.dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="extra.crop.phone"]')!.click());
      assert.ok(dialog());
      await act(async () => dialog()!.querySelector("button")!.click());
      assert.ok(dialog(), "do not close while the save is pending");
      assert.equal(dialogProps?.saving, true);
      assert.equal(dialog()!.querySelector("button")!.disabled, true);
      await act(async () => finishSave!());
      assert.ok(dialog(), "a failed save must retain the crop editor");
      assert.equal(dialogProps?.error, "coverEditor:extra.crop.saveFailed");
      assert.deepEqual(store.getState().worldDraft.coverCrop, nextCrop);
      succeed = true;
      await act(async () => dialog()!.querySelector("button")!.click());
      assert.equal(dialogProps?.error, undefined, "retry clears the previous error");
      await act(async () => finishSave!());
      assert.equal(dialog(), null);
      assert.equal(batches, 2);
      assert.equal(commits, 2);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      env.restore();
    }
  });
}
