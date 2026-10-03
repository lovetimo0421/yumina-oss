import { useEditorStore } from "@/stores/editor";
import { useAssetStore } from "@/stores/assets";

export interface SceneImageUploadOptions {
  files: FileList | File[];
  /** The image the first file fills when it has no picture yet. */
  selectedId?: string | null;
  onProgress?: (done: number, total: number) => void;
  onFailed?: (fileName: string) => void;
}

/**
 * Local files straight into the world's asset library, then into the scene
 * image list. The first file fills the selected image if that one has no
 * picture yet; every other file becomes a new scene image named after it.
 * Resolves to the id of the last image touched.
 */
export async function uploadSceneImageFiles(opts: SceneImageUploadOptions): Promise<string | null> {
  const list = [...opts.files].filter((f) => f.type.startsWith("image/"));
  if (list.length === 0) return null;

  const store = useEditorStore.getState;
  let worldId = store().serverWorldId;
  if (!worldId) {
    await store().saveDraft();
    worldId = store().serverWorldId;
  }
  if (!worldId) return null;

  const uploadAsset = useAssetStore.getState().uploadAsset;
  const selected = (store().worldDraft.sceneImages ?? []).find((img) => img.id === opts.selectedId);
  let fillSelected = Boolean(selected && !selected.url);
  let targetId: string | null = selected?.id ?? null;

  opts.onProgress?.(0, list.length);
  for (const [i, file] of list.entries()) {
    const asset = await uploadAsset(worldId, file, "image");
    if (!asset) {
      opts.onFailed?.(file.name);
      continue;
    }
    const stem = file.name.replace(/\.[^.]+$/, "");
    if (fillSelected && targetId) {
      store().updateSceneImage(targetId, { url: `@asset:${asset.id}`, ...(selected?.name ? {} : { name: stem }) });
      fillSelected = false;
    } else {
      store().addSceneImage();
      const draft = store().worldDraft.sceneImages ?? [];
      const created = draft[draft.length - 1];
      if (created) {
        store().updateSceneImage(created.id, { url: `@asset:${asset.id}`, name: stem });
        targetId = created.id;
      }
    }
    opts.onProgress?.(i + 1, list.length);
  }
  return targetId;
}
