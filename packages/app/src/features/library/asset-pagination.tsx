import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useTranslation } from "react-i18next";

export function AssetPagination({ page, totalPages, loading, onPageChange }: {
  page: number;
  totalPages: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation("library");
  const id = useId();
  const [value, setValue] = useState(String(page));
  useEffect(() => setValue(String(page)), [page, totalPages]);
  const buttonClass = "flex h-8 min-w-8 items-center justify-center rounded-lg border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-30";
  return (
    <form aria-label={t("assets.pagination")} className="flex flex-wrap items-center justify-center gap-2 pt-2" onSubmit={(event) => {
      event.preventDefault();
      const next = Number(value);
      if (!loading && Number.isInteger(next) && next >= 1 && next <= totalPages) onPageChange(next);
    }}>
      <button type="button" aria-label={t("assets.firstPage")} disabled={loading || page <= 1} onClick={() => onPageChange(1)} className={buttonClass}><ChevronsLeft size={14} /></button>
      <button type="button" aria-label={t("assets.prev")} disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)} className={buttonClass}><ChevronLeft size={14} /></button>
      <label className="sr-only" htmlFor={id}>{t("assets.pageNumber")}</label>
      <input id={id} type="number" inputMode="numeric" min={1} max={totalPages} step={1} required disabled={loading} value={value} onChange={(event) => setValue(event.target.value)} className="h-8 w-14 rounded-lg border border-border bg-transparent px-1 text-center text-xs text-foreground tabular-nums outline-none focus:border-primary [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
      <span className="text-xs text-muted-foreground tabular-nums">/ {totalPages}</span>
      <button type="submit" disabled={loading} className={buttonClass}>{t("assets.goToPage")}</button>
      <button type="button" aria-label={t("assets.next")} disabled={loading || page >= totalPages} onClick={() => onPageChange(page + 1)} className={buttonClass}><ChevronRight size={14} /></button>
      <button type="button" aria-label={t("assets.lastPage")} disabled={loading || page >= totalPages} onClick={() => onPageChange(totalPages)} className={buttonClass}><ChevronsRight size={14} /></button>
    </form>
  );
}
