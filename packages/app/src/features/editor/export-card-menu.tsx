import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileJson, Image as ImageIcon, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadWorldJSON, downloadWorldPNG } from "@/lib/download-world";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";

interface ExportCardMenuProps {
  worldId: string | null;
  worldName?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}

/**
 * "Export card" — stands where the Publish / review-state control sits when
 * the edition has no hub to publish to (the open-source build). Downloads the
 * saved world as a Yumina PNG card or as JSON via the existing helpers.
 */
export function ExportCardMenu({ worldId, worldName, size = "md", disabled, className }: ExportCardMenuProps) {
  const { t } = useTranslation("editor");
  const [busy, setBusy] = useState(false);

  const run = async (kind: "png" | "json") => {
    if (!worldId || busy) return;
    setBusy(true);
    try {
      if (kind === "png") await downloadWorldPNG(worldId, worldName || undefined);
      else await downloadWorldJSON(worldId, worldName || undefined);
    } catch (err) {
      feedback.error(err instanceof Error ? err.message : t("shell.exportCardFailed", { defaultValue: "Export failed" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled || !worldId || busy}
          title={!worldId ? t("versionHistory.needsServerSave", { defaultValue: "Save the world first" }) : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-40",
            size === "sm" ? "h-9 px-2.5 text-xs" : "px-3 py-2 text-sm",
            className,
          )}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {t("shell.exportCard", { defaultValue: "Export card" })}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void run("png")} className="gap-2 text-xs">
          <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
          {t("shell.exportCardPng", { defaultValue: "PNG card" })}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run("json")} className="gap-2 text-xs">
          <FileJson className="h-3.5 w-3.5 text-muted-foreground" />
          {t("shell.exportCardJson", { defaultValue: "JSON" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
