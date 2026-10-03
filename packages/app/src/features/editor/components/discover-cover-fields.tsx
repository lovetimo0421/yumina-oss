import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Crop, FolderOpen, Loader2, Upload } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { useSession } from "@/lib/auth-client";
import { uploadAssetWithPresignedUrl, getAssetUploadErrorMessage } from "@/lib/asset-upload";
import { WorldCoverPreview } from "@/components/world-cover-previews";
import { CoverCropDialog } from "./cover-crop-dialog-preview";
import { AssetPicker } from "../asset-picker";
import type { CoverCropSettings } from "@/lib/cover-crop";

interface ConfirmedArtworkCrops { activeMode: "cover" | "gallery"; coverCrop?: CoverCropSettings; landscapeCoverCrop?: CoverCropSettings }

type Shape = "portrait" | "landscape";
const apiBase = import.meta.env.VITE_API_URL || "";

/** Author uploads remain ordinary world edits. Editorial crop staging lives in Admin → Manage. */
export function DiscoverCoverFields() {
  const { t } = useTranslation("coverEditor");
  const draft = useEditorStore(s => s.worldDraft);
  const worldId = useEditorStore(s => s.serverWorldId);
  const setField = useEditorStore(s => s.setField);
  const creator = useSession().data?.user;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [crop, setCrop] = useState<Shape | null>(null), [picker, setPicker] = useState<Shape | null>(null);
  const target = useRef<Shape>("portrait"), file = useRef<HTMLInputElement>(null);
  async function ensureWorld() {
    if (worldId) return worldId;
    if (!await useEditorStore.getState().saveDraft()) throw new Error(t("extra.crop.saveFailed"));
    const id = useEditorStore.getState().serverWorldId;
    if (!id) throw new Error(t("overview.saveWorldForCover"));
    return id;
  }
  async function upload(image: File) {
    const shape = target.current;
    setBusy(true); setError(null);
    try {
      const id = await ensureWorld();
      await uploadAssetWithPresignedUrl<{ thumbnailUrl: string }>({ file: image, preferredType: "image", resizeImageMaxDimension: 2048,
        prepareUrl: `${apiBase}/api/worlds/${id}/thumbnail`, registerUrl: `${apiBase}/api/worlds/${id}/thumbnail/confirm`, registerBody: ({key}) => ({key, target: shape}) });
      if (useEditorStore.getState().serverWorldId !== id) return;
      await useEditorStore.getState().refreshWorldSchema(false, { source: "cover-upload", target: shape });
      if (useEditorStore.getState().serverWorldId === id) setCrop(shape);
    } catch (cause) { setError(getAssetUploadErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function fromAsset(ref: string, shape: Shape) {
    const assetId = ref.match(/@asset:(.+)/)?.[1]; if (!assetId) return;
    setPicker(null); setBusy(true); setError(null);
    try {
      const id = await ensureWorld();
      const response = await fetch(`${apiBase}/api/worlds/${id}/thumbnail/from-asset`, { method: "POST", credentials: "include", headers: {"Content-Type":"application/json"}, body: JSON.stringify({assetId,target:shape}), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(t("overview.coverFromAssetFailed"));
      if (useEditorStore.getState().serverWorldId !== id) return;
      await useEditorStore.getState().refreshWorldSchema(false, { source: "cover-upload", target: shape });
      if (useEditorStore.getState().serverWorldId === id) setCrop(shape);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("overview.coverFromAssetFailed")); }
    finally { setBusy(false); }
  }
  async function saveCrop(value: ConfirmedArtworkCrops) {
    setBusy(true); setError(null);
    try {
      if (value.coverCrop) setField("coverCrop", value.coverCrop);
      if (value.landscapeCoverCrop) {
        if (!draft.landscapeCover && draft.avatar) setField("landscapeCover", draft.avatar);
        setField("landscapeCoverCrop", value.landscapeCoverCrop);
      }
      if (!await useEditorStore.getState().saveDraft()) throw new Error(t("extra.crop.saveFailed"));
      setCrop(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("overview.coverFromAssetFailed")); }
    finally { setBusy(false); }
  }
  return <section className="rounded-lg border border-border bg-background p-5">
    <h3 className="text-sm font-semibold">{t("overview.coverImage")}</h3>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("overview.coverImageDesc")}</p>
    <div className="mt-5 grid grid-cols-1 items-start gap-6 @min-[480px]:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)]">
      {(["portrait", "landscape"] as const).map(shape => {
        const src = shape === "portrait" ? draft.avatar : draft.landscapeCover || draft.avatar;
        const framing = shape === "portrait" ? draft.coverCrop : draft.landscapeCover ? draft.landscapeCoverCrop : draft.galleryCoverCrop;
        return <div key={shape} className="min-w-0 space-y-3">
          <p className="text-sm font-medium">{t(shape === "portrait" ? "extra.crop.phone" : "extra.crop.desktop")}</p>
          <WorldCoverPreview src={src} shape={shape} crop={framing} details={{title:draft.name,description:draft.description,creatorName:creator?.name,creatorImage:creator?.image}} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50" onClick={() => { target.current=shape; file.current?.click(); }}><Upload size={14}/>{t("overview.uploadCover")}</button>
            <button type="button" disabled={busy || !worldId} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50" onClick={() => setPicker(shape)}><FolderOpen size={14}/>{t("overview.fromAssets")}</button>
            {src && <button type="button" disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50" onClick={() => setCrop(shape)}><Crop size={14}/>{t("extra.crop.framing")}</button>}
          </div>
        </div>;
      })}
    </div>
    {busy && <Loader2 className="mt-3 h-4 w-4 animate-spin"/>}
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={event => { const image=event.currentTarget.files?.[0]; event.currentTarget.value=""; if (image) void upload(image); }}/>
    {picker && worldId && <AssetPicker worldId={worldId} filterType="image" onSelect={ref => void fromAsset(ref,picker)} onClose={() => setPicker(null)}/>}
    {crop && <CoverCropDialog src={draft.avatar} landscapeSrc={draft.landscapeCover || draft.avatar} initialMode={crop === "portrait" ? "cover" : "gallery"}
      initialCoverCrop={draft.coverCrop} initialLandscapeCrop={draft.landscapeCover ? draft.landscapeCoverCrop : undefined}
      fallbackLandscapeCrop={!draft.landscapeCover ? draft.galleryCoverCrop : undefined} saving={busy} error={error ?? undefined}
      details={{title:draft.name,description:draft.description,creatorName:creator?.name,creatorImage:creator?.image}}
      onSave={value => void saveCrop(value)} onCancel={() => { if (!busy) setCrop(null); }}/>}
  </section>;
}
