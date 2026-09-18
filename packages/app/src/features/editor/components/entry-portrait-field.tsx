import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Camera, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveImageUrl } from "@/lib/asset-url";
import { useEditorStore } from "@/stores/editor";
import { AssetPicker } from "../asset-picker";

/**
 * Picks a character's portrait: the image shown beside their lines in chat.
 *
 * Stores an `@asset:<id>` reference on the entry (`entry.portrait`); the chat
 * host resolves it to a URL at play time. Both editors mount this — the simple
 * editor as the square "avatar" next to the name, the advanced editor as a
 * labelled row — so the two can never drift on what a portrait is.
 *
 * The asset picker needs a server-side world id, so an unsaved draft is saved
 * first (same rule as BGM upload in the simple editor).
 */
export function EntryPortraitField({
  value,
  onChange,
  variant,
}: {
  value?: string;
  onChange: (portrait: string | undefined) => void;
  variant: "avatar" | "row";
}) {
  const { t } = useTranslation("editor");
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const src = value ? resolveImageUrl(value) : undefined;
  const actionLabel = src ? t("simple.character.portraitChange") : t("simple.character.portraitAdd");

  const openPicker = async () => {
    let id = serverWorldId;
    if (!id) {
      await saveDraft();
      id = useEditorStore.getState().serverWorldId;
    }
    if (!id) {
      setError(t("simple.needWorldNameSaved"));
      return;
    }
    setError(null);
    setPicking(true);
  };

  // Portalled to <body>: the simple editor's cards use backdrop-blur, which
  // makes them the containing block for `position: fixed` — the picker's
  // full-screen overlay would otherwise be trapped (and clipped) inside the card.
  const picker =
    picking && serverWorldId
      ? createPortal(
          <AssetPicker
            worldId={serverWorldId}
            filterType="image"
            onSelect={(ref) => {
              onChange(ref);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />,
          document.body,
        )
      : null;

  if (variant === "avatar") {
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={openPicker}
          title={actionLabel}
          aria-label={actionLabel}
          className={cn(
            "group flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border bg-background/50 transition-colors",
            src ? "border-border hover:border-fuchsia-400/60" : "border-dashed border-border hover:border-fuchsia-400/40",
          )}
        >
          {src ? (
            <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
          ) : (
            <Camera className="h-4 w-4 text-muted-foreground/40 group-hover:text-fuchsia-300" />
          )}
        </button>
        {src && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            title={t("simple.character.portraitRemove")}
            aria-label={t("simple.character.portraitRemove")}
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {error && (
          <p className="absolute left-0 top-full mt-1 w-56 text-[10px] text-destructive">{error}</p>
        )}
        {picker}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-bold text-foreground">{t("entries.portrait")}</label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={openPicker}
          title={actionLabel}
          aria-label={actionLabel}
          className={cn(
            "flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-card transition-colors",
            src ? "border-border hover:border-primary/50" : "border-dashed border-border hover:border-primary/40",
          )}
        >
          {src ? (
            <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
          ) : (
            <Camera className="h-5 w-5 text-muted-foreground/50" />
          )}
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs text-muted-foreground">{t("simple.character.portraitHint")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={openPicker}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              {actionLabel}
            </button>
            {src && (
              <button
                type="button"
                onClick={() => onChange(undefined)}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
              >
                {t("simple.character.portraitRemove")}
              </button>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
      {picker}
    </div>
  );
}
