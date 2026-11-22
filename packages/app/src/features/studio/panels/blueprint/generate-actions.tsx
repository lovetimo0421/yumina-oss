import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, Sparkles, Wand2 } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { getAssetCdnUrl } from "@/lib/asset-url";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MediaToolSheet, QuickGenerate, toolsFor } from "@/edition/slots";
import type { LandedAsset, QuickContext, QuickTarget } from "@/edition/slots.types";
import { cn } from "@/lib/utils";

const ASSET_REF = /^@asset:([\w-]+)$/;

/** The asset a field holds, when it is one of the card's own (`@asset:<id>`). */
export function assetOf(ref: string | undefined): LandedAsset | undefined {
  const id = ref ? ASSET_REF.exec(ref.trim())?.[1] : undefined;
  return id ? { assetId: id, url: getAssetCdnUrl(id) } : undefined;
}

export const assetRef = (landed: LandedAsset) => `@asset:${landed.assetId}`;

/** The card's characters' portraits, the first character's first: what a
 *  picture or a clip is drawn with so the people in it look like themselves.
 *  An image model takes one (the lead); a clip takes as many as it has room
 *  for. `except`: the character being animated, whose portrait is the first
 *  frame already. */
export function characterPortraits(entries: ReadonlyArray<{ id: string; role?: string; enabled?: boolean; portrait?: string }>, except?: string): LandedAsset[] {
  return entries
    .filter((e) => e.role === "character" && e.enabled !== false && e.id !== except)
    .map((e) => assetOf(e.portrait))
    .filter((a): a is LandedAsset => !!a);
}

const chip = "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400 disabled:opacity-40";

/**
 * 生成 / 加工, on the thing itself: a portrait, a scene picture, a track.
 * 生成 opens the quick generator for that slot and puts what it makes there;
 * 加工 runs a workbench tool on what is already there (cut out, upscale,
 * relight, lip-sync…). Nothing leaves the board: the result lands in the
 * field it was made for, one undo step.
 */
export function GenerateActions({ target, context, value, source, media, onPut, generate = true, className }: {
  target?: QuickTarget;
  context?: QuickContext;
  /** What the field holds now (`@asset:<id>` or a URL). */
  value?: string;
  /** What 生成 starts from when it is not the field itself: a moving
   *  portrait's first frame is the still portrait. */
  source?: string;
  media: "image" | "video" | "audio";
  /** Write the new reference into the field. */
  onPut: (ref: string) => void;
  /** False: only 加工 (the slot has no generator of its own). */
  generate?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("editor");
  const { t: tl } = useTranslation("library");
  const worldId = useEditorStore((s) => s.serverWorldId);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const readOnly = useEditorStore((s) => s.readOnlyInspect);
  const [open, setOpen] = useState<null | { kind: "quick" } | { kind: "tool"; id: string }>(null);
  const current = assetOf(value);
  const tools = current ? toolsFor(media) : [];
  if (readOnly || !worldId) return null;

  const put = (landed: LandedAsset | undefined) => {
    if (!landed) return;
    const store = useEditorStore.getState();
    store.beginBatch();
    try { onPut(assetRef(landed)); } finally { useEditorStore.getState().commitBatch(); }
  };

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} data-generate-actions="">
      {generate && target && (
        <button type="button" data-generate-open="" onClick={() => setOpen({ kind: "quick" })}
          className={cn(chip, "border-white/10 text-foreground/80 hover:border-white/25 hover:text-foreground")}>
          <Sparkles className="h-3 w-3" />{t("blueprint.gen.generate")}
        </button>
      )}
      {tools.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-generate-tools="" className={cn(chip, "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground")}>
              <Wand2 className="h-3 w-3" />{t("blueprint.gen.refine")}<ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {tools.map((tool) => (
              <DropdownMenuItem key={tool.id} onSelect={() => setOpen({ kind: "tool", id: tool.id })} className="text-xs">
                {tl(`generation.tools.item.${tool.id}.name` as never)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {open?.kind === "quick" && target && createPortal(
        <QuickGenerate
          target={target}
          worldId={worldId}
          context={context ?? {}}
          current={source !== undefined ? assetOf(source) : current}
          references={target.kind === "portrait" || target.kind === "audio" || target.kind === "voice" ? [] : characterPortraits(entries, target.kind === "portrait-video" ? target.entryId : undefined)}
          onLanded={put}
          onClose={() => setOpen(null)}
        />,
        document.body,
      )}
      {open?.kind === "tool" && current && createPortal(
        <MediaToolSheet
          toolId={open.id as never}
          worldId={worldId}
          inputs={{ [media]: current.assetId }}
          // A new version of the same thing takes its place; anything else
          // (a 3D model of the picture) goes to the library, not the field.
          onLanded={(landed) => { const tool = tools.find((x) => x.id === open.id); if (tool?.replacesInput) put(landed[0]); }}
          onClose={() => setOpen(null)}
        />,
        document.body,
      )}
    </span>
  );
}
