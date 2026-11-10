import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Film, X } from "lucide-react";
import { resolveImageUrl } from "@/lib/asset-url";
import { useEditorStore } from "@/stores/editor";
import { AssetPicker } from "../asset-picker";

type Clip = "idle" | "speaking";
type PortraitVideo = { idle?: string; speaking?: string };

/**
 * A character's moving portrait: an idle loop, and a clip that plays while
 * they are talking. Where chat can play video it replaces the still portrait;
 * custom frontends read both clips off the entry. Sits under the still
 * portrait field in every editor that has one.
 */
export function EntryPortraitVideoField({ value, onChange }: {
  value?: PortraitVideo;
  onChange: (next: PortraitVideo | undefined) => void;
}) {
  const { t } = useTranslation("editor");
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const [picking, setPicking] = useState<Clip | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (clip: Clip, ref: string | undefined) => {
    const next = { ...value, [clip]: ref };
    if (!ref) delete next[clip];
    onChange(next.idle || next.speaking ? next : undefined);
  };

  const open = async (clip: Clip) => {
    let id = serverWorldId;
    if (!id) { await saveDraft(); id = useEditorStore.getState().serverWorldId; }
    if (!id) { setError(t("simple.needWorldNameSaved")); return; }
    setError(null);
    setPicking(clip);
  };

  return (
    <div className="space-y-2" data-portrait-video>
      <label className="text-sm font-bold text-foreground">{t("entries.portraitVideo")}</label>
      <div className="flex gap-3">
        {(["idle", "speaking"] as const).map((clip) => {
          const ref = value?.[clip];
          return (
            <div key={clip} className="flex flex-col items-center gap-1">
              <div className="relative">
                <button type="button" onClick={() => void open(clip)} aria-label={t(`entries.portraitVideoClip.${clip}`)}
                  className={`flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border bg-card transition-colors ${ref ? "border-border hover:border-primary/50" : "border-dashed border-border hover:border-primary/40"}`}>
                  {ref
                    ? <video src={resolveImageUrl(ref)} autoPlay muted loop playsInline className="h-full w-full object-cover" />
                    : <Film className="h-5 w-5 text-muted-foreground/50" />}
                </button>
                {ref && (
                  <button type="button" onClick={() => set(clip, undefined)} aria-label={t("entries.portraitVideoRemove")}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <span className="text-[11px] text-muted-foreground">{t(`entries.portraitVideoClip.${clip}`)}</span>
            </div>
          );
        })}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {picking && serverWorldId && createPortal(
        <AssetPicker worldId={serverWorldId} filterType="video"
          onSelect={(ref) => { set(picking, ref); setPicking(null); }}
          onClose={() => setPicking(null)} />,
        document.body,
      )}
    </div>
  );
}
