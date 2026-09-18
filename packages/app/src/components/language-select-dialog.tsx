import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { LANGUAGE_OPTIONS } from "@/lib/languages";

export interface LanguageSelectDialogProps {
  open: boolean;
  onSelect: (language: string | null) => void;
  onClose: () => void;
  title?: string;
  /** If true, show a "Skip / No language" option */
  allowSkip?: boolean;
}

export function LanguageSelectDialog({
  open,
  onSelect,
  onClose,
  title,
  allowSkip,
}: LanguageSelectDialogProps) {
  const { t } = useTranslation("editor");
  const contentRef = useRef<HTMLDivElement>(null);

  // Escape key + auto-focus
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

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Container */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Card */}
        <div
          ref={contentRef}
          role="dialog"
          aria-modal="true"
          aria-label={title ?? t("extra.selectLanguage")}
          tabIndex={-1}
          className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl outline-none"
        >
          <h2 className="mb-4 text-lg font-semibold text-foreground">
            {title ?? t("extra.selectLanguage")}
          </h2>

          {/* Language grid */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {LANGUAGE_OPTIONS.map((lang) => (
              <button
                key={lang.code}
                type="button"
                onClick={() => {
                  onSelect(lang.code);
                  onClose();
                }}
                className="flex items-center gap-3 rounded-xl border border-border p-3 hover:bg-accent transition-colors cursor-pointer"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-xs font-bold">
                  {lang.short}
                </span>
                <span className="text-sm font-medium text-foreground">
                  {lang.label}
                </span>
              </button>
            ))}
          </div>

          {/* Skip button */}
          {allowSkip && (
            <button
              type="button"
              onClick={() => {
                onSelect(null);
                onClose();
              }}
              className="mt-4 w-full rounded-xl border border-border p-3 text-sm text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              {t("variantBar.skip", "Skip")}
            </button>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
