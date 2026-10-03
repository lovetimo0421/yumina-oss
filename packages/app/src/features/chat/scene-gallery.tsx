import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Images, Lock } from "lucide-react";
import type { SceneImage } from "@yumina/engine";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resolveImageUrl } from "@/lib/asset-url";
import { useChatStore } from "@/stores/chat";
import { cn } from "@/lib/utils";

const SCENE_MARK_RE = /\[image:[^\]\n]*?\|scene=([^\]|\s]+)/g;

/** The world's scene images and which of them this session has already shown.
 *  Revealed = the server's per-session record, plus whatever this tab saw in
 *  its own turns, plus a scan of the loaded messages (covers the opening). */
export function useSceneGallery(): { images: SceneImage[]; revealed: Set<string> } {
  const session = useChatStore((s) => s.session);
  const messages = useChatStore((s) => s.messages);
  const revealedFromTurns = useChatStore((s) => s.revealedSceneImages);
  return useMemo(() => {
    const schema = session?.world?.schema as { sceneImages?: SceneImage[] } | undefined;
    const images = Array.isArray(schema?.sceneImages) ? schema!.sceneImages!.filter((img) => img.url) : [];
    const revealed = new Set<string>(revealedFromTurns);
    const persisted = (session?.state as { metadata?: { sceneImagesUnlocked?: unknown } } | undefined)?.metadata?.sceneImagesUnlocked;
    if (Array.isArray(persisted)) for (const id of persisted) if (typeof id === "string") revealed.add(id);
    for (const m of messages) {
      if (typeof m.content !== "string" || !m.content.includes("scene=")) continue;
      for (const hit of m.content.matchAll(SCENE_MARK_RE)) revealed.add(hit[1]!);
    }
    return { images, revealed };
  }, [session, messages, revealedFromTurns]);
}

/**
 * The player's picture gallery: every scene image the author registered, the
 * ones the story has already shown in full, the rest as a locked slot wearing
 * the author's hint. The hint is the hook — it tells the player there is a
 * moment worth reaching.
 */
export function SceneGalleryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("chat");
  const { images, revealed } = useSceneGallery();
  const unlocked = images.filter((img) => revealed.has(img.id)).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Images className="h-4 w-4 text-muted-foreground" />
            {t("header.sceneGallery")}
            <span className="ml-auto text-xs font-normal tabular-nums text-muted-foreground">
              {t("header.sceneGalleryCount", { unlocked, total: images.length })}
            </span>
          </DialogTitle>
        </DialogHeader>
        {images.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("header.sceneGalleryEmpty")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {images.map((img) => {
              const isRevealed = revealed.has(img.id);
              const src = isRevealed ? resolveImageUrl(img.url) : undefined;
              return (
                <figure key={img.id} className="min-w-0">
                  <div
                    className={cn(
                      "relative aspect-square overflow-hidden rounded-xl border border-border bg-muted/40",
                      !isRevealed && "border-dashed",
                    )}
                  >
                    {src ? (
                      <img src={src} alt={img.name || img.id} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
                        <Lock className="h-5 w-5 text-muted-foreground/50" />
                        <p className="line-clamp-3 text-[12px] leading-snug text-muted-foreground/80">
                          {img.hint?.trim() || t("header.sceneGalleryLocked")}
                        </p>
                      </div>
                    )}
                  </div>
                  <figcaption className={cn("mt-1.5 truncate text-xs", isRevealed ? "text-foreground" : "text-muted-foreground/60")}>
                    {isRevealed ? img.name || img.id : "· · ·"}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
