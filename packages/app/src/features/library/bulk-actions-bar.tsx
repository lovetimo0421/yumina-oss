import { CheckSquare, ChevronDown, Copy, Download, FolderInput, Link, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface BulkActionsBarProps {
  active: boolean;
  selectedCount: number;
  totalCount: number;
  onToggle: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDelete: () => void;
  disableDelete?: boolean;
  selectLabel?: string;
  selectClassName?: string;
  onMove?: () => void;
  onDownload?: () => void;
  onCopyRefs?: () => void;
  onCopyUrls?: () => void;
  busy?: boolean;
}

export function BulkActionsBar({
  active,
  selectedCount,
  totalCount,
  onToggle,
  onSelectAll,
  onClear,
  onDelete,
  disableDelete,
  selectLabel,
  selectClassName,
  onMove,
  onDownload,
  onCopyRefs,
  onCopyUrls,
  busy = false,
}: BulkActionsBarProps) {
  const { t } = useTranslation("library");
  const allSelected = selectedCount > 0 && selectedCount === totalCount;

  if (!active) {
    return (
      <button
        onClick={onToggle}
        disabled={totalCount === 0}
        className={cn("flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30", selectClassName)}
      >
        <CheckSquare size={14} strokeWidth={2} />
        {selectLabel ?? t("bulk.select")}
      </button>
    );
  }

  return (
    <div className="flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-primary/25 bg-primary/[0.06] px-1.5 py-1 shadow-[0_0_0_1px_rgba(232,184,49,0.04)]">
      <span className="px-2 text-[11px] font-semibold uppercase tracking-wider text-primary/90 tabular-nums">
        {t("bulk.selectedCount", { count: selectedCount })}
      </span>

      <span className="h-3.5 w-px bg-white/10" />

      <button
        onClick={allSelected ? onClear : onSelectAll}
        disabled={busy}
        className="rounded-full px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground/80 transition-colors hover:bg-white/5 hover:text-foreground"
      >
        {allSelected ? t("bulk.clearSelection") : t("bulk.selectAll")}
      </button>

      {onMove && <button onClick={onMove} disabled={selectedCount === 0 || busy}
        className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground/80 hover:bg-white/5 hover:text-foreground disabled:opacity-40">
        <FolderInput size={12} />{t("assets.moveSelected")}
      </button>}

      {onDownload && <button onClick={onDownload} disabled={selectedCount === 0 || busy}
        className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground/80 hover:bg-white/5 hover:text-foreground disabled:opacity-40">
        <Download size={12} />{t("assets.download")}
      </button>}

      {(onCopyRefs || onCopyUrls) && <DropdownMenu>
        <DropdownMenuTrigger asChild><button disabled={selectedCount === 0 || busy}
          className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground/80 hover:bg-white/5 hover:text-foreground disabled:opacity-40">
          <Copy size={12} />{t("assets.copySelected")}<ChevronDown size={11} />
        </button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onCopyRefs && <DropdownMenuItem onSelect={onCopyRefs}><Copy size={14} />{t("assets.copyRef")}</DropdownMenuItem>}
          {onCopyUrls && <DropdownMenuItem onSelect={onCopyUrls}><Link size={14} />{t("assets.copyUrl")}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>}

      <button
        onClick={onDelete}
        disabled={selectedCount === 0 || disableDelete || busy}
        className="flex items-center gap-1 rounded-full bg-red-500/90 px-3 py-1 text-[11px] font-bold text-white shadow-sm transition-all hover:bg-red-500 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-sm"
      >
        <Trash2 size={11} strokeWidth={2.5} />
        {t("bulk.delete")}
      </button>

      <button
        onClick={onToggle}
        disabled={busy}
        title={t("bulk.cancel")}
        className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-white/5 hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>
  );
}
