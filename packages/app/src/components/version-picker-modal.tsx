import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Globe, Play, X } from "lucide-react";
import { LANGUAGE_SHORT, variantRowLabels } from "@/lib/languages";
import type { LanguageVariant } from "@/lib/languages";


interface VersionPickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (worldId: string) => void;
  variants: LanguageVariant[];
  worldName?: string;
}

export function VersionPickerModal({
  open,
  onClose,
  onSelect,
  variants,
  worldName,
}: VersionPickerModalProps) {
  const { t } = useTranslation("editor");
  const { t: tChat, i18n } = useTranslation("chat");
  const contentRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState(variants[0]?.id ?? "");
  const [showAllLanguages, setShowAllLanguages] = useState(false);

  // Same rule as the logged-in play flow (SessionPickerModal): compare by base
  // language so a zh-Hant UI still treats zh variants as "current language".
  const uiLangBase = i18n.language.split("-")[0];
  const isCurrentLang = (v: { language: string | null }) =>
    (v.language ?? "").split("-")[0] === uiLangBase;
  const variantsInCurrentLanguage = variants.filter(isCurrentLang);
  const hasOtherLanguageVariants =
    variants.length > 1 && variants.some((v) => !isCurrentLang(v));
  const rowLabels = variantRowLabels(variants);
  const displayedVariants =
    showAllLanguages || variantsInCurrentLanguage.length === 0
      ? variants
      : variantsInCurrentLanguage;

  useEffect(() => {
    if (open && variants.length > 0) {
      setShowAllLanguages(false);
      const currentLang = variants.filter(
        (v) => (v.language ?? "").split("-")[0] === i18n.language.split("-")[0]
      );
      const initialList = currentLang.length > 0 ? currentLang : variants;
      setSelectedId(initialList[0].id);
    }
  }, [open, variants, i18n.language]);

  const toggleShowAllLanguages = () => {
    setShowAllLanguages((prev) => {
      const next = !prev;
      // Collapsing back to current-language view can hide the selected
      // variant — snap the selection back to a visible one.
      if (!next && variantsInCurrentLanguage.length > 0 && !variantsInCurrentLanguage.some((v) => v.id === selectedId)) {
        setSelectedId(variantsInCurrentLanguage[0].id);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    contentRef.current?.focus();
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open || variants.length === 0) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/78 animate-in fade-in duration-150"
        onClick={onClose}
      />
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm rounded-2xl border border-white/[0.06] bg-[#1A1B20] shadow-[0_18px_60px_rgba(0,0,0,0.42)] animate-in fade-in zoom-in-95 duration-200 mx-4 outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <div>
            <h2 className="text-[0.95rem] font-semibold text-foreground">
              {worldName ?? t("selectVersionLabel")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mx-5 h-px bg-white/[0.06]" />

        {/* Version list */}
        <div className="space-y-1 px-3 py-3">
          {hasOtherLanguageVariants && (
            <div className="flex items-center justify-end px-0.5 pb-1">
              <button
                type="button"
                onClick={toggleShowAllLanguages}
                title={tChat(
                  showAllLanguages
                    ? "header.showCurrentLanguage"
                    : "header.showAllLanguages"
                )}
                aria-label={tChat(
                  showAllLanguages
                    ? "header.showCurrentLanguage"
                    : "header.showAllLanguages"
                )}
                aria-pressed={showAllLanguages}
                className={`flex h-5 w-5 items-center justify-center rounded-md transition-colors ${
                  showAllLanguages
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground/40 hover:bg-white/[0.04] hover:text-muted-foreground/70"
                }`}
              >
                <Globe className="h-3 w-3" />
              </button>
            </div>
          )}
          {displayedVariants.map((v) => {
            const isSelected = v.id === selectedId;
            const label = rowLabels.get(v.id) ?? v.name;
            const langShort = v.language ? (LANGUAGE_SHORT[v.language] ?? null) : null;

            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setSelectedId(v.id)}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm transition-all ${
                  isSelected
                    ? "border border-primary/20 bg-primary/[0.06] text-foreground"
                    : "border border-transparent text-muted-foreground/60 hover:border-white/[0.06] hover:bg-white/[0.02] hover:text-foreground"
                }`}
              >
                {/* Radio dot */}
                <div
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                    isSelected ? "border-primary" : "border-muted-foreground/30"
                  }`}
                >
                  {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
                </div>

                <span className="flex-1 font-medium">{label}</span>

                {langShort && (
                  <span className="shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground/50">
                    {langShort}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mx-5 h-px bg-white/[0.06]" />

        {/* Footer */}
        <div className="px-4 py-3.5">
          <button
            type="button"
            onClick={() => {
              if (selectedId) onSelect(selectedId);
            }}
            disabled={!selectedId}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary/90 px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            Preview
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
