import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Download, FileJson, ImageIcon, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LANGUAGE_SHORT, variantLanguageLabel, variantRowLabels } from "@/lib/languages";
import type { LanguageVariant } from "@/lib/languages";
import { downloadWorldPNG, downloadWorldJSON } from "@/lib/download-world";
import i18n from "@/lib/i18n";


type Format = "png" | "json";

interface VariantDownloadPickerProps {
  open: boolean;
  onClose: () => void;
  /** World ID to download when no variants are provided (single-variant case). */
  worldId?: string;
  /** Optional language variants. When supplied with length > 1, a variant
   *  picker is shown; otherwise the dialog is just a format chooser. */
  variants?: LanguageVariant[];
  worldName?: string;
}

export function VariantDownloadPicker({
  open,
  onClose,
  worldId,
  variants,
  worldName,
}: VariantDownloadPickerProps) {
  const { t } = useTranslation("editor");
  const contentRef = useRef<HTMLDivElement>(null);
  const variantList = variants ?? [];
  const rowLabels = variantRowLabels(variantList);
  const showVariants = variantList.length > 1;

  const initialId = (() => {
    if (showVariants) {
      return (
        variantList.find((v) => v.language === i18n.language)?.id ??
        variantList[0]?.id ??
        worldId ??
        ""
      );
    }
    return worldId ?? variantList[0]?.id ?? "";
  })();

  const [selectedId, setSelectedId] = useState(initialId);
  const [format, setFormat] = useState<Format>("png");
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (showVariants) {
      const match =
        variantList.find((v) => v.language === i18n.language)?.id ??
        variantList[0]?.id ??
        worldId ??
        "";
      setSelectedId(match);
    } else {
      setSelectedId(worldId ?? variantList[0]?.id ?? "");
    }
  }, [open, variants, worldId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    contentRef.current?.focus();
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleDownload = async () => {
    if (!selectedId || downloading) return;
    setDownloading(true);
    const variant = showVariants ? variantList.find((v) => v.id === selectedId) : null;
    const name = variant
      ? `${worldName || variant.name} - ${variantLanguageLabel(variant)}`
      : worldName;
    if (format === "png") {
      await downloadWorldPNG(selectedId, name || undefined);
    } else {
      await downloadWorldJSON(selectedId, name || undefined);
    }
    setDownloading(false);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/80 animate-in fade-in duration-150"
        onClick={onClose}
      />
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm rounded-lg border border-border bg-card shadow-lg animate-in fade-in zoom-in-95 duration-200 mx-4 outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">
            {showVariants ? t("downloadVariant") : t("downloadLabel")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Format toggle */}
        <div className="px-5 pt-4 pb-2">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: "png", label: "PNG", desc: t("downloadWithCover", "with cover"), Icon: ImageIcon },
                { id: "json", label: "JSON", desc: t("downloadDataOnly", "data only"), Icon: FileJson },
              ] as const
            ).map((opt) => {
              const active = format === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setFormat(opt.id)}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <opt.Icon className="h-3.5 w-3.5" />
                    {opt.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground/70">{opt.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Variant list (only for multi-variant worlds) */}
        {showVariants && (
          <div className="space-y-1 px-5 py-3">
            {variantList.map((v) => {
              const isSelected = v.id === selectedId;
              const label = rowLabels.get(v.id) ?? v.name;
              const langShort = v.language ? (LANGUAGE_SHORT[v.language] ?? null) : null;

              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedId(v.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                    isSelected
                      ? "bg-primary/10 text-foreground ring-1 ring-primary/20"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                      isSelected ? "border-primary" : "border-muted-foreground/30",
                    )}
                  >
                    {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
                  </div>

                  <span className="flex-1 font-medium">{label}</span>

                  {langShort && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                      {langShort}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading || !selectedId}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {t("downloadLabel")} {format.toUpperCase()}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
