import { CheckSquare, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface BulkActionsBarProps {
  active: boolean;
  selectedCount: number;
  totalCount: number;
  onToggle: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDelete: () => void;
  disableDelete?: boolean;
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
}: BulkActionsBarProps) {
  const { t } = useTranslation("library");
  const allSelected = selectedCount > 0 && selectedCount === totalCount;

  if (!active) {
    return (
      <button
        onClick={onToggle}
        disabled={totalCount === 0}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-white/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
      >
        <CheckSquare size={13} strokeWidth={2} />
        {t("bulk.select")}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 rounded-full border border-primary/25 bg-primary/[0.06] px-1.5 py-1 shadow-[0_0_0_1px_rgba(232,184,49,0.04)]">
      <span className="px-2 text-[11px] font-semibold uppercase tracking-wider text-primary/90 tabular-nums">
        {t("bulk.selectedCount", { count: selectedCount })}
      </span>

      <span className="h-3.5 w-px bg-white/10" />

      <button
        onClick={allSelected ? onClear : onSelectAll}
        className="rounded-full px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground/80 transition-colors hover:bg-white/5 hover:text-foreground"
      >
        {allSelected ? t("bulk.clearSelection") : t("bulk.selectAll")}
      </button>

      <button
        onClick={onDelete}
        disabled={selectedCount === 0 || disableDelete}
        className="flex items-center gap-1 rounded-full bg-red-500/90 px-3 py-1 text-[11px] font-bold text-white shadow-sm transition-all hover:bg-red-500 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-sm"
      >
        <Trash2 size={11} strokeWidth={2.5} />
        {t("bulk.delete")}
      </button>

      <button
        onClick={onToggle}
        title={t("bulk.cancel")}
        className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-white/5 hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>
  );
}
